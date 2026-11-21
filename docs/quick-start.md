# 远程协助首次使用

已有协助服务器时，在控制端保存地址，在 Windows 上生成被控端，然后交换六位码。自建服务器的人多做一次 Linux 部署。局域网使用原来的本地中继，无需云服务器。

## 1. 下载源码并准备控制端

从项目的 GitHub 页面选择 **Code → Download ZIP** 并解压，也可以用页面上的 HTTPS 地址执行 `git clone`。从其他可信渠道取得源码压缩包也可以。在包含 `package.json` 的目录打开终端。 [GitHub 下载源码说明](https://docs.github.com/en/repositories/working-with-files/using-files/downloading-source-code-archives)

在 Windows 或 macOS 控制端安装 Node.js 22.12 或以上版本，再运行：

```sh
npm ci
node tools/assist-config.js
```

配置 CLI 会列出命令。日常 CLI 没有地址时会提示导入旧设备的配置文件，或者新建公网、局域网配置。它只在需要建立公网连接时启动 Electron 的 WebRTC 组件。Windows 安装包在 Windows 上构建。

## 2. 公网协助

在控制端填入自己服务器的真实域名。下例的 `assist.example.com` 是示例。配置会保存在当前用户目录。

```sh
node tools/assist-config.js init wss://assist.example.com/assist
```

如果控制端有多台设备，在各自电脑上执行 `node tools/assist-config.js device-id`。运行 `init` 时，在地址后传入用英文逗号分隔的所有公开 ID。服务器的授权列表和发给朋友的安装包应使用同一份列表。

已有服务器可跳到第 4 节。首次部署继续第 3 节。

## 3. 在一台新的 Linux 服务器上启动服务

以下步骤面向有公网 IPv4、使用 systemd 的独立 Linux 主机。准备公开 DNS A 记录，指向这台主机的公网 IPv4。直连该域名，使用 CDN 的域名应设置为仅 DNS。需要 Node.js、npm、支持 `profile` 配置的 Caddy、Docker Engine、OpenSSL 和 Git 或解压工具。Node 和 Caddy 应安装在系统路径，供系统服务读取。先用 `sudo ss -lntup` 核对端口。如果 443 已被网站或别的反代使用，需要在该反代接入 `/assist` 并另配证书同步，可参考部署说明。 [Caddy 安装文档](https://caddyserver.com/docs/install) · [Docker Linux 主机网络](https://docs.docker.com/engine/network/drivers/host/) · [已有反代的配置](public-assist.md#服务端)

### 安全组和主机防火墙

在云控制台找到 **实例 → 安全组 → 入站规则**。添加下面四条允许规则。主机如果启用了防火墙，也要在该防火墙允许同样的流量。协助人和朋友使用任意网络时，来源填 `0.0.0.0/0`。

| 协议 | 端口 | 用途 |
| --- | --- | --- |
| TCP | 443 | 加密配对和证书验证 |
| UDP | 3478 | 寻找直连路径和 UDP 中继入口 |
| TCP | 5349 | TLS 中继入口 |
| UDP | 49170–49185 | 中继转发加密数据 |

当前方案用 443 验证证书，协助服务无需开放 TCP 80。TCP 18082 只在服务器内部监听。TCP 3389、局域网中继端口和管理接口无需开到公网。SSH 22 先确认管理员可以从新规则允许的地址或私网成功登录，再收紧原规则。不要为了安装把所有端口开放。 [阿里云安全组配置](https://help.aliyun.com/en/ecs/user-guide/security-groups-for-different-use-cases) · [Caddy 证书验证文档](https://caddyserver.com/docs/caddyfile/directives/tls)

### 上传服务设置

在配置过的控制端导出设置。文件包含公开设备 ID、TURN 地址和本地信令端口。把它上传到 Linux 管理账户的家目录。

```powershell
node tools/assist-config.js server-env | Set-Content -Encoding ascii ./assist-server.env
scp ./assist-server.env ubuntu@assist.example.com:~/
```

macOS 用 `node tools/assist-config.js server-env > assist-server.env` 生成同一文件。把示例的 `ubuntu` 和域名换成自己的。服务器上的源码可以从 GitHub 下载同一版本，也可以把源码压缩包上传后解压。以管理员身份进入解压后的项目目录，再执行下面各段。示例用 `/home/ubuntu/assist-server.env` 作为上传文件路径。

### 启动配对服务和 HTTPS

此段用于首次部署。在 Bash 中把域名和上传文件路径改成实际值。系统自带或新装的默认 Caddy 服务如果占用 443，要先确认没有承载业务。此步骤运行项目自带的 Caddy 服务单元。

```bash
base=/opt/yclj-assist
domain=assist.example.com
uploaded=/home/ubuntu/assist-server.env
sudo install -d -m 0755 "$base/app" "$base/runtime"
sudo install -m 0644 public-assist/server.js public-assist/protocol.js public-assist/operator-password.js "$base/app/"
sudo ln -s "$(command -v node)" "$base/runtime/node"
sudo ln -s "$(command -v caddy)" "$base/runtime/caddy"
sudo npm install --prefix "$base/app" --no-save --omit=dev --ignore-scripts ws@8.23.0
sudo install -m 0600 "$uploaded" "$base/signaling.env"
sudo sh -c 'printf "YCLJ_ASSIST_TURN_SECRET=%s\n" "$(openssl rand -hex 32)" >> /opt/yclj-assist/signaling.env'
printf 'YCLJ_PUBLIC_HOST=%s\n' "$domain" | sudo tee "$base/tls.env" >/dev/null
sudo install -m 0644 public-assist/deploy/Caddyfile "$base/Caddyfile"
sudo install -m 0755 public-assist/deploy/sync-turn-tls.sh "$base/sync-turn-tls.sh"
sudo install -m 0644 public-assist/deploy/yclj-assist-*.service public-assist/deploy/yclj-assist-turn-tls.timer /etc/systemd/system/
sudo env YCLJ_PUBLIC_HOST="$domain" "$base/runtime/caddy" validate --config "$base/Caddyfile"
sudo systemctl daemon-reload
sudo systemctl enable --now yclj-assist-signal.service yclj-assist-tls.service
```

先从控制电脑运行 `curl.exe -i https://assist.example.com/`，macOS 用 `curl -i`。TLS 验证通过且根路径返回 `404`，说明 HTTPS 已就绪。失败时用 `sudo journalctl -u yclj-assist-tls.service -n 40 --no-pager` 查看证书状态，核对域名和 TCP 443。签证书可能需要短暂等待。

### 启动中继并同步证书

沿用同一个 Bash 会话的 `base` 和 `domain`。把 `public_ip` 换成云控制台显示的公网 IPv4，把 `local_ip` 换成 `ip -4 addr` 里实际网卡上的 IPv4；云主机上这两个 IP 可能不同。

```bash
public_ip=203.0.113.10
local_ip=172.16.0.10
sudo groupadd --system yclj-turn
sudo useradd --system --gid yclj-turn --no-create-home --shell /usr/sbin/nologin yclj-turn
sudo install -d -m 0750 -o root -g yclj-turn "$base/turn-tls"
sudo /bin/bash "$base/sync-turn-tls.sh"
sudo test -s "$base/turn-tls/cert.pem" && sudo test -s "$base/turn-tls/key.pem"
```

确认最后一行成功再继续。证书未同步时，先回到 HTTPS 步骤。下面使用同一把服务器端 TURN 密钥。配置文件只有 root 和中继的专用组可读。

```bash
sudo install -m 0640 -o root -g yclj-turn /dev/null "$base/turnserver.conf"
{
  printf 'realm=%s\nlistening-ip=%s\nrelay-ip=%s\nexternal-ip=%s/%s\n' "$domain" "$local_ip" "$local_ip" "$public_ip" "$local_ip"
  sudo sed -n 's/^YCLJ_ASSIST_TURN_SECRET=/static-auth-secret=/p' "$base/signaling.env"
  cat <<'TURN'
use-auth-secret
listening-port=3478
tls-listening-port=5349
min-port=49170
max-port=49185
cert=/yclj-tls/cert.pem
pkey=/yclj-tls/key.pem
no-cli
no-tcp
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
denied-peer-ip=240.0.0.0-255.255.255.255
TURN
} | sudo tee "$base/turnserver.conf" >/dev/null
sudo systemctl enable --now docker
sudo docker run -d --name yclj-assist-turn --restart unless-stopped --network host \
  --user "$(id -u yclj-turn):$(id -g yclj-turn)" --read-only --cap-drop ALL --security-opt no-new-privileges \
  -v "$base/turnserver.conf:/etc/coturn/turnserver.conf:ro" -v "$base/turn-tls:/yclj-tls:ro" \
  coturn/coturn:4.19.2-r0-alpine
sudo systemctl enable --now yclj-assist-turn-tls.timer
sudo systemctl is-active yclj-assist-signal.service yclj-assist-tls.service yclj-assist-turn-tls.timer
sudo docker inspect --format '{{.State.Status}}' yclj-assist-turn
```

三个 systemd 服务项应显示 `active`，容器应显示 `running`。域名的 A 记录、公网和私网映射以及上面的 UDP 端口范围需要一致。首次安装完成后，日常协助不用登录服务器。

## 4. 生成客户端并第一次配对

在 Windows 打包机上，运行：

```powershell
node tools/assist-config.js build
```

如果配置是在另一台控制电脑生成的，可以复制公开配置 `assist-config.json`，再运行 `node tools/assist-config.js build ./assist-config.json`。发给朋友 `release-win-client/public` 中的安装包。朋友打开后点「开始」，把当前六位码告诉你。

```sh
node operator-cli/index.js 123456
```

用朋友给的实际号码替换示例。输入 `Write-Output 'OK'`，确认回传后让朋友点「断开」。换一个新码，给 CLI 加 `--relay-only` 再验一次中继。默认会自动选直连或中继。

### 在自己的 Mac 沿用现有控制身份

Windows 上从已配置的项目目录导出。终端会要求输入口令，输入时隐藏。

```powershell
node tools/assist-config.js export-device ./my-control.yclj-device
```

要生成免口令文件，在导出命令末尾加 `--no-passphrase`。免口令文件包含明文控制私钥。

把迁移文件传到自己的 Mac。在 Mac 上安装依赖后导入。如果文件加密过，输入相同的导出口令。

```sh
npm ci
node tools/assist-config.js import-device ./my-control.yclj-device
node operator-cli/index.js 123456
```

导入把地址和原来的设备身份一起恢复。用的是同一个授权，服务器和朋友的安装包无需重新配置。只把导出文件交给自己的设备。已有不同控制身份的电脑会拒绝覆盖，可用 `YCLJ_OPERATOR_DEVICE_DIR` 指定单独目录。共用身份的两台电脑在服务端对应同一个设备 ID。

### 可选的服务器口令

要让控制设备在每次公网配对时多输一个口令，创建配置时加 `--extra-password`，再运行 `server-env` 设置这个口令。输入时不显示。它可以包含文字、字母、数字和符号，至少四个字符。

```sh
node tools/assist-config.js init wss://assist.example.com/assist --extra-password
node tools/assist-config.js server-env
```

在部署支持口令的新服务时，把导出设置中的 `YCLJ_ASSIST_OPERATOR_PASSWORDS` 一并写入服务器权限受限的环境文件。该项包含口令校验值，请像其他服务器设置一样保管。给已部署的新版服务新增这项后，用 `sudo systemctl restart yclj-assist-signal.service` 应用配置。该设备连续输错五次后锁定十分钟。锁定记录存放在服务进程中。

这项保护默认关闭。用 `export-device` 迁移时，文件会记住是否需要输协助口令。迁移文件使用独立的导出口令加密，也可显式选择免口令导出。协助口令及其校验值不会进迁移文件。

## 5. 局域网版

在运行局域网服务的电脑上，先把示例 IP 换成该电脑的局域网 IP。两端在同一台电脑测试时用 `127.0.0.1`。

```sh
node tools/assist-config.js init-lan ws://192.168.1.10:18081
node tools/assist-config.js serve-lan
```

也可以用已有的 Windows 主机端启动原中继，端口与上面的配置保持一致。二选一，避免占用同一个端口。朋友从另一台电脑连接时，在服务电脑的防火墙里只向该局域网放行配置中的 TCP 端口，公网安全组和路由器端口转发都无需开放此端口。

在另一终端生成预填地址的 Windows 安装包：

```powershell
node tools/assist-config.js build-lan
```

安装包位于 `release-win-client/lan`。朋友可以修改连接地址，点「开始」后发送六位码。控制电脑运行 `node operator-cli/index.js 123456 --lan`，或用 `--url` 指定其他局域网地址。局域网操作密钥留在控制端，安装包里只有可修改的服务地址。
