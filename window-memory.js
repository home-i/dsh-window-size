/**
 * Remember, restore, and control the Desktop window size.
 *
 * The Host starts while the shell's window is already created but still hidden,
 * so the remembered size (and optional centering) is applied before the first
 * paint. A slow poll then records every manual resize, ignoring maximized,
 * minimized and hidden states so the next launch never reopens oversized. The
 * same controller backs the settings page, which can apply a size, re-center,
 * or record the current window immediately.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { readState, writeState } from './state.js'
import { isDesktopHost, loadWindowApi } from './win32.js'

/** Electron's minimum window size, mirrored from the Desktop shell. */
export const MIN_WIDTH = 520
export const MIN_HEIGHT = 600
/** First-run size used when nothing was configured or recorded. */
export const DEFAULT_WIDTH = 1440
export const DEFAULT_HEIGHT = 900
/** How often to look for a window that does not exist yet. */
const FIND_INTERVAL_MS = 250
/** Give up waiting when the shell never creates its window. */
const FIND_TIMEOUT_MS = 180_000
/** How often to notice a manual resize. */
const POLL_INTERVAL_MS = 1_500
/** Wait for a drag to settle before writing it. */
const SAVE_DELAY_MS = 700
/** Ignore sizes observed immediately after this plugin sets one. */
const RESTORE_GRACE_MS = 1_200
/** Longest a settings-page request waits for a window to appear. */
const RPC_WAIT_MS = 3_000

/**
 * Coerce one configured pixel size.
 * @param value - configured number.
 * @param fallback - size used when the value is unusable.
 * @param minimum - smallest accepted size.
 * @returns a positive integer at least the minimum.
 */
function configured(value, fallback, minimum) {
  const number = Math.round(Number(value))
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.max(minimum, number)
}

/**
 * Clamp a value between two bounds.
 * @param value - candidate.
 * @param minimum - lower bound.
 * @param maximum - upper bound, which may be below the lower bound.
 * @returns the bounded value.
 */
function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

/**
 * Convert a physical window size to the CSS-pixel size Electron reports.
 * @param pixels - physical width or height.
 * @param scale - pixels per CSS pixel.
 * @returns rounded CSS pixels.
 */
function toCssPixels(pixels, scale) {
  return Math.round(pixels / scale)
}

/**
 * Create the window-size controller.
 *
 * The controller starts immediately: it waits for the shell window, restores
 * the remembered size, and then tracks manual resizes. `dispose` stops it.
 * @param options - configured first-run size and test seams.
 * @param options.width - first-run width in CSS pixels.
 * @param options.height - first-run height in CSS pixels.
 * @param options.center - whether a missing record centers the window.
 * @param options.enabled - whether a missing record enables the feature.
 * @param options.pid - Electron main-process id; defaults to the parent process.
 * @param options.pollIntervalMs - resize observation period.
 * @param options.findTimeoutMs - how long to wait for the window.
 * @param options.skipFind - do not wait for the window at bootstrap, for tests.
 * @param options.api - prebuilt window API, used by tests.
 * @param logger - logger receiving failure details.
 * @returns the controller, whose methods are safe to call before a window exists.
 */
export function createWindowMemory(options = {}, logger = console) {
  const fallback = {
    width: configured(options.width, DEFAULT_WIDTH, MIN_WIDTH),
    height: configured(options.height, DEFAULT_HEIGHT, MIN_HEIGHT),
  }
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
  const findTimeoutMs = options.findTimeoutMs ?? FIND_TIMEOUT_MS

  /** Latest known record; replaced wholesale on every write. */
  let state = {
    size: null,
    center: typeof options.center === 'boolean' ? options.center : true,
    enabled: typeof options.enabled === 'boolean' ? options.enabled : true,
    last: undefined,
  }
  let api
  let apiError
  try {
    api = options.api ?? loadWindowApi()
  } catch (error) {
    apiError = error instanceof Error ? error.message : String(error)
  }

  const host = isDesktopHost()
  const desktop = host && process.platform === 'win32' && api !== undefined
  const pid = options.pid ?? process.ppid

  let disposed = false
  let hwnd
  let pollTimer
  let saveTimer
  let graceUntil = 0
  let observed
  /** Serializes disk writes and window mutations so poll and RPC never interleave. */
  let queue = Promise.resolve()

  /**
   * Run one operation after the previous one finished.
   * @param operation - work to serialize.
   * @returns the operation's result.
   */
  function serialized(operation) {
    const run = queue.then(operation, operation)
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Measure the live window in CSS pixels.
   * @returns current size, or null when no window is known.
   */
  function currentSize() {
    if (!desktop || !hwnd) return null
    const bounds = api.bounds(hwnd)
    if (!bounds) return null
    const scale = api.dpiScale(hwnd)
    return { width: toCssPixels(bounds.width, scale), height: toCssPixels(bounds.height, scale) }
  }

  /**
   * Center a physical rectangle on the window's monitor work area.
   * @param handle - window handle.
   * @param width - physical width.
   * @param height - physical height.
   * @returns position and size for `setBounds`, or null without monitor data.
   */
  function centeredTarget(handle, width, height) {
    const area = api.workArea(handle)
    if (!area) return null
    return {
      x: area.x + Math.round((area.width - width) / 2),
      y: area.y + Math.round((area.height - height) / 2),
      width,
      height,
    }
  }

  /**
   * Record the live window size and persist the whole document.
   * @param source - diagnostic label for the record.
   * @param action - what produced the size.
   */
  async function persist(source, action) {
    const measured = currentSize()
    if (measured === null) return
    const stores = action === 'resize' || action === 'apply' || action === 'remember' || action === 'center'
    if (!stores && state.size !== null) {
      state = { ...state, last: { action, source, size: measured, at: Date.now() } }
      await writeState(state)
      return
    }
    if (action === 'resize' && state.size !== null
      && state.size.width === measured.width && state.size.height === measured.height) return
    state = {
      ...state,
      size: stores ? measured : state.size,
      last: {
        action,
        source,
        size: measured,
        dpiScale: hwnd ? api.dpiScale(hwnd) : undefined,
        title: hwnd ? api.title(hwnd).slice(0, 120) : undefined,
        at: Date.now(),
      },
    }
    await writeState(state)
  }

  /**
   * Wait until the shell creates the application window.
   * @returns the window handle, or undefined on timeout.
   */
  async function waitForWindow() {
    const deadline = Date.now() + findTimeoutMs
    while (!disposed && Date.now() < deadline) {
      const found = api.findApplicationWindow(pid)
      if (found) return found
      await sleep(FIND_INTERVAL_MS)
    }
    return undefined
  }

  /**
   * Apply one CSS-pixel size, clamped to the work area, honoring centering.
   * @param size - requested size in CSS pixels.
   * @returns the applied size, or null when no window is available.
   */
  function place(size) {
    if (!desktop || !hwnd) return null
    const bounds = api.bounds(hwnd)
    if (!bounds) return null
    const scale = api.dpiScale(hwnd)
    const area = api.workArea(hwnd)
    const wanted = {
      width: Math.max(MIN_WIDTH, Math.round(Number(size.width))),
      height: Math.max(MIN_HEIGHT, Math.round(Number(size.height))),
    }
    const maxWidth = area ? Math.max(MIN_WIDTH, Math.floor(area.width / scale)) : wanted.width
    const maxHeight = area ? Math.max(MIN_HEIGHT, Math.floor(area.height / scale)) : wanted.height
    const target = {
      width: Math.round(clamp(wanted.width, MIN_WIDTH, maxWidth) * scale),
      height: Math.round(clamp(wanted.height, MIN_HEIGHT, maxHeight) * scale),
    }
    const centered = state.center ? centeredTarget(hwnd, target.width, target.height) : null
    const rect = centered ?? { x: bounds.x, y: bounds.y, ...target }
    if (!centered && area) {
      rect.x = clamp(rect.x, area.x, area.x + area.width - rect.width)
      rect.y = clamp(rect.y, area.y, area.y + area.height - rect.height)
    }
    graceUntil = Date.now() + RESTORE_GRACE_MS
    api.setBounds(hwnd, rect)
    const after = api.bounds(hwnd)
    if (after) observed = { width: after.width, height: after.height }
    return currentSize()
  }

  /**
   * Apply the remembered size at startup.
   */
  async function restore() {
    if (state.enabled) place(state.size ?? fallback)
    await persist(state.size === null ? 'default' : 'remembered', 'restore')
  }

  /**
   * Notice manual resizes and record the settled size.
   */
  function poll() {
    if (disposed || !desktop || !hwnd) return
    const bounds = api.bounds(hwnd)
    if (!bounds) {
      hwnd = undefined
      return
    }
    if (!state.enabled) return
    if (Date.now() < graceUntil) return
    if (!api.isVisible(hwnd) || api.isMaximized(hwnd) || api.isMinimized(hwnd)) return
    if (observed && observed.width === bounds.width && observed.height === bounds.height) return
    observed = { width: bounds.width, height: bounds.height }
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      if (disposed || !hwnd) return
      const settled = api.bounds(hwnd)
      if (!settled || settled.width !== bounds.width || settled.height !== bounds.height) return
      if (api.isMaximized(hwnd) || api.isMinimized(hwnd)) return
      serialized(() => persist('window', 'resize')).catch(() => undefined)
    }, SAVE_DELAY_MS)
  }

  const bootstrap = (async () => {
    if (!desktop) return
    state = { ...state, ...(await readState(state)) }
    if (options.skipFind === true) return
    hwnd = await waitForWindow()
    if (!hwnd || disposed) return
    await serialized(restore)
    if (disposed) return
    pollTimer = setInterval(poll, pollIntervalMs)
  })().catch(error => {
    logger.warn?.(`dsh-window-size: ${error instanceof Error ? error.message : String(error)}`)
  })

  /**
   * Wait for the window to become controllable, without blocking a page request
   * for the whole bootstrap deadline.
   * @param waitMs - longest extra wait; defaults to RPC_WAIT_MS.
   * @returns the window handle.
   * @throws when no window exists yet.
   */
  async function ensureWindow(waitMs = RPC_WAIT_MS) {
    if (!desktop) throw new Error('window control is unavailable on this Host')
    if (hwnd === undefined) {
      await Promise.race([bootstrap, sleep(waitMs)])
      hwnd = hwnd ?? api.findApplicationWindow(pid)
    }
    if (hwnd === undefined) throw new Error('the desktop window is not available yet')
    return hwnd
  }

  const controller = {
    /** Whether this Host can control the window at all. */
    available: desktop,

    /** Why window control is unavailable, when it is. */
    unavailableReason: desktop
      ? null
      : apiError ?? (host ? `unsupported platform ${process.platform}` : 'not the Desktop Host'),

    /**
     * Snapshot for the settings page.
     * @returns recorded size, flags, live size, and the last action.
     */
    status() {
      return {
        available: desktop,
        reason: controller.unavailableReason,
        platform: process.platform,
        recorded: state.size ?? { width: fallback.width, height: fallback.height },
        recordedSource: state.size === null ? 'default' : 'saved',
        center: state.center,
        enabled: state.enabled,
        current: currentSize(),
        defaults: { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT },
        minimum: { width: MIN_WIDTH, height: MIN_HEIGHT },
        last: state.last ?? null,
      }
    },

    /**
     * Apply one size now and remember it.
     * @param size - requested size in CSS pixels.
     * @returns the status after the change.
     */
    async apply(size) {
      await ensureWindow()
      await serialized(async () => {
        const applied = place({ width: size.width, height: size.height })
        if (applied === null) throw new Error('no desktop window to resize')
        await persist('settings', 'apply')
      })
      return controller.status()
    },

    /**
     * Re-apply the recorded size with the current centering preference.
     * @returns the status after the change.
     */
    async reapply() {
      return controller.apply(state.size ?? fallback)
    },

    /**
     * Apply the configured default size.
     * @returns the status after the change.
     */
    async reset() {
      return controller.apply(fallback)
    },

    /**
     * Center the window at its current size.
     * @returns the status after the change.
     */
    async center() {
      await ensureWindow()
      await serialized(async () => {
        if (!desktop || !hwnd) throw new Error('no desktop window to center')
        const bounds = api.bounds(hwnd)
        if (!bounds) throw new Error('no desktop window to center')
        const target = centeredTarget(hwnd, bounds.width, bounds.height)
        if (!target) throw new Error('no monitor work area for the window')
        graceUntil = Date.now() + RESTORE_GRACE_MS
        api.setBounds(hwnd, target)
        await persist('settings', 'center')
      })
      return controller.status()
    },

    /**
     * Record the live window size.
     * @returns the status after the change.
     */
    async remember() {
      await ensureWindow()
      await serialized(() => persist('settings', 'remember'))
      return controller.status()
    },

    /**
     * Store the centering preference without moving the window.
     * @param enabled - whether future restores center the window.
     * @returns the status after the change.
     */
    async setCenter(enabled) {
      await ensureWindow()
      await serialized(async () => {
        state = {
          ...state,
          center: enabled === true,
          last: { action: enabled === true ? 'center-on' : 'center-off', at: Date.now() },
        }
        await writeState(state)
      })
      return controller.status()
    },

    /**
     * Store whether the feature restores and tracks the size.
     * @param enabled - whether the feature is active.
     * @returns the status after the change.
     */
    async setEnabled(enabled) {
      await ensureWindow()
      await serialized(async () => {
        state = {
          ...state,
          enabled: enabled === true,
          last: { action: enabled === true ? 'enabled' : 'disabled', at: Date.now() },
        }
        await writeState(state)
      })
      return controller.status()
    },

    /** Stop tracking and cancel pending work. */
    dispose() {
      disposed = true
      if (pollTimer !== undefined) clearInterval(pollTimer)
      if (saveTimer !== undefined) clearTimeout(saveTimer)
    },
  }

  return controller
}

