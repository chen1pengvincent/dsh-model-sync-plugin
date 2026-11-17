/**
 * Where the extracted DeepSeek Harness payload lives.
 *
 * A few checks want the host's *own* code rather than a model of it: its client
 * module resolver (does the browser half really get mounted?), its pi-ai catalog
 * (does the host accept this write shape?), its YAML parser. All of that ships
 * inside `app.asar`, so it has to be extracted once and then pointed at.
 *
 * Lookup order:
 *
 *   1. `$DSH_ASAR_DIR` — wherever you extracted it
 *   2. `<plugin>/../.analysis-model-sync/asar` — the layout this plugin was
 *      developed in (payload kept beside the source tree)
 *   3. `<plugin>/.asar` — the layout a published checkout gets: extract
 *      `app.asar` into `.asar/` inside the repository
 *
 * Returning a path that does not exist is deliberate: every caller treats a
 * missing payload as "this check cannot run here" and skips, instead of failing
 * the suite on a machine that never extracted one.
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Root of the extraction: the directory that contains `dsh/node_modules`. */
export function asarRoot() {
  const configured = typeof process.env.DSH_ASAR_DIR === 'string' ? process.env.DSH_ASAR_DIR.trim() : ''
  const candidates = [
    ...(configured.length > 0 ? [resolve(configured)] : []),
    join(PLUGIN_ROOT, '..', '.analysis-model-sync', 'asar'),
    join(PLUGIN_ROOT, '.asar'),
  ]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'dsh', 'node_modules', '@deepseek-ai')) === true) return candidate
  }
  return candidates[candidates.length - 1]
}

/** The `node_modules` the host's packages resolve from. */
export function asarModules() {
  return join(asarRoot(), 'dsh', 'node_modules')
}

/** Whether a usable extraction is present. */
export function asarAvailable() {
  return existsSync(join(asarModules(), '@deepseek-ai'))
}
