/**
 * Real-upstream dry run (v2): fetches live /models and prints the update and
 * repair plan without touching DSH settings.
 *
 *   node scripts/dry-run.mjs
 *
 * Credentials are read from <DSH_HOME>/.credentials.yaml and never printed.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SyncController } from '../lib/sync.js';
import { SyncState, dshHome } from '../lib/state.js';

function readCredentialRefs() {
  const file = join(dshHome(), '.credentials.yaml');
  const refs = {};
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = /^\s{2}([A-Z0-9_]+):\s*(\S+)\s*$/.exec(line);
      if (match !== null) refs[match[1]] = match[2];
    }
  } catch (error) {
    console.error(`could not read ${file}: ${error.message}`);
  }
  return refs;
}

const refs = readCredentialRefs();
const document = {
  'llm-deepseek': {
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    ],
  },
  'llm-pi-ai': {
    providers: {
      'opencode-go': {
        displayName: 'OpenCode Go',
        apiKeyEnv: 'OPENCODE_GO_API_KEY',
        // Mirrors the current collapsed state: every advertised model on one route.
        models: [],
      },
      openrouter: { displayName: 'OpenRouter', apiKeyEnv: 'OPENROUTER_API_KEY', models: [] },
      'kimi-coding': { displayName: 'Kimi Coding', apiKeyEnv: 'KIMI_CODING_API_KEY', models: [] },
    },
  },
};

const ctx = {
  get(name) {
    if (name === 'settings') {
      return {
        get: (ns) => structuredClone(document[ns]),
        mutate: async () => {
          throw new Error('dry run: settings writes are disabled');
        },
      };
    }
    if (name === 'credentials') {
      return { resolve: async (ref) => (refs[ref] === undefined ? undefined : { value: refs[ref] }) };
    }
    return undefined;
  },
  logger: { info() {}, warn() {}, error() {} },
};

const state = new SyncState(mkdtempSync(join(tmpdir(), 'model-sync-dry-')));
const controller = new SyncController({ ctx, state, logger: console });

// First learn the advertised ids, then pretend the v1 collapse put them all on
// the primary route so repairs can be inspected.
const { models } = await controller.discoverModels(controller.routeTargets().targets.find((t) => t.route.provider === 'opencode-go'));
document['llm-pi-ai'].providers['opencode-go'].models = models.map((model) => ({ id: model.id, name: model.name ?? model.id }));

const payload = await controller.check();
for (const result of payload.results) {
  console.log(`\n=== ${result.provider} [${result.status}]${result.defaultSelected === false ? ' (默认不勾选)' : ''}`);
  if (result.error !== undefined) console.log(`  error: ${result.error}`);
  const news = result.newItems ?? [];
  console.log(`  new: ${news.length} 个${news.length > 0 ? `，示例 ${news.slice(0, 5).map((item) => `${item.id}→${item.target}`).join(', ')}` : ''}`);
  console.log(`  repairs: ${(result.repairs ?? []).map((item) => `${item.id}: ${item.from}→${item.to}`).join(', ') || 'none'}`);
  console.log(`  removed(info): ${(result.removed ?? []).length} 个`);
  console.log(`  skipped: ${(result.skipped ?? []).map((item) => `${item.id} (${item.reason})`).join(', ') || 'none'}`);
}
