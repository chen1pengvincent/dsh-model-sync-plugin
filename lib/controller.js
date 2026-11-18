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

import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BILI_ZONE_PORT, DEFAULT_PROXY_HOSTS, backupConfig, getConfig, locate as locateBili, planProviders, putConfig, putProviders,
  readConfigFile, readConfigStrict, revertProviders,
} from './bili.js'
import { listAll, listModels, protocolLadder } from './discovery.js'
import { createGateway } from './gateway/server.js'
import { PROTOCOLS } from './gateway/protocol.js'
import { diffModels, additionOp, removalOp, restoreOp } from './plan.js'
import { ProxyWatcher } from './proxy.js'
import { atPath, configuredTargets, describeSections, foreignProviderKeys, syntheticSiblings } from './targets.js'
import { Store } from './state.js'
import { displayCatalog, hiddenModels, updateVisibility } from './visibility.js'
import { parseProxy } from './http.js'
import { endpointFor } from './endpoints.js'
import { loadModelsDev, metadataFor } from './models-dev.js'
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

/**
 * How often the gateway re-reads the machine's proxy. Detection itself is
 * cached for 30s, so this is a cheap way keep egress decisions honest without
 * spawning a system tool on the request path.
 */
const EXIT_REFRESH_MS = 15_000

/** A check older than this is refreshed on boot; a once-a-day schedule is the intent. */
const STALE_AFTER_MS = 12 * 60 * 60 * 1000

/**
 * The daily check is on by default.
 *
 * Pulling the upstream catalog is the whole point of the plugin and it only
 * *reads* upstream: the result waits in the panel until the user confirms, so
 * a default-on timer cannot change a configuration on its own. Leaving it off
 * meant a fresh install looked broken (no data, no schedule) until the user
 * found a switch they did not know they needed.
 */
const DEFAULT_SCHEDULE = { enabled: true, hour: 9 }

/** Per-provider budget for one listing attempt. */
const CHECK_TIMEOUT_MS = 12_000

/** Object keys that would alias a prototype slot if used as a ledger key. */
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

/** Whether a provider/model id is safe as a plain-object key in the ledger. */
function safeLedgerKey(value) {
  return typeof value === 'string' && value.length > 0 && !RESERVED_KEYS.has(value)
}

/** Levels the DSH reasoning schema accepts. `off` is only a wire value. */
const EFFORT_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'off'])

/**
 * A `reasoningEfforts` map the DSH schema can accept.
 *
 * A listing or cache is untrusted input even when its source is official: a
 * malformed map would otherwise make the *whole* provider route fail schema
 * validation on the next write. Keep only known level names, non-empty short
 * wire strings, and require at least one enabled level.
 */
function normalizeReasoningEfforts(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  /** @type {Record<string, string>} */
  const efforts = {}
  for (const [level, wire] of Object.entries(value)) {
    if (!EFFORT_LEVELS.has(level)) continue
    if (typeof wire !== 'string' || wire.length === 0 || wire.length > 64) continue
    if (/[\r\n]/.test(wire)) continue
    efforts[level] = wire
  }
  return Object.keys(efforts).some((level) => level !== 'off') ? efforts : undefined
}

/** A field value the DSH schema can accept, or undefined for junk. */
function validFieldValue(field, value) {
  if (field === 'reasoningEfforts') return normalizeReasoningEfforts(value)
  return Number.isInteger(value) && value > 0 && value <= 1_000_000_000 ? value : undefined
}

/** Restore a ledger record after a failed save without changing its identity. */
function restoreRecord(record, snapshot) {
  for (const key of Object.keys(record)) delete record[key]
  Object.assign(record, snapshot)
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

/** Whether a failed write was the catalog refusing an undescribed protocol. */
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

/** Whether a route's endpoint lives on this machine. */
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
    this.gateway = options.gateway ?? { createGateway }
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
      // Writes read through this one: it refuses on a parse failure instead of
      // handing back an empty table that would be written over the real one.
      readConfigStrict: options.bili?.readConfigStrict ?? readConfigStrict,
      putConfig: options.bili?.putConfig ?? putConfig,
      putProviders: options.bili?.putProviders ?? putProviders,
      getConfig: options.bili?.getConfig ?? getConfig,
      backup: options.bili?.backup ?? backupConfig,
    }
    this.busy = undefined
    /** Separate from `busy`: a bili sync must not block a check, or vice versa. */
    this.biliBusy = false
    /** Live gateway handle; `undefined` means the listener is not running. */
    this.gatewayHandle = undefined
    /** One-shot note for a successful metadata action that had no error. */
    this.metadataNotice = undefined
    /** @type {NodeJS.Timeout | undefined} */
    this.timer = undefined
    this.disposed = false
  }

  /** Load state and arm the schedule. Safe to call once per activation. */
  async start() {
    await this.store.load()
    // The catalog is a fallback, not a prerequisite: load it beside the other
    // startup work so a slow public endpoint cannot delay the panel.
    this.refreshModelsDev()
      .then(() => this.warmMetadata())
      .catch((error) => this.logger?.warn?.(`model-sync: metadata warm-up failed: ${messageOf(error)}`))
    this.armSchedule()
    // bili's egress table is the only lever that reaches model traffic, and it
    // is cheap to check, so it is reconciled on boot rather than waiting for the
    // first panel visit. It writes nothing unless a system proxy is up.
    await this.syncBili({ reason: 'boot' }).catch((error) => {
      this.logger?.warn?.(`model-sync: bili sync failed: ${messageOf(error)}`)
    })
    await this.restoreGateway().catch((error) => {
      this.logger?.warn?.(`model-sync: gateway restore failed: ${messageOf(error)}`)
    })
    // The panel should open on the answer rather than on a button: after a
    // restart the first question is "did it load, and can it see my profile?".
    await this.runSelfCheck().catch((error) => {
      this.logger?.warn?.(`model-sync: boot self-check failed: ${messageOf(error)}`)
    })
    if (this.bootCheckDue()) {
      const timer = setTimeout(() => {
        this.check({ reason: 'boot' }).catch((error) => {
          this.logger?.warn?.(`model-sync: automatic check failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      }, BOOT_CHECK_DELAY_MS)
      if (typeof timer.unref === 'function') timer.unref()
      this.bootTimer = timer
    }
  }

  /**
   * Load the public catalog once per activation. It is a fallback source, so a
   * failure is reported in state and never prevents the panel from opening.
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
        })
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
    // A hand-edited or half-written state file must not turn a tombstone map
    // into a primitive that crashes the next revert.
    for (const byProvider of Object.values(metadata.records)) {
      if (byProvider === null || typeof byProvider !== 'object') continue
      for (const record of Object.values(byProvider)) {
        if (record === null || typeof record !== 'object') continue
        if (record.rejected === null || typeof record.rejected !== 'object' || Array.isArray(record.rejected)) {
          record.rejected = Object.create(null)
        }
      }
    }
    return metadata
  }

  /** One model's ledger row, created lazily. */
  metadataRecord(provider, id) {
    if (!safeLedgerKey(provider) || !safeLedgerKey(id)) {
      throw refuse('模型标识包含不支持的保留字符。', 400)
    }
    const records = this.metadataState().records
    const byProvider = records[provider] ?? (records[provider] = Object.create(null))
    return byProvider[id] ?? (byProvider[id] = {
      provider,
      id,
      firstSeenAt: Date.now(),
      pending: true,
      fields: {},
      log: [],
    })
  }

  /** Snapshot the settings document before a metadata write. */
  async snapshotMetadata(target, label) {
    return this.store.snapshot(
      `before-${label}-${target.provider}`,
      describeSections(this.ctx.get('settings')),
    )
  }

  /** Best-effort restore of a model list after the ledger write failed. */
  async restoreModelEntries(target, entries) {
    try {
      const fresh = await this.freshTarget(target.provider, target.settingsNs)
      await this.ctx.get('settings').mutate(target.settingsNs, [{
        op: 'set',
        path: [...target.settingsPath],
        value: entries,
      }], fresh.revision)
    } catch (error) {
      this.logger?.error?.(error)
    }
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

  /** Display name for a metadata value, used only in log lines. */
  metadataValueLabel(value) {
    if (value === undefined) return '未设置'
    if (typeof value === 'number') return String(value)
    if (typeof value === 'string') return value
    if (value !== null && typeof value === 'object') return Object.keys(value).join('/')
    return String(value)
  }

  /** The tab's data: only model entries whose values are not official, and only for live routes. */
  metadataView(targets) {
    const metadata = this.metadataState()
    const byProvider = new Map(targets.map((target) => [target.provider, target]))
    const models = []
    for (const [provider, rows] of Object.entries(metadata.records)) {
      const target = byProvider.get(provider)
      if (target === undefined) continue
      if (!Array.isArray(target.modelEntries)) continue
      const effective = new Set(target.effectiveIds)
      for (const [id, record] of Object.entries(rows)) {
        if (!safeLedgerKey(id) || record === null || typeof record !== 'object') continue
        if (!effective.has(id)) continue
        if (record.pending === false && Object.keys(record.fields ?? {}).length === 0) continue
        const entry = target.modelEntries.find((candidate) =>
          candidate !== null && typeof candidate === 'object' && String(candidate.id ?? '') === id)
        if (entry === undefined) continue
        const fields = {}
        let untrusted = false
        let missing = 0
        let hasUser = false
        // Start at "no models.dev field"; a low field wins over a medium one so
        // the filter matches the worst provenance on the card.
        let rank = 3
        for (const field of ['contextWindow', 'maxTokens', 'reasoningEfforts']) {
          const row = record.fields?.[field]
          const live = validFieldValue(field, entry[field])
          if (row === undefined) {
            if (live !== undefined) {
              // A value written in DSH settings before this ledger row existed.
              // Show what is actually in settings instead of a false "missing".
              fields[field] = { value: live, source: 'user', confidence: 'high', external: true, missing: false }
              untrusted = true
              hasUser = true
              continue
            }
            fields[field] = { missing: true, ...(record.rejected?.[field] === undefined ? {} : { rejected: true }) }
            missing += 1
            continue
          }
          if (!isDeepStrictEqual(live, row.value)) {
            if (live === undefined) {
              fields[field] = { missing: true, ...(record.rejected?.[field] === undefined ? {} : { rejected: true }) }
              missing += 1
              untrusted = true
              continue
            }
            // The setting was changed outside the panel after the ledger wrote
            // it. The live value is the truth until an official answer lands.
            fields[field] = { ...row, value: live, source: 'user', confidence: 'high', external: true, missing: false }
            untrusted = true
            hasUser = true
            continue
          }
          fields[field] = { ...row, missing: false }
          if (row.source !== 'official') untrusted = true
          if (row.source === 'user') hasUser = true
          if (row.source === 'models.dev') rank = Math.min(rank, row.confidence === 'low' ? 1 : 2)
        }
        if (!untrusted) continue
        models.push({
          provider,
          displayName: target.displayName,
          id,
          name: record.name ?? id,
          family: record.family,
          modality: record.modality,
          firstSeenAt: record.firstSeenAt,
          upstreamCreatedAt: record.upstreamCreatedAt,
          fields,
          missing,
          pending: true,
          status: hasUser ? 'user' : missing > 0 ? 'missing' : 'pending',
          confidence: rank === 1 ? 'low' : rank === 2 ? 'medium' : hasUser ? 'user' : 'medium',
          log: Array.isArray(record.log) ? record.log.slice(-10).reverse() : [],
        })
      }
    }
    models.sort((left, right) => (right.firstSeenAt ?? 0) - (left.firstSeenAt ?? 0))
    return {
      pendingCount: models.length,
      models,
      logs: metadata.logs.slice(-200).reverse(),
      fetchedAt: metadata.fetchedAt,
      stale: metadata.stale === true,
      error: metadata.error,
    }
  }

  /**
   * Backfill explicit model lists once the public catalog is available. This is
   * deliberately fire-and-forget: a slow catalog must not delay the panel, and
   * a conflict is harmless because the next check retries.
   */
  async warmMetadata() {
    const { targets } = await configuredTargets(this.ctx)
    for (const target of targets) {
      try {
        // Every provider in one settings namespace shares a revision. Re-read it
        // before each write so filling google does not make kimi's write stale.
        const fresh = await this.freshTarget(target.provider, target.settingsNs)
        await this.autoFillMetadata(fresh)
      } catch (error) {
        this.logger?.warn?.(`model-sync: metadata warm-up for ${target.provider} failed: ${messageOf(error)}`)
      }
    }
  }

  /**
   * Fill fields that are missing on a route that states its own model list.
   *
   * This is deliberately conservative:
   *  - a route that inherits the adapter catalog is never materialized here;
   *  - an official answer outranks every user value (the product decision),
   *    while models.dev never overwrites a hand-written value;
   *  - models.dev only ever supplies values for an exact provider/model pair;
   *  - every write is a single revision-checked `set` of the whole model array.
   */
  async autoFillMetadata(target) {
    if (!Array.isArray(target.modelEntries) || target.modelEntries.length === 0) return 0
    if (target.provider === 'deepseek-account' && target.settingsPath.length === 1) return 0
    const check = this.store.data.checks?.[target.provider]
    // A failed check inherits the previous catalog so the panel can keep
    // rendering it. Those rows are useful history, but they are not a fresh
    // official answer and must not overwrite a field during this run.
    const officialTrusted = check?.status === 'ok'
    const catalog = new Map((check?.catalog ?? []).map((model) => [model.id, model]))
    const staged = []
    const metas = []
    let changed = false
    const entries = target.modelEntries.map((entry) => {
      if (entry === null || typeof entry !== 'object') return entry
      const id = String(entry.id ?? '')
      if (id.length === 0 || !safeLedgerKey(id)) return entry
      const official = officialTrusted ? catalog.get(id) : undefined
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
      for (const field of ['contextWindow', 'maxTokens', 'reasoningEfforts']) {
        const officialValue = validFieldValue(field, clamp(field, official?.[field]))
        const fallbackValue = validFieldValue(field, clamp(field, fallback?.[field]))
        const current = entry[field]
        const previous = record?.fields?.[field]
        // A value that no longer matches what the ledger says this plugin
        // wrote was changed outside the panel (DSH settings, another tool).
        // It is a hand-written value now. The official source outranks all
        // user values by product decision, but the aggregator must not touch it.
        const manual = current !== undefined && previous !== undefined && !isDeepStrictEqual(current, previous.value)
        const external = previous?.external === true
        let nextValue
        let source
        let confidence
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
          writes.push({ field, value: current, source: 'user', confidence: 'high', external: true })
          continue
        } else if (record?.rejected?.[field] === undefined &&
                   (previous === undefined || previous.source === 'models.dev') &&
                   current === undefined && fallbackValue !== undefined) {
          nextValue = fallbackValue
          source = 'models.dev'
          confidence = fallback.confidence
        } else if (!manual && record?.rejected?.[field] === undefined &&
                   previous?.source === 'models.dev' && fallbackValue !== undefined &&
                   isDeepStrictEqual(current, previous.value) && !isDeepStrictEqual(current, fallbackValue)) {
          nextValue = fallbackValue
          source = 'models.dev'
          confidence = fallback.confidence
        }
        if (nextValue === undefined && !writes.some((item) => item.field === field)) continue
        if (nextValue !== undefined) {
          writes.push({ field, value: nextValue, source, confidence })
          next[field] = nextValue
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
    if (!changed) {
      try {
        await commit()
      } catch (error) {
        this.store.data.metadata = metadataBefore
        throw error
      }
      return 0
    }
    const before = target.modelEntries
    await this.snapshotMetadata(target, 'metadata-autofill')
    try {
      await this.ctx.get('settings').mutate(target.settingsNs, [{
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
    try {
      await commit()
      return 1
    } catch (error) {
      this.store.data.metadata = metadataBefore
      // The settings write landed; keep the ledger and the settings consistent
      // by putting the old list back when persistence failed.
      try {
        const fresh = await this.freshTarget(target.provider, target.settingsNs)
        await this.ctx.get('settings').mutate(target.settingsNs, [{
          op: 'set',
          path: [...target.settingsPath],
          value: before,
        }], fresh.revision)
      } catch (restoreError) {
        this.logger?.error?.(restoreError)
      }
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
    if (this.timer !== undefined) clearTimeout(this.timer)
    if (this.exitTimer !== undefined) clearInterval(this.exitTimer)
    if (this.bootTimer !== undefined) clearTimeout(this.bootTimer)
    // Fire and forget: dispose is synchronous, and a listener that outlives the
    // plugin would keep a port open with no route table to answer from.
    this.gatewayHandle?.stop?.()
    this.gatewayHandle = undefined
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
  async proxyState() {
    const detected = await this.proxyWatcher.current()
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
   * The exit one route's check should take.
   *
   * A local endpoint is reached directly even with the switch on: tunnelling to
   * `127.0.0.1` through a proxy means nothing to the proxy and everything to
   * the timeout budget.
   */
  async proxyFor(target) {
    const state = await this.proxyState()
    if (state.enabled !== true || state.available !== true) return undefined
    if (isLocalEndpoint(target.baseURL)) return undefined
    return parseProxy(state.url)
  }

  /** Everything the panel renders, without touching the network. */
  /**
   * Hosts whose model traffic should use the local proxy: the intersection of
   * "configured routes" and the curated list. Derived from configuration every
   * time, so removing a provider removes its host from the plan.
   * @returns {Promise<string[]>}
   */
  async proxyHosts() {
    const { targets } = await configuredTargets(this.ctx)
    const configured = new Set()
    for (const target of targets) {
      if (typeof target.baseURL !== 'string') continue
      try {
        configured.add(new URL(target.baseURL).hostname.toLowerCase())
      } catch {
        // a malformed baseURL is reported by the check, not here
      }
    }
    // Derived, never stored. A stored copy freezes the set at the moment it was
    // written: a provider added later would quietly never be proxied, and the
    // panel would keep showing the old two hosts.
    return DEFAULT_PROXY_HOSTS.filter((host) => configured.has(host.toLowerCase()))
  }

  /**
   * What bili currently has for those hosts. Read-only.
   *
   * `mode` and `rows` are what the panel shows: the whole point of this feature
   * is that the user can see the difference between "bili has no proxy for
   * Google" and "bili has one and it is stale".
   */
  async biliState() {
    const saved = this.store.data.bili ?? {}
    const enabled = saved.enabled !== false
    /** @type {any} */
    const base = {
      enabled,
      status: saved.status,
      at: stamp(saved.at),
      error: saved.error,
      written: Array.isArray(saved.written) ? saved.written.length : 0,
    }
    const where = this.bili.locate()
    if (where === undefined) return { ...base, found: false, hosts: [], rows: [] }
    /** @type {any} */
    let config = {}
    try {
      config = await this.bili.readConfigFile(where.configPath)
    } catch (error) {
      return { ...base, found: true, origin: where.origin, pid: where.pid, hosts: [], rows: [], error: messageOf(error) }
    }
    const hosts = await this.proxyHosts()
    const providers = config?.providers !== null && typeof config?.providers === 'object' ? config.providers : {}
    // bili's own global egress mode is a second author on the same wire. The
    // panel has to say so, otherwise "I turned the switch off" would be a lie
    // whenever the lane is proxying everything globally.
    let globalMode
    try {
      const effective = JSON.parse((await this.bili.getConfig(where.origin)).text)
      if (typeof effective?.upstreamProxyMode === 'string') globalMode = effective.upstreamProxyMode
    } catch {
      globalMode = undefined
    }
    // A key can hold exactly the value we would write and still not be ours: an
    // earlier version of this plugin (or the user) wrote it. `revoke` never
    // deletes those, so the panel has to say which rows it would leave alone —
    // otherwise "撤销声明" looks broken when the traffic keeps going out through
    // the proxy.
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
          proxy: entry !== null && typeof entry === 'object' && typeof entry.proxy === 'string' ? entry.proxy : undefined,
          present: entry !== undefined,
          owned: owned.has(key),
        }
      }),
    }
  }

  /** Merge one status write into state and persist it. */
  async recordBili(patch) {
    if (this.disposed === true) return patch
    // `hosts` is derived from the configured providers, so it is never stored: a
    // saved copy is what froze the set last time (a provider added afterwards was
    // silently never proxied). The panel only needs the current derivation.
    const { hosts: _derived, proxyHosts: _alsoDerived, ...durable } = patch
    this.store.data.bili = { ...(this.store.data.bili ?? {}), ...durable }
    await this.store.save().catch(() => undefined)
    return patch
  }

  /**
   * Make bili route the configured hosts through the system proxy.
   *
   * Refuses (and writes nothing) unless all three hold: the feature is on, a
   * system proxy is actually available, and bili is running. Every path that
   * writes goes through bili's validated HTTP channel after backing up the
   * previous config.
   */
  async syncBili(options = {}) {
    if (this.disposed === true) return { status: 'disposed' }
    if (this.biliBusy === true) return { status: 'busy' }
    this.biliBusy = true
    try {
      const saved = this.store.data.bili ?? {}
      if (saved.enabled === false) {
        // The switch is authoritative: off means the entries this plugin added
        // are gone again, not merely "we stopped looking". Leaving them behind
        // would keep model traffic pointed at a proxy the user believes they
        // turned off.
        const cleared = await this.revokeWritten('disabled')
        if (cleared !== undefined) return cleared
        return this.recordBili({ status: 'disabled', at: Date.now() })
      }
      const proxy = await this.proxyState()
      if (proxy.available !== true || typeof proxy.url !== 'string') {
        // A vanished proxy is the dangerous case: bili does not fall back to a
        // direct connection, so a stale entry turns "proxy is off" into
        // "everything on these hosts fails". Put the table back first.
        const cleared = await this.revokeWritten('no-proxy')
        if (cleared !== undefined) return cleared
        return this.recordBili({ status: 'no-proxy', at: Date.now(), error: undefined, detail: proxy.detail })
      }
      const where = this.bili.locate()
      if (where === undefined) return this.recordBili({ status: 'no-bili', at: Date.now(), error: undefined })
      const hosts = await this.proxyHosts()
      if (hosts.length === 0) return this.recordBili({ status: 'no-hosts', at: Date.now(), error: undefined })

      // Strict on purpose: the lane replaces the whole table, so writing what we
      // read of an unreadable file would delete the user's other entries.
      let config
      try {
        config = await this.bili.readConfigStrict(where.configPath)
      } catch (error) {
        return this.recordBili({ status: 'rejected', at: Date.now(), hosts, origin: where.origin, error: messageOf(error) })
      }
      // The PUT replaces bili's whole `providers` table, so the plan has to be
      // built from the table that is there *now*. bili rewrites this file from
      // its own settings UI, and nothing in the protocol gives us a revision, so
      // the best available guard is to read once more and plan against that.
      try {
        config = await this.bili.readConfigStrict(where.configPath)
      } catch (error) {
        return this.recordBili({ status: 'rejected', at: Date.now(), hosts, origin: where.origin, error: messageOf(error) })
      }
      const plan = planProviders(config, hosts, proxy.url)
      if (plan.touched.length === 0) {
        return this.recordBili({ status: 'unchanged', at: Date.now(), hosts, origin: where.origin, error: undefined })
      }

      const snapshot = await this.bili.backup(this.store.dir, config).catch(() => undefined)
      const reply = await this.writeProviders(where.origin, plan.next.providers)
      if (reply.status < 200 || reply.status >= 300) {
        return this.recordBili({ status: 'rejected', at: Date.now(), hosts, origin: where.origin, error: `bili refused the config (${String(reply.status)}): ${String(reply.body).slice(0, 300)}` })
      }

      // Confirm by reading back: a 2xx only means the payload parsed.
      let verified = false
      try {
        const again = await this.bili.getConfig(where.origin)
        const effective = JSON.parse(again.text)
        verified = hosts.every((host) => {
          const entry = effective?.providers?.[`https://${host}`]
          return entry !== null && typeof entry === 'object' && entry.proxy === proxy.url
        })
      } catch {
        verified = false
      }

      // The FIRST record for a key wins. A later sync sees `touched` whose
      // `previous` is the value this plugin wrote itself, so letting the newer
      // record win would forget that the key was created here — and `revoke`
      // would "restore" our own proxy instead of deleting the entry.
      /** @type {Map<string, any>} */
      const byKey = new Map((Array.isArray(saved.written) ? saved.written : []).map((entry) => [entry.key, entry]))
      for (const entry of plan.touched) {
        const kept = byKey.get(entry.key)
        // `written` follows the newest value so `revoke` can prove the entry is
        // still the one we made; `previous`/`created` stay with the first
        // record so the entry is still deleted rather than "restored".
        if (kept === undefined) byKey.set(entry.key, entry)
        else if (entry.written !== undefined) kept.written = entry.written
      }
      const written = [...byKey.values()]
      return this.recordBili({
        status: verified ? 'applied' : 'applied-unverified',
        at: Date.now(),
        hosts,
        origin: where.origin,
        written,
        snapshot,
        proxy: proxy.url,
        proxyHosts: hosts,
        error: undefined,
        reason: options.reason,
      })
    } catch (error) {
      return this.recordBili({ status: 'error', at: Date.now(), error: messageOf(error) })
    } finally {
      this.biliBusy = false
    }
  }

  /**
   * Undo every provider entry this plugin wrote, restoring whatever was there
   * before. Only keys recorded in `written` are touched — the user's own
   * provider entries are never rewritten.
   */
  /** Send only the providers table, whichever seam is available. */
  async writeProviders(origin, providers) {
    const write = this.bili.putProviders
    // No implicit fallback: without a writer this must fail here, not reach for
    // whichever module function happens to be imported. A sandbox that forgets
    // to replace the writer would otherwise edit the real lane's config.
    if (typeof write !== 'function') throw refuse('this plugin has no way to write the lane config', 500)
    return write.call(this.bili, origin, providers)
  }

  /**
   * Remove exactly the entries this plugin added, restoring whatever was there
   * before. Shared by the manual button and by "the proxy disappeared / the
   * switch was turned off", because all three mean the same thing on the wire.
   */
  async revokeWritten(reason) {
    const saved = this.store.data.bili ?? {}
    const written = Array.isArray(saved.written) ? saved.written : []
    if (written.length === 0) return undefined
    const where = this.bili.locate()
    if (where === undefined) return undefined
    let config
    try {
      config = await this.bili.readConfigStrict(where.configPath)
    } catch (error) {
      // Undoing from a table we could not read would wipe the entries we did not
      // write; say so and keep the record so a later attempt can still undo.
      return this.recordBili({ status: 'rejected', at: Date.now(), error: messageOf(error) })
    }
    const reverted = revertProviders(config, written)
    await this.bili.backup(this.store.dir, config).catch(() => undefined)
    const reply = await this.writeProviders(where.origin, reverted.providers)
    if (reply.status < 200 || reply.status >= 300) {
      return this.recordBili({
        status: 'rejected',
        at: Date.now(),
        error: `bili refused the config (${String(reply.status)}): ${String(reply.body).slice(0, 300)}`,
      })
    }
    return this.recordBili({ status: 'revoked', at: Date.now(), written: [], error: undefined, reason })
  }

  async revokeBili(options = {}) {
    if (this.disposed === true) return { status: 'disposed' }
    if (this.biliBusy === true) return { status: 'busy' }
    this.biliBusy = true
    try {
      const done = await this.revokeWritten(options.reason ?? 'manual')
      return done ?? { status: 'nothing-to-revoke' }
    } catch (error) {
      return this.recordBili({ status: 'error', at: Date.now(), error: messageOf(error) })
    } finally {
      this.biliBusy = false
    }
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
  async gatewayState() {
    const saved = this.store.data.gateway ?? {}
    const handle = this.gatewayHandle
    return {
      enabled: saved.enabled === true,
      running: handle !== undefined && typeof handle.port === 'number',
      url: handle?.url,
      port: handle?.port,
      stats: handle?.stats?.(),
      // What the listener will do for hosts that need a proxy. Read from the
      // cached exit, so the panel can say "direct" honestly when the proxy app
      // is off — a routed provider that needs one would otherwise just hang.
      exit: this.gatewayExit === undefined
        ? undefined
        : {
          available: this.gatewayExit.available === true,
          url: this.gatewayExit.available === true ? this.gatewayExit.url : undefined,
          source: this.gatewayExit.source,
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
   * The live route table, rebuilt from settings rather than from state.
   *
   * Credentials are resolved by the settings layer on every pass, which is why
   * this file never has to hold an API key to serve a request: `previousBaseURL`
   * and the model-to-protocol map are the only things worth persisting.
   */
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
    this.gatewayExit = await this.proxyState()
    const handle = this.gateway.createGateway({
      // Called per request, so a route change never needs a restart.
      routes: () => this.gatewayRoutesCache,
      proxyFor: (host) => this.proxyForHost(host),
      hostNeedsProxy: (host) => DEFAULT_PROXY_HOSTS.includes(host),
      logger: this.logger,
    })
    const forbidden = await this.reservedPorts()
    await handle.start(this.store.data.gateway?.port ?? 0, forbidden)
    this.gatewayHandle = handle
    await this.recordGateway({ port: handle.port })
    // The exit is read synchronously per request, so it has to be kept fresh
    // while the listener lives: the proxy app may be turned on (or move ports)
    // long after the gateway started.
    this.armExitRefresh()
    return handle
  }

  /**
   * The proxy a gateway request to `host` should use, if any. Host filtering is
   * the server's job (`hostNeedsProxy`); this only answers "is there an exit".
   * `host` is accepted so the seam matches `hostNeedsProxy` if it ever needs it.
   */
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
    this.gatewayExit = await this.proxyState()
    return this.gatewayExit
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
      await this.reconcileGatewayPort(handle.port)
    } catch (error) {
      this.logger?.warn?.(`model-sync: the gateway did not start: ${messageOf(error)}`)
      await this.revertRoutedBases('the gateway did not start, so the routes were put back')
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
    /** @type {string | undefined} */
    let snapshot
    for (const [provider, row] of Object.entries(entries)) {
      const target = targets.find((candidate) => candidate.provider === provider)
      if (target === undefined) continue
      const wanted = `${url}/g/${row.routeId}`
      if (target.baseURL === wanted) continue
      if (typeof target.baseURL !== 'string' || target.baseURL.includes('/g/') !== true) continue
      // The only settings write in this plugin that used to run without a
      // snapshot: the old port is about to be forgotten, so keep it somewhere.
      snapshot ??= await this.store.snapshot('before-gateway-port', describeSections(settings))
      await this.write(target.settingsNs, () => [{
        op: 'set',
        path: ['providers', provider, 'baseURL'],
        value: wanted,
      }], target.revision).catch((error) => {
        this.logger?.warn?.(`model-sync: could not re-point ${provider} at the gateway: ${messageOf(error)}`)
      })
    }
  }

  /** Put every routed baseURL back the way it was and forget the routes. */
  async revertRoutedBases(reason) {
    const entries = { ...(this.store.data.gateway?.entries ?? {}) }
    if (Object.keys(entries).length === 0) return
    /** @type {string[]} */
    const unreverted = []
    const { targets } = await configuredTargets(this.ctx)
    for (const [provider, row] of Object.entries(entries)) {
      const target = targets.find((candidate) => candidate.provider === provider)
      if (target === undefined) continue
      const op = row.previousBaseURL === undefined
        ? { op: 'unset', path: ['providers', provider, 'baseURL'] }
        : { op: 'set', path: ['providers', provider, 'baseURL'], value: row.previousBaseURL }
      /** @type {any[]} */
      const ops = [op]
      if (row.inbound !== undefined) {
        ops.push(row.previousApi === undefined
          ? { op: 'unset', path: ['providers', provider, 'api'] }
          : { op: 'set', path: ['providers', provider, 'api'], value: row.previousApi })
      }
      // The entry is the only memory of the original baseURL. Dropping it on a
      // failed write would leave the route pointed at a gateway that is about to
      // stop, with nothing left to restore from.
      const failure = await this.write(target.settingsNs, () => ops, target.revision).then(
        () => undefined,
        (error) => messageOf(error),
      )
      if (failure === undefined) {
        delete entries[provider]
        continue
      }
      unreverted.push(`${provider}: ${failure}`)
    }
    const status = unreverted.length === 0 ? 'reverted' : 'revert-failed'
    const reasonText = unreverted.length === 0 ? reason : `${String(reason)} (${unreverted.join('; ')})`
    this.store.data.gateway = { ...(this.store.data.gateway ?? {}), entries, status, reason: reasonText }
    await this.store.save().catch(() => undefined)
    await this.refreshGatewayRoutes().catch(() => undefined)
    await this.stopGateway().catch(() => undefined)
  }

  /** Remember the gateway's own port so a restart reuses it instead of drifting. */
  async recordGateway(patch) {
    this.store.data.gateway = { ...(this.store.data.gateway ?? {}), ...patch }
    await this.store.save()
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
      const { targets } = await configuredTargets(this.ctx)
      const target = targets.find((row) => row.provider === options.provider)
      if (target === undefined) throw refuse(`provider "${options.provider}" is not configured`, 400)
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
      const exit = proxy.enabled === true && proxy.available === true ? parseProxy(proxy.url) : undefined
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
        upstreamBaseURL: target.baseURL,
        previousBaseURL: target.baseURL,
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
      await this.store.save()
      try {
        const handle = await this.ensureGateway()
        const baseURL = `${handle.url}/g/${routeId}`
        const snapshot = await this.store.snapshot('before-gateway-route', describeSections(settings))
        /** @type {any[]} */
        const ops = [{ op: 'set', path: ['providers', target.provider, 'baseURL'], value: baseURL }]
        if (lock !== undefined) ops.push({ op: 'set', path: ['providers', target.provider, 'api'], value: lock })
        await this.write(target.settingsNs, () => ops, target.revision)
        // The route now reads differently (baseURL, maybe api), and the server
        // compares each request against `tap`; leaving the cache stale would
        // mis-file every request until the next restart.
        await this.refreshGatewayRoutes().catch(() => undefined)
        return {
          provider: target.provider,
          baseURL,
          previousBaseURL: target.baseURL,
          inbound: lock,
          models: Object.keys(models).length,
          unattributed,
          blind: blind.map((attempt) => attempt.api),
          snapshot,
        }
      } catch (error) {
        // A half-done route is worse than none: drop the entry so the next panel
        // visit describes the machine as it actually is.
        const entries = { ...(this.store.data.gateway?.entries ?? {}) }
        delete entries[target.provider]
        this.store.data.gateway = { ...(this.store.data.gateway ?? {}), entries }
        await this.store.save()
        await this.refreshGatewayRoutes().catch(() => undefined)
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
      const { targets } = await configuredTargets(this.ctx)
      const target = targets.find((row) => row.provider === options.provider)
      const row = (this.store.data.gateway?.entries ?? {})[options.provider]
      if (row === undefined) throw refuse(`provider "${options.provider}" is not routed through the gateway`, 400)
      if (target === undefined) throw refuse(`provider "${options.provider}" is not configured`, 400)
      // Judged by the shape of the baseURL, not by a live listener: a stopped
      // gateway has no `url`, and that used to skip this guard entirely — so
      // undoing after a stop would overwrite whatever baseURL the user typed.
      const pointsHere = typeof target.baseURL === 'string' && target.baseURL.includes(`/g/${String(row.routeId)}`)
      if (target.baseURL !== undefined && pointsHere !== true) {
        throw refuse('this route no longer points at the gateway; edit the baseURL in Settings instead of undoing it here', 409)
      }
      const snapshot = await this.store.snapshot('before-gateway-unroute', describeSections(settings))
      // Models added while the protocol was locked exist only because the
      // gateway states one; putting the route back would leave pi-ai unable to
      // resolve them, and it fails the whole profile rather than those ids.
      const added = row.addedAfterRouting ?? []
      if (added.length > 0) {
        throw refuse(
          `这条路由里的 ${added.join(', ')} 是在收拢协议之后加进来的：它们本来由上游按各自协议服务，现在只有网关会翻译。撤销网关前请先在设置里把它们从这条路由移除，否则它们会被当成 ${String(row.inbound ?? '入站')} 直接打到上游。`,
          409,
        )
      }
      const ops = [row.previousBaseURL === undefined
        ? { op: 'unset', path: ['providers', target.provider, 'baseURL'] }
        : { op: 'set', path: ['providers', target.provider, 'baseURL'], value: row.previousBaseURL }]
      if (row.inbound !== undefined) {
        ops.push(row.previousApi === undefined
          ? { op: 'unset', path: ['providers', target.provider, 'api'] }
          : { op: 'set', path: ['providers', target.provider, 'api'], value: row.previousApi })
      }
      await this.write(target.settingsNs, () => ops, target.revision)
      const entries = { ...(this.store.data.gateway?.entries ?? {}) }
      delete entries[options.provider]
      this.store.data.gateway = { ...(this.store.data.gateway ?? {}), entries }
      await this.store.save()
      await this.refreshGatewayRoutes().catch(() => undefined)
      if (Object.keys(entries).length === 0) await this.stopGateway()
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
    let view = await this.view()
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (!Array.isArray(view.providers) || view.providers.length > 0) break
      await new Promise((resolve) => setTimeout(resolve, 250))
      view = await this.view()
    }
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
    const state = { ...this.store.data, selfCheck: undefined }
    return merge(
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
    this.store.data.hiddenModels = hidden
    try {
      await this.store.save()
      return hidden
    } catch (error) {
      if (this.store.data.hiddenModels === hidden) this.store.data.hiddenModels = previous
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

  async view() {
    const proxy = await this.proxyState()
    this.gatewayExit = proxy
    const { targets, problems } = await configuredTargets(this.ctx)
    /**
     * A state file this plugin could not read is archived by `Store.load()`;
     * saying so once is the difference between "the ledger is empty" and "the
     * ledger was replaced on purpose".
     */
    for (const notice of this.store.data.notices ?? []) {
      problems.push({ provider: 'state', reason: String(notice?.detail ?? notice) })
    }
    const checks = this.store.data.checks ?? {}
    const ignored = this.store.data.ignored ?? {}
    return {
      proxy,
      bili: await this.biliState(),
      gateway: await this.gatewayState(),
      legacy: this.legacySiblings(),
      schedule: this.store.data.schedule ?? DEFAULT_SCHEDULE,
      // Written by `runSelfCheck()` on boot and by the panel's 自检 button.
      selfCheck: this.store.data.selfCheck ?? undefined,
      summary: this.store.data.summary ?? undefined,
      lastCheckAt: stamp(this.store.data.summary?.at),
      hidden: this.visibility(),
      usage: [...this.modelUsage()],
      providers: targets.map((target) => {
        const check = checks[target.provider]
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
      problems,
      foreign: foreignProviderKeys(this.ctx),
      metadata: this.metadataView(targets),
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
   * @param {AbortSignal} [options.signal]
   */
  async check(options = {}) {
    if (this.busy !== undefined) throw new BusyError()
    this.busy = options.reason ?? 'manual'
    try {
      const { targets } = await configuredTargets(this.ctx)
      const selected = options.provider === undefined
        ? targets
        : targets.filter((target) => target.provider === options.provider)
      if (selected.length === 0) {
        throw Object.assign(new Error(options.provider === undefined ? 'no provider is configured' : `provider "${options.provider}" is not configured`), {
          status: 400,
          safe: true,
          publicMessage: options.provider === undefined ? 'no provider is configured' : `provider "${options.provider}" is not configured`,
        })
      }

      const proxy = await this.proxyState()
      this.gatewayExit = proxy
      const results = []
      for (const target of selected) {
        results.push(await this.checkOne(target, { signal: options.signal, proxy }))
      }

      // Fill metadata only after every provider answered, so one slow route does
      // not delay another route's check. Each write is revision-checked; a
      // conflict is skipped rather than replayed (the next check will retry).
      if (this.modelsDevLoader !== undefined && this.modelsDevIndex === undefined) {
        await this.refreshModelsDev().catch(() => undefined)
      }
      for (const target of selected) {
        try {
          // Multiple providers share one settings namespace, so each write
          // advances the revision the next provider must use.
          const fresh = await this.freshTarget(target.provider, target.settingsNs)
          await this.autoFillMetadata(fresh)
        } catch (error) {
          this.logger?.warn?.(`model-sync: metadata fill for ${target.provider} failed: ${messageOf(error)}`)
        }
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
      return { results, summary: this.store.data.summary }
    } finally {
      this.busy = undefined
    }
  }

  /** One provider's check; never throws, always records a status. */
  async checkOne(target, options) {
    const checks = this.store.data.checks ?? (this.store.data.checks = {})
    /** @type {any} */
    const previous = checks[target.provider]
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
    const routed = this.store.data.gateway?.entries?.[target.provider]
    const original = routed?.upstreamBaseURL ?? routed?.previousBaseURL
    const endpoint = target.adapter === 'deepseek' ? { baseURL: original ?? target.listingBaseURL }
      : endpointFor(typeof original === 'string' ? { ...target, baseURL: original } : target)
    if (endpoint.baseURL === undefined) {
      record.status = 'no-endpoint'
      record.protocol = target.api
      checks[target.provider] = record
      return { provider: target.provider, ...record }
    }

    const candidates = target.adapter === 'deepseek' ? ['deepseek-models'] : protocolLadder({
      configured: target.api,
      remembered: this.store.data.ladder?.[target.provider],
      hints: hintsFor(target),
    })
    const exit = options.proxy?.enabled === true && options.proxy?.available === true && !isLocalEndpoint(endpoint.baseURL)
      ? parseProxy(options.proxy.url)
      : undefined

    try {
      const listed = await this.list({
        baseURL: endpoint.baseURL,
        candidates,
        apiKey: target.apiKey,
        headers: target.headers,
        proxy: exit,
        timeoutMs: CHECK_TIMEOUT_MS,
        signal: options.signal,
      })
      const { added, gone } = diffModels({ upstream: listed.models, effective: target.effectiveIds })
      const ignored = new Set(this.store.data.ignored?.[target.provider] ?? [])
      record.status = 'ok'
      record.protocol = listed.api
      record.via = listed.via
      record.upstreamCount = listed.models.length
      record.complete = listed.complete !== false
      record.catalog = listed.models
      const old = new Map((previous?.catalog ?? []).map((model) => [model.id, model]))
      if (previous?.complete === true && record.complete) {
        record.upstreamNew = listed.models.filter(({ id }) => !old.has(id)).map(({ id }) => id)
        record.upstreamChanged = listed.models.filter((model) => {
          const prior = old.get(model.id)
          return prior && !isDeepStrictEqual(model, prior)
        }).map(({ id }) => id)
      }
      record.added = await Promise.all(added.filter((model) => !ignored.has(model.id)).map(async (model) => {
        const blocked = await this.candidateBlock(target, model)
        return { ...model, ...(blocked ? { blocked } : {}) }
      }))
      record.gone = record.complete ? gone : []
      // Only an answered-with-models listing confirms a protocol: a 200 whose
      // body has an empty `data` array is what a wrong path on a real gateway
      // looks like, and remembering it would pin the wrong protocol forever.
      if (listed.models.length > 0 && target.adapter !== 'deepseek') {
        this.store.data.ladder = { ...this.store.data.ladder, [target.provider]: listed.api }
      }
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error)
      if (previous?.status === 'ok' || previous?.lastSuccessAt !== undefined) {
        record.lastSuccessAt = previous.lastSuccessAt ?? previous.at
        record.added = previous.added ?? []
        record.upstreamCount = previous.upstreamCount
        record.catalog = previous.catalog
        record.complete = previous.complete
        record.upstreamNew = previous.upstreamNew
        record.upstreamChanged = previous.upstreamChanged
      }
    }
    checks[target.provider] = record
    return { provider: target.provider, ...record }
  }

  async candidateBlock(target, model) {
    if (target.hasModelOverrides) return '需先在 DSH 官方设置处理模型覆盖'
    if (target.adapter === 'deepseek' && model.blocked !== undefined) return model.blocked
    if (target.adapter === 'deepseek' && model.inputModalities !== undefined) return undefined
    const llm = this.ctx.get('llm')
    try {
      if (await llm?.resolveModelInfo?.(target.provider, model.id)) return undefined
    } catch {
      // A candidate outside the live catalog needs the route's explicit metadata.
    }
    const installed = await this.nativeCatalog(target.provider)
    const modelInCatalog = installed.find(({ id }) => id === model.id)
    if (modelInCatalog) return undefined
    const protocols = new Set(installed.map(({ api }) => api))
    if (target.api === undefined && protocols.size !== 1) return '待确认模型调用协议'
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
      const { targets } = await configuredTargets(this.ctx)
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
      const check = this.store.data.checks?.[options.provider]
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
        for (const id of wanted) {
          const blocked = await this.candidateBlock(target, known.get(id))
          if (blocked) throw refuse(`${id}：${blocked}。`)
        }
      }

      const routed = this.store.data.gateway?.entries?.[options.provider]
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
          proxy: proxy.enabled && proxy.available ? parseProxy(proxy.url) : undefined,
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
      const after = (await configuredTargets(this.ctx)).targets.find((row) => row.provider === options.provider)
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
          const candidates = await Promise.all(offeredAgain.map(async (model) => {
            const blocked = await this.candidateBlock(after, model)
            return blocked ? { ...model, blocked } : model
          }))
          check.added = [
            ...(check.added ?? []).filter((model) => !written.includes(model.id) && !removals.has(model.id)),
            ...candidates,
          ]
          if (check.gone !== undefined) check.gone = check.gone.filter((id) => !removals.has(id))
        }
        let hidden
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
      for (const field of ['contextWindow', 'maxTokens', 'reasoningEfforts']) {
        const value = extra[field] ?? model?.[field] ?? fallback?.[field]
        if (validFieldValue(field, value) === undefined) continue
        const official = model?.[field] !== undefined
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
      if (!['contextWindow', 'maxTokens', 'reasoningEfforts'].includes(field)) throw refuse('字段无效。', 400)
      const { targets } = await configuredTargets(this.ctx)
      const target = targets.find((row) => row.provider === options.provider)
      if (target === undefined) throw refuse('供应商不存在。', 400)
      if (!Array.isArray(target.modelEntries)) {
        throw refuse('该供应商使用继承目录，没有可编辑的显式模型字段。', 409)
      }
      const id = String(options.id ?? '')
      if (!safeLedgerKey(id)) throw refuse('模型标识包含不支持的保留字符。', 400)
      const index = target.modelEntries.findIndex((entry) =>
        entry !== null && typeof entry === 'object' && String(entry.id ?? '') === id)
      if (index < 0) throw refuse('模型不在当前供应商的显式清单中。', 409)
      let value = options.value
      if (field === 'reasoningEfforts') {
        value = normalizeReasoningEfforts(value)
        if (value === undefined) throw refuse('至少保留一个有效的推理档位。', 400)
      } else {
        if (!Number.isInteger(value) || value <= 0 || value > 1_000_000_000) throw refuse('请输入合理的正整数。', 400)
        if (field === 'maxTokens' && target.adapter === 'deepseek' &&
            Number.isInteger(target.modelMaxTokens) && target.modelMaxTokens > 0 && value > target.modelMaxTokens) {
          throw refuse(`超过该路由的最大输出上限 ${target.modelMaxTokens}。`, 400)
        }
      }
      const entries = target.modelEntries.map((entry, position) =>
        position === index ? { ...entry, [field]: value } : entry)
      await this.snapshotMetadata(target, 'metadata-update')
      try {
        await this.ctx.get('settings').mutate(target.settingsNs, [{
          op: 'set',
          path: [...target.settingsPath],
          value: entries,
        }], target.revision)
      } catch (error) {
        if (isConflict(error)) throw refuse('配置已被其他操作修改，请刷新后重试。', 409)
        throw error
      }
      const record = this.metadataRecord(target.provider, id)
      const recordBefore = structuredClone(record)
      // Deliberately not marked `external`: a value edited in this tab is still
      // provisional, so a later official answer may replace it. A value edited
      // directly in DSH settings is marked external by autoFill, but an official
      // answer still outranks it.
      record.fields[field] = { value, source: 'user', confidence: 'high', at: Date.now() }
      if (record.rejected?.[field] !== undefined) delete record.rejected[field]
      record.pending = Object.values(record.fields).some((row) => row.source !== 'official')
      this.metadataLog(target.provider, id, '手动修改', { field, to: value })
      try {
        await this.store.save()
      } catch (error) {
        restoreRecord(record, recordBefore)
        await this.restoreModelEntries(target, target.modelEntries)
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
      const { targets } = await configuredTargets(this.ctx)
      const target = targets.find((row) => row.provider === options.provider)
      if (target === undefined) throw refuse('供应商不存在。', 400)
      if (!Array.isArray(target.modelEntries)) {
        throw refuse('该供应商使用继承目录，没有可撤销的显式模型字段。', 409)
      }
      const id = String(options.id ?? '')
      if (!safeLedgerKey(id)) throw refuse('模型标识包含不支持的保留字符。', 400)
      const record = this.metadataState().records?.[target.provider]?.[id]
      if (record === undefined || record === null || typeof record !== 'object') {
        throw refuse('没有可撤销的补全记录。', 409)
      }
      if (record.fields === null || typeof record.fields !== 'object' || Array.isArray(record.fields)) {
        record.fields = {}
      }
      const recordBefore = structuredClone(record)
      const index = target.modelEntries.findIndex((entry) =>
        entry !== null && typeof entry === 'object' && String(entry.id ?? '') === id)
      if (index < 0) throw refuse('模型已不在当前供应商的显式清单中。', 409)
      const entry = target.modelEntries[index]
      const deletions = new Set()
      const adoptions = []
      const cleared = new Set()
      for (const [field, row] of Object.entries(record.fields ?? {})) {
        if (row?.source !== 'models.dev') continue
        const current = entry[field]
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
        record.rejected ??= Object.create(null)
        for (const field of cleared) {
          delete record.fields[field]
          record.rejected[field] = Date.now()
        }
        // A reverted models.dev value must stay reverted: without this tombstone
        // the next startup/check would silently write the same fallback again.
        for (const field of deletions) record.rejected[field] = Date.now()
        record.pending = Object.values(record.fields ?? {}).some((row) => row.source !== 'official')
      }
      if (deletions.size === 0) {
        if (adoptions.length === 0 && cleared.size === 0) {
          throw refuse('这条记录没有可撤销的自动补全字段。', 409)
        }
        adoptLedger()
        this.metadataLog(target.provider, id, '保留手动值', {
          note: '设置中的字段已与补全值不同，撤销不会删除它',
        })
        try {
          await this.store.save()
        } catch (error) {
          restoreRecord(record, recordBefore)
          throw error
        }
        this.metadataNotice = '检测到手动修改，已保留你的值；没有可删除的自动补全字段。'
        return this.view()
      }
      const entries = target.modelEntries.map((candidate, position) => {
        if (position !== index) return candidate
        const next = { ...candidate }
        for (const field of deletions) delete next[field]
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
      await this.snapshotMetadata(target, 'metadata-revert')
      try {
        await this.ctx.get('settings').mutate(target.settingsNs, [{
          op: 'set',
          path: [...target.settingsPath],
          value: entries,
        }], target.revision)
      } catch (error) {
        if (isConflict(error)) throw refuse('配置已被其他操作修改，请刷新后重试。', 409)
        throw error
      }
      for (const field of deletions) delete record.fields[field]
      adoptLedger()
      this.metadataLog(target.provider, id, '撤销补全', adoptions.length > 0 ? {
        note: '手动修改的字段已保留',
      } : {})
      try {
        await this.store.save()
      } catch (error) {
        restoreRecord(record, recordBefore)
        await this.restoreModelEntries(target, target.modelEntries)
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
      const { targets } = await configuredTargets(this.ctx)
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
      const { targets } = await configuredTargets(this.ctx)
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

  /**
   * The synthetic providers the previous plugin created: `<base>-chat`,
   * `<base>-messages`, `<base>-responses` beside a real `<base>`.
   *
   * They exist because the old version had to give each wire protocol its own
   * route. They are also the reason the Models page grew cards nobody asked
   * for, so the panel offers to remove them. Detection is deliberately narrow:
   * the parent route must still exist, and the name must carry a protocol
   * suffix — a provider someone named "opencode-chat" by hand is left alone
   * unless the parent it shadows is present.
   */
  legacySiblings() {
    /** @type {{ns: string, provider: string, parent: string, api?: string, baseURL?: string}[]} */
    const found = []
    for (const descriptor of describeSections(this.ctx.get('settings'))) {
      const value = descriptor.value
      if (value === null || typeof value !== 'object') continue
      const table = /** @type {any} */ (value)['providers']
      if (table === null || typeof table !== 'object') continue
      // Same predicate `configuredTargets` uses to hide them, so the list the
      // panel offers to delete and the list it offers to manage cannot drift.
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
    const { targets } = await configuredTargets(this.ctx)
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
        map.set(id, {
          contextWindow: window,
          maxTokens,
          ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
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
        if (Array.isArray(info?.inputModalities) && info.inputModalities.length > 0) entry['inputModalities'] = [...info.inputModalities]
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

  /** Remember an edited setting (proxy override, schedule, ignored ids). */
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
      if (patch.bili !== undefined) await this.syncBili({ reason: 'settings' })
      return this.view()
    } finally {
      this.busy = undefined
    }
  }
}
