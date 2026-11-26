/** Field validation and read-only projections shared by metadata review and writes. */
import { isDeepStrictEqual } from 'node:util'

import { lookupModelsDev, metadataFor } from './models-dev.js'

/** Object keys that would alias a prototype slot if used as a ledger key. */
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

/** Whether a provider/model id is safe as a plain-object key in the ledger. */
export function safeLedgerKey(value) {
  return typeof value === 'string' && value.length > 0 && !RESERVED_KEYS.has(value)
}

export function isLedgerObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
export function normalizeReasoningEfforts(value) {
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

/** Fields the metadata ledger tracks, in display order. */
export const METADATA_FIELDS = ['contextWindow', 'maxTokens', 'reasoningEfforts', 'input']
const REVIEW_REQUIRED = ['contextWindow', 'maxTokens', 'input']
export const REVIEW_INPUTS = ['text', 'image', 'audio', 'video', 'pdf']

export function ordinaryReminderSignatures({ issues, fields }) {
  return issues.filter(({ kind }) => kind !== 'conflict').map((issue) => {
    const field = fields[issue.field]
    const value = field?.candidate
    const comparable = value && !Array.isArray(value) && typeof value === 'object' ? Object.entries(value).sort() : value
    return JSON.stringify([issue, comparable, field?.candidateSource])
  })
}

export function reviewInput(value) {
  if (!Array.isArray(value)) return undefined
  const categories = value.map((item) => typeof item === 'string'
    ? item === 'application/pdf' ? 'pdf' : item.split('/')[0]
    : undefined)
  const modes = REVIEW_INPUTS.filter((mode) => categories.includes(mode))
  return modes.length ? modes : undefined
}

/** Only the input modalities DSH can express, with `text` required. */
export function normalizeInput(value) {
  if (!Array.isArray(value)) return undefined
  const input = []
  for (const item of value) {
    if ((item === 'text' || item === 'image') && !input.includes(item)) input.push(item)
  }
  if (!input.includes('text')) return undefined
  return ['text', ...input.filter((item) => item !== 'text')]
}

/**
 * The settings key for a logical metadata field. The DeepSeek adapter names
 * the capability `inputModalities`; pi-ai names it `input`.
 */
export function entryFieldFor(target, field) {
  return field === 'input' && target?.adapter === 'deepseek' ? 'inputModalities' : field
}

/** Whether a logical input value is absent (undefined or an empty list). */
export function inputMissing(value) {
  return value === undefined || (Array.isArray(value) && value.length === 0)
}

/** First non-empty input capability among the candidates. */
export function firstInput(...values) {
  for (const value of values) {
    const input = normalizeInput(value)
    if (input !== undefined) return input
  }
  return undefined
}

/** A field value the DSH schema can accept, or undefined for junk. */
export function validFieldValue(field, value) {
  if (field === 'reasoningEfforts') return normalizeReasoningEfforts(value)
  if (field === 'input') return normalizeInput(value)
  return Number.isInteger(value) && value > 0 && value <= 1_000_000_000 ? value : undefined
}

/** The tab's data: only model entries whose values are not official, and only for live routes. */
export function metadataView(targets, metadata) {
  const byProvider = new Map(targets.map((target) => [target.provider, target]))
  const models = []
  for (const [provider, rows] of Object.entries(metadata.records)) {
    const target = byProvider.get(provider)
    if (target === undefined || !isLedgerObject(rows)) continue
    if (!Array.isArray(target.modelEntries)) continue
    const effective = new Set(target.effectiveIds)
    const entries = new Map()
    for (const entry of target.modelEntries) {
      if (entry === null || typeof entry !== 'object') continue
      const id = String(entry.id ?? '')
      if (!entries.has(id)) entries.set(id, entry)
    }
    for (const [id, record] of Object.entries(rows)) {
      if (!safeLedgerKey(id) || !isLedgerObject(record)) continue
      if (!effective.has(id)) continue
      if (record.pending === false && Object.keys(record.fields ?? {}).length === 0) continue
      const entry = entries.get(id)
      if (entry === undefined) continue
      const fields = {}
      let untrusted = false
      let missing = 0
      let hasUser = false
      // Start at "no models.dev field"; a low field wins over a medium one so
      // the filter matches the worst provenance on the card.
      let rank = 3
      for (const field of METADATA_FIELDS) {
        const fieldKey = entryFieldFor(target, field)
        const row = record.fields?.[field]
        const live = validFieldValue(field, entry[fieldKey])
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
    lastSync: metadata.lastSync,
  }
}

/** Project the evidence and decisions for one route without changing its ledger. */
export function reviewModels(target, { routeIdentity, check, records, gatewayOffline, modelsDevIndex }, requestedIds) {
  const provider = target.provider
  const catalog = new Map((check?.catalog ?? []).map((model) => [model.id, model]))
  const published = new Map((target.effectiveModels ?? []).map((model) => [String(model.id), model]))
  const entries = new Map((target.modelEntries ?? []).filter((row) => typeof row?.id === 'string').map((row) => [row.id, row]))
  const blocked = new Map((check?.added ?? []).filter((row) => row.blocked).map((row) => [row.id, row.blocked]))
  const gone = new Set(check?.status === 'ok' && check.complete ? check.gone : [])
  const ids = new Set([...target.effectiveIds, ...catalog.keys()])
  const selected = requestedIds === undefined ? [...ids] : requestedIds.filter((id) => ids.has(id))
  return selected.filter(safeLedgerKey).map((id) => {
    const record = records?.[id]
    const entry = entries.get(id)
    const upstream = catalog.get(id)
    const facts = check?.reviewFacts?.[id] ?? {}
    const exact = modelsDevIndex && lookupModelsDev(modelsDevIndex, provider, id)?.model
    const aggregate = exact && metadataFor(modelsDevIndex, provider, id)
    const fields = {}
    const issues = []
    for (const name of METADATA_FIELDS) {
      const key = entryFieldFor(target, name)
      const actual = validFieldValue(name, entry?.[key])
      const ledger = record?.fields?.[name]
      const official = name === 'input' ? reviewInput(facts.input) : validFieldValue(name, facts[name])
      const suggestion = name === 'input' ? reviewInput(exact?.modalities?.input) : validFieldValue(name, aggregate?.[name])
      const matched = actual !== undefined && isDeepStrictEqual(actual, ledger?.value)
      const legacyManual = actual !== undefined && (!matched || ledger?.source === 'user')
      const savedInput = name === 'input' && reviewInput(record?.reviewInput?.value)
      const accepted = matched && ledger?.reviewPinned === true
      const confirmed = matched && ledger?.source === 'official' ? actual : undefined
      const value = savedInput || (legacyManual || accepted ? actual : official ?? confirmed)
      const source = savedInput ? record.reviewInput.source : legacyManual ? 'user' : accepted ? ledger.source
        : official !== undefined ? 'official' : confirmed !== undefined ? 'host' : undefined
      const observed = actual !== undefined && !isDeepStrictEqual(actual, value) ? actual : undefined
      const candidate = official ?? suggestion
      fields[name] = { value, source, observed, candidate, locked: accepted, candidateSource: official !== undefined ? 'official' : suggestion !== undefined ? 'models.dev' : undefined }
      const hostDisagrees = name !== 'input' && observed !== undefined && !isDeepStrictEqual(official, observed)
      if (official !== undefined && value !== undefined && (!isDeepStrictEqual(official, value) || hostDisagrees)) issues.push({ kind: 'conflict', field: name, value: official })
      else if (REVIEW_REQUIRED.includes(name) && value === undefined) issues.push({ kind: 'missing', field: name })
    }
    if (blocked.has(id) && !published.has(id)) issues.push({ kind: 'route', text: blocked.get(id) })
    if (gatewayOffline) issues.push({ kind: 'gateway' })
    if (gone.has(id)) issues.push({ kind: 'absent' })
    const fingerprint = JSON.stringify(issues)
    const previousDecision = record?.reviewDecision
    const ignored = previousDecision?.action === 'ignore' && previousDecision.routeIdentity === routeIdentity
      ? previousDecision.signatures : []
    const pendingOrdinary = ordinaryReminderSignatures({ issues, fields }).some((signature) => !ignored?.includes(signature))
    const conflict = issues.some(({ kind }) => kind === 'conflict')
    const evidence = Object.values(fields).some((field) => field.candidate !== undefined || field.source === 'host')
    const level = !evidence || conflict ? 'unverified'
      : REVIEW_REQUIRED.every((name) => {
        const field = fields[name]
        return field.candidateSource === 'official' && isDeepStrictEqual(field.value, field.candidate)
      }) ? 'official' : 'partial'
    return {
      provider, routeKey: target.key, id, displayName: target.displayName,
      name: entry?.name ?? upstream?.name ?? published.get(id)?.name ?? id,
      fields, issues, fingerprint, level,
      pending: conflict || pendingOrdinary,
      keepable: entry !== undefined && issues.some(({ kind, field }) => kind === 'conflict' && !fields[field].locked &&
        validFieldValue(field, entry[entryFieldFor(target, field)]) !== undefined),
      edited: Object.values(fields).some((field) => field.source === 'user'),
      canWrite: entry !== undefined && !target.hasModelOverrides,
      canRevert: Object.values(record?.fields ?? {}).some((field) => field?.source === 'models.dev' && !field.reviewPinned),
      revision: target.revision,
      reviewRevision: record?.reviewRevision ?? 0,
      updatedAt: Math.max(check?.lastSuccessAt ?? (check?.status === 'ok' ? check.at : 0), record?.log?.at(-1)?.at ?? 0),
      inputAvailable: reviewInput(published.get(id)?.inputModalities ?? entry?.[entryFieldFor(target, 'input')])?.filter((mode) => mode === 'text' || mode === 'image'),
      protocol: target.api,
    }
  })
}

export function reviewHistory(checks, journal, logs) {
  const latest = Object.entries(checks).flatMap(([provider, check]) => check?.at && !journal.some((row) => row.type === 'check' && row.provider === provider && row.at === check.at)
    ? [{ at: check.at, provider, type: 'check', status: check.status, title: check.status === 'ok' ? `检查 ${check.upstreamCount} 个模型` : check.status === 'no-endpoint' ? '缺少目录端点' : '目录检查失败' }]
    : [])
  return [...journal, ...latest, ...logs.map((row) => ({
    ...row, type: 'field', title: row.message, model: row.modelId,
  }))].sort((left, right) => right.at - left.at).slice(0, 200)
}
