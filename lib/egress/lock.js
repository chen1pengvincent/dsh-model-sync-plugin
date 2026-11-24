import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'

const LOCK_WAIT_MS = 5_000
const LOCK_STALE_MS = 60_000
const exec = promisify(execFile)

export class LockTimeoutError extends Error {
  code = 'LOCK_TIMEOUT'

  constructor() {
    super('model-sync egress lock is busy')
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

async function processIdentity(pid) {
  try {
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      return stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19]
    }
    if (process.platform === 'darwin') {
      const { stdout } = await exec('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
        timeout: 500,
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      })
      return stdout.trim() || undefined
    }
  } catch {
    // An unidentifiable live PID still owns its lock.
  }
  return undefined
}

async function reapDeadOwner(path) {
  const names = await readdir(path).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const name of names) {
    const match = /^owner-(\d+)-\d+-[a-f0-9-]+$/.exec(name)
    if (match === null || Number(match[1]) < 1) continue
    const pid = Number(match[1])
    const ownerPath = join(path, name)
    if (alive(pid)) {
      const acquired = Number(name.split('-')[2])
      if (Date.now() - acquired < LOCK_STALE_MS) continue
      const stored = await readFile(ownerPath, 'utf8').catch(() => '')
      const current = stored === '' ? undefined : await processIdentity(pid)
      if (current === undefined || current === stored) continue
    }
    // Each acquisition has a different filename. Two reapers can race safely:
    // neither can remove a successor's owner file after it has acquired.
    await unlink(ownerPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

/** Publish a fully initialized lock atomically. An owned directory is nonempty. */
export async function withLock(path, fn, waitMs = LOCK_WAIT_MS) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const candidate = await mkdtemp(join(dirname(path), '.egress-lock-'))
  const name = `owner-${process.pid}-${Date.now()}-${randomUUID()}`
  let acquired = false
  try {
    await writeFile(join(candidate, name), await processIdentity(process.pid) ?? '', { mode: 0o600 })
    const deadline = Date.now() + waitMs
    do {
      try {
        await rename(candidate, path)
        acquired = true
        break
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error
      }
      if (Date.now() >= deadline) throw new LockTimeoutError()
      await reapDeadOwner(path)
      await sleep(Math.min(100, Math.max(0, deadline - Date.now())))
    } while (true)
    return await fn()
  } finally {
    if (acquired) {
      await unlink(join(path, name))
      // rmdir cannot remove a successor's nonempty lock.
      await rmdir(path).catch((error) => {
        if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
      })
    } else {
      await rm(candidate, { recursive: true, force: true })
    }
  }
}
