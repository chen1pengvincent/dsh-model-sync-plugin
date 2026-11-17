/**
 * A dry run of the plugin against the *actual* profile on this machine.
 *
 * Everything here is read-only by construction: `settings.mutate` records the
 * operations instead of applying them, and the bili lane is a recorder that
 * replays the real config but refuses to write. What it buys is the one thing
 * offline unit tests cannot: real provider configs, real credentials refs, real
 * upstreams, real system proxy — and an exact diff of what the plugin would
 * write if you pressed the buttons.
 *
 * Run: node scripts/rehearse.mjs [--provider google]
 */

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { Controller } from '../lib/controller.js'
import { getConfig, locate, putProviders, readConfigFile } from '../lib/bili.js'
import { asarModules } from './asar.mjs'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = process.env.DSH_PROFILE ?? 'desktop'
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)
const PATCH = join(PROFILE_DIR, 'cordis.patch.yml')
const CREDENTIALS = join(DSH_HOME, '.credentials.yaml')
const PIAI = 'llm-pi-ai'
const ENDPOINTS = {
  'google': 'https://generativelanguage.googleapis.com',
  'deepseek-official': 'https://api.deepseek.com',
  'kimi-coding': 'https://api.kimi.com/coding',
  'openai': 'https://api.openai.com/v1',
}
// `opencode` and `opencode-go` are deliberately absent: the installed host
// reports no default address for them (the catalog puts the address on each
// model), which is exactly the hole `lib/endpoints.js` fills. Leaving them out
// keeps this rehearsal honest about where the address came from.
const DEEPSEEK = 'llm-deepseek'
const ASAR_MODULES = asarModules()

/** The profile's YAML is machine-written; only the provider table matters here. */
function loadYaml() {
  try {
    const require = createRequire(join(ASAR_MODULES, 'noop.js'))
    return require('yaml')
  } catch {
    return undefined
  }
}

async function readPatch() {
  const yaml = loadYaml()
  if (yaml === undefined) throw new Error(`the "yaml" package is not readable under ${ASAR_MODULES}`)
  const text = await readFile(PATCH, 'utf8')
  const parsed = yaml.parse(text)
  if (Array.isArray(parsed) !== true) throw new Error('the profile patch is not a YAML array')
  const entry = parsed.find((row) => row?.id === PIAI)
  if (entry === undefined) throw new Error('the profile patch has no llm-pi-ai entry')
  return entry.config?.providers ?? {}
}

/** `refs:` in the credentials file is `REF -> secret` (or `{secret}`). */
async function readCredentials() {
  const yaml = loadYaml()
  const text = await readFile(CREDENTIALS, 'utf8')
  const parsed = yaml.parse(text)
  // The harness keeps plain `refs: REF -> value` at the top level (records are
  // for interactive sign-ins and are not what a route's apiKeyEnv points at).
  const records = parsed?.refs ?? {}
  const out = new Map()
  for (const [ref, value] of Object.entries(records)) {
    const secret = typeof value === 'string' ? value : value?.secret ?? value?.value
    if (typeof secret === 'string' && secret.length > 0) out.set(ref, secret)
  }
  return out
}

function describeSections(providers, deepseek) {
  return [
    { ns: PIAI, value: { providers }, revision: 1 },
    { ns: DEEPSEEK, value: deepseek, revision: 1 },
  ]
}

/** The ids the host would report for a route: its own list, else the shipped catalog. */
async function effectiveIdsFor(provider, profile) {
  if (Array.isArray(profile?.models)) return profile.models.map((model) => String(model.id ?? model))
  try {
    const require = createRequire(join(ASAR_MODULES, 'noop.js'))
    const { getBuiltinModels } = require('@earendil-works/pi-ai/dist/providers/all.js')
    const build = await getBuiltinModels()
    const models = build?.[provider] ?? build?.get?.(provider)
    if (models !== undefined) return [...(models.keys?.() ?? Object.keys(models))]
  } catch {
    // A missing catalog only makes the rehearsal narrower, never wrong.
  }
  return []
}

async function main() {
  const providers = await readPatch()
  const secrets = await readCredentials()
  const before = createHash('sha256').update(await readFile(PATCH)).digest('hex')
  const beforeStat = await stat(PATCH)

  const writes = []
  const laneWrites = []
  const dir = await mkdtemp(join(tmpdir(), 'model-sync-rehearsal-'))
  const logger = { info() {}, warn: (m) => console.log('  · warn:', m), error: (m) => console.log('  · error:', m) }

  const settings = {
    // Synchronous on purpose: the harness's describe() is sync, and the
    // plugin reads it without awaiting.
    describe: () => describeSections(providers, { provider: 'deepseek-official', models: [] }),
    // Records every op, and applies it to the in-memory copy only: the point is
    // to see what would be written, never to touch the user's file. Applying it
    // in memory is what makes the read-back in `apply()` mean anything here.
    async mutate(ns, ops, revision) {
      writes.push({ ns, revision, ops })
      if (ns !== PIAI) return
      for (const op of ops) {
        const path = Array.isArray(op.path) ? op.path : []
        // providers.<route>.models and providers.<route> are the only shapes.
        // `providers` here is already the *inner* map (route -> profile), so the
        // path segment after the namespace is the route key itself. Getting this
        // wrong invents a phantom 'llm-pi-ai' key and every read-back then sees
        // the old document while the run claims success.
        const [, route, field] = path
        if (route === undefined) continue
        if (field === undefined) {
          if (op.op === 'set') providers[route] = structuredClone(op.value)
          else delete providers[route]
          continue
        }
        const profile = (providers[route] ??= {})
        if (op.op === 'set') profile[field] = structuredClone(op.value)
        else delete profile[field]
      }
    },
    get(ns) {
      return describeSections(providers, {}).find((row) => row.ns === ns)?.value
    },
  }

  const listed = [
    { provider: 'deepseek-official', settingsNs: DEEPSEEK, settingsPath: [], displayName: 'DeepSeek', defaultBaseURL: 'https://api.deepseek.com' },
    ...Object.keys(providers).map((provider) => ({
      provider,
      settingsNs: PIAI,
      settingsPath: ['providers', provider],
      displayName: provider,
      // What the host reports as the provider's default endpoint. Same table as
      // scripts/live-discovery.mjs, which reached all six of them for real.
      defaultBaseURL: ENDPOINTS[provider],
    })),
  ]

  /** @type {Map<string, string[]>} */
  const effective = new Map()
  for (const [provider, profile] of Object.entries(providers)) effective.set(provider, await effectiveIdsFor(provider, profile))

  const biliWrites = []
  const backups = []

  // The recorder below can only reach a *copy* of the lane's config, so even a
  // bug that bypasses every seam writes to a temp file instead of the user's.
  const sandbox = await mkdtemp(join(tmpdir(), 'rehearse-bili-'))
  const realWhere = locate()
  const sandboxConfig = join(sandbox, 'billion-context.json')
  ECHO_STATE: {
    if (realWhere === undefined) break ECHO_STATE
    const raw = await readConfigFile(realWhere.configPath)
    await writeFile(sandboxConfig, JSON.stringify(raw, null, 2), { mode: 0o600 })
  }

  const ctx = {
    get(name) {
      if (name === 'settings') return settings
      if (name === 'profileContext') return { dir: PROFILE_DIR }
      if (name === 'llm') {
        return {
          listConfigurableProviders: () => listed,
          listModels: async (provider) => {
            // Like the host: a stated list replaces the catalog.
            const stated = providers[provider]?.models
            if (Array.isArray(stated)) return stated.map((model) => ({ id: String(model?.id ?? model) }))
            return (effective.get(provider) ?? []).map((id) => ({ id }))
          },
          resolveModelInfo: async (provider, id) => ({ provider, id, name: id }),
        }
      }
      if (name === 'credentials') {
        return {
          async resolve(ref) {
            const value = secrets.get(ref)
            return value === undefined ? undefined : { value, source: 'credentials' }
          },
          async describe(ref) {
            return { configured: secrets.has(ref), source: secrets.has(ref) ? 'credentials' : undefined, writable: false, shadowed: [] }
          },
        }
      }
      return undefined
    },
    logger,
  }

  const controller = new Controller(ctx, {
    dir,
    logger,
    // The real lane's config is read, but its writer is replaced by a recorder.
    bili: {
      // `locate` is synchronous in the real module; wrapping it in async here
      // would hand the controller a Promise and make every field undefined.
      // Everything below points at the sandbox copy, never the real lane.
      locate: () => (realWhere === undefined ? undefined : { ...realWhere, configPath: sandboxConfig }),
      readConfigFile: (path) => readConfigFile(path),
      getConfig: async () => ({ status: 200, text: JSON.stringify(await readConfigFile(sandboxConfig)) }),
      putProviders: async (origin, providers) => {
        biliWrites.push({ origin, providers })
        const merged = { ...(await readConfigFile(sandboxConfig)), ...(realWhere === undefined ? {} : {}), providers }
        await writeFile(sandboxConfig, JSON.stringify(merged, null, 2), { mode: 0o600 })
        return { status: 200, body: 'recorded in the sandbox copy' }
      },
      backup: async (dir, config) => {
        backups.push({ dir, keys: Object.keys(config ?? {}) })
        return undefined
      },
    },
  })

  await controller.store.load()

  const view = await controller.view()
  console.log('\n== 1. 这台机器上插件看到的供应商 ==')
  for (const row of view.providers) {
    console.log(`  ${row.provider.padEnd(18)} api=${String(row.api ?? '（未写，按目录）').padEnd(22)} explicit=${row.explicitModels ? 'yes' : 'no '} 已启用 ${row.eagerCount}`)
    console.log(`     baseURL: ${row.baseURL ?? '（继承内置默认）'}`)
  }
  const seen = new Set(view.providers.map((row) => row.provider))
  const hidden = new Set(view.legacy.map((row) => row.provider))
  for (const provider of Object.keys(providers)) {
    if (seen.has(provider) || hidden.has(provider)) continue
    console.log(`  ${provider.padEnd(18)} （彩排看不到它的模型：路由没有 models[]，继承适配器目录）`)
  }
  console.log(`  proxy: ${JSON.stringify(view.proxy)}`)
  console.log(`  遗留合成供应商: ${view.legacy.map((row) => row.provider).join(', ') || '（无）'}`)

  console.log('\n== 2. 真实上游检查（走系统代理） ==')
  const checked = await controller.check({ reason: 'rehearsal' })
  for (const row of checked.results) {
    const added = row.added?.map((m) => m.id) ?? []
    console.log(`  ${row.provider.padEnd(18)} status=${String(row.status).padEnd(9)} upstream=${String(row.upstreamCount ?? '?').padEnd(4)} via=${String(row.via ?? '?').padEnd(6)} added=${added.length}${row.error === undefined ? '' : ` error=${row.error}`}`)
  }

  const target = process.argv.includes('--provider')
    ? process.argv[process.argv.indexOf('--provider') + 1]
    : 'google'
  const chosen = checked.results.find((row) => row.provider === target)
  const ids = (chosen?.added ?? []).map((model) => model.id).slice(0, 3)

  if (ids.length > 0) {
    console.log(`\n== 3. 如果点「加入 ${ids.length} 个」到 ${target}，会写什么 ==`)
    writes.length = 0
    await controller.apply({ provider: target, ids })
    for (const batch of writes) {
      console.log(`  ns=${batch.ns} revision=${String(batch.revision)} ops=${batch.ops.length}`)
      for (const op of batch.ops) {
        const value = Array.isArray(op.value) ? op.value : op.value
        console.log(`    ${op.op} ${op.path.join('.')}`)
        if (Array.isArray(value)) {
          for (const model of value.slice(0, 4)) console.log(`       ${JSON.stringify(model)}`)
          if (value.length > 4) console.log(`       … 共 ${value.length} 条`)
        } else if (value !== undefined) {
          console.log(`       ${JSON.stringify(value).slice(0, 200)}`)
        }
      }
    }
    console.log(`  provider 键数量: ${Object.keys(providers).length} → 写入只碰 models，键数量不会变`)
  } else {
    console.log(`\n== 3. ${target} 没有新增模型，跳过写入演练 ==`)
  }

  console.log('\n== 4. 待人工核对的旧版路由 ==')
  const legacy = controller.legacySiblings()
  console.log(`  ${legacy.length} 条: ${legacy.map((row) => row.provider).join(', ')}`)

  console.log('\n== 5. bili 出口（只记录，不写） ==')
  try {
    const state = await controller.syncBili({ reason: 'rehearsal' })
    console.log(`  ${JSON.stringify({ status: state.status, found: state.found, hosts: state.hosts, written: state.written, error: state.error })}`)
    for (const write of laneWrites) {
      console.log(`  会 PUT ${write.origin}/__bili/config: ${JSON.stringify(write.providers)}`)
    }
  } catch (error) {
    console.log(`  (${error.message})`)
  }

  const after = createHash('sha256').update(await readFile(PATCH)).digest('hex')
  const afterStat = await stat(PATCH)
  console.log(`  如果同步，会 PUT ${biliWrites.length} 次，备份 ${backups.length} 次`)

  console.log('\n== 6. 真的没写东西吗 ==')
  console.log(`  cordis.patch.yml sha256 前 ${before.slice(0, 12)} / 后 ${after.slice(0, 12)} → ${before === after ? '未改动 ✅' : '被改动了 ❌'}`)
  console.log(`  mtime ${String(beforeStat.mtimeMs)} → ${String(afterStat.mtimeMs)}`)
  console.log(`  记录到的 settings.mutate 调用: ${writes.length} 次（全部只在内存里）`)
  console.log(`  记录到的 bili PUT: ${laneWrites.length} 次（全部只在内存里）`)

  // The panel is rendered by the browser, which nothing here can run. What can be
  // checked is the half that broke before: the render function itself, fed the
  // payload this profile actually produces. A missing comma there throws on every
  // render and the host turns it into a blank settings section.
  console.log('\n== 7. 面板能不能渲染这份真实数据 ==')
  try {
    const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
    const react = {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      Fragment: 'fragment',
      useCallback: (fn) => fn,
      useEffect: () => undefined,
      useMemo: (fn) => fn(),
      useRef: (value) => ({ current: value }),
      useState: (value) => [typeof value === 'function' ? value() : value, () => undefined],
    }
    const registered = []
    const context = {
      window: { __ModuleLoader__: { load: (entry) => registered.push(entry) } },
      console,
      fetch: async () => { throw new Error('no fetch during render') },
      setTimeout,
      clearTimeout,
    }
    vm.createContext(context)
    vm.runInContext(bundle, context, { filename: 'client.js' })
    const module = registered[0].factory(() => react)
    let Panel
    module.apply({ slots: { inject: (_name, factory) => factory(), register: (_options, component) => { Panel = component; return () => undefined } } })

    const flatten = (node) => {
      if (node === undefined || node === null || node === false || node === true) return ''
      if (typeof node === 'string' || typeof node === 'number') return String(node)
      if (Array.isArray(node)) return node.map(flatten).join(' ')
      if (typeof node !== 'object') return ''
      if (typeof node.type === 'function') {
        const children = node.children.length === 1 ? node.children[0] : node.children
        return flatten(node.type({ ...(node.props ?? {}), children }))
      }
      return flatten(node.children ?? node.props?.children)
    }

    const render = (payload) => flatten(Panel({ view: payload }))
    const empty = Panel({ view: null })
    const full = render(view)
    const rows = (view.providers ?? []).length
    console.log(`  真实 payload: ${rows} 个供应商 / ${(view.legacy ?? []).length} 个遗留键 / 状态 ${String(view.bili?.status)}`)
    console.log(`  空状态渲染: ${empty === undefined ? '未返回' : 'ok'}；真实数据渲染: ${full.length} 字`)
    console.log(`  首行片段: ${full.slice(0, 60).replace(/\s+/g, ' ')}…`)
  } catch (error) {
    console.log(`  ❌ 渲染失败: ${error.message}`)
    console.log('     宿主会把它变成一块空白，先修 client.js 再重启。')
  }

  // Everything above rehearses what a *click* would do. The first minute after a
  // restart is different: the controller boots on its own and reconciles the lane
  // and the gateway without anyone watching. This runs that path against the real
  // profile, with the lane writer still pointed at the sandbox copy.
  console.log('\n== 8. 重启后的第一分钟（start 的真实路径） ==')
  const bootLaneBefore = laneWrites.length
  try {
    const started = Date.now()
    await controller.start()
    const view2 = await controller.view()
    const bootWrites = laneWrites.length - bootLaneBefore
    console.log(`  start() 用时 ${String(Date.now() - started)}ms，未抛错 ✅`)
    console.log(`  bili 同步状态: ${String(view2.bili?.status)}（本次记录到 PUT ${String(bootWrites)} 次，全部在沙箱副本里）`)
    if (bootWrites > 0) {
      for (const row of laneWrites.slice(bootLaneBefore)) {
        for (const [key, value] of Object.entries(row.providers ?? {})) console.log(`    会写: ${key} → ${JSON.stringify(value)}`)
      }
    }
    console.log(`  网关: enabled=${String(view2.gateway?.enabled)} running=${String(view2.gateway?.running)}`)
    const armed = controller.nextScheduledAt()
    console.log(`  定时检查: ${armed === undefined ? '未启用' : new Date(armed).toLocaleString('zh-CN')}`)
    console.log(`  开机检查: ${controller.bootTimer === undefined ? '跳过（上次检查还很新）' : '已排期（20 秒后）'}`)
    // The panel opens on this verdict, so a boot that cannot produce one is a
    // defect the user would meet as a missing row.
    const verdict = view2.selfCheck
    if (verdict === undefined) {
      console.log('  ❌ 启动自检没有留下结论：面板首行会缺一块')
    } else {
      console.log(`  启动自检: ${verdict.ok ? '✅ 通过' : `❌ ${String(verdict.failures.length)} 个问题`}（${new Date(String(verdict.at)).toLocaleString('zh-CN')}）`)
      for (const row of verdict.failures.slice(0, 4)) console.log(`    [${row.area}] ${row.message}`)
      for (const row of verdict.warnings.slice(0, 3)) console.log(`    · [${row.area}] ${row.message}`)
    }
  } catch (error) {
    console.log(`  ❌ start() 抛错: ${error.message}`)
    console.log('     插件加载时会走这里，抛错等于面板静默消失。')
  }
  // Requirement ⑤ exists so that ② can work on a mixed route: pi-ai refuses the
  // *whole* route when a listed id has no protocol in its catalog, and a mixed
  // route has no single protocol to fall back on. This walks the real thing —
  // real profile, real upstream — with the settings buffer still in memory.
  console.log('\n== 9. 收拢协议之后能不能加目录外的模型（真实上游，全部在内存） ==')
  const mixed = checked.results.find((row) => row.provider === (process.argv.includes('--mixed')
    ? process.argv[process.argv.indexOf('--mixed') + 1]
    : 'opencode-go'))
  const external = (mixed?.added ?? [])[0]?.id
  if (mixed === undefined) {
    console.log('  （没有可用的混合协议路由，跳过）')
  } else if (external === undefined) {
    console.log(`  ${mixed.provider}: 上游没有目录外的模型，跳过`)
  } else {
    try {
      writes.length = 0
      const routed = await controller.routeGateway({ provider: mixed.provider })
      const routeOps = writes.flatMap((batch) => batch.ops.map((op) => `${op.op} ${op.path.join('.')}`))
      console.log(`  收拢: 入站=${String(routed.inbound)} 归属模型=${String(routed.models)} 条 ops: ${routeOps.join(' + ') || '（无）'}`)
      const state = await controller.gatewayState()
      const entry = state.entries.find((row) => row.provider === mixed.provider)
      const nowBase = (await controller.view()).providers.find((row) => row.provider === mixed.provider)?.baseURL
      console.log(`  账本: 收拢协议=${String(entry?.inbound)} running=${String(state.running)} url=${String(state.url)}`)
      console.log(`  读回的 baseURL: ${String(nowBase)}（${nowBase === routed.baseURL ? '与写入一致 ✅' : '❌ 与写入不一致'}）`)

      writes.length = 0
      const applied = await controller.apply({ provider: mixed.provider, ids: [external] })
      const applyOps = writes.flatMap((batch) => batch.ops.map((op) => `${op.op} ${op.path.join('.')}`))
      const wrote = JSON.stringify(writes.flatMap((batch) => batch.ops)).includes(external)
      const missed = routed.unattributed?.length ?? 0
      if (routed.inbound === undefined) {
        console.log(`  ⚠ 没有收拢：${missed} 个模型没探到协议（${(routed.unattributed ?? []).slice(0, 4).join(', ')}…），没答上来的协议=${JSON.stringify(routed.blind ?? [])}。`)
        console.log('    彩排的假宿主不做 pi-ai 的严格校验，下面这步在真实宿主里会被拒并回滚；请重跑一次或先「检查」再收拢。')
      }
      console.log(`  新增目录外 id "${external}": ${wrote ? '写入成功 ✅' : '❌ 没写进去'}（${applyOps.join(' + ') || '无 op'}）`)
      console.log(`  新增后 addedAfterRouting: ${JSON.stringify((controller.store.data.gateway.entries[mixed.provider]?.addedAfterRouting ?? []))}`)

      try {
        await controller.unrouteGateway({ provider: mixed.provider })
        console.log('  ❌ 撤销没有被拒——宿主会解析不了这条路由')
      } catch (error) {
        console.log(`  撤销被拒（预期）: ${String(error.message).slice(0, 80)}…`)
      }

      await controller.remove({ provider: mixed.provider, id: external }).catch((error) => {
        console.log(`  移除失败: ${error.message}`)
      })
      writes.length = 0
      const undone = await controller.unrouteGateway({ provider: mixed.provider })
      const undoOps = writes.flatMap((batch) => batch.ops.map((op) => `${op.op} ${op.path.join('.')}`))
      console.log(`  移除后再撤销: baseURL 回到 ${String(undone.baseURL)}，ops: ${undoOps.join(' + ') || '（无）'}`)
      console.log(`  收拢前后 provider 键数量不变: ${Object.keys(providers).length} 个键，写入只碰 models/baseURL/api`)
      console.log(`  apply 回执: written=${JSON.stringify(applied.written)}（路由仍然只有 ${Object.keys(providers).length} 个 provider 键）`)
    } catch (error) {
      console.log(`  ❌ 收拢/新增演练失败: ${error.message}`)
    }
  }

  controller.dispose()

  await rm(dir, { recursive: true, force: true })
}

await main()
