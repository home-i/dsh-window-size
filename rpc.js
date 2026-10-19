/**
 * RPC channel between the settings page and this plugin's Host half.
 *
 * The channel is a prefix route on the Web carrier: `POST /dsh-window-size/<endpoint>`
 * carrying the Connection client-request envelope. Admission goes through
 * `connection.admit`, so only an authenticated page of this Host can reach the
 * window — the same fence `connection.rpc.handle` applies.
 *
 * Why not `connection.rpc.handle`: in this Desktop Host build the helper
 * registers its route through the Connection service's own context and never
 * returns, leaving the path unserved (the page then sees the carrier's 405).
 * Registering the prefix route through `webServer.register` plus
 * `connection.admit` reproduces the documented contract with public methods.
 */

/** Channel shared by both halves. */
export const CHANNEL = '/dsh-window-size'

/** Largest request body accepted on the channel. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Validate a size payload from the page.
 * @param payload - untrusted request body.
 * @returns integer width and height.
 * @throws when either member is not a positive finite number.
 */
function readSize(payload) {
  const width = Math.round(Number(payload?.width))
  const height = Math.round(Number(payload?.height))
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('width and height must be positive numbers')
  }
  return { width, height }
}

/**
 * Read a boolean payload from the page.
 * @param payload - untrusted request body.
 * @returns the boolean value.
 * @throws when the payload is not a boolean.
 */
function readFlag(payload) {
  if (typeof payload !== 'boolean') throw new Error('expected a boolean payload')
  return payload
}

/**
 * Dispatch one endpoint.
 * @param controller - window controller.
 * @param endpoint - endpoint name from the URL.
 * @param payload - request body payload.
 * @returns the endpoint result.
 */
async function dispatch(controller, endpoint, payload) {
  switch (endpoint) {
    case 'status': return controller.status()
    case 'apply': return await controller.apply(readSize(payload))
    case 'reapply': return await controller.reapply()
    case 'reset': return await controller.reset()
    case 'center': return await controller.center()
    case 'remember': return await controller.remember()
    case 'set-center': return await controller.setCenter(readFlag(payload))
    case 'set-enabled': return await controller.setEnabled(readFlag(payload))
    default: throw new Error(`unknown endpoint ${JSON.stringify(endpoint)}`)
  }
}

/**
 * Resolve the endpoint from a request path.
 * @param pathname - request path.
 * @returns the endpoint, or undefined when the path is outside the channel.
 */
function endpointFromPath(pathname) {
  if (!pathname.startsWith(`${CHANNEL}/`)) return undefined
  const endpoint = pathname.slice(CHANNEL.length + 1)
  if (endpoint === '' || endpoint.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    return undefined
  }
  return endpoint
}

/**
 * Answer one response envelope.
 * @param res - Node response.
 * @param status - HTTP status.
 * @param body - JSON body.
 */
function respond(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * Build a response envelope.
 * @param rpcId - request id to echo.
 * @param result - success or failure result.
 * @returns the envelope.
 */
function envelope(rpcId, result) {
  return { type: 'server-response', rpcId, result }
}

/**
 * Register the channel on the Host Web carrier.
 * @param ctx - plugin context; `connection` and `webServer` are injected.
 * @param controller - window controller backing the endpoints.
 * @param logger - logger receiving registration failures.
 * @returns a disposer for the registration, or undefined when unavailable.
 */
export function installWindowRpc(ctx, controller, logger = console) {
  const connection = ctx.connection
  const webServer = ctx.webServer
  if (webServer === undefined || typeof webServer.register !== 'function') {
    logger.warn?.('dsh-window-size: Host Web carrier unavailable — the settings page cannot reach the window')
    return undefined
  }
  if (connection === undefined || typeof connection.admit !== 'function') {
    logger.warn?.('dsh-window-size: Host Connection unavailable — the settings page cannot reach the window')
    return undefined
  }

  const handler = async (req, res) => {
    const admission = connection.admit(req)
    if (admission.rejection !== undefined) {
      res.writeHead(admission.rejection)
      res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const endpoint = endpointFromPath(url.pathname)
    if (req.method !== 'POST' || endpoint === undefined) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
    if (contentType !== 'application/json') {
      res.writeHead(415)
      res.end('content type must be application/json')
      return
    }
    let raw = ''
    try {
      for await (const chunk of req) {
        raw += chunk
        if (raw.length > MAX_BODY_BYTES) throw new Error('body too large')
      }
    } catch (error) {
      res.writeHead(400)
      res.end(String(error instanceof Error ? error.message : error))
      return
    }
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      res.writeHead(400)
      res.end('body is not JSON')
      return
    }
    const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
    if (message?.type !== 'client-request' || message?.method !== endpoint) {
      respond(res, 200, envelope(rpcId, {
        ok: false,
        error: { code: 'gateway/bad-request', message: 'invalid client-request envelope', details: {} },
      }))
      return
    }
    try {
      const value = await dispatch(controller, endpoint, message.payload)
      respond(res, 200, envelope(rpcId, { ok: true, value }))
    } catch (error) {
      respond(res, 200, envelope(rpcId, {
        ok: false,
        error: {
          code: 'bad-request',
          message: error instanceof Error ? error.message : String(error),
          details: {},
        },
      }))
    }
  }

  try {
    return webServer.register({ kind: 'prefix', path: CHANNEL, handler })
  } catch (error) {
    logger.warn?.(`dsh-window-size: RPC registration failed: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}
