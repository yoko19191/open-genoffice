// proper-lockfile 4.1.2 has no bundled TypeScript declarations.
// @ts-expect-error The typed facade below is the only import boundary for this pinned CJS package.
import properLockfile from 'proper-lockfile'

type LockOptions = {
  realpath: false
  stale: number
  retries: {
    retries: number
    factor: number
    minTimeout: number
    maxTimeout: number
  }
}

export const lock = properLockfile.lock as (
  path: string,
  options: LockOptions,
) => Promise<() => Promise<void>>
