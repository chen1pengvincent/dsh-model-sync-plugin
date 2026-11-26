/**
 * The api names a route can declare. The first three are pi-ai's own list;
 * `google-generative-ai` is here because a mixed route may serve Gemini models
 * beside OpenAI-shaped ones, and narrowing such a route requires translating
 * to the Gemini wire too.
 */
export const PROTOCOLS = ['openai-completions', 'anthropic-messages', 'openai-responses', 'google-generative-ai']
