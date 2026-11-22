# 公网协助

Windows 被控端和 CLI 自动连到相同的 `wss://.../assist` 地址进行配对。ICE 优先选择直连，直连无法建立时选择 coturn，操作流量在两端之间由 DTLS 加密。SSH 用于维护服务器。

## 使用

控制端便携包自带 Node.js，Mac 用系统 WebKit，Windows 用 Microsoft Edge WebView2 Runtime。两版都支持交互式公网协助和 `--run` 脚本模式。 [控制端使用步骤](quick-start.md#1-准备控制端)

从源码运行时，在 Windows 或 macOS 上用 Node.js 22.12 或以上版本安装项目依赖并生成当前控制设备的公开 ID。已登录的 Mac 桌面上，支持观看画面的交互式公网 `wss://` 会话优先使用系统 WebKit，首次使用由 Xcode Command Line Tools 编译并缓存观看程序。源码模式的 Windows 控制端、`--run`、Mac 上的本机 `ws://` 测试和无法编译 WebKit 的 Mac 使用 Electron。Mac 源码模式可设置 `YCLJ_MAC_RTC=electron` 使用兼容引擎。

```powershell
npm ci
node tools/assist-config.js device-id
```

将设备 ID 加入服务端 `YCLJ_ASSIST_OPERATOR_IDS`，并在生成 Windows 安装包时传入同一个 ID。私钥由 CLI 保存在当前用户的 `yclj-operator` 数据目录。朋友打开预配的客户端后点击「开始」，把当前六位码告诉协助人。等待期间每五分钟换码，验证码只用一次。服务端校验验证码和设备，两端签名交换临时密钥，再建立加密的 WebRTC 连接。

```sh
node tools/assist-config.js init wss://assist.example.com/assist
node operator-cli/index.js 123456
node operator-cli/index.js 123456 --url wss://assist.example.com/assist --run ./check.ps1
```

每次新建连接使用一个新验证码。连上后验证码留在界面上，等待阶段的自动换码随即停止。原有命令、JSON 操作和 `/ui`、`/lb`、`/clear` 宏可用，脚本模式沿用 UTF-8 PowerShell 脚本。新版客户端和 CLI 的会话持续到任一端断开、退出或失联。服务器定期续发有时效的中继凭据。断开后已启动的独立进程可能继续运行。

`--run` 配对后等待 Windows PowerShell 提示符，并用一条回显命令确认 Shell 就绪。出现发布者信任提示时选择「本次不运行」。30 秒内无法确认就绪时，CLI 返回 `powershell_ready_timeout`。

### 屏幕共享

使用支持屏幕共享的 Windows 客户端和交互式 CLI 配对。两端支持键鼠时，Windows 端按钮显示「共享屏幕并允许控制」，点击一次就同时共享主屏幕和启用远程键鼠。协助端窗口自动打开，可在画面内点击、拖拽、滚动和输入，点击画面后键盘输入发送到 Windows。使用旧版或不支持键鼠的控制端时，Windows 显示「共享屏幕」。点击「停止共享」或断开连接会撤回键鼠权限并释放按下的键和鼠标按钮。停止共享后命令会话继续运行。

画面由 Electron 采集，沿用 WebRTC 直连或 TURN 中继。新版 Windows 客户端开始共享后，协助端可在画面窗口切换画质。每次开始共享时使用标准档。

| 档位 | 分辨率上限 | 帧率上限 | 视频编码码率上限 |
| --- | ---: | ---: | ---: |
| 省流 | 960×540 | 8 帧/秒 | 350 kbps |
| 标准 | 1280×720 | 15 帧/秒 | 900 kbps |
| 清晰 | 1920×1080 | 15 帧/秒 | 1.8 Mbps |

视频走媒体轨，键鼠和命令走数据通道。连接拥塞时会丢弃积压的鼠标移动和滚轮事件。遇到拥塞可以切到省流档，Windows 端也可停止共享来释放视频带宽。Windows 键鼠由 [Windows Input Simulator](https://github.com/michaelnoonan/inputsimulator) 注入到当前桌面，受 Windows 原有的权限限制。

配置 CLI 的 `init` 把服务器地址和设备公开 ID 保存到当前用户的 `assist-config.json`，默认使用当前设备的 ID。如果 Windows 和 Mac 都要发起协助，在两台设备分别执行 `device-id`，然后运行 `init` 时在服务器地址后传入英文逗号分隔的两个 ID。配置文件可以复制到打包用的 Windows 电脑。

自己的 Windows 和 Mac 也可以共用已经授权的控制身份。用 `export-device` 和 `import-device` 迁移地址和私钥。导出默认加密，也可以显式选择免口令。 [跨设备使用步骤](quick-start.md#在自己的-mac-沿用现有控制身份)

```powershell
npm run assist:config -- build
```

也可以在 `build` 后指定配置文件路径。安装包生成在 `release-win-client/public`。配置里的地址和公开设备 ID 随包固定，软件隐藏地址栏，复制按钮只复制六位码。服务器地址换了就重新构建。在需要手填局域网地址的场景，用同一套源码执行 `npm run win-client:dist`。地址能从安装包或网络连接中查到。想减少向对方暴露控制端公网 IP，可在 CLI 上加 `--relay-only`，该会话全程经中继。

## 服务端

在 Linux 上把 `public-assist/server.js`、`public-assist/protocol.js` 和 `public-assist/operator-password.js` 放入同一目录。使用项目的 systemd 单元时目录为 `/opt/yclj-assist/app`。在该目录用 `npm install --no-save --omit=dev ws@8.23.0` 安装运行依赖。运行 `node tools/assist-config.js server-env` 可导出设备 ID、默认的 TURN 地址和本地端口。把输出加入服务器环境文件，在服务器上生成并加上 TURN 密钥。如果用独立的 TURN 主机，在服务器环境文件里改用其地址。环境文件仅授予服务管理者访问权限。 [首次部署命令](quick-start.md#3-在一台新的-linux-服务器上启动服务)

```ini
YCLJ_ASSIST_OPERATOR_IDS=<CLI 输出的设备 ID，多个用英文逗号分隔>
YCLJ_ASSIST_TURN_SECRET=<openssl rand -hex 32 生成的值>
YCLJ_ASSIST_TURN_URLS=turn:assist.example.com:3478?transport=udp,turns:assist.example.com:5349?transport=tcp
YCLJ_ASSIST_PORT=18082
```

信令只监听 `127.0.0.1:18082`。在已有 HTTPS 反向代理的独立域名下，只公开以下路径。服务不提供公网管理 API。Windows 客户端只主动发起连接。

```nginx
location = /assist {
    proxy_pass http://127.0.0.1:18082;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_read_timeout 30s;
}
```

在 coturn 中使用相同的随机密钥。阿里云 ECS 的网卡为私网地址时，设置 `external-ip` 的公网和私网映射。域名证书需要同时用于 WSS 和 TURN TLS，并在续期后重载相应服务。

```ini
realm=assist.example.com
use-auth-secret
static-auth-secret=<与 YCLJ_ASSIST_TURN_SECRET 相同>
listening-port=3478
tls-listening-port=5349
external-ip=<公网 IPv4>/<网卡私网 IPv4>
relay-ip=<网卡私网 IPv4>
min-port=49170
max-port=49185
cert=<完整证书链 PEM 文件>
pkey=<私钥 PEM 文件>
no-cli
no-dtls
no-tcp-relay
no-multicast-peers
user-quota=10
total-quota=16
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
```

在宿主机和云安全组开放 TCP 443、UDP 3478、TCP 5349 和用于中继的 UDP 49170–49185。信令的 `18082`、局域网中继端口和服务管理入口使用回环或私网。coturn 可与 ERPNext 分开运行，分别维护容器和端口。

ECS 可以使用公网 IP 证书。`public-assist/deploy/Caddyfile` 通过 TCP 443 完成 TLS-ALPN 验证和自动续期。`sync-turn-tls.sh` 将续期证书同步给 coturn，使用 `SIGUSR2` 重载证书。此配置只使用 TCP 443 验证证书。

参考部署目录是 `/opt/yclj-assist`。`yclj-assist-signal.service` 提供回环信令，`yclj-assist-tls.service` 运行 Caddy，`yclj-assist-turn` 容器转发数据，`yclj-assist-turn-tls.timer` 同步续期后的证书。

公网配对服务按来源 IP 限制同时连接数和一分钟内建立连接的次数。部署使用本机 Caddy 转发，Caddy 用实际访问者的 IP 覆盖外部提交的 `X-Forwarded-For`。配对服务仅从本机代理的连接读取该头。

## 验证

在两台 Windows 电脑上分别使用不同的网络。由被控端生成六位验证码，协助端用 CLI 连接后运行 `Write-Output 'YCLJ OK'` 并核对回传。两端应显示实测路径。在其中一端限制直连 UDP 后用新验证码重复，确认自动选用中继。可用 `--relay-only` 单独核对 TURN。逐一核对未登记设备、复用验证码和断开后的 CLI 状态，再用原来的地址跑一次局域网连接。

本地集成测试通过 `npm run assist:test` 执行。设置 `YCLJ_ASSIST_TURN_URLS` 和匹配本地 coturn 的 `YCLJ_ASSIST_TURN_SECRET` 时，额外验证 TURN 和 `--run`。测试也可通过 `YCLJ_ASSIST_TEST_BLOCK_UDP=1` 限制测试客户端的直连 UDP，再用正常的 CLI 检查中继。
