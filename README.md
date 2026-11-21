# YCLJ Stack

## 远程协助

[首次使用指南](docs/quick-start.md)包含源码下载、公网服务器部署、安全组和局域网打包步骤。

朋友打开预配服务器的 Windows 被控端，点「开始」，把界面上的六位验证码告诉协助人。协助人用 Windows 或 macOS 上的 `operator-cli/index.js` 输入验证码发起连接。公网等待期间每五分钟自动换码，使用后的码立即失效。连接后可查看传输路径，随时点「断开」。[公网协助部署](docs/public-assist.md)

公网安装包内置服务器地址和可信控制设备的公开 ID。需要手填连接地址时，可用同一源码生成局域网安装包。窗口标题和快捷方式均为「kk远程连接」。连上后保留当前验证码和线路状态，会话持续到任一端断开、退出或失联。

日常连接用 `node operator-cli/index.js <验证码>`。首次配置和生成专属被控端使用 `node tools/assist-config.js`。自建服务器时用同一个配置工具导出服务器设置，服务程序在 Linux 主机上单独运行。

## 当前版本（2026-11-21）

- 本机主机端安装包：`release-host-client/KK_SSH-host-win setup 0.1.12.exe`。安装器会结束旧主控端和服务进程，并迁移到独立目录 `yclj-host-win`。安装后的程序为 `远程帮助主机端.exe`。打开窗口时，已有服务就直接显示状态，服务未开启就自动启动；关闭窗口时会询问只关闭面板、同时退出服务或取消。服务继续运行时，可从系统托盘重新打开。启动时检查本机和局域网地址上的旧服务，防止两份中继同时对外提供相同连接地址。主机端采用白底、绿色连接状态和橙色验证码。窗口可逐个输入同事的六位验证码，最多同时配对 20 位；输入自动去除空格，不满六位时连接按钮不可用，成功后清空输入框，失败则保留。同事卡片的 IP 行显示状态、复制和对应的断开按钮。中继会把主机看到的同事 IP 发给客户端，供复制验证码时一并分享。
- 无需打开窗口时，可运行 `tools/Start-HostBackground.ps1` 启动相同的主机服务。后台运行期间打开主机端程序，会显示这个服务的状态。协助端可使用 `node operator-cli/host-control.js status|start|stop|pair <验证码>|send <命令>|events [序号]|disconnect|shutdown` 连接和操作。
- 主机端会自动保存操作密钥，协助端本机连接时自动读取。你和同事都不用填写密钥；同事只需要连接地址，并在配对时提供其客户端显示的六位验证码。
- 本机协助端连接示例：`node operator-cli/host-control.js pair <验证码>`；已连接后可用 `send` 和 `events` 操作及读取结果。主控 0.1.11 新增 `node operator-cli/host-control.js run <脚本.ps1>`，使用旧版 Windows 客户端的连接，在单独的 PowerShell 进程运行 UTF-8 脚本并返回输出、错误和退出码。同一时间配对多位同事时，用 `run --peer <设备ID> <脚本.ps1>` 指定目标。
- `run` 适用于非交互脚本，脚本上限为 8 KiB，标准输出和标准错误各最多返回 32,768 个字符。断开连接或等待结果超时会报告 `unconfirmed`，不会自动重跑。需要持续使用同一个 PowerShell 会话或通过原流程回传图像时，继续用 `send` 和 `events`。
- Windows 界面源码：`electron-client-win/`。
- 同事端公网安装包为 `release-win-client/public/KK_SSH-clent-win setup 0.1.30.exe`。安装器会结束旧客户端进程。默认安装目录为 `kkssh clent`，桌面和开始菜单的快捷方式名称为「kk远程连接」。安装后的程序为 `远程帮助客户端.exe`。两端均使用 `build-assets/kunkunxin4.ico` 作为程序图标。
- 界面包含六位配对码、开始和断开按钮及操作记录。通用安装包有连接地址栏，局域网连接可一起复制验证码和连接 IP。
- 同事端默认以横向 4:3 显示操作记录区，并选中左侧“简略”，显示以 `> ` 提示符开头的绿色命令。右侧“详细”包含命令标签、小号时间、白色终端输出和系统记录。最后一条命令末尾的下划线会闪动。提示符和光标仅用于界面显示。
- 左侧“开始”按钮用白底淡绿边。等待配对时变为“未连接”并显示绿色呼吸效果。配对后绿色从左向右填满，右侧稍亮，同时有细光点从右向左飘。点击右侧“断开”按钮会把本次详细记录保存为桌面的 `.log` 文件。
- 记录停在底部时自动跟随最新内容；向上查看旧内容时保持当前位置。
- 配对码旁可复制或刷新号码；刷新仅在等待配对时可用，连接中仍可断开。协助人员断开后会自动生成新号码。
- 局域网客户端默认使用 `ws://127.0.0.1:18081`。可以在界面修改，也可以用配置 CLI 为安装包预填局域网主机地址。
- 当前本地中继监听地址通过 `RELAY_HOST` 设置；未设置时仅监听 `127.0.0.1`。
- 中继必须配置 `ADMIN_TOKEN` 或 `YCLJ_ADMIN_TOKEN`，不再提供默认管理员口令。
- 主机端操作密钥保存在当前 Windows 用户的 `%APPDATA%\yclj-host-win\operator-token`，不会进入同事端安装包。

用配置 CLI 生成公网或局域网被控端，或重新构建 Windows 主机端：

```powershell
npm run assist:config -- build
npm run assist:config -- build-lan
npm run win-host:dist
```

下方为基础使用和部署说明。

This folder now contains:

- `relay/`: LAN WebSocket relay (auth + PIN pairing + transparent routing)
- `public-assist/`: public WebSocket signaling and encrypted WebRTC transport
- `operator-cli/`: Windows/local control terminal (`yclj <PIN>`)
- `client-cli/`: headless Linux client (`yclj-client`)
- `electron-client-win/`: Windows desktop client (Electron)
- `electron-host-win/`: Windows local relay dashboard (Electron)

## 1) Install

```bash
cd yclj
npm install
```

## 2) Start Relay

```powershell
$env:ADMIN_TOKEN = "replace-with-strong-token"
$env:RELAY_PORT = "8080"
node relay/index.js
```

## 3) Start A Client

### Option A: Linux headless client

```bash
RELAY_URL=ws://<relay-host>:8080 node client-cli/index.js
```

### Option B: Windows desktop client (recommended for your current setup)

```powershell
$env:RELAY_URL = "ws://<relay-host>:8080"
npm run win-client:start
```

Windows desktop client flow:

1. Fill relay URL and shell (default `powershell.exe`).
2. Click connect.
3. UI shows a 6-digit PIN.
4. Give PIN to operator.

## 4) Start Operator (Windows/local)

```powershell
$env:ADMIN_TOKEN = "replace-with-strong-token"
$env:RELAY_URL = "ws://<relay-host>:8080"
node operator-cli/index.js <PIN>
```

### Operator stdin routing rules

- JSON line that starts with `{` and parses: pass-through (AI mode)
- `/ui xxx`: send `{"type":"ui","action":"status","data":"xxx"}`
- `/lb a, b`: send `{"type":"ui","action":"plan","data":["a","b"]}`
- `/clear`: send UI clear
- `/exit`: disconnect
- normal line: send exec stdin (`payload` with `\r`)

## 5) Tests

```bash
npm run smoke
npm run win-client:check
```

`smoke` verifies: auth -> PIN -> pair -> bidirectional `exec` routing.

## 6) Build single binary for Linux client

```bash
npm run pack:client:linux
```

Output: `dist/yclj-client`

## 7) Package Windows desktop client

```powershell
npm run win-client:dist
```

Output directory: `release-win-client/`

- `KK_SSH-clent-win setup 0.1.28.exe`
- `KK_SSH-clent-win setup 0.1.28.exe.blockmap`

## 7a) Package Windows host dashboard

```powershell
npm run win-host:check
npm run win-host:test
npm run win-host:script-test
npm run win-host:dist
```

Output: `release-host-client/KK_SSH-host-win setup 0.1.12.exe`

## 8) Relay deployment guide

See: `docs/relay-deploy.md`

## Notes

- Use only on systems you own or have explicit permission to administer.
- `node-pty` is preferred; if Electron ABI mismatch happens, Windows client falls back to `child_process` shell mode.
- macOS desktop client is intentionally skipped for now, per your testing preference.
