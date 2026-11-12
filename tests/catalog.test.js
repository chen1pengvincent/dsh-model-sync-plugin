import { test } from 'node:test';
import assert from 'node:assert/strict';

import { acknowledgeCatalog, catalogSummary, updateCatalog } from '../lib/catalog.js';

test('a delta before the first expansion is surfaced, not folded into the baseline', () => {
  const first = updateCatalog(undefined, 'scope', [{ id: 'a' }, { id: 'b' }]);
  assert.equal(catalogSummary(first).firstDiscovery, true);
  assert.equal(catalogSummary(first).changedCount, 0);

  const second = updateCatalog(first, 'scope', [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  const summary = catalogSummary(second);
  assert.equal(summary.firstDiscovery, false, 'an unseen delta must be counted even before the first expansion');
  assert.deepEqual(summary.addedIds, ['c']);
  assert.equal(summary.changedCount, 1);

  const receipt = acknowledgeCatalog(second, summary.revision);
  assert.equal(receipt.acknowledged, true);
  assert.equal(catalogSummary(second).changedCount, 0, 'the first full expansion consumes the delta');
});

test('a first baseline without changes still reports first discovery', () => {
  const record = updateCatalog(undefined, 'scope', [{ id: 'a' }]);
  assert.equal(catalogSummary(record).firstDiscovery, true);
});

test('pre-filter catalogs adopt the visible baseline instead of reporting removals', () => {
  const rows = (...ids) => ids.map((id) => ({ id }));
  let record = updateCatalog(undefined, 'scope-A', rows('a', 'b', 'c'), { at: 1 });
  // Simulate a catalog written by an older build that stored every upstream row.
  delete record.filtered;
  record.seenIds = ['a', 'b', 'c'];
  record.seenSerial = record.serial;
  const next = updateCatalog(record, 'scope-A', rows('a', 'b'), { at: 2 });
  assert.deepEqual(catalogSummary(next).removedIds, [], 'filtered rows are not a removal delta');
  assert.deepEqual(catalogSummary(next).addedIds, []);
  assert.deepEqual(next.seenIds, ['a', 'b']);
  assert.equal(next.filtered, true);
});
