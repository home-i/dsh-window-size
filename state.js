/**
 * Durable window record for the Desktop window.
 *
 * The record lives under the harness home so it follows the Desktop profile,
 * not Electron's per-install userData directory. Writes replace the document
 * atomically; a corrupt or unreadable record is ignored.
 *
 * Schema v2 adds `center` (keep the window centered on the monitor work area)
 * and `enabled` (restore and track at all). A v1 document keeps its remembered
 * size and picks up the defaults for the new members.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** File name inside the plugin's own directory under the harness home. */
const FILE_NAME = 'window-size.json'

/**
 * Resolve the harness home the same way dsh does.
 * @returns absolute harness home path.
 */
function harnessHome() {
  const configured = process.env.DSH_HOME?.trim()
  return configured !== undefined && configured.length > 0
    ? configured
    : join(homedir(), '.dsh')
}

/**
 * Absolute path of the size record.
 * @returns the record path.
 */
export function statePath() {
  return join(harnessHome(), 'dsh-window-size', FILE_NAME)
}

/**
 * Validate a positive integer size.
 * @param value - candidate number.
 * @param fallback - value used when the candidate is unusable.
 * @returns a positive integer.
 */
function size(value, fallback) {
  const number = Math.round(Number(value))
  return Number.isFinite(number) && number > 0 ? number : fallback
}

/**
 * Read one boolean flag.
 * @param value - candidate value.
 * @param fallback - value used when the candidate is not a boolean.
 * @returns the boolean.
 */
function flag(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Read the recorded state.
 * @param defaults - values used for members the document does not carry.
 * @returns the record; `size` is null when never recorded.
 */
export async function readState(defaults = {}) {
  const fallback = {
    center: flag(defaults.center, true),
    enabled: flag(defaults.enabled, true),
  }
  try {
    const raw = await readFile(statePath(), 'utf8')
    const value = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { size: null, ...fallback }
    const stored = typeof value.size === 'object' && value.size !== null ? value.size : null
    const width = size(stored?.width, 0)
    const height = size(stored?.height, 0)
    return {
      size: width > 0 && height > 0 ? { width, height } : null,
      center: flag(value.center, fallback.center),
      enabled: flag(value.enabled, fallback.enabled),
      last: typeof value.last === 'object' && value.last !== null ? value.last : undefined,
    }
  } catch {
    return { size: null, ...fallback }
  }
}

/**
 * Replace the recorded document.
 * @param record - size, flags, and the last action for diagnostics.
 * @returns whether the record was written.
 */
export async function writeState(record) {
  const path = statePath()
  const temporary = `${path}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      temporary,
      `${JSON.stringify({
        size: record.size ?? null,
        center: flag(record.center, true),
        enabled: flag(record.enabled, true),
        last: record.last,
        updatedAt: Date.now(),
      }, null, 2)}\n`,
      'utf8',
    )
    await rename(temporary, path)
    return true
  } catch {
    return false
  }
}
