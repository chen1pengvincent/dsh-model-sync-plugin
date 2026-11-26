/**
 * The behaviour behind the panel: check upstream, propose additions, write
 * them on request, and undo a write.
 *
 * Division of labour inside this plugin:
 *
 *   targets.js      which routes exist and what they serve today
 *   discovery.js    what the provider advertises (over its own endpoint)
 *   proxy.js        which exit a request should take
 *   plan.js         the smallest settings edit that closes the gap
 *   state.js        what to remember and how to back out
 *   controller.js   this file — ordering, failure containment, scheduling
 *
 * The invariant the whole design protects: **this plugin never creates a
 * provider key**. A check reads; an apply edits the `models` array of a route
 * the user already configured. That is why the Models page gains no card and
 * the composer gains no group, whatever the check finds.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import {
  BILI_ZONE_PORT, DEFAULT_PROXY_HOSTS, backupConfig, getConfig, locate as locateBili, putProviders, readConfigFile,
} from './bili.js'
import { EgressSupervisor } from './egress/supervise.js'
import { gatewayExit } from './egress/gateway.js'
import { probeProxy, proxyDisplay } from './egress/probe.js'
import { readLane } from './egress/execute.js'
import { listAll, listModels, protocolLadder } from './discovery.js'
import { PROTOCOLS } from './gateway/protocols.js'
import { diffModels, additionOp, removalOp, restoreOp } from './plan.js'
import { ProxyWatcher } from './proxy.js'
import { atPath, configuredProxyHosts, configuredTargets, describeSections, foreignProviderKeys, syntheticSiblings } from './targets.js'
import { Store } from './state.js'
import { displayCatalog, hiddenModels, updateVisibility } from './visibility.js'
import { endpointFor } from './endpoints.js'
import { metadataFor } from './models-dev.js'
import {
  METADATA_FIELDS, REVIEW_INPUTS, entryFieldFor, firstInput, inputMissing, isLedgerObject, metadataView,
  normalizeInput, normalizeReasoningEfforts, ordinaryReminderSignatures, reviewHistory, reviewInput,
  reviewModels, safeLedgerKey, validFieldValue,
} from './model-metadata.js'
import { nativeCatalog } from './native-catalog.js'
import { format, inspectFiles, inspectView, merge } from './verify.js'

/** This checkout, so the profile's `link:` dependency can be compared against it. */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The note `index.js` leaves when activation threw. Its presence means the panel
 * is missing for a stated reason, which is worth saying before anything else.
 * @param {string} dir state directory
 * @returns {string | undefined}
 */
function readActivationError(dir) {
  try {
    return readFileSync(join(dir, 'activation-error.txt'), 'utf8')
  } catch {
    return undefined
  }
}

/** Boot delay before the first automatic check: long enough that startup I/O wins. */
const BOOT_CHECK_DELAY_MS = 20_000

/** Update gateway exit health off the request path while a listener is running. */
const EXIT_REFRESH_MS = 15_000

/** A check older than this is refreshed on boot; a once-a-day schedule is the intent. */
const STALE_AFTER_MS = 12 * 60 * 60 * 1000

/** Scheduled checks refresh catalogs and eligible fields. Picker changes require a saved selection. */
const DEFAULT_SCHEDULE = { enabled: true, hour: 9 }

/** Per-provider budget for one listing attempt. */
const CHECK_TIMEOUT_MS = 12_000

function needsReviewFacts(check) {
  return check?.catalog?.length > 0 && (check.reviewFacts === undefined || check.routeIdentity === null)
}

/** Undo a one-model edit, including history entries displaced by the retention limit. */
function checkpointMetadataEdit(metadata, provider, id) {
  const hasProvider = Object.hasOwn(metadata.records, provider)
  const rows = hasProvider ? metadata.records[provider] : undefined
  const hasRecord = isLedgerObject(rows) && Object.hasOwn(rows, id)
  const previous = hasRecord ? structuredClone(rows[id]) : undefined
  const logs = metadata.logs.slice()
  return () => {
    metadata.logs = logs
    if (!hasProvider) delete metadata.records[provider]
    else if (!isLedgerObject(rows)) metadata.records[provider] = rows
    else if (hasRecord) rows[id] = previous
    else delete rows[id]
  }
}

/** Hosts that need no proxy regardless of the switch: the machine itself. */
const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0|.*\.local)$/i

/** Provider families whose listing endpoint is not OpenAI-shaped, by host. */
const HOST_HINTS = [
  { test: /generativelanguage\.googleapis\.com/i, hints: ['google-generative-ai'] },
  { test: /anthropic\.com/i, hints: ['anthropic-messages'] },
  { test: /kimi\.com\/coding/i, hints: ['anthropic-messages'] },
]

/** Raised when a second operation starts while one is already running. */
export class BusyError extends Error {
  constructor() {
    super('已有其他操作正在进行，请稍后重试。')
    this.name = 'BusyError'
    this.status = 409
    this.safe = true
    this.publicMessage = '已有其他操作正在进行，请稍后重试。'
  }
}

/** A failure the panel may show verbatim. */
function refuse(message, status = 409) {
  return Object.assign(new Error(message), { status, safe: true, publicMessage: message })
}

/**
 * Why an addition to a mixed-protocol route cannot be stored.
 *
 * pi-ai resolves a model's wire protocol from the installed catalog, falling
 * back to the route's `api`. A route whose catalog spans several protocols has
 * no single one to fall back to (`sharedCatalogApi` returns undefined), so an id
 * the catalog does not describe has no protocol at all and the profile fails to
 * resolve — the write is refused and, without this message, the user sees
 * `model "x" needs an api` with no way forward.
 *
 * The way forward is the gateway: it narrows the route to one protocol on the
 * DSH side and translates per model on the way out, which is the only shape
 * pi-ai can accept for a catalog it cannot describe.
 */
const CATALOG_ADDITIONS_REFUSED = '这条路由的上游讲不止一种协议，而宿主只能从内置目录里读出模型用哪种协议；'
  + '目录里没有的新模型因此身兼「无协议」而被拒绝写入。请先点「把这条路由交给网关」：'
  + '网关会把这条路由收拢成一种协议，再按模型翻译成上游的真实协议，之后就能加入。'
  + '（网关会把这些模型翻译成各自的上游协议；Gemini 协议也支持。）'

/**
 * Did this probe attempt fail because the upstream would not talk, or because it
 * answered something other than a listing?
 *
 * The difference decides whether "this id is in no listing" is evidence. A 404
 * or a non-Gemini body is the endpoint saying "not here"; a timeout, a TLS
 * error or a 503 says nothing at all.
 */
function isTransportFailure(reason) {
  // URLs are stripped first: a host or path that happens to contain "socket" or
  // "timeout" would otherwise turn a plain 404 into a "we never got an answer",
  // which blocks narrowing for no reason.
  const text = String(reason ?? '').replace(/https?:\/\/\S+/g, ' ')
  if (text.trim().length === 0) return false
  return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EHOSTUNREACH|EAI_AGAIN|ENOTFOUND|EPIPE|EADDRNOTAVAIL|socket|timed out|timeout|aborted|could not reach|no reply within|CONNECT to|answered 5\d\d/i.test(text)
}

function isCatalogRefusal(error) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /needs an api/i.test(message) || /installed catalog does not describe/i.test(message)
}

/** Whether a failed write lost a revision race rather than failing outright. */
function isConflict(error) {
  return error !== null && typeof error === 'object'
    && (error.name === 'SettingsConflictError' || String(error.code ?? '') === 'SETTINGS_CONFLICT')
}

/** The hostname of a baseURL, or undefined when it is not a URL at all. */
function safeHostname(baseURL) {
  try {
    return new URL(baseURL).hostname
  } catch {
    return undefined
  }
}

function isLocalEndpoint(baseURL) {
  if (typeof baseURL !== 'string' || baseURL.length === 0) return false
  try {
    return LOOPBACK.test(new URL(baseURL).hostname)
  } catch {
    return false
  }
}

// Let the transport validate the original proxy setting before it dials.
function listingProxy(proxy, baseURL) {
  return proxy?.enabled && proxy.available && !isLocalEndpoint(baseURL) ? proxy.url : undefined
}

/** Gateway settings writes are supported for the pi-ai provider table. */
function gatewayProviderPath(target) {
  const path = target.settingsPath.slice(0, -1)
  if (path.length !== 2 || path[0] !== 'providers' || path[1] !== target.provider) {
    throw refuse('the protocol gateway requires a configured provider table entry', 409)
  }
  return path
}

function currentGatewayProvider(settings, target) {
  const section = describeSections(settings).find(({ ns }) => ns === target.settingsNs)
  if (!section) throw refuse('could not read the settings section to verify the gateway write', 409)
  const providers = section?.value?.providers
  const live = providers && Object.hasOwn(providers, target.provider) ? providers[target.provider] : undefined
  return live && typeof live === 'object' && !Array.isArray(live) ? live : undefined
}

function gatewayAddress(row, port) {
  if (Number.isInteger(port) && port > 0 && port <= 65535) return `http://127.0.0.1:${port}/g/${row.routeId}`
}

function ownedGatewayPort(target, row, savedPort) {
  const written = Object.hasOwn(row, 'routedPort') ? row.routedPort : savedPort
  for (const port of [written, row.nextPort]) {
    const address = gatewayAddress(row, port)
    if (address !== undefined && target.configuredBaseURL === address) return port
  }
}

function restoredGatewayAddress(row, baseURL, api) {
  return baseURL === row.previousBaseURL && (row.inbound === undefined || api !== row.inbound)
}

/** Keep the guard for uncertain catalogs; a user can also remove a model in DSH settings. */
function remainingGatewayModels(target, row, models) {
  const tracked = row.addedAfterRouting ?? []
  if (!tracked.length) return tracked
  const catalog = Array.isArray(models) && models.length > 0 ? models
    : isDeepStrictEqual(models, target.modelEntries) ? target.effectiveModels : undefined
  const ids = catalog?.map((model) => typeof model === 'string' ? model : model?.id)
  if (!ids?.length || !ids.every((id) => typeof id === 'string' && id.length > 0)) return tracked
  const present = new Set(ids)
  return tracked.filter((id) => present.has(id))
}

function gatewayRestoreConfirmed(settings, target, row) {
  try {
    const live = currentGatewayProvider(settings, target)
    return Boolean(live && restoredGatewayAddress(row, live.baseURL, live.api) && !remainingGatewayModels(target, row, live.models).length)
  } catch {
    // An unreadable settings section cannot authorize forgetting the route.
    return false
  }
}

/** Protocol hints for a route whose configuration does not state one. */
function hintsFor(target) {
  for (const row of HOST_HINTS) {
    if (typeof target.baseURL === 'string' && row.test.test(target.baseURL)) return row.hints
  }
  return []
}

/** ISO timestamp for the panel. */
function stamp(at) {
  return at === undefined ? undefined : new Date(at).toISOString()
}

/** One-line message from anything that was thrown. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

export class Controller {
  /**
   * @param {any} ctx harness context
   * @param {object} options
   * @param {string} options.dir state directory
   * @param {any} [options.logger]
   * @param {typeof listModels} [options.list] listing implementation (defaults to the real one)
   */
  constructor(ctx, options) {
    this.ctx = ctx
    this.logger = options.logger
    this.store = new Store(options.dir)
    // Injectable so the check path can be exercised without a network.
    this.list = options.list ?? listModels
    // The gateway probe asks every protocol at once, which is the only way to
    // learn *which* protocol serves a given model id upstream.
    this.listAll = options.listAll ?? listAll
    this.nativeCatalog = options.nativeCatalog ?? nativeCatalog
    // Injected so gateway routing can be exercised without binding a socket.
    this.gateway = options.gateway
    this.proxyWatcher = options.proxyWatcher ?? new ProxyWatcher()
    // Optional so tests stay offline: the real activation passes this in, and
    // the fallback catalog is merely absent when it is not.
    this.modelsDevLoader = options.modelsDevLoader
    this.modelsDevCachePath = join(options.dir, 'models.dev.json')
    this.modelsDevIndex = undefined
    this.modelsDevInfo = undefined
    this.modelsDevPromise = undefined
    // Injected so bili integration can be exercised without a live lane.
    this.bili = {
      locate: options.bili?.locate ?? locateBili,
      readConfigFile: options.bili?.readConfigFile ?? readConfigFile,
      putProviders: options.bili?.putProviders ?? putProviders,
      getConfig: options.bili?.getConfig ?? getConfig,
      backup: options.bili?.backup ?? backupConfig,
    }
    this.busy = undefined
    this.egressProbe = options.egress?.probe ?? probeProxy
    this.egress = new EgressSupervisor({
      dir: options.egress?.dir ?? (process.env.DSH_MODEL_SYNC_EGRESS_DIR || join(homedir(), '.dsh', 'model-sync')),
      profile: resolve(options.dir),
      store: this.store,
      bili: this.bili,
      hosts: () => configuredProxyHosts(this.ctx, DEFAULT_PROXY_HOSTS),
      proxy: (options) => this.proxyState(options),
      probe: this.egressProbe,
      logger: this.logger,
    })
    /** Live gateway handle; `undefined` means the listener is not running. */
    this.gatewayHandle = undefined
    /** One-shot note for a successful metadata action that had no error. */
    this.metadataNotice = undefined
    /** @type {NodeJS.Timeout | undefined} */
    this.timer = undefined
    this.lifetime = new AbortController()
    this.disposed = false
  }

  /** Load state and arm the schedule. Safe to call once per activation. */
  async start() {
    this.stateReady = this.store.load()
    await this.stateReady
    this.stateReady = undefined
    if (this.disposed) return
    // Historical catalogs without a route identity can still appear in history.
    for (const check of Object.values(this.store.data.checks ?? {})) {
      if (check && check.routeIdentity === undefined) check.routeIdentity = null
    }
    // `runSelfCheck()` below is the one startup path that refreshes models.dev
    // and fills metadata. Running both would race two writers against the same
    // settings revision before the panel opens.
    this.armSchedule()
    this.egress.start()
    await this.restoreGateway().catch((error) => {
      this.logger?.warn?.(`model-sync: gateway restore failed: ${messageOf(error)}`)
    })
    if (this.disposed) return
    // The panel should open on the answer rather than on a button: after a
    // restart the first question is "did it load, and can it see my profile?".
    await this.runSelfCheck().catch((error) => {
      this.logger?.warn?.(`model-sync: boot self-check failed: ${messageOf(error)}`)
    })
    if (this.disposed) return
    const checkDue = this.bootCheckDue()
    // Older catalog snapshots did not preserve whether the listing or the
    // host supplied a field. Refresh their evidence before using it to grade.
    if (checkDue || Object.values(this.store.data.checks ?? {}).some(needsReviewFacts)) {
      const timer = setTimeout(() => {
        this.check({ reason: 'boot', evidenceOnly: !checkDue }).catch((error) => {
          this.logger?.warn?.(`model-sync: automatic check failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      }, BOOT_CHECK_DELAY_MS)
      if (typeof timer.unref === 'function') timer.unref()
      this.bootTimer = timer
    }
  }

  /**
   * Share overlapping loads. Manual checks and the boot self-check refresh
   * the public catalog even when an in-memory index already exists.
   */
  refreshModelsDev(options = {}) {
    if (this.modelsDevLoader === undefined) return Promise.resolve(undefined)
    if (this.modelsDevPromise !== undefined) return this.modelsDevPromise
    if (this.modelsDevIndex !== undefined && options.force !== true) return Promise.resolve(this.modelsDevIndex)
    this.modelsDevPromise = (async () => {
      try {
        const result = await this.modelsDevLoader({
          cachePath: this.modelsDevCachePath,
          force: options.force === true,
          signal: this.lifetime.signal,
        })
        if (this.disposed) return undefined
        this.modelsDevIndex = result.index
        this.modelsDevInfo = {
          fetchedAt: result.fetchedAt,
          stale: result.stale === true,
          error: typeof result.error === 'string' ? result.error : undefined,
        }
        const metadata = this.metadataState()
        metadata.fetchedAt = result.fetchedAt
        metadata.stale = result.stale === true
        metadata.error = this.modelsDevInfo.error
        await this.store.save()
        return result.index
      } catch (error) {
        if (this.disposed) return undefined
        const metadata = this.metadataState()
        metadata.error = error instanceof Error ? error.message : String(error)
        await this.store.save().catch(() => undefined)
        this.logger?.warn?.(`model-sync: models.dev unavailable: ${metadata.error}`)
        return undefined
      } finally {
        this.modelsDevPromise = undefined
      }
    })()
    return this.modelsDevPromise
  }

  /** Consume the one-shot note returned by the last metadata action. */
  takeMetadataNotice() {
    const notice = this.metadataNotice
    this.metadataNotice = undefined
    return notice
  }

  /** The persisted metadata namespace, created on first use for old state files. */
  metadataState() {
    const data = this.store.data
    if (data.metadata === null || typeof data.metadata !== 'object') {
      data.metadata = { records: {}, logs: [], fetchedAt: undefined, stale: false, error: undefined }
    }
    const metadata = data.metadata
    if (metadata.records === null || typeof metadata.records !== 'object') metadata.records = {}
    if (!Array.isArray(metadata.logs)) metadata.logs = []
    return metadata
  }

  /** One model's ledger row, created lazily. */
  metadataRecord(provider, id) {
    if (!safeLedgerKey(provider) || !safeLedgerKey(id)) {
      throw refuse('模型标识包含不支持的保留字符。', 400)
    }
    const records = this.metadataState().records
    if (!Object.hasOwn(records, provider) || !isLedgerObject(records[provider])) records[provider] = Object.create(null)
    const byProvider = records[provider]
    if (!Object.hasOwn(byProvider, id) || !isLedgerObject(byProvider[id])) byProvider[id] = {
      provider,
      id,
      firstSeenAt: Date.now(),
      pending: true,
      fields: {},
      log: [],
    }
    return byProvider[id]
  }

  /** Snapshot the settings document before a metadata write. */
  async snapshotMetadata(target, label) {
    return this.store.snapshot(
      `before-${label}-${target.provider}`,
      describeSections(this.ctx.get('settings')),
    )
  }

  /** Add one human-readable line to the tab's change log. */
  metadataLog(provider, id, message, extra = {}) {
    const metadata = this.metadataState()
    const record = this.metadataRecord(provider, id)
    const row = { at: Date.now(), provider, modelId: id, message, ...extra }
    metadata.logs.push(row)
    if (metadata.logs.length > 300) metadata.logs.splice(0, metadata.logs.length - 300)
    if (!Array.isArray(record.log)) record.log = []
    record.log.push(row)
    if (record.log.length > 40) record.log.splice(0, record.log.length - 40)
  }

  /**
   * Write one field and remember where it came from. The previous value is not
   * overwritten in the settings until a caller decides to write; this only
   * maintains the ledger's view of what *this plugin* put there.
   */
  metadataSetField(provider, id, field, value, source, confidence, extra = {}) {
    const record = this.metadataRecord(provider, id)
    const previous = record.fields[field]
    const same = previous !== undefined && previous.source === source && isDeepStrictEqual(previous.value, value)
    record.fields[field] = { value, source, confidence, at: Date.now(), ...extra }
    if (source !== 'models.dev' && record.rejected?.[field] !== undefined) delete record.rejected[field]
    if (!same) this.metadataLog(provider, id,
      extra.external === true ? '设置中手动修改' : source === 'official' ? '官方来源更新' : '自动补全', {
        field,
        from: previous?.value,
        to: value,
        source,
      })
    return !same
  }

  metadataView(targets) {
    return metadataView(targets, this.metadataState())
  }

  activeGatewayEntry(target) {
    const gateway = this.store.data.gateway
    const row = gateway?.entries?.[target.provider]
    return row && ownedGatewayPort(target, row, gateway.port) !== undefined ? row : undefined
  }

  listingRoute(target) {
    const routed = this.activeGatewayEntry(target)
    const original = routed?.upstreamBaseURL ?? routed?.previousBaseURL
    const baseURL = target.adapter === 'deepseek' ? original ?? target.listingBaseURL
      : endpointFor(typeof original === 'string' ? { ...target, baseURL: original } : target).baseURL
    // The persisted identity binds the evidence without storing the endpoint or credentials.
    const identity = createHash('sha256').update(JSON.stringify([
      target.key, target.provider, baseURL, target.adapter, target.api, target.apiEnv, target.apiKey,
      Object.entries(target.headers ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    ])).digest('hex')
    return { baseURL, identity }
  }

  currentCheck(target, identity) {
    const check = this.store.data.checks?.[target.provider]
    return check?.routeIdentity === undefined || check.routeIdentity === (identity ?? this.listingRoute(target).identity) ? check : undefined
  }

  reviewModels(target, ids) {
    const routeIdentity = this.listingRoute(target).identity
    return reviewModels(target, {
      routeIdentity,
      check: this.currentCheck(target, routeIdentity),
      records: this.store.data.metadata?.records?.[target.provider],
      gatewayOffline: Boolean(this.activeGatewayEntry(target)) && !this.gatewayHandle,
      modelsDevIndex: this.modelsDevIndex,
    }, ids)
  }

  reviewView(targets) {
    const models = targets.flatMap((target) => this.reviewModels(target))
    const data = this.store.data
    return {
      models,
      pendingCount: models.filter((model) => model.pending).length,
      history: reviewHistory(data.checks ?? {}, data.reviewHistory ?? [], data.metadata?.logs ?? []),
    }
  }

  refreshReviewIgnores(target) {
    const rows = this.store.data.metadata?.records?.[target.provider]
    const ignored = Object.entries(rows ?? {}).filter(([, row]) => row?.reviewDecision?.signatures?.length)
    if (ignored.length === 0) return
    const identity = this.listingRoute(target).identity
    const models = new Map(this.reviewModels(target, ignored.map(([id]) => id)).map((model) => [model.id, model]))
    for (const [id, record] of ignored) {
      const decision = record?.reviewDecision
      if (decision?.action !== 'ignore' || !decision.signatures?.length) continue
      const model = models.get(id)
      const current = decision.routeIdentity === identity && model ? ordinaryReminderSignatures(model) : []
      const signatures = decision.signatures.filter((signature) => current.includes(signature))
      if (signatures.length === 0) delete record.reviewDecision
      else if (signatures.length !== decision.signatures.length) record.reviewDecision = { ...decision, signatures }
    }
  }

  addReviewHistory(rows) {
    this.store.data.reviewHistory = [...(this.store.data.reviewHistory ?? []), ...rows].slice(-200)
  }

  async saveReview(options) {
    if (this.busy !== undefined || this.visibilityBusy) throw new BusyError()
    this.busy = 'metadata'
    try {
      if (!safeLedgerKey(options.provider) || !safeLedgerKey(options.id)) throw refuse('模型标识无效。', 400)
      const { targets } = await configuredTargets(this.ctx, options.provider)
      const target = targets.find((row) => row.provider === options.provider)
      const model = target && this.reviewModels(target, [options.id])[0]
      if (!model || model.routeKey !== options.routeKey || model.revision !== options.revision ||
          model.reviewRevision !== options.reviewRevision || model.fingerprint !== options.fingerprint) {
        throw refuse('模型信息已变化，请切换到最新资料后重新核对。', 409)
      }
      const entries = target.modelEntries
      const current = entries?.find((row) => row?.id === model.id)
      const updated = current && { ...current }
      const decision = options.decision
      const requested = options.changes
      const changes = []
      if (decision === 'ignore' || decision === 'keep') {
        if (requested !== undefined || !(decision === 'keep' ? model.keepable : model.pending)) {
          throw refuse('当前模型没有可处理的提醒。', 409)
        }
      } else {
        if (decision !== undefined || !requested || typeof requested !== 'object' || Array.isArray(requested)) throw refuse('请输入要保存的模型信息。', 400)
        if (!model.canWrite) throw refuse('当前模型没有可写的配置条目。', 409)
        for (const [field, change] of Object.entries(requested)) {
          if (!METADATA_FIELDS.includes(field) || !change || typeof change !== 'object') throw refuse('模型字段无效。', 400)
          const fromCandidate = change.useCandidate === true
          const fact = model.fields[field]
          if (fromCandidate && (change.candidateSource !== fact.candidateSource || fact.candidate === undefined ||
            !isDeepStrictEqual(change.value, fact.candidate))) {
            throw refuse('候选值或来源已变化，请重新选择并预览。', 409)
          }
          const source = fromCandidate ? fact.candidateSource : 'user'
          const raw = change.value
          const value = field === 'input' ? reviewInput(raw) : validFieldValue(field, raw)
          if (value === undefined || source === undefined || (field === 'input' && raw.some((item) => !REVIEW_INPUTS.includes(item)))) throw refuse('请检查所填写的模型字段。', 400)
          const key = entryFieldFor(target, field)
          const hostValue = field === 'input' ? normalizeInput(value) : value
          if (hostValue !== undefined) updated[key] = hostValue
          changes.push({ field, key, from: fact.observed ?? fact.value, value, source, hostValue })
        }
        if (changes.length === 0) throw refuse('没有待保存的模型字段。', 400)
        const changedLimits = changes.some(({field}) => field === 'contextWindow' || field === 'maxTokens')
        const context = updated.contextWindow ?? model.fields.contextWindow.value
        const output = updated.maxTokens ?? model.fields.maxTokens.value
        if (changedLimits && context > 0 && output > context) throw refuse('最大输出不能超过上下文窗口。', 400)
        if (changes.some(({field}) => field === 'maxTokens') && target.adapter === 'deepseek' && target.modelMaxTokens > 0 && output > target.modelMaxTokens) {
          throw refuse(`超过该路由的最大输出上限 ${target.modelMaxTokens}。`, 400)
        }
      }

      const settings = this.ctx.get('settings')
      const metadataBefore = structuredClone(this.store.data.metadata)
      const historyBefore = this.store.data.reviewHistory
      const nextEntries = changes.length && !isDeepStrictEqual(current, updated) ? entries.map((row) => row === current ? updated : row) : undefined
      let committedRevision
      if (nextEntries) {
        await this.snapshotMetadata(target, 'review')
        try {
          await settings.mutate(target.settingsNs, [{ op: 'set', path: target.settingsPath, value: nextEntries }], target.revision)
        } catch (error) {
          if (isConflict(error)) throw refuse('配置已变化，请刷新后重新保存。', 409)
          throw error
        }
        committedRevision = describeSections(settings).find(({ ns }) => ns === target.settingsNs)?.revision
      }
      try {
        const record = this.metadataRecord(model.provider, model.id)
        record.fields ??= {}
        record.reviewRevision = model.reviewRevision + 1
        if (decision === 'ignore') {
          const signatures = ordinaryReminderSignatures(model)
          record.reviewDecision = { action: 'ignore', routeIdentity: this.listingRoute(target).identity, signatures }
        }
        if (decision === 'keep') {
          for (const { kind, field } of model.issues) {
            if (kind !== 'conflict' || model.fields[field].locked) continue
            const value = validFieldValue(field, current?.[entryFieldFor(target, field)])
            if (value === undefined) continue
            const source = model.fields[field].observed !== undefined ? 'user' : model.fields[field].source ?? 'user'
            record.fields[field] = { value, source, confidence: 'high', at: Date.now(), reviewPinned: true }
          }
        }
        if (decision) {
          this.addReviewHistory([{ at: Date.now(), type: 'decision', provider: model.provider, model: model.id,
            title: decision === 'keep' ? '保留当前配置' : '忽略本次提醒' }])
        }
        for (const change of changes) {
          const { field, value, source, hostValue } = change
          const at = Date.now()
          if (field === 'input') record.reviewInput = { value, source, at }
          if (hostValue !== undefined) {
            record.fields[field] = { value: hostValue, source, confidence: source === 'models.dev' ? 'medium' : 'high', at, reviewPinned: source !== 'official' }
            if (record.rejected?.[field] !== undefined) delete record.rejected[field]
          }
          this.metadataLog(model.provider, model.id, '保存模型配置', { field, from: change.from, to: value, source })
        }
        await this.store.save()
      } catch (error) {
        this.store.data.metadata = metadataBefore
        this.store.data.reviewHistory = historyBefore
        if (nextEntries) await this.rollbackMetadataWrite(target, entries, nextEntries, committedRevision)
        throw error
      }
      return this.view()
    } finally {
      this.busy = undefined
    }
  }

  /**
   * Backfill explicit model lists once the public catalog is available. This is
   * deliberately fire-and-forget: a slow catalog must not delay the panel, and
   * a conflict is harmless because the next check retries.
   */
  async warmMetadata() {
    if (this.busy !== undefined) throw new BusyError()
    this.busy = 'metadata'
    try {
      const { targets } = await configuredTargets(this.ctx)
      const fields = { updated: 0, promoted: 0, adopted: 0 }
      let providers = 0
      for (const target of targets) {
        if (this.disposed) break
        try {
          const fresh = await this.freshTarget(target.provider, target.settingsNs)
          this.refreshReviewIgnores(fresh)
          await this.autoFillMetadata(fresh, fields)
          providers += 1
        } catch (error) {
          this.logger?.warn?.(`model-sync: metadata warm-up for ${target.provider} failed: ${messageOf(error)}`)
        }
      }
      return { updated: fields.updated, fields, providers }
    } finally {
      this.busy = undefined
    }
  }

  /**
   * Fill fields that are missing on a route that states its own model list.
   *
   * This is deliberately conservative:
   *  - a route that inherits the adapter catalog is never materialized here;
   *  - pinned values and user-set input capabilities are preserved;
   *    models.dev never replaces hand-written values;
   *  - models.dev only ever supplies values for an exact provider/model pair;
   *  - every write is a single revision-checked `set` of the whole model array.
   */
  async autoFillMetadata(target, totals) {
    if (!Array.isArray(target.modelEntries) || target.modelEntries.length === 0) return 0
    if (target.provider === 'deepseek-account' && target.settingsPath.length === 1) return 0
    const check = this.currentCheck(target)
    // A failed check inherits the previous catalog so the panel can keep
    // rendering it. Those rows are useful history, but they are not a fresh
    // official answer and must not overwrite a field during this run.
    const officialTrusted = check?.status === 'ok'
    const catalog = new Map((check?.catalog ?? []).map((model) => [model.id, model]))
    // The installed pi-ai catalog is a local source. It is read even
    // when the provider listing failed, because it can still describe a model's
    // input capability without any network answer.
    let nativeById = new Map()
    if (target.adapter !== 'deepseek') {
      try {
        const installed = await this.nativeCatalog(target.provider)
        nativeById = new Map((installed ?? []).map((model) => [model.id, model]))
      } catch {
        nativeById = new Map()
      }
    }
    this.lifetime.signal.throwIfAborted()
    const staged = []
    const metas = []
    let changed = false
    const entries = target.modelEntries.map((entry) => {
      if (entry === null || typeof entry !== 'object') return entry
      const id = String(entry.id ?? '')
      if (id.length === 0 || !safeLedgerKey(id)) return entry
      const official = officialTrusted ? catalog.get(id) : undefined
      const native = nativeById.get(id)
      const officialSource = official ?? (target.adapter === 'deepseek' ? undefined : native)
      const fallback = this.modelsDevIndex === undefined
        ? undefined
        : metadataFor(this.modelsDevIndex, target.provider, id)
      const record = this.metadataState().records?.[target.provider]?.[id]
      const next = { ...entry }
      const writes = []
      const clamp = (field, value) => (
        field === 'maxTokens' && target.adapter === 'deepseek' &&
        Number.isInteger(target.modelMaxTokens) && target.modelMaxTokens > 0 &&
        Number.isInteger(value)
          ? Math.min(value, target.modelMaxTokens)
          : value
      )
      for (const field of METADATA_FIELDS) {
        const fieldKey = entryFieldFor(target, field)
        const officialRaw = field === 'input'
          ? firstInput(official?.input, official?.inputModalities, native?.input, native?.inputModalities)
          : officialSource?.[field]
        const officialValue = validFieldValue(field, clamp(field, officialRaw))
        const fallbackValue = validFieldValue(field, clamp(field, fallback?.[field]))
        const current = entry[fieldKey]
        const previous = record?.fields?.[field]
        if (previous?.reviewPinned === true && isDeepStrictEqual(current, previous.value)) continue
        // A value that no longer matches what the ledger says this plugin
        // wrote was changed outside the panel (DSH settings, another tool).
        // It is a hand-written value now. The official source outranks all
        // user values by product decision, but the aggregator must not touch it.
        const manual = current !== undefined && previous !== undefined && !isDeepStrictEqual(current, previous.value)
        const external = previous?.external === true
        // `input` is a capability switch, not a measurement: a non-empty value
        // in settings is a user decision unless this plugin wrote that exact
        // value as a models.dev fallback. A later official answer may replace a
        // fallback, but never a hand-written `[text]`.
        const userInput = field === 'input' && !inputMissing(current) &&
          (previous === undefined || previous.source === 'user' || !isDeepStrictEqual(current, previous.value))
        let nextValue
        let source
        let confidence
        if (userInput) {
          // Adopt the hand-written capability so the tab reflects settings and
          // neither models.dev nor an official answer silently widens it.
          writes.push({ field, value: current, source: 'user', confidence: 'high', external: true, adopt: true })
          continue
        }
        if (officialValue !== undefined) {
          if (previous !== undefined && previous.source !== 'official' && isDeepStrictEqual(current, officialValue)) {
            // The value was already right, but it was credited to models.dev
            // or to the user. Promote the provenance without a settings write.
            writes.push({ field, value: officialValue, source: 'official', confidence: 'high', promote: true })
          } else if (!isDeepStrictEqual(current, officialValue)) {
            // Official wins, including over a hand-written DSH setting.
            nextValue = officialValue
            source = 'official'
            confidence = 'high'
          }
        } else if (manual || external) {
          // Adopt the hand-written value into the ledger so the tab shows what
          // is actually in settings. models.dev never overwrites it.
          writes.push({ field, value: current, source: 'user', confidence: 'high', external: true, adopt: true })
          continue
        } else {
          const absent = field === 'input' ? inputMissing(current) : current === undefined
          if (record?.rejected?.[field] === undefined &&
              (previous === undefined || previous.source === 'models.dev') &&
              absent && fallbackValue !== undefined) {
            nextValue = fallbackValue
            source = 'models.dev'
            confidence = fallback.confidence
          } else if (record?.rejected?.[field] === undefined &&
                     previous?.source === 'models.dev' && fallbackValue !== undefined &&
                     isDeepStrictEqual(current, previous.value) && !isDeepStrictEqual(current, fallbackValue)) {
            nextValue = fallbackValue
            source = 'models.dev'
            confidence = fallback.confidence
          }
        }
        if (nextValue === undefined && !writes.some((item) => item.field === field)) continue
        if (nextValue !== undefined) {
          writes.push({ field, value: nextValue, source, confidence })
          next[fieldKey] = nextValue
          if (!isDeepStrictEqual(nextValue, current)) changed = true
        }
      }
      if (writes.length === 0 && record === undefined) return entry
      if (writes.length > 0 || record !== undefined) {
        metas.push({
          id,
          name: official?.name ?? entry.name ?? id,
          family: fallback?.family,
          modality: fallback?.modality,
          canonical: fallback?.canonical,
          firstSeenAt: record?.firstSeenAt ?? Date.now(),
          upstreamCreatedAt: official?.createdAt ?? record?.upstreamCreatedAt,
        })
      }
      for (const write of writes) staged.push({ id, ...write })
      return next
    })
    if (staged.length === 0 && metas.length === 0) return 0
    const metadataBefore = structuredClone(this.store.data.metadata)
    const commit = async () => {
      for (const item of staged) {
        this.metadataSetField(target.provider, item.id, item.field, item.value, item.source, item.confidence,
          item.external === true ? { external: true } : {})
      }
      for (const meta of metas) {
        const record = this.metadataRecord(target.provider, meta.id)
        if (meta.name !== undefined && meta.name !== meta.id) record.name = meta.name
        if (meta.family !== undefined) record.family = meta.family
        if (meta.modality !== undefined) record.modality = meta.modality
        if (meta.canonical !== undefined) record.canonical = meta.canonical
        record.firstSeenAt ??= meta.firstSeenAt
        if (meta.upstreamCreatedAt !== undefined) record.upstreamCreatedAt = meta.upstreamCreatedAt
        const rows = Object.values(record.fields ?? {})
        record.pending = rows.length > 0 && rows.some((row) => row.source !== 'official')
      }
      await this.store.save()
    }
    const countCommitted = () => {
      if (!totals) return
      for (const item of staged) {
        const previous = metadataBefore?.records?.[target.provider]?.[item.id]?.fields?.[item.field]
        if (item.adopt === true) {
          if (previous?.source !== item.source || !isDeepStrictEqual(previous.value, item.value)) totals.adopted += 1
        } else if (item.promote === true) totals.promoted += 1
        else totals.updated += 1
      }
    }
    if (!changed) {
      try {
        await commit()
        countCommitted()
      } catch (error) {
        this.store.data.metadata = metadataBefore
        throw error
      }
      return 0
    }
    const before = target.modelEntries
    const settings = this.ctx.get('settings')
    await this.snapshotMetadata(target, 'metadata-autofill')
    this.lifetime.signal.throwIfAborted()
    try {
      await settings.mutate(target.settingsNs, [{
        op: 'set',
        path: [...target.settingsPath],
        value: entries,
      }], target.revision)
    } catch (error) {
      if (isConflict(error)) {
        const metadata = this.metadataState()
        metadata.logs.push({ at: Date.now(), provider: target.provider, modelId: '*', message: '并发修改导致自动补全跳过' })
        if (metadata.logs.length > 300) metadata.logs.splice(0, metadata.logs.length - 300)
        await this.store.save().catch(() => undefined)
        return 0
      }
      throw error
    }
    const committedRevision = describeSections(settings).find(({ ns }) => ns === target.settingsNs)?.revision
    try {
      await commit()
      countCommitted()
      return 1
    } catch (error) {
      this.store.data.metadata = metadataBefore
      await this.rollbackMetadataWrite(target, before, entries, committedRevision)
      throw error
    }
  }

  /**
   * Whether the start-up check is due.
   *
   * Two reasons not to: the ledger is fresh (a check on every launch would spend
   * the user's quota for nothing), or the daily timer is about to fire — the two
   * would race into the same `busy` slot and one of them would log a 409.
   */
  bootCheckDue(now = Date.now()) {
    const last = this.store.data.summary?.at
    if (last !== undefined && now - last <= STALE_AFTER_MS) return false
    const nextFire = this.nextScheduledAt(now)
    if (nextFire !== undefined && nextFire - now < 60_000) return false
    return true
  }

  dispose() {
    this.disposed = true
    this.lifetime.abort()
    if (this.timer !== undefined) clearTimeout(this.timer)
    if (this.bootTimer !== undefined) clearTimeout(this.bootTimer)
    return Promise.all([
      this.egress.stop(), this.stopGateway(),
      this.checkRun?.catch(() => undefined), this.selfCheckRun?.catch(() => undefined),
    ])
  }

  /**
   * When the daily timer will next fire, or `undefined` when it is off.
   * Local time on purpose: the hour is something the user typed on this clock.
   */
  nextScheduledAt(nowMs = Date.now()) {
    const schedule = this.store.data.schedule ?? DEFAULT_SCHEDULE
    if (schedule?.enabled !== true) return undefined
    const hour = Number.isInteger(schedule.hour) ? schedule.hour : 9
    const now = new Date(nowMs)
    const next = new Date(now)
    next.setHours(hour, 0, 0, 0)
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
    return next.getTime()
  }

  /** Arm the next daily check. Only one timer exists; each arm replaces it. */
  armSchedule() {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (this.disposed) return
    const at = this.nextScheduledAt()
    if (at === undefined) return
    const delay = at - Date.now()
    const timer = setTimeout(() => {
      this.check({ reason: 'schedule' })
        .catch((error) => {
          this.logger?.warn?.(`model-sync: scheduled check failed: ${error instanceof Error ? error.message : String(error)}`)
        })
        .finally(() => {
          if (this.disposed !== true) this.armSchedule()
        })
    }, Math.min(delay, 2_147_483_000))
    if (typeof timer.unref === 'function') timer.unref()
    this.timer = timer
  }

  /** The proxy this machine currently offers, and whether this plugin will use it. */
  async proxyState(options) {
    const detected = await this.proxyWatcher.current(options)
    // There is no separate switch and no manual URL: the plugin follows whatever
    // the machine's system proxy is, which is also what the bili lane reads. A
    // second source here used to exist and was never written by any UI, so it was
    // a knob that only looked like one.
    return {
      enabled: true,
      available: detected.url !== undefined,
      url: detected.url,
      source: detected.source,
      detail: detected.detail,
    }
  }

  /**
   * What bili currently has for those hosts. Read-only.
   *
   * `mode` and `rows` are what the panel shows: the whole point of this feature
   * is that the user can see the difference between "bili has no proxy for
   * Google" and "bili has one and it is stale".
   */
  async biliState(targets) {
    const saved = this.store.data.bili ?? {}
    const enabled = saved.enabled !== false
    /** @type {any} */
    const base = {
      enabled,
      status: saved.status,
      at: stamp(saved.at),
      error: saved.error,
      warning: enabled ? saved.warning : undefined,
      written: Array.isArray(saved.written) ? saved.written.length : 0,
    }
    const where = this.bili.locate()
    if (where === undefined) return { ...base, found: false, hosts: [], rows: [] }
    let lane
    try {
      lane = await readLane(this.bili, where)
    } catch {
      // Keep the existing status and row shape while the lane is unavailable.
      lane = undefined
    }
    const configured = new Set(targets.map((target) => safeHostname(target.baseURL)?.toLowerCase()))
    const hosts = DEFAULT_PROXY_HOSTS.filter((host) => configured.has(host.toLowerCase()))
    const providers = lane?.providers ?? {}
    const globalMode = typeof lane?.config.upstreamProxyMode === 'string' ? lane.config.upstreamProxyMode : undefined
    const owned = new Set((Array.isArray(saved.written) ? saved.written : []).map((entry) => entry?.key))
    return {
      ...base,
      found: true,
      origin: where.origin,
      pid: where.pid,
      configPath: where.configPath,
      globalMode,
      hosts,
      rows: hosts.map((host) => {
        const entry = /** @type {any} */ (providers)[`https://${host}`]
        const key = `https://${host}`
        return {
          host,
          key,
          proxy: typeof entry?.proxy === 'string' && entry.proxy.trim() !== ''
            ? proxyDisplay(entry.proxy) ?? '代理地址无效' : undefined,
          present: entry !== undefined,
          owned: owned.has(key),
        }
      }),
    }
  }

  async syncBili({ reason = 'manual' } = {}) {
    return this.egress.run(reason === 'settings' ? 'settings' : 'manual', reason)
  }

  async revokeBili({ reason = 'manual' } = {}) {
    return this.egress.run('revoke', reason)
  }

  /**
   * Ports the gateway must never bind. The compression lane answers model
   * traffic on its own port and refuses a tunnel aimed at itself, so binding
   * there would turn every request into a 403.
   */
  async reservedPorts() {
    const ports = new Set([BILI_ZONE_PORT])
    try {
      const where = await this.bili.locate()
      const port = where === undefined ? undefined : Number(new URL(where.origin).port)
      if (Number.isInteger(port) && port > 0) ports.add(port)
    } catch {
      // A missing lane only means the default reservation is all we know.
    }
    return [...ports]
  }

  /** Gateway bookkeeping for the panel. State and the live handle only. */
  async gatewayState(proxy) {
    const saved = this.store.data.gateway ?? {}
    const handle = this.gatewayHandle
    const exit = handle === undefined ? proxy ?? this.gatewayExit : this.gatewayExit
    return {
      enabled: saved.enabled === true,
      running: handle !== undefined && typeof handle.port === 'number',
      url: handle?.url,
      port: handle?.port,
      stats: handle?.stats?.(),
      // What the listener will do for hosts that need a proxy. Read from the
      // cached exit, so the panel can say "direct" honestly when the proxy app
      // is off — a routed provider that needs one would otherwise just hang.
      exit: exit === undefined
        ? undefined
        : {
          available: exit.available === true,
          url: exit.available === true ? exit.url : undefined,
          source: exit.source,
        },
      entries: Object.entries(saved.entries ?? {}).map(([provider, row]) => ({
        provider,
        routeId: row.routeId,
        at: stamp(row.at),
        models: Object.keys(row.models ?? {}).length,
        previousBaseURL: row.previousBaseURL,
        // A narrowed route answers one protocol on the way in and is translated
        // per model on the way out; saying so is what makes the panel's "why
        // did my model list change" question answerable.
        inbound: row.inbound,
        addedAfterRouting: (row.addedAfterRouting ?? []).length,
        // Non-zero means the probe could not name a protocol for that many of
        // the route's own models, which is why the route was left un-narrowed.
        unattributed: (row.unattributed ?? []).length,
        // Protocols the probe could not reach at all; when this is non-empty the
        // un-narrowed route is a "try again later", not a permanent state.
        blind: row.blind ?? [],
      })),
    }
  }

  /**
   * How this particular upstream wants to be authenticated.
   *
   * A route that speaks `anthropic-messages` is not necessarily an Anthropic
   * deployment: opencode serves that protocol behind a bearer token, and the
   * encoder's `x-api-key` gets a 401. So the route states its own auth, and the
   * server applies it after the encoder.
   *
   * @param {any} target a configured route
   * @returns {Record<string, string> | undefined}
   */
  authHeadersFor(target) {
    const key = typeof target.apiKey === 'string' && target.apiKey.length > 0 ? target.apiKey : undefined
    if (key === undefined) return undefined
    const api = target.api ?? 'openai-completions'
    if (api === 'anthropic-messages') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    if (api === 'google-generative-ai') return { 'x-goog-api-key': key }
    return { authorization: `Bearer ${key}` }
  }

  /** Rebuild the runtime route table with fresh credentials from the host. */
  async refreshGatewayRoutes() {
    const { targets } = await configuredTargets(this.ctx)
    /** @type {Map<string, any>} */
    const routes = new Map()
    for (const [provider, row] of Object.entries(this.store.data.gateway?.entries ?? {})) {
      const target = targets.find((candidate) => candidate.provider === provider)
      if (target === undefined) continue
      // `target.baseURL` becomes this gateway once the route is written, so the
      // upstream is remembered on the entry: reading the live value here would
      // point the gateway at itself on the next refresh — and would also hide
      // the host-specific headers below.
      const upstreamBaseURL = typeof row.upstreamBaseURL === 'string'
        ? row.upstreamBaseURL
        : row.previousBaseURL ?? target.baseURL
      // During initial routing the settings still point at the recorded upstream.
      // After a manual redirect, keep the journal for recovery without pairing
      // the new settings' credentials with the old upstream.
      if (target.baseURL !== upstreamBaseURL && !this.activeGatewayEntry(target)) continue
      /**
       * opencode answers `400 MissingSessionID` to anything without this header,
       * and a rewritten baseURL means the harness never sends it. Stable per
       * route so the provider can attribute requests to one session.
       */
      const host = typeof upstreamBaseURL === 'string' ? safeHostname(upstreamBaseURL) : undefined
      const session = host !== undefined && /(^|\.)opencode\.ai$/.test(host)
        ? { 'x-opencode-session': row.session ?? `model-sync-${target.key}` }
        : {}
      routes.set(row.routeId, {
        tap: target.api,
        upstreamBaseURL,
        apiKey: target.apiKey,
        headers: target.headers,
        authHeaders: { ...session, ...(this.authHeadersFor(target) ?? {}) },
        models: new Map(Object.entries(row.models ?? {})),
      })
    }
    this.gatewayRoutesCache = routes
    return routes
  }

  /** Start the listener if it is not running yet. Writes nothing to settings. */
  async ensureGateway() {
    if (this.disposed) throw new Error('the controller was disposed')
    if (this.gatewayHandle !== undefined) return this.gatewayHandle
    // Two clicks (or a click during boot) would otherwise both pass the check
    // above, both bind a listener, and only the last would be reachable — an
    // orphan listener with no way to stop it.
    if (this.ensureRun !== undefined) return this.ensureRun
    this.ensureRun = this.#openGateway().finally(() => {
      this.ensureRun = undefined
    })
    return this.ensureRun
  }

  async #openGateway() {
    const routes = await this.refreshGatewayRoutes()
    if (routes.size === 0) throw refuse('no provider is routed through the gateway yet', 409)
    // Resolved once, then read synchronously per request: the server asks for an
    // exit on the hot path, and a stale-but-recent answer beats an await there.
    await this.refreshExit()
    const gateway = this.gateway ?? await import('./gateway/server.js')
    const handle = gateway.createGateway({
      // Called per request, so a route change never needs a restart.
      routes: () => this.gatewayRoutesCache,
      proxyFor: (host) => this.proxyForHost(host),
      hostNeedsProxy: (host) => DEFAULT_PROXY_HOSTS.includes(host),
      logger: this.logger,
    })
    const forbidden = await this.reservedPorts()
    if (this.disposed) throw new Error('the controller was disposed')
    try {
      await handle.start(this.store.data.gateway?.port ?? 0, forbidden)
      if (this.disposed) throw new Error('the controller was disposed')
      const saved = this.store.data.gateway
      if (saved.port !== handle.port) {
        // Older ledgers only recorded the shared port. Preserve that evidence
        // before saving the new listener port, including across partial repairs.
        const entries = Object.fromEntries(Object.entries(saved.entries).map(([provider, row]) => [
          provider, Object.hasOwn(row, 'routedPort') ? row : { ...row, routedPort: saved.port ?? null },
        ]))
        await this.recordGateway({ port: handle.port, entries })
      } else {
        await this.recordGateway({ port: handle.port })
      }
      if (this.disposed) throw new Error('the controller was disposed')
    } catch (error) {
      await handle.stop?.()
      throw error
    }
    this.gatewayHandle = handle
    // The exit is read synchronously per request, so it has to be kept fresh
    // while the listener lives: the proxy app may be turned on (or move ports)
    // long after the gateway started.
    this.armExitRefresh()
    return handle
  }

  /** Keep the synchronous per-request exit decision current. */
  armExitRefresh() {
    if (this.exitTimer !== undefined) return
    const timer = setInterval(() => {
      this.refreshExit().catch(() => undefined)
    }, EXIT_REFRESH_MS)
    if (typeof timer.unref === 'function') timer.unref()
    this.exitTimer = timer
  }

  /** Re-read the machine's proxy so per-request egress decisions stay current. */
  async refreshExit() {
    if (this.exitRefresh !== undefined) return this.exitRefresh
    this.exitRefresh = (async () => {
      const proxy = await this.proxyState({ fresh: true })
      const next = await gatewayExit(proxy, this.egressProbe, this.store.data.bili?.supervisor !== false)
      if (this.gatewayExit?.available !== next.available) {
        this.logger?.info?.(`[egress] gateway: ${next.available ? 'proxy available' : next.reason ?? 'no proxy'}`)
      }
      this.gatewayExit = next
      return next
    })().finally(() => { this.exitRefresh = undefined })
    return this.exitRefresh
  }

  proxyForHost(host) {
    const exit = this.gatewayExit
    if (exit === undefined || exit.enabled !== true || exit.available !== true) return undefined
    return exit.url
  }

  async startGateway() {
    const handle = await this.ensureGateway()
    return { url: handle.url, port: handle.port }
  }

  async stopGateway() {
    if (this.ensureRun) await this.ensureRun.catch(() => undefined)
    const handle = this.gatewayHandle
    this.gatewayHandle = undefined
    if (this.exitTimer !== undefined) {
      clearInterval(this.exitTimer)
      this.exitTimer = undefined
    }
    if (handle !== undefined) await handle.stop?.()
    return { running: false }
  }

  /**
   * Bring the gateway back up on boot.
   *
   * A routed provider's `baseURL` lives in the user's settings, so it survives a
   * restart; the listener does not. Leaving the two out of sync would make every
   * request to that provider fail with a connection refused and no explanation,
   * so this either restarts the listener (and re-points baseURLs at the port it
   * actually got) or puts the baseURLs back and says why.
   */
  async restoreGateway() {
    const entries = this.store.data.gateway?.entries ?? {}
    if (Object.keys(entries).length === 0) return
    try {
      const handle = await this.ensureGateway()
      if (this.disposed) return
      await this.reconcileGatewayPort(handle.port)
    } catch (error) {
      if (this.disposed) return
      this.logger?.warn?.(`model-sync: the gateway did not start: ${messageOf(error)}`)
      await this.revertRoutedBases('the gateway did not start, so the routes were put back')
    }
  }

  /** Revalidate the route on each revision attempt, including the first. */
  async writeGatewayRoute(target, fields, restoring) {
    const path = gatewayProviderPath(target)
    const settings = this.ctx.get('settings')
    return this.write(target.settingsNs, () => {
      const live = currentGatewayProvider(settings, target)
      const narrowing = fields.api !== undefined && target.api === undefined
      if (!live || live.baseURL !== target.configuredBaseURL || live.api !== target.api
        || (narrowing && !isDeepStrictEqual(live.models, target.modelEntries))
        || (restoring && remainingGatewayModels(target, restoring, live.models).length)) {
        throw refuse('the configured provider or its gateway settings changed during this operation', 409)
      }
      return Object.entries(fields).map(([key, value]) => value === undefined
        ? { op: 'unset', path: [...path, key] }
        : { op: 'set', path: [...path, key], value })
    }, target.revision)
  }

  async recordGatewayPorts(provider, routedPort, nextPort) {
    const entries = this.store.data.gateway.entries
    await this.recordGateway({ entries: { ...entries, [provider]: { ...entries[provider], routedPort, nextPort } } })
  }

  async restoreGatewayFields(target, row) {
    const settings = this.ctx.get('settings')
    const live = currentGatewayProvider(settings, target)
    if (!live || live.baseURL !== target.configuredBaseURL || live.api !== target.api) {
      throw refuse('the configured provider or its gateway settings changed during this operation', 409)
    }
    const added = remainingGatewayModels(target, row, live.models)
    if (added.length > 0) {
      throw refuse(
        `这条路由里的 ${added.join(', ')} 是在收拢协议之后加进来的：它们本来由上游按各自协议服务，现在只有网关会翻译。撤销网关前请先在设置里把它们从这条路由移除，否则它们会被当成 ${String(row.inbound ?? '入站')} 直接打到上游。`,
        409,
      )
    }
    if (restoredGatewayAddress(row, live.baseURL, live.api)) return
    if (ownedGatewayPort(target, row, this.store.data.gateway.port) === undefined) {
      throw refuse('this route no longer points at the gateway; check the route in Settings', 409)
    }
    const fields = { baseURL: row.previousBaseURL }
    if (row.inbound !== undefined && target.api === row.inbound) fields.api = row.previousApi
    try {
      await this.writeGatewayRoute(target, fields, row)
    } catch (error) {
      const live = currentGatewayProvider(this.ctx.get('settings'), target)
      if (!live || !Object.entries(fields).every(([key, value]) => live[key] === value)) throw error
    }
  }

  /**
   * The kernel may hand us a different port than last time. If it did, the
   * persisted baseURLs point at a port nothing listens on, so they are rewritten
   * to the one that is live.
   */
  async reconcileGatewayPort(port) {
    const url = `http://127.0.0.1:${String(port)}`
    const entries = this.store.data.gateway?.entries ?? {}
    if (Object.keys(entries).length === 0) return
    const { targets } = await configuredTargets(this.ctx)
    const settings = this.ctx.get('settings')
    const restored = []
    /** @type {string | undefined} */
    let snapshot
    for (const [provider, row] of Object.entries(entries)) {
      const target = targets.find((candidate) => candidate.provider === provider)
      if (target === undefined) continue
      if (restoredGatewayAddress(row, target.configuredBaseURL, target.api)) {
        restored.push([target, row])
        continue
      }
      const wanted = `${url}/g/${row.routeId}`
      const owned = ownedGatewayPort(target, row, this.store.data.gateway.port)
      if (owned === undefined) continue
      if (target.configuredBaseURL === wanted) {
        if (row.nextPort !== undefined) await this.recordGatewayPorts(provider, port)
        continue
      }
      // The only settings write in this plugin that used to run without a
      // snapshot: the old port is about to be forgotten, so keep it somewhere.
      snapshot ??= await this.store.snapshot('before-gateway-port', describeSections(settings))
      await this.recordGatewayPorts(provider, owned, port)
      try {
        await this.writeGatewayRoute(target, { baseURL: wanted })
      } catch (error) {
        this.logger?.warn?.(`model-sync: could not re-point ${provider} at the gateway: ${messageOf(error)}`)
        continue
      }
      await this.recordGatewayPorts(provider, port)
    }
    if (restored.length && !this.busy) {
      const remaining = { ...this.store.data.gateway.entries }
      for (const [target, row] of restored) {
        if (remaining[target.provider] === row && gatewayRestoreConfirmed(settings, target, row)) delete remaining[target.provider]
      }
      if (Object.keys(remaining).length === Object.keys(this.store.data.gateway.entries).length) return
      await this.recordGateway({ entries: remaining })
      if (Object.keys(remaining).length === 0) await this.stopGateway()
      else await this.refreshGatewayRoutes()
    }
  }

  /** Put every routed baseURL back the way it was and forget the routes. */
  async revertRoutedBases(reason) {
    const entries = { ...(this.store.data.gateway?.entries ?? {}) }
    if (Object.keys(entries).length === 0) return
    /** @type {string[]} */
    const unreverted = []
    const restored = []
    const { targets } = await configuredTargets(this.ctx)
    for (const [provider, row] of Object.entries(entries)) {
      const target = targets.find((candidate) => candidate.provider === provider)
      if (target === undefined) {
        unreverted.push(`${provider}: the configured route could not be read`)
        continue
      }
      // The entry is the only memory of the original baseURL. Dropping it on a
      // failed write would leave the route pointed at a gateway that is about to
      // stop, with nothing left to restore from.
      const failure = await this.restoreGatewayFields(target, row).then(
        () => undefined,
        (error) => messageOf(error),
      )
      if (failure === undefined) {
        restored.push([target, row])
        continue
      }
      unreverted.push(`${provider}: ${failure}`)
    }
    const settings = this.ctx.get('settings')
    for (const [target, row] of restored) {
      if (gatewayRestoreConfirmed(settings, target, row)) delete entries[target.provider]
      else unreverted.push(`${target.provider}: could not verify the restored gateway settings`)
    }
    const status = unreverted.length === 0 ? 'reverted' : 'revert-failed'
    const reasonText = unreverted.length === 0 ? reason : `${String(reason)} (${unreverted.join('; ')})`
    await this.recordGateway({ entries, status, reason: reasonText }).catch((error) => this.logger?.warn?.(messageOf(error)))
    await this.refreshGatewayRoutes().catch(() => undefined)
    await this.stopGateway().catch(() => undefined)
  }

  /** Remember the gateway's own port so a restart reuses it instead of drifting. */
  async recordGateway(patch) {
    const previous = this.store.data.gateway
    const next = { ...previous, ...patch }
    this.store.data.gateway = next
    try {
      await this.store.save()
    } catch (error) {
      if (this.store.data.gateway === next) this.store.data.gateway = previous
      throw error
    }
  }

  /**
   * Point one route at the gateway.
   *
   * Only the route's `baseURL` is written; the credential the user configured
   * stays where it is (`apiKeyEnv` untouched, and the gateway forwards the
   * authorization header it receives). The previous value is remembered, so
   * this is a two-way door rather than a one-way edit.
   *
   * @param {object} options
   * @param {string} options.provider
   */
  async routeGateway(options) {
    if (this.busy !== undefined) throw new BusyError()
    this.busy = 'gateway-route'
    try {
      const settings = this.ctx.get('settings')
      const { targets } = await configuredTargets(this.ctx, options.provider)
      const target = targets.find((row) => row.provider === options.provider)
      if (target === undefined) throw refuse(`provider "${options.provider}" is not configured`, 400)
      gatewayProviderPath(target)
      if (typeof target.baseURL !== 'string' || target.baseURL.length === 0) {
        throw refuse('this route declares no baseURL, so there is no upstream to put behind the gateway', 409)
      }
      // Asked before the loopback check: once routed, the baseURL *is* this
      // machine, and "already routed" is the message that explains why.
      if ((this.store.data.gateway?.entries ?? {})[target.provider] !== undefined) {
        throw refuse('this provider is already routed through the gateway', 409)
      }
      if (isLocalEndpoint(target.baseURL) === true) {
        throw refuse('this route already points at this machine; pointing it at the gateway would make it talk to itself', 409)
      }

      const proxy = await this.proxyState()
      const exit = listingProxy(proxy, target.baseURL)
      const candidates = protocolLadder({
        configured: target.api,
        remembered: this.store.data.ladder?.[target.provider],
        hints: hintsFor(target),
      })
      // Which protocol serves which id is the one thing only the upstream can
      // answer, and it is asked once, here, not on every request.
      const probe = await this.listAll({
        baseURL: target.baseURL,
        candidates,
        apiKey: target.apiKey,
        headers: target.headers,
        proxy: exit,
        timeoutMs: CHECK_TIMEOUT_MS,
        prefer: target.api === undefined ? [] : [target.api],
      })
      /** @type {Record<string, string>} */
      const models = {}
      for (const [id, api] of probe.attribution) models[id] = api
      if (Object.keys(models).length === 0) {
        throw refuse('the upstream answered a listing with no models, so there is nothing to route', 409)
      }

      const routeId = target.provider
      /**
       * A route whose upstream speaks several protocols has no single `api`, so
       * pi-ai cannot resolve any id the catalog does not describe (it reports
       * `model "X" needs an api` and refuses the whole profile). Stating one
       * protocol here and translating per model is what makes such an id
       * storable at all — so the gateway route is also a protocol narrowing.
       */
      const inboundProtocols = new Set(Object.values(models))
      /**
       * Narrowing states one protocol for the *whole* route, so every model the
       * route currently serves has to be one the gateway can name. A probe that
       * timed out on one dialect would otherwise look like "this route only
       * speaks completions" and quietly break the models it missed.
       */
      const unattributed = target.effectiveIds.filter((id) => models[id] === undefined)
      /**
       * "This id is in no listing" means two very different things depending on
       * whether the listings were actually reachable. A protocol that answered
       * 404 answered the question — it does not serve these ids. A protocol that
       * timed out answered nothing, and narrowing on a partial picture is how a
       * working model silently becomes one that 400s.
       */
      const blind = (probe.attempts ?? []).filter((attempt) => attempt.ok !== true && isTransportFailure(attempt.reason))
      /**
       * Stating one `api` makes every request on this route that one protocol,
       * so it is only safe when the gateway can translate all of them. A route
       * serving a protocol this build has no codec for keeps `api` unset and
       * passes requests through instead.
       */
      const translatable = [...inboundProtocols].every((api) => PROTOCOLS.includes(api))
      // Unattributed ids only block narrowing when some protocol never answered;
      // ids no listing mentions are ones the upstream does not serve at all.
      const lock = target.api === undefined
        && inboundProtocols.size > 1
        && translatable
        && (unattributed.length === 0 || blind.length === 0)
        ? 'openai-completions'
        : undefined
      const entry = {
        provider: target.provider,
        routeId,
        routedPort: null,
        upstreamBaseURL: target.baseURL,
        previousBaseURL: target.configuredBaseURL,
        ...(lock === undefined ? {} : { inbound: lock, previousApi: target.api }),
        ...(unattributed.length === 0 ? {} : { unattributed: unattributed.slice(0, 12) }),
        ...(blind.length === 0 ? {} : { blind: blind.map((attempt) => attempt.api) }),
        models,
        at: Date.now(),
      }
      this.store.data.gateway = {
        ...(this.store.data.gateway ?? {}),
        entries: { ...(this.store.data.gateway?.entries ?? {}), [target.provider]: entry },
      }
      let keepListener = false
      try {
        const handle = await this.ensureGateway()
        const baseURL = `${handle.url}/g/${routeId}`
        await this.recordGatewayPorts(target.provider, handle.port)
        const snapshot = await this.store.snapshot('before-gateway-route', describeSections(settings))
        try {
          await this.writeGatewayRoute(target, { baseURL, ...(lock === undefined ? {} : { api: lock }) })
        } catch (error) {
          // A host may persist the edit and then fail to acknowledge it. Keep
          // serving that URL while the outcome is unknown or partially applied.
          keepListener = true
          const live = currentGatewayProvider(settings, target)
          keepListener = live?.baseURL === baseURL
          if (!keepListener || live.api !== (lock ?? target.api)) throw error
        }
        // The route now reads differently (baseURL, maybe api), and the server
        // compares each request against `tap`; leaving the cache stale would
        // mis-file every request until the next restart.
        await this.refreshGatewayRoutes().catch(() => undefined)
        return {
          provider: target.provider,
          baseURL,
          previousBaseURL: target.configuredBaseURL,
          inbound: lock,
          models: Object.keys(models).length,
          unattributed,
          blind: blind.map((attempt) => attempt.api),
          snapshot,
        }
      } catch (error) {
        if (keepListener) throw error
        const entries = { ...(this.store.data.gateway?.entries ?? {}) }
        delete entries[target.provider]
        this.store.data.gateway = { ...(this.store.data.gateway ?? {}), entries }
        try {
          await this.store.save()
        } finally {
          if (Object.keys(entries).length === 0) await this.stopGateway()
          await this.refreshGatewayRoutes().catch(() => undefined)
        }
        throw error
      }
    } finally {
      this.busy = undefined
    }
  }

  /** Undo `routeGateway` for one provider: restore the baseURL it had before. */
  async unrouteGateway(options) {
    if (this.busy !== undefined) throw new BusyError()
    this.busy = 'gateway-unroute'
    try {
      const settings = this.ctx.get('settings')
      const { targets } = await configuredTargets(this.ctx, options.provider)
      const target = targets.find((row) => row.provider === options.provider)
      const row = (this.store.data.gateway?.entries ?? {})[options.provider]
      if (row === undefined) throw refuse(`provider "${options.provider}" is not routed through the gateway`, 400)
      if (target === undefined) throw refuse(`provider "${options.provider}" is not configured`, 400)
      const snapshot = await this.store.snapshot('before-gateway-unroute', describeSections(settings))
      await this.restoreGatewayFields(target, row)
      if (!gatewayRestoreConfirmed(settings, target, row)) throw refuse('could not verify the restored gateway settings', 409)
      const entries = { ...(this.store.data.gateway?.entries ?? {}) }
      delete entries[options.provider]
      await this.recordGateway({ entries })
      if (Object.keys(entries).length === 0) await this.stopGateway()
      await this.refreshGatewayRoutes().catch(() => undefined)
      return { provider: options.provider, baseURL: row.previousBaseURL, snapshot }
    } finally {
      this.busy = undefined
    }
  }

  /**
   * Answer "is this installation working?" from the inside.
   *
   * The panel could not do the install half (it would have to read the
   * profile's manifest), and a terminal script cannot see what the loaded
   * plugin sees. Running both halves here means one click covers what used to
   * be seven manual checks in an acceptance list.
   *
   * @returns {Promise<{ok: boolean, failures: object[], warnings: object[], notes: string[]}>}
   */
  async selfCheck() {
    // Provider routes can still be settling when a restart reaches this point.
    // An empty first read used to be recorded as a permanent failure: every
    // later self-check read that verdict back through inspectFiles(), so the
    // panel stayed red even after the providers appeared. Give the routes a
    // short, bounded chance to load, and never carry the previous verdict into
    // the next one.
    let routes = await configuredTargets(this.ctx)
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (this.disposed || routes.targets.length > 0) break
      await new Promise((resolve) => setTimeout(resolve, 250))
      routes = await configuredTargets(this.ctx)
    }
    if (this.disposed) throw new Error('the controller was disposed')
    const profileDir = this.ctx.get('profileContext')?.dir
    /** @type {any} */
    let manifest
    if (typeof profileDir === 'string') {
      try {
        manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
      } catch {
        manifest = undefined
      }
    }
    /** @type {any} */
    let lane
    try {
      const where = this.bili.locate()
      if (where !== undefined) lane = await this.bili.readConfigFile(where.configPath)
    } catch {
      lane = undefined
    }
    // A self-check is also the "自查" button: it must read both libraries and
    // write what it learned, not just inspect the already-cached snapshot.
    let library = { updated: 0, fields: { updated: 0, promoted: 0, adopted: 0 }, providers: 0 }
    try {
      await this.refreshModelsDev({ force: true })
      if (this.disposed) throw new Error('the controller was disposed')
      library = await this.warmMetadata()
      routes = await configuredTargets(this.ctx)
    } catch (error) {
      library.error = messageOf(error)
    }
    if (this.disposed) throw new Error('the controller was disposed')
    const view = { ...await this.diagnostics(routes), providers: routes.targets }
    this.lifetime.signal.throwIfAborted()
    const info = this.modelsDevInfo
    const state = { ...this.store.data, selfCheck: undefined }
    const verdict = merge(
      inspectFiles({
        manifest,
        state,
        lane,
        source: PACKAGE_ROOT,
        packageName: 'dsh-model-sync',
        // An earlier activation failure is recorded as a file by `index.js`,
        // because a throwing optional plugin is silent in the Web host.
        activationError: readActivationError(this.store.dir),
      }),
      inspectView(view),
    )
    const syncedAt = info?.fetchedAt === undefined ? '本次未获取' : new Date(info.fetchedAt).toLocaleString('zh-CN')
    const syncNote = library.error === undefined
      ? `模型库同步：更新 ${library.updated} 个字段（${library.providers} 个供应商；models.dev ${syncedAt}${info?.stale === true ? '，缓存' : ''}）`
      : `模型库同步未完成：${library.error}`
    verdict.notes = [...(verdict.notes ?? []), syncNote]
    this.metadataState().lastSync = {
      at: Date.now(),
      reason: 'selfcheck',
      source: 'selfcheck',
      providers: library.providers,
      updated: library.updated,
      fields: library.fields,
      fetchedAt: info?.fetchedAt,
      stale: info?.stale === true,
      error: info?.error ?? library.error,
    }
    return verdict
  }

  /**
   * Run the self-check and keep its verdict in the ledger.
   *
   * Stored rather than computed per request: the panel asks for this every time
   * it mounts, and reading the lane config on every render would be wasted IO.
   * The text is stored too — it is a few hundred bytes and it means the panel
   * can show the same sentences the terminal prints.
   */
  async runSelfCheck() {
    this.lifetime.signal.throwIfAborted()
    // The boot run and a click on 「自检」 can overlap: the boot one is fired
    // without being awaited, so a fast user would otherwise store two verdicts
    // and show a first row that disagrees with the text under it. One run at a
    // time, and everyone awaiting it gets the same object.
    if (this.selfCheckRun !== undefined) return this.selfCheckRun
    this.selfCheckRun = this.#writeSelfCheck().finally(() => {
      this.selfCheckRun = undefined
    })
    return this.selfCheckRun
  }

  async #writeSelfCheck() {
    const verdict = await this.selfCheck()
    this.lifetime.signal.throwIfAborted()
    this.store.data.selfCheck = {
      at: new Date().toISOString(),
      ok: verdict.ok,
      failures: verdict.failures.slice(0, 8),
      warnings: verdict.warnings.slice(0, 8),
      text: format(verdict),
    }
    await this.store.save()
    return verdict
  }


  visibility() {
    return hiddenModels(this.store.data)
  }

  async displayModels() {
    return { groups: await displayCatalog(this.ctx), hidden: this.visibility() }
  }

  async setVisibility(changes) {
    if (this.visibilityBusy || this.busy === 'apply') throw new BusyError()
    if (!Array.isArray(changes) || changes.length === 0 || changes.some((row) =>
      typeof row?.provider !== 'string' || !row.provider || typeof row.id !== 'string' || !row.id || typeof row.visible !== 'boolean')) {
      throw refuse('请选择要显示或隐藏的模型。', 400)
    }
    this.visibilityBusy = true
    try {
      const groups = await displayCatalog(this.ctx)
      const available = new Set(groups.flatMap((row) => row.models.map(({ id }) => JSON.stringify([row.provider, id]))))
      if (changes.some(({ provider, id }) => !available.has(JSON.stringify([provider, id])))) {
        throw refuse('模型清单已变化，请刷新后重新保存。')
      }
      return { hidden: await this.persistVisibility(changes) }
    } finally {
      this.visibilityBusy = false
    }
  }

  async persistVisibility(changes) {
    const previous = this.visibility()
    const hidden = updateVisibility(this.store.data, changes)
    const historyBefore = this.store.data.reviewHistory
    const previousKeys = new Set(previous.map((pair) => JSON.stringify(pair)))
    this.addReviewHistory(changes.filter(({ provider, id, visible }) => visible === previousKeys.has(JSON.stringify([provider, id])))
      .map(({ provider, id, visible }) => ({ at: Date.now(), provider, model: id, type: 'selection', title: visible ? '显示到对话下拉框' : '从对话下拉框隐藏' })))
    this.store.data.hiddenModels = hidden
    try {
      await this.store.save()
      return hidden
    } catch (error) {
      if (this.store.data.hiddenModels === hidden) this.store.data.hiddenModels = previous
      this.store.data.reviewHistory = historyBefore
      throw error
    }
  }

  modelUsage() {
    const counts = new Map()
    const projections = this.ctx.get('sessionProjections')
    if (!projections?.snapshot) return counts
    for (const session of this.ctx.get('sessions')?.list?.() ?? []) {
      const selection = projections.snapshot(session, ['modelSelection']).values.modelSelection?.next
      if (!selection?.provider || !selection.model) continue
      const key = JSON.stringify([selection.provider, selection.model])
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }

  async diagnostics({ targets, problems }) {
    const proxy = await this.proxyState()
    return {
      proxy,
      bili: await this.biliState(targets),
      gateway: await this.gatewayState(proxy),
      legacy: this.legacySiblings(),
      schedule: this.store.data.schedule ?? DEFAULT_SCHEDULE,
      lastCheckAt: stamp(this.store.data.summary?.at),
      problems: [...problems, ...(this.store.data.notices ?? []).map((notice) => ({
        provider: 'state', reason: String(notice?.detail ?? notice),
      }))],
    }
  }

  async view() {
    const routes = await configuredTargets(this.ctx)
    const { targets } = routes
    const ignored = this.store.data.ignored ?? {}
    return {
      ...await this.diagnostics(routes),
      // Written by `runSelfCheck()` on boot and by the panel's 自检 button.
      selfCheck: this.store.data.selfCheck ?? undefined,
      summary: this.store.data.summary ?? undefined,
      hidden: this.visibility(),
      usage: [...this.modelUsage()],
      providers: targets.map((target) => {
        const check = this.currentCheck(target)
        const routed = (this.store.data.gateway?.entries ?? {})[target.provider]
        const entries = new Map((check?.catalog ?? []).map((model) => [model.id, model]))
        for (const model of target.modelEntries ?? []) {
          if (typeof model?.name === 'string') entries.set(model.id, model)
        }
        return {
          provider: target.provider,
          displayName: target.displayName,
          baseURL: target.baseURL,
          api: target.api,
          explicitModels: target.explicitModels,
          // A route carrying `modelOverrides` cannot also state a model list,
          // so the panel stops offering one instead of letting the write fail.
          hasModelOverrides: target.hasModelOverrides,
          catalogManaged: target.provider === 'deepseek-account' && target.settingsPath.length === 1,
          routedThroughGateway: routed !== undefined,
          eagerCount: target.effectiveIds.length,
          eagerIds: target.effectiveIds,
          modelNames: target.effectiveIds.flatMap((id) => {
            const model = entries.get(id)
            return model?.name && model.name !== id ? [[id, model.name]] : []
          }),
          key: target.key,
          check: check === undefined || (target.adapter === 'deepseek' && check.status === 'adapter')
            ? undefined
            : {
              at: stamp(check.at),
              status: check.status,
              protocol: check.protocol,
              via: check.via,
              lastSuccessAt: stamp(check.lastSuccessAt),
              complete: check.complete,
              upstreamNew: check.upstreamNew ?? [],
              upstreamChanged: check.upstreamChanged ?? [],
              upstreamCount: check.upstreamCount,
              added: check.added ?? [],
              catalog: check.catalog ?? [],
              gone: check.gone ?? [],
              error: check.error,
            },
          ignored: ignored[target.provider] ?? [],
        }
      }),
      foreign: foreignProviderKeys(this.ctx),
      metadata: this.metadataView(targets),
      review: this.reviewView(targets),
      snapshots: (await this.store.snapshots()).slice(0, 8).map((row) => row.name),
    }
  }

  /**
   * Ask every configured provider (or one) what it advertises, store the
   * comparison, and auto-fill blank metadata fields on explicit model lists.
   *
   * @param {object} [options]
   * @param {string} [options.provider] limit to one route
   * @param {string} [options.reason] 'manual' | 'boot' | 'schedule'
   * @param {boolean} [options.evidenceOnly] refresh legacy catalogs without applying metadata
   * @param {AbortSignal} [options.signal]
   */
  async check(options = {}) {
    this.lifetime.signal.throwIfAborted()
    if (this.busy !== undefined) throw new BusyError()
    this.busy = options.reason ?? 'manual'
    const signal = options.signal ? AbortSignal.any([options.signal, this.lifetime.signal]) : this.lifetime.signal
    this.checkRun = this.#runCheck({ ...options, signal }).finally(() => {
      this.checkRun = undefined
      this.busy = undefined
    })
    return this.checkRun
  }

  async #runCheck(options) {
    const { targets } = await configuredTargets(this.ctx, options.provider)
    const selected = options.evidenceOnly ? targets.filter(({ provider }) => needsReviewFacts(this.store.data.checks?.[provider])) : targets
    if (selected.length === 0) {
      if (options.evidenceOnly) return { results: [] }
      throw Object.assign(new Error(options.provider === undefined ? 'no provider is configured' : `provider "${options.provider}" is not configured`), {
        status: 400,
        safe: true,
        publicMessage: options.provider === undefined ? 'no provider is configured' : `provider "${options.provider}" is not configured`,
      })
    }

    // The button means "look at both libraries": the user explicitly asks
    // for a fresh models.dev answer, not whatever was cached at activation.
    if (!options.evidenceOnly) await this.refreshModelsDev({ force: true }).catch(() => undefined)
    this.lifetime.signal.throwIfAborted()
    const proxy = await this.proxyState()
    const results = []
    for (const target of selected) {
      this.lifetime.signal.throwIfAborted()
      results.push(await this.checkOne(target, { signal: options.signal, proxy }))
    }
    this.lifetime.signal.throwIfAborted()
    this.addReviewHistory(results.flatMap((row) => {
      const event = { at: row.at, provider: row.provider, type: 'check', status: row.status }
      if (row.status !== 'ok') return [{ ...event, title: row.status === 'no-endpoint' ? '缺少目录端点' : '目录检查失败' }]
      const added = row.upstreamNew ?? row.added?.map(({ id }) => id) ?? []
      return [{ ...event, title: `检查 ${row.upstreamCount} 个模型` }, ...added.slice(0, 12).map((model) => ({
        ...event, type: 'discovery', model, title: '发现目录模型',
      }))]
    }))
    if (options.evidenceOnly) {
      for (const target of selected) this.refreshReviewIgnores(target)
      await this.store.save()
      return { results }
    }

    // Fill metadata only after every provider answered, so one slow route does
    // not delay another route's check. Each write is revision-checked; a
    // conflict is skipped rather than replayed (the next check will retry).
    const fields = { updated: 0, promoted: 0, adopted: 0 }
    const incomplete = []
    for (const target of selected) {
      this.lifetime.signal.throwIfAborted()
      try {
        // Multiple providers share one settings namespace, so each write
        // advances the revision the next provider must use.
        const fresh = await this.freshTarget(target.provider, target.settingsNs)
        if (this.listingRoute(fresh).identity !== this.listingRoute(target).identity) {
          incomplete.push({ provider: target.provider, reason: '检查期间路由已变化，请重新检查' })
          continue
        }
        this.lifetime.signal.throwIfAborted()
        this.refreshReviewIgnores(fresh)
        await this.autoFillMetadata(fresh, fields)
      } catch (error) {
        incomplete.push({ provider: target.provider, reason: messageOf(error) })
        this.logger?.warn?.(`model-sync: metadata fill for ${target.provider} failed: ${messageOf(error)}`)
      }
    }
    this.lifetime.signal.throwIfAborted()
    const info = this.modelsDevInfo
    this.metadataState().lastSync = {
      at: Date.now(),
      reason: options.reason ?? 'manual',
      source: 'check',
      providers: selected.length,
      incomplete,
      updated: fields.updated,
      fields,
      fetchedAt: info?.fetchedAt,
      stale: info?.stale === true,
      error: info?.error,
    }

    const additions = results.reduce((total, row) => total + (row.status === 'ok' ? (row.added?.length ?? 0) : 0), 0)
    this.store.data.summary = {
      at: Date.now(),
      reason: options.reason ?? 'manual',
      providers: results.length,
      ok: results.filter((row) => row.status === 'ok').length,
      additions,
    }
    await this.store.save()
    return { results, summary: this.store.data.summary, sync: this.store.data.metadata?.lastSync }
  }

  /** Record the provider's result unless the controller is shutting down. */
  async checkOne(target, options) {
    const checks = this.store.data.checks ?? (this.store.data.checks = {})
    /** @type {any} */
    const previous = this.currentCheck(target)
    const record = {
      at: Date.now(),
      status: 'error',
      protocol: undefined,
      via: undefined,
      upstreamCount: 0,
      added: [],
      gone: [],
      error: undefined,
    }
    // A pi-ai route whose address lives on each catalog model (opencode and
    // opencode-go are the two installed here) gets its endpoint from the hints
    // table. When even that has nothing, the honest answer is "the plugin does
    // not know where to ask" — not a red failure, because the route itself may
    // be perfectly usable.
    const { baseURL, identity } = this.listingRoute(target)
    record.routeIdentity = identity
    if (baseURL === undefined) {
      record.status = 'no-endpoint'
      record.protocol = target.api
      checks[target.provider] = record
      const { routeIdentity, ...result } = record
      return { provider: target.provider, ...result }
    }

    const candidates = target.adapter === 'deepseek' ? ['deepseek-models'] : protocolLadder({
      configured: target.api,
      remembered: this.store.data.ladder?.[target.provider],
      hints: hintsFor(target),
    })
    const exit = listingProxy(options.proxy, baseURL)

    try {
      const listed = await this.list({
        baseURL,
        candidates,
        apiKey: target.apiKey,
        headers: target.headers,
        proxy: exit,
        timeoutMs: CHECK_TIMEOUT_MS,
        signal: options.signal,
      })
      this.lifetime.signal.throwIfAborted()
      const { added, gone } = diffModels({ upstream: listed.models, effective: target.effectiveIds })
      const ignored = new Set(this.store.data.ignored?.[target.provider] ?? [])
      record.protocol = listed.api
      record.via = listed.via
      record.upstreamCount = listed.models.length
      record.complete = listed.complete !== false
      record.reviewFacts = Object.fromEntries(listed.models.filter(({ id }) => safeLedgerKey(id)).flatMap((model) => {
        const value = {
          contextWindow: validFieldValue('contextWindow', model.contextWindow),
          maxTokens: validFieldValue('maxTokens', model.maxTokens),
          input: reviewInput(model.input ?? model.inputModalities),
          reasoningEfforts: normalizeReasoningEfforts(model.reasoningEfforts),
        }
        return Object.values(value).some((field) => field !== undefined) ? [[model.id, value]] : []
      }))
      // The provider listing is authoritative, but some routes omit a model's
      // input capability. The catalog shipped with the host knows the model it
      // actually runs, so merge only that missing capability into the official
      // row. Numbers and reasoning stay from the provider answer.
      const getNative = this.nativeCatalogForBatch(target.provider)
      const nativeIndex = target.adapter === 'deepseek' ? undefined : await getNative().catch(() => undefined)
      record.catalog = listed.models.map((model) => {
        const native = nativeIndex?.byId.get(model.id)
        const input = firstInput(model.input, model.inputModalities, native?.input, native?.inputModalities)
        return input === undefined ? model : { ...model, input }
      })
      const old = new Map((previous?.catalog ?? []).map((model) => [model.id, model]))
      if (previous?.complete === true && record.complete) {
        record.upstreamNew = listed.models.filter(({ id }) => !old.has(id)).map(({ id }) => id)
        record.upstreamChanged = listed.models.filter((model) => {
          const prior = old.get(model.id)
          if (!prior) return false
          // The saved catalog may include host input. Only reviewFacts records
          // what the upstream actually declared; older snapshots lack that evidence.
          if (previous.reviewFacts && !isDeepStrictEqual(previous.reviewFacts[model.id]?.input, record.reviewFacts[model.id]?.input)) return true
          if (!Object.hasOwn(prior, 'input') && !Object.hasOwn(model, 'input')) return !isDeepStrictEqual(model, prior)
          const { input, ...priorListing } = prior
          if (Object.hasOwn(model, 'input')) priorListing.input = model.input
          return !isDeepStrictEqual(model, priorListing)
        }).map(({ id }) => id)
      }
      record.added = await Promise.all(added.filter((model) => !ignored.has(model.id)).map(async (model) => {
        const blocked = await this.candidateBlock(target, model, getNative)
        return { ...model, ...(blocked ? { blocked } : {}) }
      }))
      this.lifetime.signal.throwIfAborted()
      record.gone = record.complete ? gone : []
      record.status = 'ok'
      // Only an answered-with-models listing confirms a protocol: a 200 whose
      // body has an empty `data` array is what a wrong path on a real gateway
      // looks like, and remembering it would pin the wrong protocol forever.
      if (listed.models.length > 0 && target.adapter !== 'deepseek') {
        this.store.data.ladder = { ...this.store.data.ladder, [target.provider]: listed.api }
      }
    } catch (error) {
      this.lifetime.signal.throwIfAborted()
      record.error = error instanceof Error ? error.message : String(error)
      if (previous?.status === 'ok' || previous?.lastSuccessAt !== undefined) {
        record.lastSuccessAt = previous.lastSuccessAt ?? previous.at
        record.added = previous.added ?? []
        record.upstreamCount = previous.upstreamCount
        record.catalog = previous.catalog
        record.reviewFacts = previous.reviewFacts
        record.complete = previous.complete
        record.upstreamNew = previous.upstreamNew
        record.upstreamChanged = previous.upstreamChanged
      }
    }
    checks[target.provider] = record
    const { routeIdentity, ...result } = record
    return { provider: target.provider, ...result }
  }

  /** One host snapshot per validation batch; a failed optional read can be retried. */
  nativeCatalogForBatch(provider) {
    let pending
    const load = async () => {
      const byId = new Map()
      const protocols = new Set()
      for (const model of await this.nativeCatalog(provider)) {
        byId.set(model.id, model)
        protocols.add(model.api)
      }
      return { byId, protocolCount: protocols.size }
    }
    return () => pending ??= load().catch((error) => {
      pending = undefined
      throw error
    })
  }

  async candidateBlock(target, model, getNative) {
    if (target.hasModelOverrides) return '需先在 DSH 官方设置处理模型覆盖'
    if (target.adapter === 'deepseek' && model.blocked !== undefined) return model.blocked
    if (target.adapter === 'deepseek' && model.inputModalities !== undefined) return undefined
    const llm = this.ctx.get('llm')
    try {
      if (await llm?.resolveModelInfo?.(target.provider, model.id)) return undefined
    } catch {
      // A candidate outside the live catalog needs the route's explicit metadata.
    }
    const { byId, protocolCount } = await getNative()
    if (byId.has(model.id)) return undefined
    if (target.api === undefined && protocolCount !== 1) return '待确认模型调用协议'
    if (!target.requestBaseURL) return '需补充模型调用地址'
    if ((!Number.isInteger(model.contextWindow) || model.contextWindow <= 0) ||
        (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) return '待补上下文窗口和最大输出'
    return undefined
  }

  /**
   * Save one route's model list. Existing addition-only callers may omit removeIds.
   *
   * @param {object} options
   * @param {string} options.provider
   * @param {string[]} [options.ids] defaults to every non-ignored addition from the last check
   * @returns {Promise<{provider: string, written: string[], snapshot: string}>}
   */
  async apply(options) {
    if (this.busy !== undefined || this.visibilityBusy) throw new BusyError()
    this.busy = 'apply'
    try {
      const membership = options.removeIds !== undefined
      const pickerChanges = options.pickerChanges
      if (pickerChanges !== undefined && (!Array.isArray(pickerChanges) || pickerChanges.some((row) =>
        typeof row?.id !== 'string' || !row.id || typeof row.visible !== 'boolean'))) {
        throw refuse('显示选项无效。', 400)
      }
      const validIds = (ids) => Array.isArray(ids) && ids.every((id) => typeof id === 'string' && id.length > 0)
      if (membership && (!validIds(options.removeIds) || !validIds(options.ids))) throw refuse('模型变更无效。', 400)
      const removals = new Set(options.removeIds ?? [])
      const seenUsage = new Map(Array.isArray(options.seenUsage)
        ? options.seenUsage.filter((pair) => Array.isArray(pair) && typeof pair[0] === 'string' && Number.isSafeInteger(pair[1]) && pair[1] >= 0)
        : [])
      if (options.showInPicker !== undefined && typeof options.showInPicker !== 'boolean') throw refuse('显示选项无效。', 400)
      const { targets } = await configuredTargets(this.ctx, options.provider)
      const target = targets.find((row) => row.provider === options.provider)
      if (target === undefined) {
        throw Object.assign(new Error(`provider "${options.provider}" is not configured`), {
          status: 400,
          safe: true,
          publicMessage: `provider "${options.provider}" is not configured`,
        })
      }
      if (membership && target.provider === 'deepseek-account' && target.settingsPath.length === 1) {
        throw refuse('DeepSeek Account 的模型清单由账号目录提供，可以在模型管理中调整下拉框选项。')
      }
      const check = this.currentCheck(target)
      const addsRequested = !membership || options.ids.length > 0
      if (addsRequested && (check === undefined || ((membership || options.showInPicker !== undefined) && check.status !== 'ok'))) {
        throw refuse(membership ? '请先检查供应商的上游目录，再保存新增模型。' : 'check this provider before applying', 409)
      }
      if (target.hasModelOverrides) {
        throw refuse('this provider sets "modelOverrides", which cannot be combined with a model list; edit it in Settings → Models instead', 409)
      }
      if (pickerChanges?.some(({ id }) => !target.effectiveIds.includes(id) || removals.has(id))) {
        throw refuse('模型清单已变化，请刷新后重新保存。')
      }
      const known = new Map((check?.added ?? []).map((model) => [model.id, model]))
      const requested = Array.isArray(options.ids) ? options.ids.map(String) : [...known.keys()]
      /** @type {string[]} */
      const wanted = requested.filter((id) => known.has(id))
      if (wanted.length === 0 && removals.size === 0) throw refuse('nothing to add: run a check first, or pick models the last check reported', 409)
      if (membership || options.showInPicker !== undefined) {
        if (new Set(wanted).size !== new Set(requested).size || wanted.some((id) => removals.has(id))) {
          throw refuse('候选清单已变化，请刷新后重新选择。')
        }
        const getNative = this.nativeCatalogForBatch(target.provider)
        for (const id of wanted) {
          const blocked = await this.candidateBlock(target, known.get(id), getNative)
          if (blocked) throw refuse(`${id}：${blocked}。`)
        }
      }

      const routed = this.activeGatewayEntry(target)
      const routedModels = { ...(routed?.models ?? {}) }
      if (routed !== undefined && wanted.length > 0) {
        const proxy = await this.proxyState()
        const upstream = routed.upstreamBaseURL ?? routed.previousBaseURL
        if (!upstream) throw refuse('网关记录缺少原始上游地址。')
        const probe = await this.listAll({
          baseURL: upstream,
          candidates: protocolLadder({
            configured: routed.inbound ?? target.api,
            remembered: this.store.data.ladder?.[options.provider],
            hints: hintsFor(target),
          }),
          apiKey: target.apiKey,
          headers: target.headers,
          proxy: listingProxy(proxy, upstream),
          timeoutMs: CHECK_TIMEOUT_MS,
          prefer: routed.inbound === undefined ? [] : [routed.inbound],
        }).catch(() => undefined)
        const ambiguous = wanted.filter((id) =>
          probe?.attribution?.get(id) === undefined || (probe.claimants?.get(id)?.length ?? 0) > 1)
        if (ambiguous.length > 0) {
          throw refuse(`暂未确认 ${ambiguous.join('、')} 的转发协议，模型配置未写入。`)
        }
        for (const id of wanted) routedModels[id] = probe.attribution.get(id)
      }

      /**
       * A stated list is written back verbatim, so only the additions need a
       * shape; a route that inherits the catalog gets every id materialized and
       * therefore needs them all. Asking about ids we merely keep would let a
       * pre-existing entry the catalog cannot describe block an unrelated add.
       */
      const enrichIds = target.adapter === 'deepseek' || target.modelEntries === undefined
        ? [...new Set([...wanted, ...target.effectiveIds.filter((id) => !removals.has(id))])]
        : wanted
      const metadata = await this.enrichment(target, enrichIds, known)
      const enrich = (id) => metadata.get(id)
      const snapshot = await this.store.snapshot(`before-${membership ? 'models' : 'add'}-${options.provider}`, describeSections(this.ctx.get('settings')))
      let previous
      let submitted
      /** @type {string[]} */
      let written = []
      let removed = []
      try {
        await this.write(target.settingsNs, async () => {
          const fresh = await this.freshTarget(options.provider, target.settingsNs)
          if (fresh.hasModelOverrides) throw refuse('模型覆盖设置已变化，请在 DSH「设置 → 模型」处理。')
          if (membership && (!isDeepStrictEqual(fresh.modelEntries, target.modelEntries) ||
            !isDeepStrictEqual(fresh.effectiveIds, target.effectiveIds) ||
            fresh.baseURL !== target.baseURL || fresh.listingBaseURL !== target.listingBaseURL || fresh.api !== target.api)) {
            throw refuse('此供应商的配置已变化，请核对清单后重新保存。')
          }
          previous = fresh.modelEntries
          // A model somebody else added between the read and this retry also gets
          // materialized here, so it needs the same metadata treatment.
          // Entries already in the document are written back untouched, so only
          // ids that would be *synthesized* need a shape from the catalog.
          const carried = new Set((fresh.modelEntries ?? []).map((entry) => String(entry?.id ?? entry)))
          const latecomers = fresh.effectiveIds.filter((id) => !removals.has(id) && !metadata.has(id) && !carried.has(id))
          if (latecomers.length > 0) {
            for (const [id, entry] of await this.enrichment(fresh, latecomers, known)) metadata.set(id, entry)
          }
          const missing = wanted.filter((id) => !fresh.effectiveIds.includes(id))
          removed = fresh.effectiveIds.filter((id) => removals.has(id))
          if (membership && removed.length !== removals.size) throw refuse('已添加的模型发生变化，请核对清单后重新保存。')
          if (membership && fresh.effectiveIds.length - removed.length + missing.length === 0) {
            throw refuse('每个供应商至少保留一个模型。可以同时勾选替代模型，再保存。')
          }
          if (removed.length > 0) {
            const usage = this.modelUsage()
            if (removed.some((id) => (usage.get(JSON.stringify([options.provider, id])) ?? 0) > (seenUsage.get(id) ?? 0))) {
              throw refuse('有新的会话在使用待移除的模型。请核对提醒后重新保存。')
            }
          }
          if (missing.length === 0 && removed.length === 0) throw refuse('those models are already configured', 409)
          written = missing
          const additions = missing.map((id) => {
            const model = known.get(id)
            const extra = metadata.get(id) ?? {}
            const named = model?.name !== undefined && model.name !== id ? { name: model.name } : {}
            return { id, ...extra, ...named }
          })
          submitted = additionOp({ target: fresh, additions, removals, enrich })
          return [submitted]
        }, target.revision)
      } catch (error) {
        // A catalog that cannot name the protocol refuses the whole profile, so
        // the mutation is rejected rather than stored — name the way out.
        if (isCatalogRefusal(error)) throw refuse(CATALOG_ADDITIONS_REFUSED, 409)
        throw error
      }

      // Read the edit back. Validation is expected to have refused a profile it
      // cannot resolve, but a host that stored it anyway would leave this route
      // without any model at all; undoing is cheaper than explaining that.
      const committed = describeSections(this.ctx.get('settings')).find((row) => row.ns === target.settingsNs)
      const after = (await configuredTargets(this.ctx, options.provider)).targets.find((row) => row.provider === options.provider)
      /**
       * Only pi-ai resolves a stated list against a catalog, and its failure mode
       * is unmistakable: the route keeps its key but reports **no models at all**
       * (`resolveProfiles(..., 'deferred')`). A list that merely lags the write is
       * not evidence of anything, and undoing a good write is worse than the
       * problem it guards against — so only the empty route is rolled back.
       */
      const lost = (target.adapter === 'pi-ai' || membership) && (after === undefined || after.effectiveIds.length === 0)
      const removalUnverified = removed.length > 0 && (!after || removed.some((id) => after.effectiveIds.includes(id)))
      const pickerUnverified = pickerChanges !== undefined &&
        (!after || [...written, ...pickerChanges.map(({ id }) => id)].some((id) => !after.effectiveIds.includes(id)))
      const restore = async () => {
        const current = describeSections(this.ctx.get('settings')).find((row) => row.ns === target.settingsNs)
        if (current === undefined || current.revision !== committed?.revision ||
          !isDeepStrictEqual(atPath(current.value, submitted.path), submitted.value)) {
          throw new Error('the committed model list no longer matches')
        }
        await this.rollbackModels(target, previous, current.revision)
      }
      if (lost || removalUnverified || pickerUnverified) {
        try {
          await restore()
        } catch {
          throw refuse('写入后模型清单无法解析，且未能安全恢复。请重新打开 DSH「设置 → 模型」核对。')
        }
        if (removalUnverified && !lost) throw refuse('宿主仍将此模型列为已添加，本次变更已恢复。')
        if (pickerUnverified && !lost) throw refuse('宿主暂未列出所选模型，本次变更已恢复。')
        throw refuse(CATALOG_ADDITIONS_REFUSED, 409)
      }

      const previousCheck = check && { ...check }
      const previousRoute = routed && { ...routed }
      const previousGatewayRoutes = this.gatewayRoutesCache
      const historyBefore = this.store.data.reviewHistory
      try {
        if (routed !== undefined) {
          for (const id of removed) delete routedModels[id]
          routed.models = routedModels
          routed.addedAfterRouting = [...new Set([...(routed.addedAfterRouting ?? []), ...written])].filter((id) => !removals.has(id))
          await this.refreshGatewayRoutes()
        }
        if (check !== undefined) {
          const ignored = new Set(this.store.data.ignored?.[options.provider])
          const offeredAgain = (check.catalog ?? []).filter(({ id }) => removals.has(id) && !ignored.has(id))
          const getNative = this.nativeCatalogForBatch(target.provider)
          const candidates = await Promise.all(offeredAgain.map(async (model) => {
            const blocked = await this.candidateBlock(after, model, getNative)
            return blocked ? { ...model, blocked } : model
          }))
          check.added = [
            ...(check.added ?? []).filter((model) => !written.includes(model.id) && !removals.has(model.id)),
            ...candidates,
          ]
          if (check.gone !== undefined) check.gone = check.gone.filter((id) => !removals.has(id))
        }
        let hidden
        this.addReviewHistory([
          ...written.map((model) => ({ at: Date.now(), provider: options.provider, model, type: 'selection', title: '添加到模型配置' })),
          ...removed.map((model) => ({ at: Date.now(), provider: options.provider, model, type: 'selection', title: '从模型配置移除' })),
        ])
        const changes = (pickerChanges ?? []).map((row) => ({ ...row, provider: options.provider }))
        if (options.showInPicker !== undefined) {
          changes.push(...written.map((id) => ({ provider: options.provider, id, visible: options.showInPicker })))
        }
        if (changes.length === 0) {
          await this.store.save()
          hidden = this.visibility()
        } else {
          hidden = await this.persistVisibility(changes)
        }
        await this.recordAddedMetadata(target, written, known, metadata).catch((error) => {
          this.logger?.warn?.(`model-sync: metadata ledger for ${options.provider} failed: ${messageOf(error)}`)
        })
        return { provider: options.provider, written, ...(membership ? { removed } : {}), snapshot, hidden }
      } catch (error) {
        if (previousCheck) this.store.data.checks[options.provider] = previousCheck
        this.store.data.reviewHistory = historyBefore
        if (previousRoute) this.store.data.gateway.entries[options.provider] = previousRoute
        this.gatewayRoutesCache = previousGatewayRoutes
        try {
          await restore()
        } catch {
          throw refuse('模型清单已写入，但未能保存插件状态或恢复清单。请刷新后核对实际结果。')
        }
        this.logger?.error?.(error)
        throw refuse('插件状态未能保存，本次模型变更已恢复。')
      }
    } finally {
      this.busy = undefined
    }
  }

  /**
   * Remember the provenance of fields that were just synthesized for additions.
   * Official values (the provider's own listing) are trusted immediately; a
   * models.dev fallback stays in the "待确认模型信息" tab until the provider
   * itself answers.
   */
  async recordAddedMetadata(target, ids, known, enriched) {
    if (!Array.isArray(ids) || ids.length === 0) return
    let touched = false
    for (const id of ids) {
      if (!safeLedgerKey(id)) continue
      const model = known.get(id)
      const extra = enriched.get(id) ?? {}
      const fallback = this.modelsDevIndex === undefined
        ? undefined
        : metadataFor(this.modelsDevIndex, target.provider, id)
      const rows = {}
      for (const field of METADATA_FIELDS) {
        const fieldKey = entryFieldFor(target, field)
        const value = field === 'input'
          ? firstInput(extra.input, extra.inputModalities, model?.input, model?.inputModalities, fallback?.input)
          : extra[fieldKey] ?? model?.[fieldKey] ?? fallback?.[field]
        if (validFieldValue(field, value) === undefined) continue
        const official = field === 'input'
          ? firstInput(model?.input, model?.inputModalities) !== undefined
          : model?.[fieldKey] !== undefined
        rows[field] = { value, official }
      }
      if (Object.keys(rows).length === 0) continue
      const record = this.metadataRecord(target.provider, id)
      record.name = model?.name !== undefined && model.name !== id ? model.name : id
      if (fallback?.family !== undefined) record.family = fallback.family
      if (fallback?.modality !== undefined) record.modality = fallback.modality
      if (fallback?.canonical !== undefined) record.canonical = fallback.canonical
      if (model?.createdAt !== undefined) record.upstreamCreatedAt = model.createdAt
      record.firstSeenAt ??= Date.now()
      for (const [field, row] of Object.entries(rows)) {
        this.metadataSetField(
          target.provider,
          id,
          field,
          row.value,
          row.official ? 'official' : 'models.dev',
          row.official ? 'high' : (fallback?.confidence ?? 'medium'),
        )
      }
      const fields = Object.values(record.fields ?? {})
      record.pending = fields.length > 0 && fields.some((row) => row.source !== 'official')
      this.metadataLog(target.provider, id, '自动补全', {
        note: record.pending ? 'models.dev 推测值，待官方来源确认' : '官方来源',
      })
      touched = true
    }
    if (touched) await this.store.save()
  }

  /** One model's ledger row for editing from the tab. */
  async updateMetadata(options) {
    if (this.busy !== undefined) throw new BusyError()
    this.busy = 'metadata'
    try {
      const field = String(options.field ?? '')
      if (!METADATA_FIELDS.includes(field)) throw refuse('字段无效。', 400)
      const { targets } = await configuredTargets(this.ctx, options.provider)
      const target = targets.find((row) => row.provider === options.provider)
      if (target === undefined) throw refuse('供应商不存在。', 400)
      if (!Array.isArray(target.modelEntries)) {
        throw refuse('该供应商使用继承目录，没有可编辑的显式模型字段。', 409)
      }
      const id = String(options.id ?? '')
      if (!safeLedgerKey(target.provider) || !safeLedgerKey(id)) throw refuse('模型标识包含不支持的保留字符。', 400)
      const index = target.modelEntries.findIndex((entry) =>
        entry !== null && typeof entry === 'object' && String(entry.id ?? '') === id)
      if (index < 0) throw refuse('模型不在当前供应商的显式清单中。', 409)
      let value = options.value
      if (field === 'reasoningEfforts') {
        value = normalizeReasoningEfforts(value)
        if (value === undefined) throw refuse('至少保留一个有效的推理档位。', 400)
      } else if (field === 'input') {
        value = normalizeInput(value)
        if (value === undefined) throw refuse('输入能力至少需要包含 text，且只支持 text/image。', 400)
      } else {
        if (!Number.isInteger(value) || value <= 0 || value > 1_000_000_000) throw refuse('请输入合理的正整数。', 400)
        if (field === 'maxTokens' && target.adapter === 'deepseek' &&
            Number.isInteger(target.modelMaxTokens) && target.modelMaxTokens > 0 && value > target.modelMaxTokens) {
          throw refuse(`超过该路由的最大输出上限 ${target.modelMaxTokens}。`, 400)
        }
      }
      const fieldKey = entryFieldFor(target, field)
      const entries = target.modelEntries.map((entry, position) =>
        position === index ? { ...entry, [fieldKey]: value } : entry)
      const settings = this.ctx.get('settings')
      const undoLedger = checkpointMetadataEdit(this.metadataState(), target.provider, id)
      await this.snapshotMetadata(target, 'metadata-update')
      try {
        await settings.mutate(target.settingsNs, [{
          op: 'set',
          path: [...target.settingsPath],
          value: entries,
        }], target.revision)
      } catch (error) {
        if (isConflict(error)) throw refuse('配置已被其他操作修改，请刷新后重试。', 409)
        throw error
      }
      const committedRevision = describeSections(settings).find(({ ns }) => ns === target.settingsNs)?.revision
      try {
        const record = this.metadataRecord(target.provider, id)
        // A value edited in this tab is provisional until an official answer arrives.
        record.fields[field] = { value, source: 'user', confidence: 'high', at: Date.now() }
        if (record.rejected?.[field] !== undefined) delete record.rejected[field]
        record.pending = Object.values(record.fields).some((row) => row.source !== 'official')
        this.metadataLog(target.provider, id, '手动修改', { field, to: value })
        await this.store.save()
      } catch (error) {
        undoLedger()
        await this.rollbackMetadataWrite(target, target.modelEntries, entries, committedRevision)
        throw error
      }
      return this.view()
    } finally {
      this.busy = undefined
    }
  }

  /** Undo provisional fields for one model; official values and user edits stay. */
  async revertMetadata(options) {
    if (this.busy !== undefined) throw new BusyError()
    this.busy = 'metadata'
    try {
      const { targets } = await configuredTargets(this.ctx, options.provider)
      const target = targets.find((row) => row.provider === options.provider)
      if (target === undefined) throw refuse('供应商不存在。', 400)
      if (!Array.isArray(target.modelEntries)) {
        throw refuse('该供应商使用继承目录，没有可撤销的显式模型字段。', 409)
      }
      const id = String(options.id ?? '')
      if (!safeLedgerKey(target.provider) || !safeLedgerKey(id)) throw refuse('模型标识包含不支持的保留字符。', 400)
      const record = this.metadataState().records?.[target.provider]?.[id]
      if (record === undefined || record === null || typeof record !== 'object') {
        throw refuse('没有可撤销的补全记录。', 409)
      }
      const index = target.modelEntries.findIndex((entry) =>
        entry !== null && typeof entry === 'object' && String(entry.id ?? '') === id)
      if (index < 0) throw refuse('模型已不在当前供应商的显式清单中。', 409)
      const entry = target.modelEntries[index]
      const deletions = new Set()
      const adoptions = []
      const cleared = new Set()
      for (const [field, row] of Object.entries(record.fields ?? {})) {
        if (row?.source !== 'models.dev' || row.reviewPinned === true) continue
        if (!METADATA_FIELDS.includes(field)) continue
        const current = entry[entryFieldFor(target, field)]
        if (current === undefined) {
          // The user deleted the field in DSH settings; there is no value to
          // restore, but the stale ledger entry should go away too.
          cleared.add(field)
          continue
        }
        if (!isDeepStrictEqual(current, row.value)) {
          // The user rewrote this field after the fallback was written. Never
          // delete that value; adopt it as a hand-written field instead.
          adoptions.push([field, current])
          continue
        }
        deletions.add(field)
      }
      const adoptLedger = () => {
        for (const [field, value] of adoptions) {
          record.fields[field] = { value, source: 'user', confidence: 'high', at: Date.now(), external: true }
        }
        if (!record.rejected || typeof record.rejected !== 'object' || Array.isArray(record.rejected)) {
          record.rejected = Object.create(null)
        }
        for (const field of cleared) {
          delete record.fields[field]
          record.rejected[field] = Date.now()
        }
        // A reverted models.dev value must stay reverted: without this tombstone
        // the next startup/check would silently write the same fallback again.
        for (const field of deletions) record.rejected[field] = Date.now()
        record.pending = Object.values(record.fields ?? {}).some((row) => row.source !== 'official')
      }
      const undoLedger = checkpointMetadataEdit(this.metadataState(), target.provider, id)
      if (deletions.size === 0) {
        if (adoptions.length === 0 && cleared.size === 0) {
          throw refuse('这条记录没有可撤销的自动补全字段。', 409)
        }
        try {
          adoptLedger()
          this.metadataLog(target.provider, id, '保留手动值', {
            note: '设置中的字段已与补全值不同，撤销不会删除它',
          })
          await this.store.save()
        } catch (error) {
          undoLedger()
          throw error
        }
        this.metadataNotice = '检测到手动修改，已保留你的值；没有可删除的自动补全字段。'
        return this.view()
      }
      const entries = target.modelEntries.map((candidate, position) => {
        if (position !== index) return candidate
        const next = { ...candidate }
        for (const field of deletions) delete next[entryFieldFor(target, field)]
        return next
      })
      if (isDeepStrictEqual(entries, target.modelEntries)) {
        throw refuse('这条记录没有可撤销的自动补全字段。', 409)
      }
      if (deletions.has('contextWindow') || deletions.has('maxTokens')) {
        const next = entries[index]
        if (!Number.isInteger(next?.contextWindow) || !Number.isInteger(next?.maxTokens)) {
          const installed = new Set((await this.nativeCatalog(target.provider)).map(({ id: knownId }) => knownId))
          let known = installed.has(id)
          if (!known) {
            try {
              await this.ctx.get('llm').resolveModelInfo(target.provider, id)
              known = true
            } catch {
              known = false
            }
          }
          if (!known) {
            throw refuse('撤销后该模型会缺少宿主必需的上下文窗口/最大输出，整条路由可能失效。请先在设置里手写这两个数值，再撤销。', 409)
          }
        }
      }
      const settings = this.ctx.get('settings')
      await this.snapshotMetadata(target, 'metadata-revert')
      try {
        await settings.mutate(target.settingsNs, [{
          op: 'set',
          path: [...target.settingsPath],
          value: entries,
        }], target.revision)
      } catch (error) {
        if (isConflict(error)) throw refuse('配置已被其他操作修改，请刷新后重试。', 409)
        throw error
      }
      const committedRevision = describeSections(settings).find(({ ns }) => ns === target.settingsNs)?.revision
      try {
        for (const field of deletions) delete record.fields[field]
        adoptLedger()
        this.metadataLog(target.provider, id, '撤销补全', adoptions.length > 0 ? {
          note: '手动修改的字段已保留',
        } : {})
        await this.store.save()
      } catch (error) {
        undoLedger()
        await this.rollbackMetadataWrite(target, target.modelEntries, entries, committedRevision)
        throw error
      }
      return this.view()
    } finally {
      this.busy = undefined
    }
  }

  /**
   * Put a route's model list back the way a failed write found it.
   *
   * `undefined` means the route inherited the catalog; restoring that state is
   * an `unset`, which the schema reads as "no stated list".
   * @param {any} target
   * @param {readonly unknown[] | undefined} previous
   */
  async rollbackMetadataWrite(target, previous, written, revision) {
    const live = describeSections(this.ctx.get('settings')).find(({ ns }) => ns === target.settingsNs)
    if (revision === undefined || live?.revision !== revision || !isDeepStrictEqual(atPath(live.value, target.settingsPath), written)) {
      throw refuse('插件状态保存失败，模型配置已有其他变更，请重新核对。', 409)
    }
    await this.rollbackModels(target, previous, revision)
  }

  async rollbackModels(target, previous, revision) {
    const op = previous === undefined
      ? { op: 'unset', path: [...target.settingsPath] }
      : { op: 'set', path: [...target.settingsPath], value: previous }
    await this.ctx.get('settings').mutate(target.settingsNs, [op], revision)
  }

  /**
   * Remove one model from a route's stated list.
   * @param {{provider: string, id: string}} options
   */
  async remove(options) {
    if (this.busy !== undefined) throw new BusyError()
    this.busy = 'remove'
    try {
      const { targets } = await configuredTargets(this.ctx, options.provider)
      const target = targets.find((row) => row.provider === options.provider)
      if (target === undefined) throw refuse(`provider "${options.provider}" is not configured`, 400)
      const snapshot = await this.store.snapshot(`before-remove-${options.provider}`, describeSections(this.ctx.get('settings')))
      /** @type {{ fallsBackToCatalog?: boolean } | undefined} */
      let lastOne
      await this.write(target.settingsNs, async () => {
        const fresh = await this.freshTarget(options.provider, target.settingsNs)
        const op = removalOp(fresh, options.id)
        if ('unsupported' in op) throw refuse(op.unsupported, 409)
        lastOne = op
        // The flag is for this method's return value, not for the settings
        // schema: `mutate` expects exactly {op, path} or {op, path, value}.
        return [op.op === 'set'
          ? { op: /** @type {'set'} */ ('set'), path: op.path, value: op.value }
          : { op: /** @type {'unset'} */ ('unset'), path: op.path }]
      }, target.revision)
      // Removing a model is not the same as ignoring it: the removal is in the
      // settings, so the next check sees the id as an addition again and the
      // user can add it back. Only `ignore()` writes the blacklist.
      // A routed route keeps a list of the models that only exist because the
      // gateway states one protocol. Removing one has to shrink that list, or
      // undoing the gateway would complain about a model that is already gone.
      const routed = (this.store.data.gateway?.entries ?? {})[options.provider]
      if (Array.isArray(routed?.addedAfterRouting)) {
        const left = routed.addedAfterRouting.filter((id) => id !== options.id)
        if (left.length === 0) delete routed.addedAfterRouting
        else routed.addedAfterRouting = left
      }
      await this.store.save()
      return {
        provider: options.provider,
        removed: options.id,
        snapshot,
        ...(lastOne?.fallsBackToCatalog === true
          ? { note: '这是最后一条：列表已删除，这条路由回到内置目录；要彻底停用它，请在官方设置里关掉这个供应商' }
          : {}),
      }
    } finally {
      this.busy = undefined
    }
  }

  /**
   * Stop offering a set of upstream ids for one route without writing anything.
   * The list lives here rather than upstream, so it is lossless and undoable by
   * clearing `ignored` in the state file.
   * @param {{provider: string, ids: string[]}} options
   */
  async ignore(options) {
    if (this.busy !== undefined) throw new BusyError()
    this.busy = 'ignore'
    try {
      const provider = String(options.provider ?? '')
      const ids = (Array.isArray(options.ids) ? options.ids : []).map(String)
      if (provider.length === 0 || ids.length === 0) throw refuse('nothing to ignore', 400)
      const current = this.store.data.ignored?.[provider] ?? []
      this.store.data.ignored = { ...this.store.data.ignored, [provider]: [...new Set([...current, ...ids])] }
      const check = this.store.data.checks?.[provider]
      if (check !== undefined) check.added = (check.added ?? []).filter((model) => !ids.includes(model.id))
      await this.store.save()
      return { provider, ignored: this.store.data.ignored[provider] }
    } finally {
      this.busy = undefined
    }
  }

  /**
   * Forget the ids the user asked not to see again for one route. The ids were
   * only filtered out of the last check, so nothing upstream has to change.
   * @param {{provider: string}} options
   */
  async unignore(options) {
    if (this.busy !== undefined) throw new BusyError()
    this.busy = 'unignore'
    try {
      const provider = String(options.provider ?? '')
      if (provider.length === 0) throw refuse('which provider?', 400)
      const remaining = { ...(this.store.data.ignored ?? {}) }
      delete remaining[provider]
      this.store.data.ignored = remaining
      await this.store.save()
      return { provider, ignored: [] }
    } finally {
      this.busy = undefined
    }
  }

  /**
   * Stop stating a model list for one route, so it serves the adapter's
   * catalog again. `unset` restores the inherited value when the base layer has
   * one and otherwise deletes the key, so this is also the undo for a
   * materialization.
   * @param {{provider: string}} options
   */
  async restore(options) {
    if (this.busy !== undefined) throw new BusyError()
    this.busy = 'restore'
    try {
      const { targets } = await configuredTargets(this.ctx, options.provider)
      const target = targets.find((row) => row.provider === options.provider)
      if (target === undefined) throw refuse(`provider "${options.provider}" is not configured`, 400)
      const snapshot = await this.store.snapshot(`before-restore-${options.provider}`, describeSections(this.ctx.get('settings')))
      await this.write(target.settingsNs, async () => {
        const fresh = await this.freshTarget(options.provider, target.settingsNs)
        return [restoreOp(fresh)]
      }, target.revision)
      const checks = { ...this.store.data.checks }
      delete checks[options.provider]
      this.store.data.checks = checks
      await this.store.save()
      return { provider: options.provider, snapshot }
    } finally {
      this.busy = undefined
    }
  }

  /**
   * Remove provider keys that no registered route backs — the leftovers an
   * earlier version of this plugin created. Each key is only dropped after the
   * caller names it, and a snapshot is taken first.
   * @param {{providers: string[]}} options
   */
  async cleanup(options) {
    if (this.busy !== undefined) throw new BusyError()
    this.busy = 'cleanup'
    try {
      const foreign = new Set(foreignProviderKeys(this.ctx))
      const doomed = (options.providers ?? []).filter((provider) => foreign.has(provider))
      if (doomed.length === 0) throw refuse('none of the named providers are unknown to this profile', 400)
      const settings = this.ctx.get('settings')
      // Every foreign key in this profile lives in the section that also holds
      // the configured routes; find the namespace that actually contains them.
      // Grouped by namespace: an `unset` only lands in the section it is aimed
      // at, so a key that lives in the other section would be reported as
      // removed while still being there.
      /** @type {Map<string, {revision: number, providers: string[]}>} */
      const groups = new Map()
      for (const provider of doomed) {
        const holder = this.namespaceHolding([provider])
        if (holder === undefined) continue
        const group = groups.get(holder.ns) ?? { revision: holder.revision, providers: [] }
        group.providers.push(provider)
        groups.set(holder.ns, group)
      }
      if (groups.size === 0) throw refuse('could not find the settings section holding those providers', 500)
      const snapshot = await this.store.snapshot('before-cleanup', describeSections(settings))
      /** @type {string[]} */
      const removed = []
      for (const [ns, group] of groups) {
        await this.write(ns, async () => {
          const stillForeign = new Set(foreignProviderKeys(this.ctx))
          const left = group.providers.filter((provider) => stillForeign.has(provider))
          removed.push(...left)
          return left.map((provider) => ({ op: 'unset', path: ['providers', provider] }))
        }, group.revision)
      }
      if (removed.length === 0) throw refuse('those providers are already gone', 409)
      return { removed, snapshot }
    } finally {
      this.busy = undefined
    }
  }

  /** Flag possible 0.x protocol siblings for manual review. Names alone cannot establish ownership. */
  legacySiblings() {
    /** @type {{ns: string, provider: string, parent: string, api?: string, baseURL?: string}[]} */
    const found = []
    for (const descriptor of describeSections(this.ctx.get('settings'))) {
      const value = descriptor.value
      if (value === null || typeof value !== 'object') continue
      const table = /** @type {any} */ (value)['providers']
      if (table === null || typeof table !== 'object') continue
      for (const provider of syntheticSiblings(Object.keys(table))) {
        const entry = /** @type {any} */ (table)[provider]
        found.push({
          ns: descriptor.ns,
          provider,
          parent: /^(.*)-(?:chat|messages|responses)$/.exec(provider)[1],
          api: typeof entry?.api === 'string' ? entry.api : undefined,
          baseURL: typeof entry?.baseURL === 'string' ? entry.baseURL : undefined,
        })
      }
    }
    return found
  }

  /** Find the section (and revision) that holds one of these provider keys. */
  namespaceHolding(providers) {
    for (const descriptor of describeSections(this.ctx.get('settings'))) {
      const value = descriptor.value
      if (value === null || typeof value !== 'object') continue
      const table = /** @type {Record<string, unknown>} */ (value)['providers']
      if (table === null || typeof table !== 'object') continue
      for (const provider of providers) {
        if (Object.hasOwn(table, provider)) return { ns: descriptor.ns, revision: descriptor.revision }
      }
    }
    return undefined
  }

  /** Re-read one configured route, failing safely when it disappeared. */
  async freshTarget(provider, ns) {
    const { targets } = await configuredTargets(this.ctx, provider)
    const target = targets.find((row) => row.provider === provider)
    if (target === undefined) throw refuse(`provider "${provider}" is no longer configured`, 409)
    if (ns !== undefined && target.settingsNs !== ns) throw refuse(`provider "${provider}" moved to another settings section`, 409)
    return target
  }

  /**
   * Per-model metadata to write beside a bare id, for adapters that validate a
   * stated list without falling back to catalog metadata. Only the deepseek
   * adapter is like that: materializing `{id}` there would drop
   * `inputModalities`, `contextWindow` and the display name.
   *
   * @param {any} target
   * @param {readonly string[]} ids
   */
  async enrichment(target, ids, discovered = new Map()) {
    /** @type {Map<string, object>} */
    const map = new Map()
    const llm = this.ctx.get('llm')
    if (target.adapter !== 'deepseek') {
      // pi-ai falls back to catalog metadata per id, so a bare `{id}` is enough
      // for a model the installed catalog describes. An id it does **not**
      // describe is another matter: the schema then requires `contextWindow`
      // and `maxTokens` on the entry, and refuses the whole route without them.
      const installed = new Set((await this.nativeCatalog(target.provider)).map(({ id }) => id))
      for (const id of ids) {
        if (installed.has(id)) continue
        let known = true
        try {
          await llm.resolveModelInfo(target.provider, id)
        } catch {
          known = false
        }
        if (known) continue
        const model = discovered.get(id)
        const fallback = this.modelsDevIndex === undefined
          ? undefined
          : metadataFor(this.modelsDevIndex, target.provider, id)
        const window = model?.contextWindow ?? fallback?.contextWindow
        const maxTokens = model?.maxTokens ?? fallback?.maxTokens
        if (!Number.isInteger(window) || window <= 0 || !Number.isInteger(maxTokens) || maxTokens <= 0) {
          throw refuse(
            `上游没有给出 "${id}" 的上下文窗口与最大输出，宿主无法为一个内置目录里没有的模型建路由。请先在设置里手写这两个数值，或用 "\"ignore\"" 忽略它。`,
            409,
          )
        }
        const reasoningEfforts = normalizeReasoningEfforts(model?.reasoningEfforts ?? fallback?.reasoningEfforts)
        const input = firstInput(model?.input, model?.inputModalities, fallback?.input)
        map.set(id, {
          contextWindow: window,
          maxTokens,
          ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
          ...(input === undefined ? {} : { input }),
        })
      }
      return map
    }
    for (const id of ids) {
      const model = discovered.get(id)
      const fallback = this.modelsDevIndex === undefined
        ? undefined
        : metadataFor(this.modelsDevIndex, target.provider, id)
      const reasoningEfforts = normalizeReasoningEfforts(model?.reasoningEfforts ?? fallback?.reasoningEfforts)
      if (model?.inputModalities !== undefined && model.blocked === undefined) {
        const { contextWindow, maxTokens, inputModalities, systemPromptUpdate, toolUpdate, description } = model
        map.set(id, {
          inputModalities,
          ...(contextWindow === undefined ? {} : { contextWindow }),
          ...(maxTokens === undefined ? {} : { maxTokens: Math.min(maxTokens, target.modelMaxTokens) }),
          ...(systemPromptUpdate === undefined ? {} : { systemPromptUpdate }),
          ...(toolUpdate === undefined ? {} : { toolUpdate }),
          ...(description === undefined ? {} : { description }),
          ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
          ...(firstInput(model.input, model.inputModalities) === undefined ? {} : { inputModalities: firstInput(model.input, model.inputModalities) }),
        })
        continue
      }
      try {
        const info = await llm?.resolveModelInfo?.(target.provider, id)
        /** @type {Record<string, unknown>} */
        const entry = {}
        if (typeof info?.name === 'string' && info.name.length > 0 && info.name !== id) entry['name'] = info.name
        const window = info?.context?.contextWindow
        if (Number.isInteger(window) && window > 0) entry['contextWindow'] = window
        if (Number.isInteger(info?.defaultMaxTokens) && info.defaultMaxTokens > 0) {
          const maxTokens = target.adapter === 'deepseek' && Number.isInteger(target.modelMaxTokens) && target.modelMaxTokens > 0
            ? Math.min(info.defaultMaxTokens, target.modelMaxTokens)
            : info.defaultMaxTokens
          entry['maxTokens'] = maxTokens
        }
        const input = firstInput(info?.input, info?.inputModalities, fallback?.input)
        if (input !== undefined) entry[entryFieldFor(target, 'input')] = input
        if (reasoningEfforts !== undefined) entry['reasoningEfforts'] = reasoningEfforts
        map.set(id, entry)
      } catch {
        // A lookup failure must not block the write: the bare id still works.
      }
    }
    return map
  }

  /**
   * One write, with the only retry this plugin performs: a revision conflict
   * means somebody else edited settings between the read and the write, so the
   * ops are **rebuilt** from a fresh read rather than replayed. Replaying would
   * recreate a provider key somebody else deleted — and `providers` is exactly
   * the key this plugin must never create.
   *
   * @param {string} ns
   * @param {() => Promise<object[]> | object[]} build
   * @param {number} revision
   */
  async write(ns, build, revision) {
    const settings = this.ctx.get('settings')
    const attempt = async (expected) => {
      await settings.mutate(ns, await build(), expected)
    }
    try {
      await attempt(revision)
      return
    } catch (error) {
      if (!isConflict(error)) throw error
      const fresh = describeSections(settings).find((row) => row.ns === ns)
      if (fresh === undefined) throw refuse('the settings section disappeared while this write was in flight', 409)
      await attempt(fresh.revision)
    }
  }

  /** Persist panel settings and apply schedule or egress changes. */
  async settings(patch) {
    if (this.busy !== undefined) throw new BusyError()
    this.busy = 'settings'
    try {
      const next = { ...this.store.data }
      if (patch.schedule !== undefined) {
        const schedule = { ...next.schedule, ...patch.schedule }
        if (schedule.hour !== undefined) {
          const hour = Number(schedule.hour)
          if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw refuse('the check hour must be a whole hour between 0 and 23', 400)
          schedule.hour = hour
        }
        next.schedule = schedule
      }
      if (patch.ignored !== undefined) next.ignored = patch.ignored
      if (patch.gateway !== undefined) {
        const gateway = { ...(next.gateway ?? {}), ...patch.gateway }
        if (gateway.enabled !== undefined && typeof gateway.enabled !== 'boolean') {
          throw refuse('"gateway.enabled" must be a boolean', 400)
        }
        delete gateway.entries
        next.gateway = { ...(next.gateway ?? {}), ...gateway }
      }
      if (patch.bili !== undefined) {
        const bili = { ...(next.bili ?? {}), ...patch.bili }
        if (bili.enabled !== undefined && typeof bili.enabled !== 'boolean') throw refuse('"bili.enabled" must be a boolean', 400)
        if (bili.supervisor !== undefined && typeof bili.supervisor !== 'boolean') throw refuse('"bili.supervisor" must be a boolean', 400)
        // `hosts` is derived from the configured providers, so accepting a list
        // here would let a stale copy override reality. Say so instead of silently
        // storing it.
        if (patch.bili?.hosts !== undefined) {
          throw refuse('"bili.hosts" is derived from your providers and cannot be set', 400)
        }
        delete bili.hosts
        next.bili = bili
      }
      this.store.data = next
      this.proxyWatcher.invalidate()
      if (patch.schedule !== undefined) this.armSchedule()
      await this.store.save()
      // Turning the feature on takes effect immediately rather than at the next check.
      if (patch.bili?.supervisor === true || patch.bili?.enabled !== undefined) await this.syncBili({ reason: 'settings' })
      return this.view()
    } finally {
      this.busy = undefined
    }
  }
}
