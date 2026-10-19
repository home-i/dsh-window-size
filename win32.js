/**
 * Win32 window access for the Electron Desktop shell.
 *
 * Electron renderers cannot resize the main window (`window.resizeTo` only
 * emits `content-bounds-updated`), and the Desktop shell does not persist
 * window bounds, so the remembered size is applied to the native window from
 * the Host process. `koffi` ships with `@deepseek-ai/dsh-desktop-host`, which is
 * this process's own entry point, so the binding is resolved from there and
 * never from the DSH profile.
 */
import { createRequire } from 'node:module'

/** Leave the size untouched. */
export const SWP_NOSIZE = 0x0001
/** Leave the position untouched. */
export const SWP_NOMOVE = 0x0002
/** Keep the current z-order. */
export const SWP_NOZORDER = 0x0004
/** Do not activate the window. */
export const SWP_NOACTIVATE = 0x0010
/** Pick the monitor nearest the window. */
export const MONITOR_DEFAULTTONEAREST = 2
/**
 * Smallest width that identifies the application window. Electron creates it
 * at 1280 while the first-run onboarding window is a fixed 600 wide, so this
 * separates the two windows of one process without reading page state.
 */
const APPLICATION_WINDOW_MIN_WIDTH = 1000
/** Class name Electron gives every BrowserWindow. */
const ELECTRON_WINDOW_CLASS = 'Chrome_WidgetWin_1'
/** Assumed scale for a window whose DPI cannot be read. */
const BASE_DPI = 96

/**
 * Whether this process is the Desktop shell's Host child.
 * @returns true when started by `dsh-desktop-host` over its IPC channel.
 */
export function isDesktopHost() {
  const entry = process.argv[1] ?? ''
  return typeof process.send === 'function'
    && /[\\/]dsh-desktop-host[\\/]lib[\\/]index\.js$/u.test(entry)
}

/**
 * Load the Win32 bindings used to observe and place the application window.
 * @returns window operations, or undefined when koffi or user32 is unavailable.
 */
export function loadWindowApi() {
  const require = createRequire(process.argv[1] ?? import.meta.url)
  const koffi = require('koffi')
  const user32 = koffi.load('user32.dll')

  const RECT = koffi.struct('DshWindowRect', {
    left: 'int32', top: 'int32', right: 'int32', bottom: 'int32',
  })
  const MONITORINFO = koffi.struct('DshMonitorInfo', {
    cbSize: 'uint32', rcMonitor: RECT, rcWork: RECT, dwFlags: 'uint32',
  })

  const FindWindowExW = user32.func('void * __stdcall FindWindowExW(void *parent, void *after, const char16_t *cls, const char16_t *title)')
  const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)')
  const GetWindowTextLengthW = user32.func('int __stdcall GetWindowTextLengthW(void *hwnd)')
  const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void *hwnd, _Out_ uint16_t *buffer, int max)')
  const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *hwnd, _Out_ DshWindowRect *rect)')
  const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *hwnd)')
  const IsZoomed = user32.func('bool __stdcall IsZoomed(void *hwnd)')
  const IsIconic = user32.func('bool __stdcall IsIconic(void *hwnd)')
  const GetDpiForWindow = user32.func('uint32_t __stdcall GetDpiForWindow(void *hwnd)')
  const SetWindowPos = user32.func('bool __stdcall SetWindowPos(void *hwnd, void *after, int x, int y, int cx, int cy, uint32_t flags)')
  const MonitorFromWindow = user32.func('void * __stdcall MonitorFromWindow(void *hwnd, uint32_t flags)')
  const GetMonitorInfoW = user32.func('bool __stdcall GetMonitorInfoW(void *monitor, _Inout_ DshMonitorInfo *info)')
  const SetProcessDpiAwarenessContext = user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t value)')

  try {
    // Report physical pixels and the real monitor scale instead of a
    // DPI-virtualized coordinate space.
    SetProcessDpiAwarenessContext(-4)
  } catch {
    // A process that is already DPI aware keeps its current context.
  }

  /**
   * Read a window's outer rectangle.
   * @param hwnd - window handle.
   * @returns absolute position and size, or null when the window is gone.
   */
  function bounds(hwnd) {
    if (!hwnd) return null
    const rect = {}
    if (!GetWindowRect(hwnd, rect)) return null
    const width = rect.right - rect.left
    const height = rect.bottom - rect.top
    if (!(width > 0 && height > 0)) return null
    return { x: rect.left, y: rect.top, width, height }
  }

  /**
   * Read the DPI scale of a window.
   * @param hwnd - window handle.
   * @returns pixels per CSS pixel, at least 1.
   */
  function dpiScale(hwnd) {
    let dpi = BASE_DPI
    try {
      dpi = GetDpiForWindow(hwnd) || BASE_DPI
    } catch {
      dpi = BASE_DPI
    }
    return Math.max(1, dpi / BASE_DPI)
  }

  /**
   * Read the work area of the monitor that holds a window.
   * @param hwnd - window handle.
   * @returns work area rectangle, or null when monitor data is unavailable.
   */
  function workArea(hwnd) {
    const monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
    if (!monitor) return null
    const info = { cbSize: koffi.sizeof(MONITORINFO) }
    if (!GetMonitorInfoW(monitor, info)) return null
    return {
      x: info.rcWork.left,
      y: info.rcWork.top,
      width: info.rcWork.right - info.rcWork.left,
      height: info.rcWork.bottom - info.rcWork.top,
    }
  }

  /**
   * Move and resize one window.
   * @param hwnd - window handle.
   * @param rect - absolute position and size.
   * @returns whether Windows accepted the request.
   */
  function setBounds(hwnd, rect) {
    return SetWindowPos(
      hwnd,
      null,
      Math.round(rect.x),
      Math.round(rect.y),
      Math.round(rect.width),
      Math.round(rect.height),
      SWP_NOZORDER | SWP_NOACTIVATE,
    )
  }

  /**
   * Find the Desktop application window of one Electron process.
   * @param pid - Electron main-process id.
   * @returns window handle, or null before the window exists.
   */
  function findApplicationWindow(pid) {
    let hwnd = null
    for (;;) {
      hwnd = FindWindowExW(null, hwnd, ELECTRON_WINDOW_CLASS, null)
      if (!hwnd) return null
      const owner = [0]
      GetWindowThreadProcessId(hwnd, owner)
      if (owner[0] !== pid) continue
      const rect = bounds(hwnd)
      if (rect && rect.width >= APPLICATION_WINDOW_MIN_WIDTH) return hwnd
    }
  }

  /**
   * Read a window title for diagnostics.
   * @param hwnd - window handle.
   * @returns current window title, or an empty string.
   */
  function title(hwnd) {
    const length = GetWindowTextLengthW(hwnd)
    if (length <= 0) return ''
    const buffer = Buffer.alloc((length + 1) * 2)
    GetWindowTextW(hwnd, buffer, length + 1)
    return buffer.toString('utf16le', 0, length * 2)
  }

  return {
    findApplicationWindow,
    bounds,
    dpiScale,
    workArea,
    setBounds,
    title,
    isVisible: hwnd => Boolean(IsWindowVisible(hwnd)),
    isMaximized: hwnd => Boolean(IsZoomed(hwnd)),
    isMinimized: hwnd => Boolean(IsIconic(hwnd)),
  }
}
