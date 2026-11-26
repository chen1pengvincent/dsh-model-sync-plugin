/**
 * Reading a fresh installation like a reviewer would.
 *
 * Everything here reads a description someone else produced — the panel's
 * `view`, the profile manifest, the plugin's own ledger — and says whether the
 * pieces agree. The point is to catch the failures that do not throw: a plugin
 * that loaded without its ledger, a route routed through a listener that never
 * started, a proxy table that lost the entry it promised to keep.
 *
 * `scripts/verify.mjs` is the thin IO layer; keeping the judgement here means
 * the rules can be tested against fixtures instead of a live host.
 */

/** Where a check's complaint came from, for grouping in the printed verdict. */
export const AREAS = ['install', 'state', 'providers', 'gateway', 'bili', 'schedule']

/**
 * @typedef {object} Finding
 * @property {string} area one of {@link AREAS}
 * @property {string} message what is wrong, in the user's words
 */

/**
 * @typedef {object} Verdict
 * @property {boolean} ok no failures
 * @property {Finding[]} failures problems that need a human
 * @property {Finding[]} warnings things worth knowing that are not broken
 * @property {string[]} notes what was inspected
 */

/** @returns {Verdict} */
function empty() {
  return { ok: true, failures: [], warnings: [], notes: [] }
}

/**
 * @param {Verdict} verdict
 * @param {string} area
 * @param {string} message
 */
function fail(verdict, area, message) {
  verdict.failures.push({ area, message })
}

/**
 * @param {Verdict} verdict
 * @param {string} area
 * @param {string} message
 */
function warn(verdict, area, message) {
  verdict.warnings.push({ area, message })
}

/** bili's lane port. A gateway bound here would collide with the proxy hop. */
import { BILI_ZONE_PORT } from './bili.js'

const BILI_PORT = BILI_ZONE_PORT

/**
 * Judge the panel's `view` — what the running host actually reports.
 *
 * @param {any} view the JSON body of `/model-sync/api/view`
 * @param {{now?: number}} [options]
 * @returns {Verdict}
 */
export function inspectView(view, options = {}) {
  const verdict = empty()
  if (view === null || typeof view !== 'object') {
    fail(verdict, 'providers', 'the host returned no view at all — the plugin is loaded but its controller did not answer')
    verdict.ok = false
    return verdict
  }

  const providers = Array.isArray(view.providers) ? view.providers : []
  const problems = Array.isArray(view.problems) ? view.problems : []
  verdict.notes.push(`${providers.length} 个已配置供应商`)

  if (providers.length === 0) {
    fail(verdict, 'providers', '一个已配置的供应商都没有：插件只管理你在官方设置里配好的路由，先在「设置 → 模型」里配一个')
  }

  for (const problem of problems) {
    const reason = String(problem?.reason ?? problem)
    if (problem?.provider === 'state') {
      fail(verdict, 'state', `账本没有被读入：${reason}`)
      continue
    }
    warn(verdict, 'providers', `${String(problem?.provider ?? '?')}: ${reason}`)
  }

  // --- gateway -------------------------------------------------------------
  const gateway = view.gateway ?? {}
  const entries = Array.isArray(gateway.entries) ? gateway.entries : []
  if (gateway.enabled === true && gateway.running !== true) {
    fail(verdict, 'gateway', '网关开关是开的，但监听器没在跑：走网关的路由会全部连不上')
  }
  if (gateway.running === true && gateway.port === BILI_PORT) {
    fail(verdict, 'gateway', `网关占用了 ${BILI_PORT}，那是 bili 车道的端口`)
  }
  if (gateway.running === true && entries.length === 0) {
    warn(verdict, 'gateway', '网关在跑但没有路由用它的协议')
  }
  if (entries.length > 0 && gateway.exit?.available === false) {
    warn(verdict, 'gateway', '网关在跑，但没检测到系统代理：需要代理的上游会直连')
  }
  const known = new Set(providers.map((row) => row?.provider))
  for (const entry of entries) {
    if (known.has(entry?.provider) !== true) {
      fail(verdict, 'gateway', `网关里还记着 "${String(entry?.provider)}"，但这条路由已经不在配置里了`)
    }
    if (entry?.inbound !== undefined && entry?.addedAfterRouting > 0) {
      verdict.notes.push(`${String(entry.provider)} 收拢为 ${String(entry.inbound)}，其中 ${String(entry.addedAfterRouting)} 个模型靠网关才存在`)
    }
  }
  if (entries.length > 0) verdict.notes.push(`${entries.length} 条路由经过网关`)

  // --- bili ---------------------------------------------------------------
  const bili = view.bili ?? {}
  if (bili.status === 'rejected') {
    fail(verdict, 'bili', `bili 拒绝了写进去的代理声明：${String(bili.error ?? '没有给出原因')}`)
  }
  if (bili.enabled !== false && Number(bili.written) > 0 && bili.found !== true) {
    fail(verdict, 'bili', '账本里记着写过的代理键，但找不到 bili 车道：那些键现在没有接管者')
  }
  if (bili.found === true) {
    verdict.notes.push(`bili 车道 ${String(bili.origin ?? '?')}，全局模式 ${String(bili.globalMode ?? '未知')}`)
    if (bili.enabled === false && String(bili.globalMode ?? '') !== 'direct' && Number(bili.written) > 0) {
      warn(verdict, 'bili', '插件这边的开关是关的，但 bili 自己的全局模式不是 direct —— 请求仍然会走代理')
    }
    for (const row of Array.isArray(bili.rows) ? bili.rows : []) {
      if (row?.present === false && row?.proxy !== undefined) {
        warn(verdict, 'bili', `${String(row.host)} 在 bili 配置里没有条目，这条会直连`)
      }
    }
  } else if (bili.enabled !== false) {
    warn(verdict, 'bili', '没检测到 bili 车道：需要代理的模型会由宿主自己出网，能不能通取决于它')
  }

  // --- schedule -----------------------------------------------------------
  const schedule = view.schedule ?? {}
  if (schedule.enabled === false) {
    warn(verdict, 'schedule', '定时检查是关的：上游发了新模型也不会有人发现')
  } else if (view.lastCheckAt === undefined) {
    warn(verdict, 'schedule', '还没检查过：面板里点一次「检查」看看上游有什么')
  }

  // --- legacy leftovers ---------------------------------------------------
  const legacy = Array.isArray(view.legacy) ? view.legacy : []
  if (legacy.length > 0) {
    warn(verdict, 'providers', `有 ${legacy.length} 条路由的名称符合旧版命名规则，请在 DSH 模型设置中核对归属和模型配置。`)
  }

  verdict.ok = verdict.failures.length === 0
  return verdict
}

/**
 * Judge what is on disk, without a running host.
 *
 * @param {object} options
 * @param {any} options.manifest the profile's `package.json`
 * @param {any} [options.state] the plugin's `state.json`
 * @param {any} [options.lane] bili's `billion-context.json`, when one was found
 * @param {string} options.source this checkout's absolute path
 * @param {string} options.packageName
 * @returns {Verdict}
 */
export function inspectFiles({ manifest, state, lane, source, packageName, activationError }) {
  const verdict = empty()
  const dependencies = manifest?.dependencies ?? {}
  const dependency = dependencies[packageName]
  const override = manifest?.pnpm?.overrides?.[packageName]
  const bundles = manifest?.dsh?.profile?.bundles
  const projection = manifest?.dsh?.desktop?.generationProjection?.plugins?.[packageName]

  if (typeof activationError === 'string' && activationError.length > 0) {
    // The host records an activation failure as a file because a throwing
    // optional plugin is silent in the Web host. If that file is still there,
    // the panel is missing for a stated reason -- say the reason.
    fail(verdict, 'install', `上一次激活失败，原因写在 activation-error.txt：${activationError.split('\n')[1] ?? activationError.split('\n')[0]}`)
  }

  if (manifest === undefined) {
    // The panel runs this inside the host, where the profile manifest is not
    // always readable (a bare test context, or a profile mid-rewrite). Say so
    // instead of claiming the install is broken; `scripts/verify.mjs` refuses
    // to run at all without a manifest for exactly that reason.
    verdict.notes.push('没有读到 profile 的 package.json，跳过安装检查')
  } else if (typeof dependency !== 'string') {
    fail(verdict, 'install', `profile 的 dependencies 里没有 ${packageName}`)
  } else if (dependency.startsWith('link:') === true && dependency !== `link:${source}`) {
    // A link to somewhere else is unambiguous: the host is loading other code
    // than the checkout this verdict is being produced from.
    fail(verdict, 'install', `dependencies 指向 ${dependency}，不是这个 checkout（${source}）`)
  } else if (dependency.startsWith('link:') !== true && dependency.startsWith('file:') !== true) {
    verdict.notes.push(`dependencies 是 ${dependency}（不是链接安装，插件可能来自一次打包）`)
  }
  if (manifest !== undefined && typeof override === 'string' && override !== dependency) {
    // override wins over dependencies on the next `pnpm install`.
    fail(verdict, 'install', `pnpm.overrides 还写着 ${override}：下次 pnpm install 会把它装回来`)
  }
  if (manifest !== undefined && Array.isArray(bundles) && bundles.includes(packageName) !== true) {
    fail(verdict, 'install', `dsh.profile.bundles 里没有 ${packageName}：宿主不会加载它`)
  }
  if (manifest !== undefined && projection === undefined) {
    warn(verdict, 'install', '没有 generation projection：桌面端下次重装可能会把旧版本装回来')
  } else if (projection?.generationId !== undefined) {
    verdict.notes.push(`generation ${String(projection.generationId)}`)
  }
  if (state === undefined) {
    // Nothing in the ledger is the honest answer to "did the host load me?": the
    // file is written on the first boot, so its absence means the plugin has
    // never run — installed, but not restarted into.
    verdict.notes.push('还没有 state.json：插件装好了，但宿主还没用它启动过（重启后才会有）')
  } else {
    if (state.version !== 1) {
      fail(verdict, 'state', `state.json 的 version 是 ${String(state.version)}，不是 1`)
    }
    if (Array.isArray(state.notices) && state.notices.length > 0) {
      warn(verdict, 'state', `账本里有 ${state.notices.length} 条提示，打开面板能看到`)
    }
    verdict.notes.push(`${Array.isArray(state.snapshots) ? state.snapshots.length : 0} 份快照`)
    const boot = state.selfCheck
    if (boot !== undefined) {
      // The stored verdict is the only proof that the loaded host ran this
      // code: the file cannot exist before the plugin's own `start()`.
      const at = new Date(String(boot.at))
      const when = Number.isNaN(at.getTime()) ? String(boot.at) : at.toLocaleString('zh-CN')
      verdict.notes.push(`上次启动自检：${boot.ok === true ? '✅ 通过' : `❌ ${Array.isArray(boot.failures) ? boot.failures.length : 0} 个问题`}（${when}）`)
      if (boot.ok !== true) {
        for (const row of (Array.isArray(boot.failures) ? boot.failures : []).slice(0, 4)) {
          fail(verdict, String(row?.area ?? 'boot'), String(row?.message ?? row))
        }
      }
    }
  }

  const written = state?.bili?.written
  const keys = Array.isArray(written) ? written.map((row) => (typeof row === 'string' ? row : row?.key)).filter(Boolean) : []
  if (keys.length > 0) {
    if (lane === undefined) {
      fail(verdict, 'bili', `账本记着 ${keys.length} 个代理键，但读不到 bili 配置`)
    } else {
      const providers = lane?.providers !== null && typeof lane?.providers === 'object' ? lane.providers : {}
      for (const key of keys) {
        const entry = providers[key]
        if (entry === undefined || typeof entry?.proxy !== 'string') {
          fail(verdict, 'bili', `bili 配置里没有 ${String(key)} 的代理条目：这条会直连`)
        }
      }
      verdict.notes.push(`bili 配置里 ${Object.keys(providers).length} 个 providers 键`)
    }
  }

  verdict.ok = verdict.failures.length === 0
  return verdict
}

/**
 * Merge two verdicts into one, keeping the order they were produced in.
 *
 * @param {...Verdict} verdicts
 * @returns {Verdict}
 */
export function merge(...verdicts) {
  const verdict = empty()
  for (const part of verdicts) {
    verdict.failures.push(...part.failures)
    verdict.warnings.push(...part.warnings)
    verdict.notes.push(...part.notes)
  }
  verdict.ok = verdict.failures.length === 0
  return verdict
}

/**
 * Render a verdict for a terminal: failures first, then warnings, then notes.
 *
 * @param {Verdict} verdict
 * @param {{width?: number}} [options]
 * @returns {string}
 */
export function format(verdict, options = {}) {
  const width = options.width ?? 60
  /** @type {string[]} */
  const lines = []
  const label = { install: '安装', state: '账本', providers: '供应商', gateway: '网关', bili: 'bili', schedule: '定时' }
  const wrap = (text) => {
    const words = text.split(/(?<=[，。；：、）])|\s+/u).filter(Boolean)
    /** @type {string[]} */
    const out = []
    let line = ''
    let widthSoFar = 0
    for (const word of words) {
      const size = [...word].length
      if (widthSoFar > 0 && widthSoFar + size > width) {
        out.push(line)
        line = ''
        widthSoFar = 0
      }
      line += word
      widthSoFar += size
    }
    if (line.length > 0) out.push(line)
    return out
  }
  for (const finding of verdict.failures) {
    const [first, ...rest] = wrap(finding.message)
    lines.push(`❌ [${label[finding.area] ?? finding.area}] ${first}`)
    for (const line of rest) lines.push(`   ${line}`)
  }
  for (const finding of verdict.warnings) {
    const [first, ...rest] = wrap(finding.message)
    lines.push(`⚠️  [${label[finding.area] ?? finding.area}] ${first}`)
    for (const line of rest) lines.push(`   ${line}`)
  }
  if (verdict.notes.length > 0) lines.push(`· ${verdict.notes.join(' · ')}`)
  lines.push(verdict.ok ? '✅ 没有发现会拦住你的问题' : `❌ ${verdict.failures.length} 个问题需要处理`)
  return lines.join('\n')
}
