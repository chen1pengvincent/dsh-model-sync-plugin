/** Catalog changes are U (last complete upstream listing) minus B (last viewed
 * listing), never U minus the models enabled in DSH. No credentials live here. */
import { randomUUID } from 'node:crypto';

const HISTORY_LIMIT = 16;
const sameIds = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);

export function catalogSummary(record) {
  if (!record) return undefined;
  const current = new Set(record.ids);
  const seen = new Set(record.seenIds);
  const addedIds = record.ids.filter((id) => !seen.has(id));
  const removedIds = record.seenIds.filter((id) => !current.has(id));
  return {
    revision: `${record.generation}:${record.serial}`,
    total: record.ids.length,
    addedIds,
    removedIds,
    addedCount: addedIds.length,
    removedCount: removedIds.length,
    changedCount: addedIds.length + removedIds.length,
    // A baseline that has not been expanded yet is only "first discovery" when
    // it carries no delta; a model that appears before the first expansion must
    // still be counted and tagged rather than silently folded into the baseline.
    firstDiscovery: record.firstViewedAt === null && addedIds.length === 0 && removedIds.length === 0,
    checkedAt: record.checkedAt,
    changedAt: record.changedAt,
  };
}

export function updateCatalog(previous, scope, models, { base, at = Date.now(), allowEmpty = false } = {}) {
  if (!Array.isArray(models) || models.some((model) => typeof model?.id !== 'string' || !model.id.trim())) {
    throw new Error('模型目录为空或不完整；保留上次成功目录');
  }
  if (!allowEmpty && models.length === 0) throw new Error('模型目录为空或不完整；保留上次成功目录');
  const ids = [...new Set(models.map((model) => model.id))].sort();
  if (ids.length !== models.length) throw new Error('模型目录包含重复 ID；保留上次成功目录');
  const initial = !previous || previous.scope !== scope;
  const record = initial ? {
    scope,
    generation: randomUUID(),
    serial: 1,
    seenSerial: 1,
    seenIds: ids,
    firstViewedAt: null,
    changedAt: at,
    history: [],
    filtered: true,
  } : structuredClone(previous);
  if (!initial && !sameIds(ids, record.ids)) {
    record.history.push({ serial: record.serial, ids: record.ids });
    record.history = record.history.slice(-HISTORY_LIMIT);
    record.serial += 1;
    record.changedAt = at;
  }
  // Catalogs written before display filtering stored every upstream row. Moving
  // to the visible-only baseline must not surface the filtered rows as one huge
  // "removed" delta: adopt the current visible set as the acknowledged baseline.
  if (!initial && record.filtered !== true) {
    record.seenIds = ids;
    record.seenSerial = record.serial;
  }
  record.filtered = true;
  record.ids = ids;
  record.models = structuredClone(models);
  record.base = base;
  record.checkedAt = at;
  return record;
}

/** A receipt is tied to the EXACT rendered revision. A late receipt may advance
 * B to R, never to R+1; old tabs cannot roll B back. Expired receipts do nothing. */
export function acknowledgeCatalog(record, revision, at = Date.now()) {
  if (!record || typeof revision !== 'string') return { acknowledged: false, reason: 'missing-catalog' };
  const prefix = `${record.generation}:`;
  if (!revision.startsWith(prefix)) return { acknowledged: false, reason: 'changed-scope' };
  const serial = Number(revision.slice(prefix.length));
  if (!Number.isSafeInteger(serial) || serial < 1 || `${prefix}${serial}` !== revision) {
    return { acknowledged: false, reason: 'invalid-revision' };
  }
  if (serial > record.serial) return { acknowledged: false, reason: 'unknown-revision' };
  if (serial < record.seenSerial) return { acknowledged: false, reason: 'already-superseded' };
  const snapshot = serial === record.serial ? record.ids : record.history.find((item) => item.serial === serial)?.ids;
  if (!snapshot) return { acknowledged: false, reason: 'expired-revision' };
  record.seenIds = [...snapshot];
  record.seenSerial = serial;
  record.firstViewedAt ??= at;
  record.history = record.history.filter((item) => item.serial > serial);
  return { acknowledged: true, catalog: catalogSummary(record) };
}
