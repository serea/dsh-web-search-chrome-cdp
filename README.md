# dsh-web-search-chrome-cdp

DeepSeek Harness 的 `web_search` 插件。它连接本机已经开启远程调试的 Chrome，用真实搜索结果页代替官方搜索 API。

官方搜索会再打一次模型请求，让 DeepSeek 的 `web_search_20250305` 服务端工具返回引用。一次搜索要多花一轮模型和 token，摘要也经常很短。这个插件打开一个后台标签读取结果页，能用到本机的语言、地区和登录态，并且不额外打模型。搜完即关标签，不读取 Cookie、密码，也不改动已经打开的标签。

Chrome 136 之后 `/json/version` 会返回 404，带 `Origin` 的 WebSocket 也会被拒绝。插件只读 `DevToolsActivePort`，用原始 TCP 帧连接，不带 `Origin`。

## 安装

需要本机已经能运行 `dsh`。把 `<profile>` 换成自己的 profile 名，Web GUI 通常是 `web`。

```bash
dsh plugin --profile <profile> add github:serea/dsh-web-search-chrome-cdp
```

装完后重启 Web GUI，或新开一个会话。已经在跑的会话仍使用启动时的搜索提供方。

如果 Git 安装被拦住，改成先克隆再按本地目录安装：

```bash
git clone https://github.com/serea/dsh-web-search-chrome-cdp.git
dsh plugin --profile <profile> add "$(pwd)/dsh-web-search-chrome-cdp"
```

安装会把 `searchProvider` 改成 `chrome-cdp`，并把 `fetchProvider` 重写成 `http`。原来如果给网页抓取配了别的后端，需要在安装后自己改回去。

## 打开 Chrome 调试端口

已经在跑的 Chrome 不会接受事后加上的调试参数。先完全退出 Chrome，再带端口重开。

macOS：

```bash
open -na "Google Chrome" --args --remote-debugging-port=9222
```

Linux：

```bash
google-chrome --remote-debugging-port=9222
```

Windows PowerShell：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

确认调试端口文件的第一行是 `9222`：

| 系统 | 文件 |
|---|---|
| macOS | `~/Library/Application Support/Google/Chrome/DevToolsActivePort` |
| Linux | `~/.config/google-chrome/DevToolsActivePort` |
| Windows | `%LOCALAPPDATA%\Google\Chrome\User Data\DevToolsActivePort` |

Edge、Brave、Chromium 也会被自动识别。端口不是 9222，或浏览器装在非默认目录时，在 profile 的 `cordis.patch.yml` 里写绝对路径：

```yaml
- id: web-search-chrome-cdp
  name: '@local/web-search-chrome-cdp'
  config:
    port: 9222
    browserPath: /devtools/browser/<DevToolsActivePort 第二行>
```

`browserPath` 是 `DevToolsActivePort` 的第二行，不是本机文件路径。

## 配置

不写配置时先搜 Bing，结果不够再搜百度，并打开前两个可访问的结果页补摘要。验证码页不会覆盖搜索引擎原来的摘要。

```yaml
- id: web-search-chrome-cdp
  name: '@local/web-search-chrome-cdp'
  config:
    engines: bing,baidu
    enrichCount: 2
    navigationTimeoutMs: 12000
```

`engines` 可用 `bing`、`baidu`、`google`、`ddg`，按逗号分隔。`config` 会被整段替换，改的时候带上需要保留的字段。

## 卸载

```bash
dsh plugin --profile <profile> remove @local/web-search-chrome-cdp
```

卸载后搜索回到安装前的官方提供方。也可以只把 `web` 行的 `searchProvider` 改回 `deepseek-official`，先停用而不卸载。
