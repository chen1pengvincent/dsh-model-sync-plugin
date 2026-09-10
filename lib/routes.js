/**
 * dsh-model-sync — built-in route table.
 *
 * First principles: a provider's `/models` listing carries model ids (and at
 * best trivial metadata), never the wire protocol. DSH's pi-ai adapter also
 * cannot place a model the installed catalog does not describe onto a
 * multi-protocol route without a route-level protocol. So every route this
 * plugin can serve gets its *endpoint facts* from here — one place that knows
 * how to talk to the provider — while model metadata is discovered live.
 *
 * `adapter: 'deepseek'` routes write `llm-deepseek.models` (the official
 * DeepSeek plugin's advisory catalog). `adapter: 'pi-ai'` routes write
 * `llm-pi-ai.providers.<provider>` and may fan out into per-protocol sibling
 * routes (`<provider>-messages`, `<provider>-responses`, …) so a mixed-protocol
 * provider can still be mirrored in full.
 */

export const PROTOCOLS = ['openai-completions', 'anthropic-messages', 'openai-responses'];

/** Human labels for synthesized sibling routes. */
export const PROTOCOL_LABELS = {
  'openai-completions': 'Chat Completions',
  'anthropic-messages': 'Anthropic Messages',
  'openai-responses': 'Responses',
};

/** npm package id (models.dev) → DSH pi-ai wire protocol. */
const NPM_TO_PROTOCOL = {
  '@ai-sdk/openai-compatible': 'openai-completions',
  '@ai-sdk/openai': 'openai-responses',
  '@ai-sdk/anthropic': 'anthropic-messages',
};

/** Default compat switches for OpenCode Go's OpenAI-compatible endpoint. */
const OPENCODE_GO_OPENAI_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  maxTokensField: 'max_tokens',
};

/** DeepSeek reasoning wire format on the Go gateway. */
const OPENCODE_GO_DEEPSEEK_COMPAT = {
  requiresReasoningContentOnAssistantMessages: true,
  thinkingFormat: 'deepseek',
};

export const BUILTIN_ROUTES = {
  'deepseek-official': {
    provider: 'deepseek-official',
    adapter: 'deepseek',
    displayName: 'DeepSeek',
    credentialRef: 'DEEPSEEK_API_KEY',
    settingsNs: 'llm-deepseek',
    discovery: { baseUrls: ['https://api.deepseek.com'] },
    modelsDevProvider: 'deepseek',
    managedByDefault: true,
    vision: { imagePixelBudget: 640000, imageMaxBytes: 1048576 },
  },
  'opencode-go': {
    provider: 'opencode-go',
    adapter: 'pi-ai',
    displayName: 'OpenCode Go',
    credentialRef: 'OPENCODE_GO_API_KEY',
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'opencode-go'],
    discovery: { baseUrls: ['https://opencode.ai/zen/go/v1'] },
    modelsDevProvider: 'opencode-go',
    managedByDefault: true,
    defaultProtocol: 'openai-completions',
    protocols: {
      'openai-completions': {
        baseUrl: 'https://opencode.ai/zen/go/v1',
        compat: OPENCODE_GO_OPENAI_COMPAT,
        compatByModel: [
          { match: '^deepseek', compat: OPENCODE_GO_DEEPSEEK_COMPAT },
        ],
      },
      'anthropic-messages': { baseUrl: 'https://opencode.ai/zen/go' },
      'openai-responses': { baseUrl: 'https://opencode.ai/zen/go/v1' },
    },
    siblingSuffix: {
      'openai-completions': 'chat',
      'anthropic-messages': 'messages',
      'openai-responses': 'responses',
    },
  },
  openrouter: {
    provider: 'openrouter',
    adapter: 'pi-ai',
    displayName: 'OpenRouter',
    credentialRef: 'OPENROUTER_API_KEY',
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'openrouter'],
    discovery: { baseUrls: ['https://openrouter.ai/api/v1'] },
    modelsDevProvider: 'openrouter',
    managedByDefault: true,
    // 400+ upstream models: list them, but never pre-select the whole catalog.
    defaultSelected: false,
    defaultProtocol: 'openai-completions',
    protocols: {
      'openai-completions': { baseUrl: 'https://openrouter.ai/api/v1' },
    },
    siblingSuffix: { 'openai-completions': 'chat' },
  },
  'kimi-coding': {
    provider: 'kimi-coding',
    adapter: 'pi-ai',
    displayName: 'Kimi Coding',
    credentialRef: 'KIMI_CODING_API_KEY',
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'kimi-coding'],
    discovery: { baseUrls: ['https://api.kimi.com/coding/v1'] },
    modelsDevProvider: 'kimi-coding',
    managedByDefault: true,
    defaultProtocol: 'anthropic-messages',
    protocols: {
      'anthropic-messages': {
        baseUrl: 'https://api.kimi.com/coding',
        compat: { allowEmptySignature: true, forceAdaptiveThinking: true },
      },
    },
    siblingSuffix: { 'anthropic-messages': 'messages' },
  },
};

/** models.dev provider id overrides for routes whose id differs upstream. */
export const MODELS_DEV_PROVIDER_ALIASES = {
  'deepseek-official': 'deepseek',
};

export function protocolFromNpm(npm) {
  if (typeof npm !== 'string' || npm.length === 0) return undefined;
  return NPM_TO_PROTOCOL[npm];
}
