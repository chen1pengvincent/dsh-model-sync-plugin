/**
 * Undo this plugin's install, without touching anything else.
 *
 * The install is three references plus one symlink, so the rollback is the same
 * three references put back the way the backup has them. It is deliberately
 * *surgical*: a backup restored wholesale would also revert every other plugin
 * installed after it (this profile has several), and that is a much bigger
 * accident than the one being fixed.
 *
 * What this cannot undo: the `models` arrays the plugin wrote through the
 * settings service. Those live in the profile's configuration, not in the
 * manifest. Reconcile them in DSH’s official model settings using the snapshot files under
 * `model-sync/snapshots/`. The CLI says so instead of pretending otherwise.
 *
 * Pure functions only: the CLI in `scripts/rollback.mjs` does the I/O.
 */

/** The package name this file was written for. */
export const PACKAGE = 'dsh-model-sync'

/** Where the three references live, spelled once so they cannot drift apart. */
const REFS = [
  {
    key: 'dependency',
    read: (manifest) => manifest?.dependencies?.[PACKAGE],
    write: (manifest, value) => {
      manifest.dependencies = { ...(manifest.dependencies ?? {}) }
      if (value === undefined) delete manifest.dependencies[PACKAGE]
      else manifest.dependencies[PACKAGE] = value
    },
    describe: 'dependencies["' + PACKAGE + '"]',
  },
  {
    key: 'override',
    read: (manifest) => manifest?.pnpm?.overrides?.[PACKAGE],
    write: (manifest, value) => {
      const overrides = { ...(manifest.pnpm?.overrides ?? {}) }
      if (value === undefined) delete overrides[PACKAGE]
      else overrides[PACKAGE] = value
      manifest.pnpm = { ...(manifest.pnpm ?? {}) }
      // An empty table is noise; drop it only when this file emptied it.
      if (Object.keys(overrides).length === 0) delete manifest.pnpm.overrides
      else manifest.pnpm.overrides = overrides
      if (Object.keys(manifest.pnpm).length === 0) delete manifest.pnpm
    },
    describe: 'pnpm.overrides["' + PACKAGE + '"]',
  },
  {
    key: 'projection',
    read: (manifest) => manifest?.dsh?.desktop?.generationProjection?.plugins?.[PACKAGE],
    write: (manifest, value) => {
      const plugins = { ...(manifest.dsh?.desktop?.generationProjection?.plugins ?? {}) }
      if (value === undefined) delete plugins[PACKAGE]
      else plugins[PACKAGE] = value
      manifest.dsh = { ...(manifest.dsh ?? {}) }
      manifest.dsh.desktop = { ...(manifest.dsh.desktop ?? {}) }
      if (Object.keys(plugins).length === 0) delete manifest.dsh.desktop.generationProjection.plugins
      else manifest.dsh.desktop.generationProjection.plugins = plugins
    },
    describe: 'dsh.desktop.generationProjection.plugins["' + PACKAGE + '"]',
  },
]

/** What the profile currently says about this package. */
export function readRefs(manifest) {
  const out = {}
  for (const ref of REFS) out[ref.key] = ref.read(manifest)
  out.bundled = (manifest?.dsh?.profile?.bundles ?? []).includes(PACKAGE)
  return out
}

/**
 * The manifest with this package's references restored from `backup`.
 *
 * Anything the backup does not mention is *removed*, not guessed: if the old
 * release was not a bundle, it must not stay in the bundle roster either.
 */
export function planRevert({ manifest, backup }) {
  const next = structuredClone(manifest ?? {})
  /** @type {string[]} */
  const changes = []
  /** @type {string[]} */
  const warnings = []

  for (const ref of REFS) {
    const before = ref.read(next)
    const after = ref.read(backup)
    if (before === undefined && after === undefined) continue
    if (JSON.stringify(before) === JSON.stringify(after)) {
      changes.push(`${ref.describe}: already matches the backup`)
      continue
    }
    ref.write(next, after)
    changes.push(
      after === undefined
        ? `${ref.describe}: ${compact(before)} → (removed)`
        : `${ref.describe}: ${compact(before)} → ${compact(after)}`,
    )
  }

  const bundles = [...(next.dsh?.profile?.bundles ?? [])]
  const wasBundled = bundles.includes(PACKAGE)
  const backupBundled = (backup?.dsh?.profile?.bundles ?? []).includes(PACKAGE)
  if (wasBundled && !backupBundled) {
    next.dsh.profile.bundles = bundles.filter((name) => name !== PACKAGE)
    if (next.dsh.profile.bundles.length === 0) delete next.dsh.profile.bundles
    changes.push(`dsh.profile.bundles: dropped "${PACKAGE}"`)
  }

  if (backup === undefined || backup === null) {
    warnings.push('no backup was supplied: every reference of this package is removed, nothing is restored')
  }
  if ((backup?.dsh?.desktop?.generationProjection?.plugins ?? {})[PACKAGE] === undefined) {
    warnings.push('the backup had no generation projection for this package, so the projection row is removed')
  }

  return { next, changes, warnings }
}

/**
 * Which backup to revert to.
 *
 * Two naming schemes exist in the wild — `.package.json.<iso>.bak` written by
 * the installer, and `package.json.bak-<stmp>` written by hand — so both are
 * accepted. Among those, a backup whose references already equal the current
 * ones is not a revert target: restoring it would be a silent no-op that looks
 * like a successful rollback. Newest usable wins; if none is usable the newest
 * is returned with a warning so the caller can decide.
 */
/**
 * Does this manifest already carry this plugin's install shape?
 *
 * This install writes `dependencies[<pkg>] = link:<source checkout>`. A backup
 * taken **while** the install was being done can therefore hold a half-migrated
 * state — `dependencies` already pointing at the checkout while `pnpm.overrides`
 * and the generation projection still name the old release. Reverting to that
 * would recreate exactly the mixed-reference bug this file exists to prevent,
 * so such a backup is not a revert target at all.
 *
 * Only classify rows that already point at this installation's source.
 * A valid pre-install backup can itself be a link to a different checkout.
 */
export function looksLikeThisInstall(refs, currentRefs) {
  const dependency = refs?.dependency
  return typeof dependency === 'string' && dependency.startsWith('link:') && dependency === currentRefs?.dependency
}

export function pickBackup(candidates, currentRefs) {
  if (candidates.length === 0) return { chosen: undefined, warning: 'no manifest backup was found' }

  const current = JSON.stringify(currentRefs)
  const identical = []
  const partial = []
  const usable = []
  for (const entry of candidates) {
    const refs = readRefs(entry.manifest)
    // Order matters: a backup identical to the current manifest also looks
    // like this install, but "nothing to revert" is the accurate diagnosis.
    if (JSON.stringify(refs) === current) identical.push(entry)
    else if (looksLikeThisInstall(refs, currentRefs)) partial.push(entry)
    else usable.push(entry)
  }

  if (usable.length > 0) {
    const skipped = [...partial, ...identical]
    const warning =
      skipped.length === 0
        ? undefined
        : `${skipped.length} backup(s) were skipped (mid-install or identical to the current references): ${skipped.map((entry) => entry.name).join(', ')}`
    return { chosen: usable[0], warning }
  }
  if (partial.length === candidates.length) {
    return {
      chosen: undefined,
      warning: 'every backup was taken mid-install: none of them is a pre-install state',
    }
  }
  return {
    chosen: candidates[0],
    warning: 'every backup lists the same references as the current manifest: reverting will change nothing',
  }
}

/** Does this file name look like a manifest backup? Both schemes count. */
export function isBackupName(name) {
  return /^\.?package\.json(\.bak-.*|(\.[^/]*)?\.bak)$/.test(name)
}

/**
 * Generation directories that belong to this package, newest first.
 *
 * `keep` is what the *reverted* manifest still points at. Skipping those is
 * load-bearing: the backup's override is `link:../.generations/live/<old>`, so
 * deleting the old generation while restoring that override would hand the
 * profile a dangling link — the rollback would break the very install it was
 * restoring.
 */
export function generationDirs(names, keep = []) {
  const tag = `${PACKAGE}+`
  const kept = new Set(keep)
  return names.filter((name) => name.startsWith(tag) && !kept.has(name)).sort().reverse()
}

/**
 * Generation names a manifest still references: both as a `generationId` and
 * inside a `link:` path. Read from the serialized form on purpose — the names
 * appear as plain strings in two different shapes, and a structural walk would
 * have to know every shape the desktop might add.
 */
export function generationsReferencedBy(manifest) {
  const text = JSON.stringify(manifest ?? {})
  const found = new Set()
  for (const match of text.matchAll(new RegExp(`${PACKAGE}\\+[^"\\\\/]+`, 'g'))) found.add(match[0])
  return found
}

/**
 * The state directories this plugin may own.
 *
 * `model-sync` is the live one; `model-sync.legacy-*` was moved aside by the
 * installer; `model-sync.v2-*` is what a rollback leaves behind when it puts
 * the previous release's own state directory back.
 */
export function stateDirs(names) {
  return {
    live: names.filter((name) => name === 'model-sync'),
    legacy: names.filter((name) => name.startsWith('model-sync.legacy-')).sort().reverse(),
    archived: names.filter((name) => name.startsWith('model-sync.v2-')).sort().reverse(),
  }
}

function compact(value) {
  if (value === undefined) return '(absent)'
  if (typeof value === 'string') return value.length > 64 ? `${value.slice(0, 61)}…` : value
  return JSON.stringify(value)
}
