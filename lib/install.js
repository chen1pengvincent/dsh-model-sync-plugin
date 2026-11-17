/**
 * The install plan, separated from the file operations so it can be reasoned
 * about (and tested) without touching a real profile.
 *
 * Installing this plugin means four references, not one:
 *
 *   1. `dependencies[<pkg>] = link:<checkout>`  — what the profile resolves.
 *   2. `pnpm.overrides[<pkg>] = link:<checkout>` — **overrides win over
 *      dependencies**, so a stale override from the previous release silently
 *      reverts the install on the next `pnpm install` (any plugin install
 *      triggers one).
 *   3. `dsh.desktop.generationProjection.plugins[<pkg>]` — the desktop records
 *      which generation of a plugin is visible; left pointing at the old
 *      release it is a rollback waiting to happen.
 *   4. `dsh.profile.bundles` — the package only contributes its patch (and its
 *      client half) if it is listed here.
 *
 * Earlier versions of this script wrote (1) and (4) only; that is exactly the
 * one-of-three bug that later bit the manual install.
 */

import { createHash } from 'node:crypto'

export const PACKAGE = 'dsh-model-sync'

/** Deterministic, so re-running the installer is idempotent. */
export function generationId(version, source) {
  const digest = createHash('sha256').update(`${version}\u0000${source}`).digest('hex').slice(0, 12)
  return `${PACKAGE}+${version}+${digest}`
}

function clone(manifest) {
  return JSON.parse(JSON.stringify(manifest))
}

/**
 * @param {object} input
 * @param {object} input.manifest      the profile's package.json, as parsed
 * @param {string} input.source        absolute path to this checkout
 * @param {string} input.version       this package's version
 * @param {string} [input.generation]  generation name to advertise; when absent
 *                                     the manifest's own entry is left alone
 * @param {{ override: boolean }} input.writeOverride
 *        write `pnpm.overrides` too — on by default, because that is the
 *        reference that decides whether the link survives a `pnpm install`
 */
export function planInstall({ manifest, source, version, generation, writeOverride = true }) {
  const next = clone(manifest)
  const changes = []
  const warnings = []
  const linked = `link:${source}`

  next.dependencies = next.dependencies ?? {}
  if (next.dependencies[PACKAGE] !== linked) {
    changes.push(`dependencies["${PACKAGE}"]: ${next.dependencies[PACKAGE] ?? '(absent)'} → ${linked}`)
    next.dependencies[PACKAGE] = linked
  }

  if (writeOverride === true) {
    next.pnpm = next.pnpm ?? {}
    next.pnpm.overrides = next.pnpm.overrides ?? {}
    if (next.pnpm.overrides[PACKAGE] !== linked) {
      changes.push(`pnpm.overrides["${PACKAGE}"]: ${next.pnpm.overrides[PACKAGE] ?? '(absent)'} → ${linked}`)
      next.pnpm.overrides[PACKAGE] = linked
    }
  }

  next.dsh = next.dsh ?? {}
  next.dsh.profile = next.dsh.profile ?? {}
  const bundles = next.dsh.profile.bundles ?? []
  if (!bundles.includes(PACKAGE)) {
    changes.push(`dsh.profile.bundles: + ${PACKAGE}`)
    next.dsh.profile.bundles = [...bundles, PACKAGE]
  }

  const plugins = next.dsh.desktop?.generationProjection?.plugins
  if (generation !== undefined) {
    next.dsh.desktop = next.dsh.desktop ?? {}
    next.dsh.desktop.generationProjection = next.dsh.desktop.generationProjection ?? { plugins: {} }
    next.dsh.desktop.generationProjection.plugins = next.dsh.desktop.generationProjection.plugins ?? {}
    const previous = plugins?.[PACKAGE]
    // `previousOverride` records whether an override existed *before* the
    // projection was created, so it must not be recomputed on every run: when
    // the generation is unchanged, keep whatever the desktop wrote.
    const entry = {
      generationId: generation,
      visibleVersion: version,
      previousOverride:
        previous?.generationId === generation
          ? (previous.previousOverride ?? { present: false })
          : { present: previous?.generationId !== undefined },
    }
    if (JSON.stringify(previous) !== JSON.stringify(entry)) {
      changes.push(
        `generationProjection.plugins["${PACKAGE}"]: ${previous?.generationId ?? '(absent)'} → ${generation}`,
      )
      next.dsh.desktop.generationProjection.plugins[PACKAGE] = entry
    }
  } else if (plugins?.[PACKAGE] !== undefined) {
    warnings.push(
      `the desktop still tracks generation "${plugins[PACKAGE].generationId}" for this package; ` +
        'pass --generation <name> after creating a generation directory, or the old release may come back',
    )
  }

  return { next, changes, warnings }
}

/**
 * Where a generation directory has to live, and what has to be inside it.
 *
 * The shape is copied from `@local/dsh-workshop-preset` on this machine: a
 * `generation.json` naming the plugin and its source, a `package.json` whose
 * dependency is a `file:` spec, and `node_modules/<pkg>` pointing back at the
 * checkout so edits are picked up without reinstalling.
 */
export function generationFiles({ source, version }) {
  return [
    {
      path: 'generation.json',
      body: `${JSON.stringify({ pluginName: PACKAGE, version, sourceSpec: source }, null, 2)}\n`,
    },
    {
      path: 'package.json',
      body: `${JSON.stringify({ name: `${PACKAGE}+generation`, private: true, dependencies: { [PACKAGE]: `file:${source}` } }, null, 2)}\n`,
    },
  ]
}
