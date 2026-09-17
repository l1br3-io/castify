# Walkthrough: DigitalOcean (Singapore) + Cloudflare R2

End-to-end deployment of Castify on a small **DigitalOcean droplet** in
Singapore, storing media in **Cloudflare R2**, with `just`-driven rclone
uploads from your workstation. Built from a real deployment; the general
reference is [`deploy.md`](./deploy.md) and provider details are in
[`providers.md`](./providers.md). For the Oracle Cloud Always Free variant see
[`deploy-oracle-r2.md`](./deploy-oracle-r2.md).

The split this guide builds (same traffic posture as the Oracle walkthrough):

```
Viewers ──(pages/API, tiny)──────► DO droplet (Singapore) ── Castify app
Viewers ──(video bytes, heavy)──► Cloudflare R2 edge (Manila/…)
```

**Cost:** ~$6/mo droplet (1 vCPU / 1 GB / 25 GB — verify the plan you pick
still bundles the public IPv4; DO's newer "v5" plans bill it as a separate
~$4/mo line item) + R2 storage (first 10 GB free, ~$0.015/GB/mo after,
streaming egress always free) + a domain (~$10/yr). A 100 GB library lands
around **$8/mo all-in**.

Why a 1 GB droplet is enough: the server relays **no video bytes** — playback
is presigned browser-direct from R2 — so it only serves the SPA and JSON.
The big instance in the Oracle walkthrough exists to *compile* the image on
the box; here we compile on your workstation instead and ship the finished
image over SSH.

## 0. Prerequisites

- A DigitalOcean account (card on file) — [cloud.digitalocean.com](https://cloud.digitalocean.com/)
- A domain (~$10/yr). This walkthrough uses a subdomain (`castify.example.com`)
  so the apex stays free — good practice if anything already lives on it.
- Docker on your workstation (we build the image locally)
- An SSH keypair: `ssh-keygen -t ed25519` and keep `~/.ssh/id_ed25519` private

## 1. Create the droplet

Create → Droplets:

| Setting    | Value                                        |
| ---------- | -------------------------------------------- |
| Region     | **Singapore (SGP1)**                           |
| Image      | **Ubuntu 24.04 (LTS) x64**                     |
| Type/Size  | Basic → **1 GB / 1 vCPU / 25 GB SSD**          |
| Auth       | **SSH Key** (paste your `.pub`)               |
| Hostname   | `castify`                                      |

**Check the monthly total before clicking Create** — see the pricing note
above if an IPv4 line item appears.

In **Add Initialization scripts** (free cloud-init hook), paste — it installs
Docker + Caddy, and adds a 2 GB swapfile (1 GB droplets ship with none):

```bash
#!/bin/bash
set -euo pipefail
exec > >(tee -a /var/log/castify-init.log) 2>&1

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y gnupg debian-keyring debian-archive-keyring curl git

# 2 GB swap safety net (1 GB droplets ship with none)
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile
  mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10 >/dev/null
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-swap.conf
fi

# Docker CE + compose plugin
curl -fsSL https://get.docker.com | sh

# Caddy (official apt repo, automatic TLS)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y && apt-get install -y caddy

mkdir -p /opt/castify
```

Notes: `gnupg` is not preinstalled on minimal Ubuntu cloud images — without
it the Caddy key step aborts the whole script. If first boot misbehaves,
`cat /var/log/castify-init.log` on the droplet shows where it stopped.

## 2. Firewall (DO Cloud Firewalls)

Networking → Firewalls → Create: inbound **TCP 22, 80, 443**, apply to the
`castify` droplet. This is the *only* firewall layer — DO's Ubuntu ships with
ufw off (no Oracle-style double firewall).

## 3. DNS

In your registrar's DNS panel add an **A record**: `castify` → droplet IPv4.
Verify:

```sh
curl -s 'https://dns.google/resolve?name=castify.example.com&type=A'
```

## 4. Build the image locally and ship it

On your workstation (x86_64 matches the droplet; the image is ~230 MB with
ffmpeg):

```sh
# stock distroless image (~16 MB, no ffmpeg) — direct-stream only
docker build -t castify:latest .

# alpine + ffmpeg variant — any codec plays; uses the same build cache
docker build --target e2e-runtime -t castify:ffmpeg .
```

Ship it — no registry needed, the tarball goes straight over SSH:

```sh
docker save castify:ffmpeg | gzip | ssh root@<droplet-ip> 'gunzip | docker load'
```

## 5. Caddy on the droplet

```sh
ssh root@<droplet-ip>
printf 'castify.example.com {\n    reverse_proxy 127.0.0.1:8427\n}\n' \
  > /etc/caddy/Caddyfile
systemctl reload caddy
```

The certificate is issued automatically on first request. See
[`deploy.md`](./deploy.md) § Reverse proxy & HTTPS for the full picture
(loopback-only port binding, `CASTIFY_APP_BASE_URL`, nginx variant).

## 6. Boot Castify

```sh
docker run -d --name castify --restart unless-stopped \
  -p 127.0.0.1:8427:8427 \
  -v castify-data:/data \
  -e CASTIFY_APP_BASE_URL=https://castify.example.com \
  -e CASTIFY_TRANSCODE_CACHE_MAX_BYTES=5368709120 \
  castify:ffmpeg
```

The 5 GB transcode-cache cap keeps the 25 GB disk safe. Verify, then open
`https://castify.example.com` and create the owner account in the wizard:

```sh
curl https://castify.example.com/api/health
# {"status":"ok",...}
```

## 7. R2: bucket + token

At [dash.cloudflare.com](https://dash.cloudflare.com) → **R2 Object Storage**
(first use asks to enable billing; free tier and zero egress still apply):

1. **Create bucket** → e.g. `castify`, location automatic.
2. **[API Tokens](https://dash.cloudflare.com/?to=/:account/r2/api-tokens) →
   Create API Token → Account API Tokens** → **Object Read & Write**, scoped
   to that one bucket → copy both keys once, and note the endpoint
   `https://<account-id>.r2.cloudflarestorage.com`.

Least-privilege option: keep a **read-only** token for Castify and a separate
**read-write** token for uploads from your machine. One RW token for both is
simpler; the blast radius is "that bucket" either way.

3. Connect in Castify: Connections → S3-compatible storage → endpoint, region
   `auto`, bucket, keys → submit → scan starts.

## 8. Uploading media from your workstation

The repo's `just` recipes drive rclone end to end (see the justfile's
`R2 media upload` section). Provide credentials — either `R2_*` keys in your
`.env`/environment (see [`.env.example`](../.env.example)) or the
`CLOUDFLARE_CASTIFY_*` names:

```sh
export R2_ACCESS_KEY_ID=...          # or CLOUDFLARE_CASTIFY_ACCESS_KEY
export R2_SECRET_ACCESS_KEY=...      # or CLOUDFLARE_CASTIFY_SECRET_KEY
export R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
```

Then:

```sh
just upload-setup            # install rclone (~/.local/bin) + write the remote
just upload /path/to/movies  # one-shot incremental sync
just upload-mount            # R2 as a local folder: ~/R2-castify
```

`upload-mount` installs a systemd **user** service (`castify-r2-mount.service`)
that remounts at login. Anything you drop in the folder uploads on close —
after which hit **Rescan** on the connection card in Castify.

Gotcha baked into the recipe: rclone's pre-upload bucket probe trips a denied
`CreateBucket` on R2 — the config sets `no_check_bucket = true`.

## 9. Ongoing care

- **Upgrade:** rebuild + reship + restart (volume survives; migrations run on
  boot; forward-only — back up first):

  ```sh
  just deploy root@<ip>   # builds, ships over SSH, restarts, health-checks
  ```

  Manual equivalent:

  ```sh
  docker build --target e2e-runtime -t castify:ffmpeg .
  docker save castify:ffmpeg | gzip | ssh root@<ip> 'gunzip | docker load'
  ssh root@<ip> 'docker rm -f castify && docker run -d --name castify --restart unless-stopped \
    -p 127.0.0.1:8427:8427 -v castify-data:/data \
    -e CASTIFY_APP_BASE_URL=https://castify.example.com \
    -e CASTIFY_TRANSCODE_CACHE_MAX_BYTES=5368709120 castify:ffmpeg'
  ```

- **Backup:** the `castify-data` volume holds the SQLite catalog — one-liner
  in [`deploy.md`](./deploy.md) § Data persistence.
- **Locked out:** `ssh root@<ip> 'docker compose ... '`-style access still
  works; use `/castify reset-password` inside the container (absolute path —
  no shell in the image).
- **Key rotation:** delete the R2 token in the dashboard, create a new one,
  update env vars → `just upload-setup`, reconnect in the Castify UI.

## Troubleshooting

**rclone upload fails with `CreateBucket … AccessDenied`** — missing
`no_check_bucket = true`; re-run `just upload-setup` (the recipe writes it).

**Connect in Castify fails 403 / signature errors** — wrong keys or the token
lacks read+list on that bucket; regenerate. Also check the endpoint contains
your account ID and region is `auto` ([`providers.md`](./providers.md) § S3).

**Site unreachable** — DO firewall missing 22/80/443, or DNS not propagated
(`curl https://dns.google/resolve?name=…`).

**Transcode slow** — 1 vCPU software-encodes roughly in real time at 720p;
fine for a personal server. Prefer H.264/AAC sources for instant direct
play.

**Droplet memory pressure** — check the swap landed (`swapon --show`) and the
transcode cache cap; both come from the setup above.
