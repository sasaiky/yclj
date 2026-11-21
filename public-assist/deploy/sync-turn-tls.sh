#!/bin/bash
set -euo pipefail

base=/opt/yclj-assist
source "$base/tls.env"
certdir="/var/lib/yclj-assist-caddy/caddy/certificates/acme-v02.api.letsencrypt.org-directory/$YCLJ_PUBLIC_HOST"
cert="$certdir/$YCLJ_PUBLIC_HOST.crt"
key="$certdir/$YCLJ_PUBLIC_HOST.key"
target="$base/turn-tls"

[[ -s "$cert" && -s "$key" ]] || exit 0
openssl x509 -checkend 600 -noout -in "$cert" >/dev/null
[[ "$(openssl x509 -in "$cert" -noout -pubkey)" == "$(openssl pkey -in "$key" -pubout)" ]]
if cmp -s "$cert" "$target/cert.pem" && cmp -s "$key" "$target/key.pem"; then
    exit 0
fi
install -m 0640 -o root -g yclj-turn "$cert" "$target/cert.new"
install -m 0640 -o root -g yclj-turn "$key" "$target/key.new"
mv -f "$target/cert.new" "$target/cert.pem"
mv -f "$target/key.new" "$target/key.pem"
if [[ "$(docker inspect --format '{{.State.Running}}' yclj-assist-turn 2>/dev/null || true)" == true ]]; then
    docker kill --signal=USR2 yclj-assist-turn >/dev/null
fi
