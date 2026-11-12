import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

// A deliberately small React commit harness, isolated in a VM. No real API,
// credentials, DOM, profile, or dependencies are accessed by these tests.
function loadClient(respond = () => { throw new Error('Unexpected API request'); }, environment = {}) {
  let active;
  let dirty = false;
  let root;
  let props;
  let tree;
  let effects = [];
  const frames = new Map();
  const calls = [];
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const React = {
    createElement(type, properties, ...children) {
      return { type, props: { ...properties, children: children.length === 1 ? children[0] : children } };
    },
    useState(initial) {
      const frame = active;
      const index = frame.cursor++;
      if (!(index in frame.hooks)) frame.hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [frame.hooks[index], (value) => {
        frame.hooks[index] = typeof value === 'function' ? value(frame.hooks[index]) : value;
        dirty = true;
      }];
    },
    useRef(initial) {
      const index = active.cursor++;
      return active.hooks[index] ??= { current: initial };
    },
    useMemo(factory, deps) {
      const index = active.cursor++;
      const old = active.hooks[index];
      if (!old || !sameDeps(old.deps, deps)) active.hooks[index] = { deps, value: factory() };
      return active.hooks[index].value;
    },
    useCallback(callback, deps) { return React.useMemo(() => callback, deps); },
    useEffect(effect, deps) {
      const frame = active;
      const index = frame.cursor++;
      const old = frame.hooks[index];
      if (!old || !sameDeps(old.deps, deps)) {
        const hook = { deps, cleanup: old?.cleanup };
        frame.hooks[index] = hook;
        effects.push(() => { hook.cleanup?.(); hook.cleanup = effect(); });
      }
    },
  };
  let exports;
  vm.runInNewContext(source, {
    ...environment.globals,
    window: { ...environment.window, __ModuleLoader__: { load({ factory }) {
      exports = factory((name) => {
        if (name === 'react') return React;
        if (environment.modules?.[name]) return environment.modules[name];
        throw new Error(`Unavailable optional module: ${name}`);
      });
    } } },
    AbortSignal: { timeout: () => undefined },
    fetch: async (url, init) => {
      const call = { path: url.replace('/model-sync/api', ''), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined };
      calls.push(call);
      const body = await respond(call);
      return { ok: true, json: async () => body };
    },
    console,
  }, { filename: 'client.js' });

  const materialize = (node, path) => {
    if (Array.isArray(node)) return node.map((child, index) => materialize(child, `${path}/${child?.props?.key ?? index}`));
    if (node == null || typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      let frame = frames.get(path);
      if (!frame || frame.type !== node.type) {
        frame = { type: node.type, hooks: [], cursor: 0 };
        frames.set(path, frame);
      }
      frame.cursor = 0;
      const parent = active;
      active = frame;
      const output = node.type(node.props);
      active = parent;
      return materialize(output, `${path}/output`);
    }
    environment.attachRef?.(node);
    return { ...node, props: { ...node.props, children: materialize(node.props.children, `${path}/children`) } };
  };
  const render = (nextRoot = root, nextProps = props, commit = true) => {
    root = nextRoot;
    props = nextProps;
    dirty = false;
    effects = [];
    tree = materialize(React.createElement(root, props), 'root');
    const pending = effects;
    effects = [];
    if (commit) for (const effect of pending) effect();
    return tree;
  };
  const flush = async () => {
    for (let i = 0; i < 24; i++) {
      await Promise.resolve();
      if (dirty) render();
    }
    return tree;
  };
  return { ...exports.__test, calls, render, flush, get tree() { return tree; } };
}

function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((child) => nodes(child, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props.children, predicate)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree == null || typeof tree === 'boolean') return '';
  if (typeof tree !== 'object') return String(tree);
  return text(tree.props.children);
}
function button(tree, name) {
  const matches = nodes(tree, (node) => node.type === 'button' && (typeof name === 'string' ? text(node) === name : name.test(text(node))));
  assert.equal(matches.length, 1, `Expected one button: ${name}; found ${matches.length}`);
  return matches[0];
}
function rowCheckbox(tree, id) {
  const row = nodes(tree, (node) => node.type === 'label' && node.props.key === id);
  assert.equal(row.length, 1, `Expected model row ${id}`);
  return nodes(row[0], (node) => node.type === 'input' && node.props.type === 'checkbox')[0];
}
const tags = (tree) => nodes(tree, (node) => node.props['data-catalog-new']).map((node) => node.props['data-catalog-new']);
const noop = () => {};

function result(overrides = {}) {
  const provider = overrides.provider ?? 'opaque-instance-A';
  const allItems = overrides.allItems ?? [
    { id: 'new', name: 'New model', target: provider, api: 'openai-responses', status: 'available', removable: false },
    { id: 'enabled', name: 'Enabled model', target: provider, api: 'openai-responses', status: 'added', added: true, removable: true },
  ];
  const skipped = overrides.skipped ?? [
    { id: 'skipped', name: 'Not compatible', status: 'skipped', reason: 'Unsupported model', reasonCode: 'non-chat' },
  ];
  return {
    provider, displayName: 'OpenAI 官方 · Work', adapter: 'pi-ai', status: 'ok', settingsRevision: 7,
    allItems, skipped, newItems: allItems.filter((item) => item.status === 'available'), removed: [], repairs: [],
    ...overrides,
    catalog: {
      revision: 'R1', total: allItems.length, addedIds: ['enabled', 'new'], removedIds: ['gone'],
      addedCount: 2, removedCount: 1, changedCount: 3, firstDiscovery: false, checkedAt: 10, changedAt: 10,
      ...overrides.catalog,
    },
  };
}
function cardProps(client, value, extra = {}) {
  return {
    result: value, expanded: true, expansion: client.captureExpansion(value), onToggle: noop,
    checked: new Set(), removals: new Set(), toggle: noop, toggleRemoval: noop, setMany: noop, clearProvider: noop,
    query: '', setQuery: noop, filter: 'all', setFilter: noop, showAll: true, setShowAll: noop,
    managed: true, onManagedChange: noop, busy: false, onViewed: noop, ...extra,
  };
}
function state(results) {
  return { lastCheck: { at: 100, results }, managed: results.map((item) => ({ provider: item.provider, displayName: item.displayName, managed: true })) };
}

test('catalog counters are independent of addable/enabled rows and initial discovery is a baseline', () => {
  const client = loadClient();
  const value = result();
  assert.equal(client.providerName(value), 'OpenAI 官方 · Work');
  assert.equal(client.catalogSummary(value.catalog), '目录2个 · 变化3项（新增2 / 移除1）');
  assert.equal(value.newItems.length, 1);
  const first = result({ catalog: { firstDiscovery: true, addedIds: [], addedCount: 0, removedIds: [], removedCount: 0, changedCount: 0 } });
  assert.equal(client.catalogSummary(first.catalog), '首次发现2个 · 已建立目录基线');
  assert.deepEqual(plain(client.captureExpansion(first).addedIds), []);
});

test('receipts require a successful complete unique directory, including zero-row deletion updates', () => {
  const client = loadClient();
  const value = result();
  const opening = client.captureExpansion(value);
  const can = (next = value, expansion = opening, query = '', filter = 'all', count = 2) => client.canAcknowledgeCatalog(next, expansion, query, filter, count);
  assert.equal(can(), true);
  for (const status of ['discovery-failed', 'unsupported', 'needs-check', 'unmanaged']) assert.equal(can({ ...value, status }), false);
  assert.equal(can({ ...value, stale: true }), false);
  assert.equal(can(value, null), false);
  assert.equal(can(value, opening, 'new'), false);
  assert.equal(can(value, opening, '', 'added'), false);
  assert.equal(can(value, opening, '', 'all', 1), false);
  assert.equal(can({ ...value, allItems: value.allItems.slice(0, 1) }), false);
  assert.equal(can({ ...value, allItems: [value.allItems[0], value.allItems[0]] }), false);
  assert.equal(can(result({ catalog: { revision: 'R2' } })), false);
  const failedOpening = client.captureExpansion({ ...value, status: 'discovery-failed' });
  assert.equal(can(value, failedOpening), false, 'recovery must not consume an opening made in an error state');
  const empty = result({ allItems: [], catalog: { total: 0, addedIds: [], addedCount: 0, changedCount: 1 } });
  assert.equal(client.canAcknowledgeCatalog(empty, client.captureExpansion(empty), '', 'all', 0), true);
});

test('R receipt never clears R+1 or a failed/stale result; expansion is a separate immutable snapshot', () => {
  const client = loadClient();
  const value = result();
  const opening = client.captureExpansion(value);
  value.catalog.addedIds.push('later-mutation');
  assert.deepEqual(plain(opening.addedIds), ['enabled', 'new']);
  const cleared = { ...value.catalog, addedIds: [], removedIds: [], addedCount: 0, removedCount: 0, changedCount: 0 };
  const receipt = { acknowledged: true, catalog: cleared };
  const current = state([value]);
  assert.equal(client.mergeViewedCatalog(current, value.provider, 'R1', receipt).lastCheck.results[0].catalog.changedCount, 0);
  for (const next of [result({ catalog: { revision: 'R2' } }), { ...value, status: 'discovery-failed' }, { ...value, stale: true }]) {
    const newer = state([next]);
    assert.equal(client.mergeViewedCatalog(newer, value.provider, 'R1', receipt), newer);
  }
  assert.equal(client.mergeViewedCatalog(current, value.provider, 'R1', { acknowledged: false, catalog: cleared }), current);
  assert.equal(client.mergeViewedCatalog(current, value.provider, 'R1', { acknowledged: true, catalog: { ...cleared, revision: 'R2' } }), current);
});

test('drafts enforce editable rows and retain the displayed CAS revision in one atomic apply body', () => {
  const client = loadClient();
  const value = result();
  let drafts = client.updateDraft({}, value, ['new', 'skipped', 'enabled'], true);
  drafts = client.updateDraft(drafts, value, ['enabled', 'new', 'skipped'], true, 'removals');
  assert.deepEqual([...drafts[value.provider].checked], ['new']);
  assert.deepEqual([...drafts[value.provider].removals], ['enabled']);
  const newer = { ...value, settingsRevision: 8 };
  assert.equal(client.updateDraft(drafts, newer, ['new'], false), drafts);
  for (const status of ['discovery-failed', 'unsupported', 'needs-check', 'unmanaged']) {
    assert.equal(client.updateDraft(drafts, { ...value, status }, ['new'], false), drafts);
    assert.equal(Object.keys(client.buildApplyRequest(drafts, [{ ...value, status }]).submitted).length, 0);
  }
  const request = client.buildApplyRequest(drafts, [newer]);
  assert.deepEqual(plain(request.body), {
    selections: { 'opaque-instance-A': ['new'] }, removals: [{ provider: 'opaque-instance-A', id: 'enabled' }],
    expectedRevisions: { 'opaque-instance-A': 7 }, repairs: false, recheck: true, rememberHabit: true,
  });
  const protectedRow = result({ allItems: [{ ...value.allItems[1], removable: false }] });
  assert.equal(Object.keys(client.updateDraft({}, protectedRow, ['enabled'], true, 'removals')).length, 0);
});

test('partial and conflicted saves only clear explicitly successful submitted drafts', () => {
  const client = loadClient();
  const a = result();
  const b = result({ provider: 'opaque-instance-B', displayName: 'OpenAI 官方 · Personal' });
  let drafts = client.updateDraft({}, a, ['new'], true);
  drafts = client.updateDraft(drafts, b, ['enabled'], true, 'removals');
  const { submitted } = client.buildApplyRequest(drafts, [a, b]);
  const outcome = { applied: [{ provider: a.provider, added: 1, removed: 0 }], errors: [{ provider: b.provider, reason: 'revision-conflict' }] };
  const remaining = client.clearAppliedDrafts(drafts, submitted, outcome);
  assert.equal(remaining[a.provider], undefined);
  assert.equal(remaining[b.provider], drafts[b.provider]);
  const changed = { ...drafts, [a.provider]: { ...drafts[a.provider], checked: new Set(['new', 'other']) } };
  assert.equal(client.clearAppliedDrafts(changed, submitted, outcome)[a.provider], changed[a.provider]);
  assert.equal(client.clearAppliedDrafts(drafts, submitted, { ...outcome, errors: [{ provider: a.provider, reason: 'partial-error' }] })[a.provider], drafts[a.provider]);
});

test('React commit acknowledges once, retains enabled/new tags through receipt, and does not consume a background revision', () => {
  const client = loadClient();
  const value = result();
  const viewed = [];
  let props = cardProps(client, value, { expanded: false, onViewed: (...args) => viewed.push(args) });
  client.render(client.ProviderCard, props);
  assert.equal(viewed.length, 0);
  assert.deepEqual(tags(client.tree), []);
  props = { ...props, expanded: true };
  client.render(client.ProviderCard, props);
  assert.equal(viewed.length, 1);
  assert.deepEqual(tags(client.tree), ['enabled', 'new']);
  assert.equal(nodes(client.tree, (node) => node.type === 'label' && node.props.key === 'skipped').length, 0,
    'unsuitable rows are not rendered');
  assert.match(text(client.tree), /已过滤 1 个不适用模型/);
  client.render(client.ProviderCard, props);
  assert.equal(viewed.length, 1);
  const read = result({ catalog: { addedIds: [], removedIds: [], addedCount: 0, removedCount: 0, changedCount: 0 } });
  props = { ...props, result: read };
  client.render(client.ProviderCard, props);
  assert.match(text(client.tree), /变化0项/);
  assert.deepEqual(tags(client.tree), ['enabled', 'new']);
  props = { ...props, result: result({ catalog: { revision: 'R2', addedIds: ['skipped'] } }) };
  client.render(client.ProviderCard, props);
  assert.equal(viewed.length, 1);
  assert.deepEqual(tags(client.tree), ['enabled', 'new']);
  assert.match(text(client.tree), /收起再展开/);
  client.render(client.ProviderCard, { ...props, expanded: false });
  client.render(client.ProviderCard, { ...props, result: read, expansion: client.captureExpansion(read), expanded: true });
  assert.deepEqual(tags(client.tree), []);
});

test('search/paging and failed render do not issue a receipt; deletion-only directory does', () => {
  const client = loadClient();
  const value = result({ allItems: Array.from({ length: 205 }, (_, i) => ({ id: `model-${i}`, status: 'available', target: 'opaque-instance-A' })) });
  const viewed = [];
  let props = cardProps(client, value, { showAll: false, onViewed: (...args) => viewed.push(args) });
  client.render(client.ProviderCard, props);
  assert.equal(viewed.length, 0);
  props = { ...props, showAll: true, query: 'model-1' };
  client.render(client.ProviderCard, props);
  assert.equal(viewed.length, 0);
  props = { ...props, query: '', filter: 'unadded' };
  client.render(client.ProviderCard, props);
  assert.equal(viewed.length, 0);
  props = { ...props, filter: 'all' };
  client.render(client.ProviderCard, props);
  assert.equal(viewed.length, 1);
  const uncommitted = loadClient();
  uncommitted.render(uncommitted.ProviderCard, cardProps(uncommitted, result(), { onViewed: () => assert.fail('render is not committed') }), false);
  const empty = result({ allItems: [], catalog: { total: 0, addedIds: [], addedCount: 0, changedCount: 1 } });
  const emptyClient = loadClient();
  let receipts = 0;
  emptyClient.render(emptyClient.ProviderCard, cardProps(emptyClient, empty, { onViewed: () => receipts++ }));
  assert.equal(receipts, 1);
  assert.match(text(emptyClient.tree), /gone/);
});

test('Panel opening does not consume unread; expanding renders all rows and reopens without tags', async () => {
  const value = result({ allItems: Array.from({ length: 205 }, (_, i) => ({ id: `model-${i}`, status: 'available', target: 'opaque-instance-A' })), catalog: { addedIds: ['model-204'], addedCount: 1, removedIds: [], removedCount: 0, changedCount: 1 } });
  const read = { ...value.catalog, addedIds: [], addedCount: 0, changedCount: 0 };
  const client = loadClient((call) => {
    if (call.path === '/state') return state([value]);
    if (call.path === '/viewed') return { acknowledged: true, catalog: read };
    throw new Error(`Unexpected ${call.path}`);
  });
  client.render(client.Panel, {});
  await client.flush();
  assert.deepEqual(client.calls.map((call) => call.path), ['/state']);
  button(client.tree, /OpenAI 官方 · Work/).props.onClick();
  await client.flush();
  assert.equal(client.calls.filter((call) => call.path === '/viewed').length, 1);
  assert.deepEqual(client.calls[1].body, { provider: value.provider, revision: 'R1' });
  assert.equal(nodes(client.tree, (node) => node.type === 'label' && node.props.key?.startsWith('model-')).length, 205);
  assert.deepEqual(tags(client.tree), ['model-204']);
  assert.match(text(client.tree), /变化0项/);
  const search = nodes(client.tree, (node) => node.type === 'input' && node.props.placeholder === '搜索模型 id / 名称')[0];
  search.props.onChange({ target: { value: 'model-1' } });
  await client.flush();
  button(client.tree, /OpenAI 官方 · Work/).props.onClick();
  await client.flush();
  button(client.tree, /OpenAI 官方 · Work/).props.onClick();
  await client.flush();
  assert.deepEqual(tags(client.tree), []);
  assert.equal(nodes(client.tree, (node) => node.type === 'input' && node.props.placeholder === '搜索模型 id / 名称')[0].props.value, '');
});

test('managed instance arrays/legacy maps and public-catalog notices are shown without claiming entitlement', async () => {
  const value = result({ notice: '官方公开目录，非账号可用性验证', source: 'official-public-catalog' });
  for (const managed of [state([value]).managed, { [value.provider]: true }]) {
    const client = loadClient((call) => {
      if (call.path === '/state') return { ...state([value]), managed };
      if (call.path === '/viewed') return { acknowledged: false, reason: 'test-unread' };
      throw new Error(`Unexpected ${call.path}`);
    });
    client.render(client.Panel, {});
    await client.flush();
    button(client.tree, /OpenAI 官方 · Work/).props.onClick();
    await client.flush();
    assert.match(text(client.tree), /官方公开目录，非账号可用性验证/);
    const label = nodes(client.tree, (node) => node.type === 'label' && text(node).includes('参与检查此服务商'))[0];
    assert.equal(nodes(label, (node) => node.type === 'input')[0].props.checked, true);
  }
  const client = loadClient();
  let receipts = 0;
  const failed = { ...value, status: 'discovery-failed', reason: 'no-access', stale: true };
  client.render(client.ProviderCard, cardProps(client, failed, { onViewed: () => receipts++ }));
  assert.equal(receipts, 0);
  assert.equal(rowCheckbox(client.tree, 'new').props.disabled, true);
  assert.equal(rowCheckbox(client.tree, 'enabled').props.disabled, true);
  assert.match(text(client.tree), /no-access/);
});

test('pending receipts deduplicate rapid reopening; failures preserve unread and a later opening retries', async () => {
  const value = result();
  let finishReceipt;
  const pending = new Promise((resolve) => { finishReceipt = resolve; });
  let attempts = 0;
  const cleared = { ...value.catalog, addedIds: [], removedIds: [], addedCount: 0, removedCount: 0, changedCount: 0 };
  const client = loadClient((call) => {
    if (call.path === '/state') return state([value]);
    if (call.path === '/viewed') return ++attempts === 1 ? pending : { acknowledged: true, catalog: cleared };
    throw new Error(`Unexpected ${call.path}`);
  });
  const toggle = async () => { button(client.tree, /OpenAI 官方 · Work/).props.onClick(); await client.flush(); };
  client.render(client.Panel, {});
  await client.flush();
  await toggle();
  await toggle();
  await toggle();
  assert.equal(attempts, 1);
  assert.deepEqual(tags(client.tree), ['enabled', 'new'], 'unconfirmed receipt does not swallow unread tags');
  finishReceipt({ acknowledged: false, reason: 'receipt-not-saved' });
  await client.flush();
  assert.match(text(client.tree), /变化3项/);
  assert.match(text(client.tree), /receipt-not-saved/);
  assert.deepEqual(tags(client.tree), ['enabled', 'new']);
  await toggle();
  await toggle();
  assert.equal(attempts, 2);
  assert.match(text(client.tree), /变化0项/);
  assert.deepEqual(tags(client.tree), ['enabled', 'new'], 'successful receipt must not erase this expansion snapshot');
  await toggle();
  await toggle();
  assert.deepEqual(tags(client.tree), []);
  assert.equal(attempts, 2, 'a confirmed revision is not posted again');
});

test('late R receipt cannot clear or auto-consume R+1 in the mounted Panel', async () => {
  const value = result();
  let current = value;
  let finishReceipt;
  const pending = new Promise((resolve) => { finishReceipt = resolve; });
  const cleared = { ...value.catalog, addedIds: [], removedIds: [], addedCount: 0, removedCount: 0, changedCount: 0 };
  const client = loadClient((call) => {
    if (call.path === '/state') return state([current]);
    if (call.path === '/check') return {};
    if (call.path === '/viewed') return pending;
    throw new Error(`Unexpected ${call.path}`);
  });
  client.render(client.Panel, {});
  await client.flush();
  button(client.tree, /OpenAI 官方 · Work/).props.onClick();
  await client.flush();
  current = result({ catalog: { revision: 'R2', addedIds: ['skipped'], removedIds: [], addedCount: 1, removedCount: 0, changedCount: 1 } });
  button(client.tree, '检查更新').props.onClick();
  await client.flush();
  finishReceipt({ acknowledged: true, catalog: cleared });
  await client.flush();
  assert.match(text(client.tree), /变化1项（新增1 \/ 移除0）/);
  assert.match(text(client.tree), /收起再展开/);
  assert.deepEqual(tags(client.tree), ['enabled', 'new']);
  assert.equal(client.calls.filter((call) => call.path === '/viewed').length, 1);
});

test('Panel saves additions/removals once, reports actual counts, and retains failed provider selections', async () => {
  const a = result();
  const b = result({ provider: 'opaque-instance-B', displayName: 'Anthropic 官方 · B' });
  const client = loadClient((call) => {
    if (call.path === '/state') return state([a, b]);
    if (call.path === '/viewed') {
      const catalog = { ...a.catalog, addedIds: [], removedIds: [], addedCount: 0, removedCount: 0, changedCount: 0 };
      return { acknowledged: true, catalog };
    }
    if (call.path === '/apply') return { applied: [{ provider: a.provider, added: 1, removed: 1 }], errors: [{ provider: b.provider, reason: 'revision-conflict' }], warnings: [{ provider: a.provider, reason: '设置已保存，后续状态刷新未完成' }] };
    throw new Error(`Unexpected ${call.path}`);
  });
  client.render(client.Panel, {});
  await client.flush();
  button(client.tree, /OpenAI 官方 · Work/).props.onClick();
  await client.flush();
  rowCheckbox(client.tree, 'new').props.onChange();
  rowCheckbox(client.tree, 'enabled').props.onChange();
  await client.flush();
  button(client.tree, /Anthropic 官方 · B/).props.onClick();
  await client.flush();
  rowCheckbox(client.tree, 'new').props.onChange();
  await client.flush();
  button(client.tree, '保存全部变更').props.onClick();
  await client.flush();
  const saves = client.calls.filter((call) => call.path === '/apply');
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0].body, {
    selections: { [a.provider]: ['new'], [b.provider]: ['new'] }, removals: [{ provider: a.provider, id: 'enabled' }],
    expectedRevisions: { [a.provider]: 7, [b.provider]: 7 }, repairs: false, recheck: true, rememberHabit: true,
  });
  assert.equal(client.calls.some((call) => ['/remove-managed', '/opened', '/check'].includes(call.path)), false);
  assert.match(text(client.tree), /添加 1 个模型 · 移除 1 个模型/);
  assert.match(text(client.tree), /revision-conflict/);
  assert.match(text(client.tree), /设置已保存，后续状态刷新未完成/);
  assert.equal(rowCheckbox(client.tree, 'new').props.checked, true);
  button(client.tree, /OpenAI 官方 · Work/).props.onClick();
  await client.flush();
  assert.equal(rowCheckbox(client.tree, 'new').props.checked, false);
  assert.equal(rowCheckbox(client.tree, 'enabled').props.checked, true);
});

function sibling(overrides = {}) {
  return {
    routeProvider: 'opencode', provider: 'opencode-sibling', owner: 'owner:opaque/A',
    settingsRevision: 7, status: 'ok', models: [{ id: 'enabled', name: 'Enabled model' }],
    ...overrides,
  };
}

test('managed flat rows use explicit root routes and owners, never protocol-name inference', () => {
  const client = loadClient();
  const a = sibling();
  const b = sibling({ owner: 'owner:opaque/B' });
  const go = sibling({ routeProvider: 'opencode-go', provider: 'not-prefixed-with-opencode' });
  const unknown = sibling({ routeProvider: undefined, provider: 'opencode-lookalike' });
  assert.deepEqual([...client.managedSiblingsFor([a, b, go, unknown], 'opencode')], [a, b]);
  assert.deepEqual([...client.managedSiblingsFor([a, b, go, unknown], 'opencode-go')], [go]);
  const first = client.managedRemovalEntry(a, a.models[0]);
  const second = client.managedRemovalEntry(b, b.models[0]);
  assert.notEqual(client.managedRowKey(first), client.managedRowKey(second));
  const legacy = { provider: 'opencode-sibling', models: a.models };
  assert.deepEqual([...client.managedSiblingsFor({ routes: [{ provider: 'opencode', siblings: [legacy] }] }, 'opencode')], [legacy]);
  assert.match(client.managedRemovalIssue(legacy), /归属|版本/);
});

test('managed removal payload captures exact owners and versions in one request without rebasing', () => {
  const client = loadClient();
  const a = sibling();
  const b = sibling({ owner: '__proto__', settingsRevision: 0 });
  const entries = [a, b].map((item) => client.managedRemovalEntry(item, item.models[0]));
  const request = client.buildManagedRemovalRequest(entries, [a, b]);
  assert.equal(request.blocked.length, 0);
  assert.equal(request.submitted[0], entries[0]);
  assert.deepEqual(JSON.parse(JSON.stringify(request.body)), {
    removals: [
      { provider: a.provider, owner: a.owner, id: 'enabled' },
      { provider: b.provider, owner: b.owner, id: 'enabled' },
    ],
    expectedRevisions: JSON.parse('{"owner:opaque/A":7,"__proto__":0}'),
    repairs: false, recheck: true, rememberHabit: true,
  });
  const newer = { ...a, settingsRevision: 8 };
  const conflict = client.buildManagedRemovalRequest([entries[0]], [newer]);
  assert.equal(entries[0].settingsRevision, 7);
  assert.equal(conflict.body.removals.length, 0);
  assert.match(conflict.blocked[0], /配置版本已变化/);
  const duplicate = client.buildManagedRemovalRequest([entries[0], entries[0]], [a]);
  assert.equal(duplicate.body.removals.length, 1);
});

test('managed removal cannot submit without a current successful owned catalog and captured version', () => {
  const client = loadClient();
  const valid = sibling();
  const entry = client.managedRemovalEntry(valid, valid.models[0]);
  for (const invalid of [
    { ...valid, owner: undefined }, { ...valid, settingsRevision: undefined },
    { ...valid, settingsRevision: -1 }, { ...valid, settingsRevision: '7' },
    { ...valid, status: 'needs-check' }, { ...valid, status: 'discovery-failed', reason: '目录不可用' },
    { ...valid, models: [] }, { ...valid, owner: 'different-owner' },
  ]) {
    const request = client.buildManagedRemovalRequest([entry], [invalid]);
    assert.equal(request.body.removals.length, 0);
    assert.equal(request.blocked.length, 1);
  }
  const old = { ...entry, settingsRevision: undefined };
  assert.equal(client.buildManagedRemovalRequest([old], [valid]).blocked.length, 1);
});

test('managed partial results clear only exact successful owner drafts; warnings are not failures', () => {
  const client = loadClient();
  const a = sibling();
  const b = sibling({ owner: 'owner:opaque/B' });
  const first = client.managedRemovalEntry(a, a.models[0]);
  const second = client.managedRemovalEntry(b, b.models[0]);
  const editedDuringRequest = { ...first, name: 'New draft' };
  const outcome = {
    applied: [{ provider: a.owner, removed: 1 }], errors: [{ provider: b.owner, reason: '版本冲突' }],
    warnings: [{ provider: a.owner, reason: '设置已写入，但状态持久化失败' }],
  };
  const remaining = client.clearManagedRemovals([first, second, editedDuringRequest], [first, second], outcome);
  assert.deepEqual([...remaining], [second, editedDuringRequest]);
  assert.deepEqual([...client.clearManagedRemovals([first, second], [first, second], {})], [first, second]);
  assert.deepEqual([...client.clearManagedRemovals([first], [first], { ...outcome, errors: [{ provider: a.owner }] })], [first]);
  assert.deepEqual([...client.outcomeWarnings(outcome)], ['设置已写入，但状态持久化失败']);
});

// A deliberately narrow in-memory native-editor scaffold. It exercises the
// existing portal/observer/save-close lifecycle, not a real DOM or DSH service.
function nativeEditorEnvironment() {
  class Element {
    constructor(className = '') { this.className = className; this.children = []; this.attributes = new Map(); this.parentElement = null; }
    get classList() { return this.className.split(/\s+/).filter(Boolean); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    get lastElementChild() { return this.children.at(-1) ?? null; }
    appendChild(child) { child.remove(); this.children.push(child); child.parentElement = this; }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((item) => item !== this); this.parentElement = null; }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    closest() { return null; }
    contains(item) { return this.children.includes(item); }
  }
  const card = new Element('fixture_rowCard');
  const editor = new Element('fixture_editor');
  const list = new Element('fixture_modelList');
  const actions = new Element('fixture_editorActions');
  const primary = new Element('fixture_primaryButton');
  const secondary = new Element('fixture_secondaryButton');
  const anchor = new Element();
  let open = true;
  const observers = new Set();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const add = (map, name, fn) => { if (!map.has(name)) map.set(name, new Set()); map.get(name).add(fn); };
  const emit = (map, name, event) => { for (const fn of [...(map.get(name) ?? [])]) fn(event); };
  anchor.closest = () => card;
  card.querySelectorAll = (query) => !open ? [] : query === 'div, section' ? [editor] : query === "[class*='modelList']" ? [list] : [];
  card.contains = (item) => [editor, actions, primary, secondary].includes(item);
  editor.querySelector = () => actions;
  editor.querySelectorAll = () => [list];
  editor.contains = (item) => [actions, primary, secondary].includes(item);
  for (const target of [primary, secondary]) target.closest = (query) => query === 'button' ? target : actions;
  const document = {
    body: new Element(),
    querySelectorAll: () => [card], createElement: () => new Element(),
    addEventListener: (name, fn) => add(documentListeners, name, fn),
    removeEventListener: (name, fn) => documentListeners.get(name)?.delete(fn),
  };
  class MutationObserver {
    constructor(callback) { this.callback = callback; observers.add(this); }
    observe() {}
    disconnect() { observers.delete(this); }
  }
  class Event { constructor(type) { this.type = type; } }
  const window = {
    confirm: () => true,
    addEventListener: (name, fn) => add(windowListeners, name, fn),
    removeEventListener: (name, fn) => windowListeners.get(name)?.delete(fn),
    dispatchEvent: (event) => { emit(windowListeners, event.type, event); return true; },
  };
  const scan = () => { for (const observer of [...observers]) observer.callback([]); };
  return {
    globals: { document, Element, MutationObserver, Event }, window,
    modules: { 'react-dom': { createPortal: (children) => ({ type: 'portal', props: { children } }) } },
    attachRef: (node) => { if (node.type === 'span' && node.props.hidden && node.props.ref) node.props.ref.current = anchor; },
    openEditor() { open = true; scan(); },
    closeEditor(save = true) {
      emit(documentListeners, 'click', { target: save ? primary : secondary });
      open = false;
      scan();
    },
    update() { window.dispatchEvent(new Event('dsh-model-sync:updated')); },
  };
}

function managedDelete(tree, owner, id = 'enabled') {
  const row = nodes(tree, (node) => node.props?.key === JSON.stringify([owner, 'opencode-sibling', id]))[0];
  assert.ok(row, `Missing managed row ${owner}/${id}; rendered: ${text(tree)}; keys: ${nodes(tree, (node) => node.props?.key !== undefined).map((node) => node.props.key).join(', ')}`);
  const control = nodes(row, (node) => node.type === 'button' && /^删除模型 /.test(node.props?.['aria-label'] ?? ''))[0];
  assert.ok(control, 'Missing native remove action');
  return control;
}

test('native managed save submits owner CAS once and keeps only failed drafts, with actual counts and warnings', async () => {
  const native = nativeEditorEnvironment();
  const a = sibling();
  const b = sibling({ owner: 'owner:opaque/B', models: [{ id: 'enabled', name: 'Other owner model' }] });
  const client = loadClient((call) => {
    if (call.path === '/managed') return [a, b];
    if (call.path === '/remove') return {
      applied: [{ provider: a.owner, removed: 1 }], errors: [{ provider: b.owner, reason: 'revision-conflict' }],
      warnings: [{ provider: a.owner, reason: '设置已提交，但后续目录检查未完成' }],
    };
    throw new Error(`Unexpected API ${call.path}`);
  }, native);
  client.render(client.ManagedPanel, { provider: { provider: 'opencode' } });
  await client.flush();
  managedDelete(client.tree, a.owner).props.onClick();
  await client.flush();
  managedDelete(client.tree, b.owner).props.onClick();
  await client.flush();
  assert.match(text(client.tree), /待移除 2 个模型/);
  native.closeEditor();
  await client.flush();
  const saves = client.calls.filter((call) => call.path === '/remove');
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0].body, {
    removals: [{ provider: a.provider, owner: a.owner, id: 'enabled' }, { provider: b.provider, owner: b.owner, id: 'enabled' }],
    expectedRevisions: { [a.owner]: 7, [b.owner]: 7 }, repairs: false, recheck: true, rememberHabit: true,
  });
  assert.match(text(client.tree), /已移除 1 个模型/);
  assert.match(text(client.tree), /revision-conflict/);
  assert.match(text(client.tree), /设置已提交，但后续目录检查未完成/);
  assert.equal(client.calls.some((call) => ['/check', '/apply', '/opened'].includes(call.path)), false);
  native.openEditor();
  await client.flush();
  assert.match(text(client.tree), /待移除 1 个模型/);
  assert.ok(managedDelete(client.tree, a.owner), 'a successful owner must not remain staged');
  assert.equal(nodes(client.tree, (node) => node.props?.key === JSON.stringify([b.owner, b.provider, 'enabled'])).length, 0);
  button(client.tree, '取消待移除').props.onClick();
  await client.flush();
  assert.ok(managedDelete(client.tree, b.owner));
});

test('native managed transport failures preserve drafts; cancelling native edit makes no request', async () => {
  const native = nativeEditorEnvironment();
  const a = sibling();
  const client = loadClient((call) => {
    if (call.path === '/managed') return [a];
    if (call.path === '/remove') throw new Error('network-unavailable');
    throw new Error(`Unexpected API ${call.path}`);
  }, native);
  client.render(client.ManagedPanel, { provider: { provider: 'opencode' } });
  await client.flush();
  managedDelete(client.tree, a.owner).props.onClick();
  await client.flush();
  native.closeEditor();
  await client.flush();
  assert.match(text(client.tree), /已保留 1 项选择/);
  native.openEditor();
  await client.flush();
  assert.match(text(client.tree), /待移除 1 个模型/);
  native.closeEditor(false);
  await client.flush();
  native.openEditor();
  await client.flush();
  assert.doesNotMatch(text(client.tree), /待移除 1 个模型/);
  assert.ok(managedDelete(client.tree, a.owner));
  assert.equal(client.calls.filter((call) => call.path === '/remove').length, 1);
});

test('native managed refresh never rebases captured versions or submits an unready catalog', async () => {
  const native = nativeEditorEnvironment();
  let current = sibling();
  const client = loadClient((call) => {
    if (call.path === '/managed') return [current];
    throw new Error(`Must not submit ${call.path}`);
  }, native);
  client.render(client.ManagedPanel, { provider: { provider: 'opencode' } });
  await client.flush();
  managedDelete(client.tree, current.owner).props.onClick();
  await client.flush();
  current = { ...current, settingsRevision: 8 };
  native.update();
  await client.flush();
  native.closeEditor();
  await client.flush();
  assert.match(text(client.tree), /配置版本已变化/);
  assert.match(text(client.tree), /设置 → 模型更新/);
  assert.match(text(client.tree), /不要重复点击原生保存/);
  assert.equal(client.calls.some((call) => call.path === '/remove'), false);
  native.openEditor();
  await client.flush();
  assert.match(text(client.tree), /待移除 1 个模型/);
  button(client.tree, '取消待移除').props.onClick();
  await client.flush();
  current = { ...current, status: 'needs-check', reason: '目录检查已过期' };
  native.update();
  await client.flush();
  assert.equal(managedDelete(client.tree, current.owner).props.disabled, true);
  assert.match(text(client.tree), /目录检查已过期/);
  managedDelete(client.tree, current.owner).props.onClick();
  await client.flush();
  assert.doesNotMatch(text(client.tree), /待移除 1 个模型/);
});

test('single-vendor cards sort naturally by display name and use the two-column grid', () => {
  const client = loadClient();
  const allItems = [
    { id: 'm10', name: 'Model 10', status: 'available', target: 'p' },
    { id: 'm2', name: 'Model 2', status: 'available', target: 'p' },
    { id: 'm1', name: 'model 1', status: 'available', target: 'p' },
  ];
  const value = result({ allItems, skipped: [], layout: 'grid', catalog: { total: 3, addedIds: [], addedCount: 0, removedIds: [], removedCount: 0, changedCount: 0 } });
  client.render(client.ProviderCard, cardProps(client, value));
  const ids = nodes(client.tree, (node) => node.type === 'label' && allItems.some((item) => item.id === node.props.key)).map((node) => node.props.key);
  assert.deepEqual(ids, ['m1', 'm2', 'm10'], 'natural order keeps Model 2 before Model 10');
  const grid = nodes(client.tree, (node) => node.props?.style?.display === 'grid')[0];
  assert.ok(grid, 'a single-vendor card renders a grid');
  assert.match(grid.props.style.gridTemplateColumns, /repeat\(2,/);
  const grouped = result({ allItems, skipped: [], layout: 'groups', catalog: { total: 3, addedIds: [], addedCount: 0, removedIds: [], removedCount: 0, changedCount: 0 } });
  client.render(client.ProviderCard, cardProps(client, grouped));
  const columns = nodes(client.tree, (node) => node.props?.style?.columnWidth === '240px')[0];
  assert.ok(columns, 'multi-vendor results keep the vendor-grouped card layout');
});

test('single-vendor cards sort before the display limit truncates rows', () => {
  const client = loadClient();
  const allItems = Array.from({ length: 205 }, (_, index) => {
    const rank = 205 - index;
    return { id: `m${rank}`, name: `Model ${String(rank).padStart(3, '0')}`, status: 'available', target: 'p' };
  });
  const value = result({
    allItems, skipped: [], layout: 'grid',
    catalog: { total: 205, addedIds: [], addedCount: 0, removedIds: [], removedCount: 0, changedCount: 0 },
  });
  client.render(client.ProviderCard, cardProps(client, value, { showAll: false }));
  const ids = nodes(client.tree, (node) => node.type === 'label' && allItems.some((item) => item.id === node.props.key))
    .map((node) => node.props.key);
  assert.equal(ids.length, 200, 'the display limit still applies');
  assert.equal(ids[0], 'm1', 'the first rendered row is the alphabetically first model');
  assert.equal(ids[199], 'm200', 'the truncated tail is the sorted tail, not the input tail');
});
