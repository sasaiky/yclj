# Relay Server Deployment Guide

This guide is for deploying `yclj/relay/index.js`.

Keep this relay on a private network. For Internet connections with a trusted operator device, a one-time PIN and end-to-end encryption, use the [public assist service](public-assist.md).

## Prerequisites

- A host reachable over a private network (Linux recommended)
- Node.js 18+
- Private access to the relay port (default `8080`) or an internal Nginx TLS reverse proxy

---

## A) Quick Start (Linux)

```bash
# 1) Upload project or clone repository
cd /opt/yclj/yclj
npm install --omit=dev

# 2) Start relay
export ADMIN_TOKEN='replace-with-a-long-random-token'
export RELAY_PORT='8080'
node relay/index.js
```

If client/operator can pair with a PIN, relay is working.

---

## B) Production (Linux + systemd)

### 1) Create runtime user and directories

```bash
sudo useradd -r -s /usr/sbin/nologin yclj
sudo mkdir -p /opt/yclj
sudo chown -R yclj:yclj /opt/yclj
```

Copy `yclj` folder to `/opt/yclj/yclj`.

### 2) Install runtime dependencies

```bash
cd /opt/yclj/yclj
sudo -u yclj npm install --omit=dev
```

### 3) Create env file

```bash
sudo tee /etc/yclj-relay.env >/dev/null <<'EOF'
ADMIN_TOKEN=replace-with-a-long-random-token
RELAY_PORT=8080
EOF
sudo chmod 600 /etc/yclj-relay.env
```

### 4) Create systemd unit

```bash
sudo tee /etc/systemd/system/yclj-relay.service >/dev/null <<'EOF'
[Unit]
Description=YCLJ Relay Server
After=network.target

[Service]
Type=simple
User=yclj
WorkingDirectory=/opt/yclj/yclj
EnvironmentFile=/etc/yclj-relay.env
ExecStart=/usr/bin/node /opt/yclj/yclj/relay/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
```

### 5) Start and enable

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now yclj-relay
sudo systemctl status yclj-relay
```

### 6) View logs

```bash
sudo journalctl -u yclj-relay -f
```

---

## C) TLS / WSS (recommended)

Use Nginx to serve `wss://relay.your-domain.com` on the private network and forward requests to `127.0.0.1:8080`. Configure the hostname to resolve to a private address for clients.

```nginx
server {
    listen 443 ssl;
    server_name relay.your-domain.com;

    ssl_certificate /etc/letsencrypt/live/relay.your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.your-domain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

Then set:

```text
RELAY_URL=wss://relay.your-domain.com
```

---

## D) Windows Server (simple run)

```powershell
cd E:\path\to\yclj
npm install --omit=dev
$env:ADMIN_TOKEN='replace-with-a-long-random-token'
$env:RELAY_PORT='8080'
node relay\index.js
```

For persistent run on Windows, use `nssm` or Task Scheduler.

---

## E) Security Checklist

- Use strong `ADMIN_TOKEN` (>= 32 random chars)
- Prefer `wss://` on public internet
- Restrict firewall/security group rules
- Rotate token periodically
- Use only on authorized systems
