import { findPackageJSON } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

let sdk
async function loadInstalledCatalog() {
  if (process.argv[1] === undefined || typeof findPackageJSON !== 'function') return undefined
  try {
    const manifest = findPackageJSON('@earendil-works/pi-ai', pathToFileURL(process.argv[1]))
    return manifest && await import(pathToFileURL(join(dirname(manifest), 'dist/providers/all.js')).href)
  } catch {
    // Other entry points and isolated tests may not have DSH's pi-ai installed.
    return undefined
  }
}

export async function nativeCatalog(provider) {
  sdk ??= loadInstalledCatalog()
  const installed = await sdk
  if (typeof installed?.getBuiltinModels !== 'function') return []
  return installed.getBuiltinModels(provider)
}
