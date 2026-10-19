/**
 * Host half of the Desktop window-size memory bundle.
 *
 * Restores the remembered size while the shell's window is still hidden, tracks
 * manual resizes, and serves the settings page over the Host Connection RPC
 * channel. Every capability the page offers (apply a size, center, record the
 * current window, reset) routes through the same controller.
 */
import { createWindowMemory } from './window-memory.js'
import { installWindowRpc } from './rpc.js'

export const name = 'dsh-window-size'

/**
 * Services this Host half needs before it activates.
 *
 * `connection` owns the RPC channel registry and `webServer` is the carrier the
 * channel's prefix route mounts on, so declaring both makes Cordis wait for a
 * complete Web Host instead of racing Loader row order.
 */
export const inject = ['connection', 'webServer']

/**
 * Start the window-size feature for this Host.
 * @param ctx - plugin context providing the lifetime effect.
 * @param config - optional first-run size and flags in CSS pixels.
 */
export function apply(ctx, config) {
  const logger = resolveLogger(ctx)
  const controller = createWindowMemory({
    width: config?.width,
    height: config?.height,
    center: config?.center,
    enabled: config?.enabled,
  }, logger)
  const disposeRpc = installWindowRpc(ctx, controller, logger)
  ctx.effect(() => () => {
    disposeRpc?.()
    controller.dispose()
  }, 'dsh-window-size: remembered window size and settings page')
}

/**
 * Build a logger that never hides a missing console from the plugin.
 * @param ctx - plugin context that may expose a named logger.
 * @returns the context logger, or the console.
 */
function resolveLogger(ctx) {
  try {
    const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-window-size') : undefined
    if (logger && typeof logger.warn === 'function') return logger
  } catch {
    // Fall through to the console.
  }
  return console
}
