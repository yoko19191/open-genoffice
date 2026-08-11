import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

export type AtomicWriteFailurePoint = 'before_rename' | 'after_rename'

export type AtomicWriteOptions = {
  platform?: NodeJS.Platform
  randomUUID?: () => string
  failAt?: AtomicWriteFailurePoint
}

function injectedFailure(): Error {
  return new Error('injected_atomic_write_failure')
}

export async function atomicWriteFile(
  target: string,
  value: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform
  const parent = dirname(target)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const temporaryPath = join(
    parent,
    `.${basename(target)}.tmp-${(options.randomUUID ?? randomUUID)()}`,
  )
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(value)
    await handle.sync()
  } finally {
    await handle.close()
  }

  let renamed = false
  try {
    if (options.failAt === 'before_rename') throw injectedFailure()
    await rename(temporaryPath, target)
    renamed = true
    if (platform !== 'win32') await chmod(target, 0o600)
    if (options.failAt === 'after_rename') throw injectedFailure()
    if (platform !== 'win32') {
      const parentHandle = await open(parent, 'r')
      try {
        await parentHandle.sync()
      } finally {
        await parentHandle.close()
      }
    }
  } catch (error) {
    if (!renamed) await unlink(temporaryPath)
    throw error
  }
}

export function atomicWriteJson(
  target: string,
  value: unknown,
  options?: AtomicWriteOptions,
): Promise<void> {
  return atomicWriteFile(target, `${JSON.stringify(value, null, 2)}\n`, options)
}
