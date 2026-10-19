# dsh-window-size

[简体中文](README.md) · **English**

Remember the **DeepSeek Harness Desktop** window size across restarts, keep it
centered, and change it from a settings page instead of dragging the frame.

![platform: Windows](https://img.shields.io/badge/platform-Windows-0078D4)
![host: DSH Desktop](https://img.shields.io/badge/host-DSH%20Desktop-4f6ef7)
![license: MIT](https://img.shields.io/badge/license-MIT-green)

- **First launch**: no record yet → **1440 × 900**, centered.
- **Every manual resize** is recorded and restored on the next launch.
- **Centered by default**: each launch places the window in the middle of the
  current display's work area. Turn it off to keep the last position instead.
- **Forgiving**: maximized, minimized, and hidden states are never recorded, so a
  maximized window does not reopen oversized; sizes are clamped to the monitor's
  work area, so a window remembered on a bigger display still fits.
- **Settings page**: `Settings → Window size` sets the size by hand, records the
  current window, re-centers, or resets to the default.
- On non-Desktop Hosts (`dsh` CLI, servers) the bundle loads but reports the
  settings page as unavailable.

## Why a Host plugin

The Desktop shell creates its main window at a fixed `1280 × 820` and persists no
window state. A renderer-side plugin cannot fix that: in Electron,
`window.resizeTo()` is routed to `WebContentsDelegate::SetContentsBounds`, which
Electron only forwards as the `content-bounds-updated` event — it does **not**
resize the `BrowserWindow`.

So the Host process does the work. It uses `koffi` (already a dependency of
`@deepseek-ai/dsh-desktop-host`) to call `FindWindowExW` / `GetWindowRect` /
`GetDpiForWindow` / `SetWindowPos` on the shell's window, and applies the
remembered size **while the window is still hidden**, before the first paint.

## Settings page

`Settings → Window size` is a `settings.section` entry. It shows the live size,
the recorded size, and the last action (with a timestamp), and offers:

| Control | Effect |
|---|---|
| Width / Height + **Apply and remember** | resizes the window now and stores that size |
| **Remember current size** | stores the size the window has right now |
| **Re-apply** | applies the recorded size again, with the current centering |
| **Restore default** | applies the configured default `1440 × 900` |
| **Center on launch** toggle | whether restores center the window |
| **Center now** | centers the window without changing its size |
| **Enable size memory** toggle | off = never restore and never record |

The page never touches the window itself. It calls the Host half over a
package-private RPC channel (`/dsh-window-size`) with
`ctx.connection.rpc.call`, and the Host answers from the same controller that
does the startup restore.

## Install

Install it straight from GitHub through the plugin manager:

```
github:home-i/dsh-window-size#v1.1.1
```

Or, from the Desktop app's **Plugins** page, install the bundle from a local
checkout. A checkout can also be linked into the Desktop profile:

```jsonc
// ~/.dsh/profiles/desktop/package.json
{
  "dependencies": {
    "dsh-window-size": "link:/path/to/dsh-window-size"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-window-size"]
    }
  }
}
```

The bundle then loads on the next launch, and edits to the checkout take effect
without reinstalling.

> Do not replace that `link:` with a hand-made Windows junction and then run
> `pnpm install`: pnpm removes the entry while installing, and Windows follows a
> junction into its target, which empties the checkout.

## Configuration

The inserted Loader row carries the first-run defaults:

```yaml
# cordis.patch.yml
- insert:
    - id: dsh-window-size
      name: dsh-window-size
      config:
        width: 1440        # first-run width,  CSS pixels
        height: 900        # first-run height, CSS pixels
        center: true       # center the window on every restore
        enabled: true      # restore and record at all
```

Sizes are CSS pixels. Width/height are clamped to at least `520 × 600`, and to
the current monitor's work area at restore time.

## State

The record lives under the harness home, next to the profile rather than in
Electron's per-install `userData` directory:

```
~/.dsh/dsh-window-size/window-size.json
```

```json
{
  "size": { "width": 1440, "height": 900 },
  "center": true,
  "enabled": true,
  "last": { "action": "restore", "source": "remembered", "at": 0 },
  "updatedAt": 0
}
```

`last` records the most recent action — `restore`, `resize`, `apply`, `remember`,
`center`, `center-on`, `center-off`, `enabled`, `disabled` — with the achieved
size, DPI scale, and window title, which is what the settings page displays and
what makes a bad restore diagnosable. Delete the file to fall back to the
configured defaults. A schema-v1 file (size + last only) is upgraded in place:
its size is kept and the new flags take their configured defaults.

## RPC contract

The Host registers a prefix route on the Web carrier and admits each request
through `connection.admit`, so only an authenticated page of the same Host can
reach the window:

```
POST /dsh-window-size/<endpoint>
content-type: application/json

{ "type": "client-request", "rpcId": "…", "method": "<endpoint>", "payload": … }
```

Endpoints: `status`, `apply` (`{width,height}`), `reapply`, `reset`, `center`,
`remember`, `set-center` (`true|false`), `set-enabled` (`true|false`). Answers use
the Connection `server-response` envelope; failures come back as
`{ ok: false, error: { code, message, details } }` with HTTP 200, while a missing
route, a non-POST request, or a failed admission is `404`/`405`/`401`.

## Files

| File | Role |
|---|---|
| `index.js` | Host plugin entry; starts the controller and the RPC channel, disposes both. |
| `window-memory.js` | Controller: window lookup, restore, centering, resize tracking, page actions. |
| `rpc.js` | Prefix route registration, admission, envelope parsing, endpoint dispatch. |
| `win32.js` | koffi bindings, DPI scale, monitor work area, window lookup. |
| `state.js` | Atomic JSON record under the harness home. |
| `client.js` | Settings page (`settings.section`), localized zh/en. |
| `cordis.patch.yml` | Loader row the bundle layer inserts. |

## Requirements

- Windows 10/11 x64 or arm64.
- The DeepSeek Harness **Desktop** app (the Host process of the Electron shell).
  The window APIs are Win32-only, so the bundle is a no-op elsewhere.

## Troubleshooting

**`dsh: cannot resolve profile bundle "dsh-window-size"`** during a
package-manager operation means the manifest listed the bundle while
`node_modules/dsh-window-size` was missing or its link target held no
`package.json`. The plugin manager's reconcile step resolves every listed
dependency without a fallback (profile startup only skips and reports it), so
restore the link or reinstall the bundle.

**The settings page says it is unavailable** — the page is running on a Host that
is not the Desktop app, or `koffi`/`user32` could not be loaded. The reason is
shown under the message.

**The window comes back at the wrong size** — check `last` in the state file: it
records what the plugin asked for, what it achieved, the DPI scale, and the
window title.

## License

[MIT](LICENSE) © home-i

---

[简体中文版 →](README.md)
