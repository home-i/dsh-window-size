# dsh-window-size

**简体中文** · [English](README.en.md)

记住 **DeepSeek Harness 桌面版**的窗口尺寸：重启后自动恢复、默认水平垂直居中，并且可以在设置页里直接改，不用手动拖窗口。

![平台：Windows](https://img.shields.io/badge/platform-Windows-0078D4)
![宿主：DSH 桌面版](https://img.shields.io/badge/host-DSH%20Desktop-4f6ef7)
![许可证：MIT](https://img.shields.io/badge/license-MIT-green)

- **首次启动**：没有记录时使用 **1440 × 900**，并居中。
- **每次手动调整**：自动记录，下次启动恢复。
- **默认居中**：每次启动都把窗口放在当前显示器工作区正中；可在设置页关闭，改为沿用上次位置。
- **不会记错**：最大化、最小化、隐藏状态一律不记录，避免下次以超大尺寸打开；恢复时会按当前显示器工作区收缩，换显示器也能用。
- **设置页**：`设置 → 窗口尺寸` 可手动设定尺寸、记住当前尺寸、立即居中、恢复默认。
- 在非桌面版 Host（`dsh` 命令行、服务器）上仍可加载，但设置页会提示不可用。

## 为什么必须做成 Host 插件

桌面版创建主窗口时把尺寸写死为 `1280 × 820`，也不持久化任何窗口状态。渲染端改不了它：在 Electron 里，`window.resizeTo()` 会被路由到 `WebContentsDelegate::SetContentsBounds`，Electron 只把它转发成 `content-bounds-updated` 事件，**并不会真的改变 `BrowserWindow` 的大小**。

所以真正干活的是 Host 进程：它通过 `koffi`（`@deepseek-ai/dsh-desktop-host` 本来就依赖它）调用 `FindWindowExW` / `GetWindowRect` / `GetDpiForWindow` / `SetWindowPos`，并且**抢在窗口显示前**完成设置，避免先闪一下旧尺寸。

## 设置页

`设置 → 窗口尺寸` 是一个 `settings.section` 条目。页面上会显示当前窗口尺寸、已记录尺寸和上次动作（含时间），并提供：

| 控件 | 作用 |
|---|---|
| 宽度 / 高度 + **应用并记住** | 立刻改变窗口尺寸并保存 |
| **记住当前尺寸** | 把你现在手动拖出来的尺寸存下来 |
| **重新应用** | 用记录值再应用一次（含当前居中设置） |
| **恢复默认** | 回到配置的默认 `1440 × 900` |
| **启动时居中** 开关 | 决定恢复时是否居中 |
| **立即居中** | 只居中，不改尺寸 |
| **启用尺寸记忆** 开关 | 关闭后既不恢复也不记录 |

页面本身不碰窗口，它通过包私有 RPC 通道 `/dsh-window-size` 调用 Host 端，Host 端用与启动恢复同一个控制器来执行。

## 安装

直接从 GitHub 安装（插件管理器里填写）：

```
github:home-i/dsh-window-size#v1.1.0
```

也可以在桌面版 **插件** 页里从本地目录安装。本地开发还可以把包链接进桌面版 profile：

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

下次启动即生效，之后改动源码也不需要重装。

> 不要把这个 `link:` 换成手工建的 Windows junction 再执行 `pnpm install`：pnpm 安装时会移除该条目，而 Windows 会顺着 junction 进入目标目录，导致源码目录被清空。

## 配置

Loader 行里配置首次启动的默认值：

```yaml
# cordis.patch.yml
- insert:
    - id: dsh-window-size
      name: dsh-window-size
      config:
        width: 1440        # 首次启动宽度，CSS 像素
        height: 900        # 首次启动高度，CSS 像素
        center: true       # 每次恢复都居中
        enabled: true      # 是否启用恢复与记录
```

尺寸单位是 CSS 像素；宽高最小被限制为 `520 × 600`，恢复时还会被当前显示器工作区限制。

## 状态文件

记录放在 harness home 下，跟随 profile 而不是 Electron 的 `userData`：

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

`last` 记录最近一次动作（`restore`、`resize`、`apply`、`remember`、`center`、`center-on`、`center-off`、`enabled`、`disabled`），包含实际达成的尺寸、DPI 缩放和窗口标题——设置页显示的就是它，出问题时也靠它定位。删除这个文件即回到配置默认值。旧版（只有 size + last）的记录会自动升级：尺寸保留，新开关取配置默认。

## RPC 约定

Host 在 Web carrier 上注册前缀路由，每个请求都先过 `connection.admit`，因此只有本 Host 的已认证页面能操作窗口：

```
POST /dsh-window-size/<endpoint>
content-type: application/json

{ "type": "client-request", "rpcId": "…", "method": "<endpoint>", "payload": … }
```

端点：`status`、`apply`（`{width,height}`）、`reapply`、`reset`、`center`、`remember`、`set-center`（`true|false`）、`set-enabled`（`true|false`）。返回使用 Connection 的 `server-response` 信封；业务失败以 HTTP 200 + `{ ok: false, error: { code, message, details } }` 返回，而路由不存在、非 POST、认证失败分别是 `404` / `405` / `401`。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | Host 插件入口；启动控制器与 RPC，并负责释放 |
| `window-memory.js` | 控制器：查找窗口、恢复、居中、跟踪缩放、处理页面动作 |
| `rpc.js` | 前缀路由注册、认证、信封解析、端点分发 |
| `win32.js` | koffi 绑定、DPI、显示器工作区、窗口查找 |
| `state.js` | harness home 下的原子 JSON 记录 |
| `client.js` | 设置页（`settings.section`），中英双语 |
| `cordis.patch.yml` | bundle 层插入的 Loader 行 |

## 环境要求

- Windows 10/11 x64 或 arm64。
- DeepSeek Harness **桌面版**（Electron shell 的 Host 进程）。窗口 API 是 Win32 的，其它环境不生效。

## 常见问题

**包管理器操作时报 `dsh: cannot resolve profile bundle "dsh-window-size"`**：说明 manifest 里列了这个 bundle，但 `node_modules/dsh-window-size` 不存在、或其链接目标里没有 `package.json`。插件管理器的 reconcile 阶段对所有已列依赖都会严格解析、没有兜底（而启动时只是跳过并报告），补回链接或重装 bundle 即可恢复。

**设置页显示不可用**：当前 Host 不是桌面版，或 `koffi` / `user32` 加载失败；具体原因会显示在提示下方。

**窗口恢复后的尺寸不对**：查看状态文件里的 `last`，它记录了请求值、实际达成值、DPI 缩放与窗口标题。

## 许可证

[MIT](LICENSE) © home-i

---

[English version →](README.en.md)
