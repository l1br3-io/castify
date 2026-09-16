# Walkthrough: Oracle Cloud (Singapore) + Cloudflare R2

End-to-end deployment of Castify on the **Oracle Cloud Always Free** tier, storing
media in **Cloudflare R2**. Total cost: **$0/month for the server** + R2 storage
(first 10 GB free, ~$0.015/GB/month after, streaming egress always free) + a domain
(~$10/year).

The split this guide builds:

```
Viewers ──(pages/API, tiny)──────► Oracle Singapore (free) ── Castify app
Viewers ──(video bytes, heavy)──► Cloudflare R2 edge (Singapore/Manila/…)
```

Good for Singapore (~1–3 ms to the server) and the Philippines (~30–50 ms; video
served from Cloudflare's Manila edge). For the general deployment reference see
[`deploy.md`](./deploy.md); for provider connection details see
[`providers.md`](./providers.md).

## 0. Prerequisites

- **A credit/debit card.** Oracle requires it for identity verification at signup.
  Always Free resources are not billed to it.
- **A domain** (~$10/yr — Porkbun, Namecheap, or Cloudflare Registrar). Needed for
  HTTPS and share links. Skip it and you're stuck on `http://<ip>:8427` — not
  recommended.
- This guide uses `media.example.com` throughout — substitute your domain.

## 1. Oracle Cloud account

1. Sign up at [cloud.oracle.com](https://www.cloud.oracle.com/) — pick a region
   **at the very first step**. Choose **Singapore**. **The home region is
   permanent; it cannot be changed later.**
2. Complete card verification. You land on the dashboard with $300 trial credit
   (30 days) — irrelevant to us; the Always Free resources keep running after it
   expires, and nothing below exceeds them.

## 2. Create the instance

1. ☰ menu → **Compute** → **Instances** → **Create instance**.
2. **Name:** `castify`.
3. **Image:** click **Edit** → leave **Canonical Ubuntu 24.04** (the default).
   Architecture shows **Ampere (aarch64)** once you pick the shape below.
4. **Shape:** click **Edit** → **Ampere** (VM.Standard.A1.Flex) →
   **2 OCPUs, 12 GB memory**. (Always Free allows exactly this much total across
   A1 instances. 1 OCPU / 6 GB also works and leaves room for a second instance.)
5. **Boot volume:** leave defaults (~47 GB — the free block-storage budget is
   200 GB total, and the app needs only a few GB beyond the OS).
6. **SSH keys:** generate or add your own public key. **Save the private key** —
   it's your only way in.
7. **Create.** If you hit *Out of host capacity*: retry at an off-peak hour, or
   edit the instance and try a different **availability domain** — free-tier A1
   capacity in Singapore comes and goes.
8. When it's running, note the **Public IPv4 address**.

## 3. Open the firewall — twice (Oracle gotcha)

Oracle filters traffic at **two** layers; you must open both or the server looks
dead from the internet.

**Layer 1 — the cloud security list:**

1. ☰ → **Networking** → **Virtual Cloud Networks** → your VCN → **Security Lists**
   → **Default Security List for …**
2. **Add Ingress Rules** — add one rule per port, source `0.0.0.0/0`:
   - TCP destination port **80**
   - TCP destination port **443**

   (Leave 22 as-is; SSH should stay open from anywhere for now, or lock it to
   your IP later.)

**Layer 2 — Ubuntu's local iptables** (Oracle's Ubuntu images ship restrictive
rules that silently drop everything except SSH):

```sh
ssh -i <your-key> ubuntu@<instance-ip>

sudo iptables -I INPUT -p tcp --dport 80 -m conntrack --ctstate NEW -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -m conntrack --ctstate NEW -j ACCEPT
sudo netfilter-persistent save
```

## 4. DNS

In your domain's DNS panel, create an **A record**: `media.example.com` →
`<instance-ip>`. If the domain is on Cloudflare, set the record to **DNS only**
(grey cloud) — let Caddy handle TLS directly.

The instance's public IP survives reboots. (To make it survive
terminate/recreate, ☰ → **Networking** → **IP Management** → reserve it —
optional.)

## 5. Install Docker and Caddy

On the server:

```sh
# Docker (official script; includes compose plugin)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu    # then: exit and ssh back in

# Caddy (official apt repo)
sudo apt install -y debian-keyring debian-archive-keyring curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | \
  sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | \
  sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Point Caddy at Castify — edit `/etc/caddy/Caddyfile` to exactly:

```caddyfile
media.example.com {
    reverse_proxy 127.0.0.1:8427
}
```

```sh
sudo systemctl reload caddy
```

## 6. Deploy Castify

```sh
sudo apt install -y git
sudo git clone https://github.com/<you>/castify /opt/castify   # or your fork
cd /opt/castify
```

Two small edits:

1. **Bind the port to loopback only** — in `docker-compose.yml`:

   ```yaml
       ports:
         - "127.0.0.1:8427:8427"
   ```

2. **Set the external URL** — create `/opt/castify/.env`:

   ```
   CASTIFY_APP_BASE_URL=https://media.example.com
   ```

Build and boot (the 12 GB instance compiles the Rust image in place, ~10–20 min;
subsequent rebuilds are incremental):

```sh
docker compose up -d --build
curl localhost:8427/api/health   # {"status":"ok",...}
```

Open `https://media.example.com` — Caddy has already obtained the certificate —
and create your owner account in the setup wizard. Done: the app is live.

## 7. Connect R2

On the Cloudflare side:

1. [Cloudflare dashboard](https://dash.cloudflare.com/) → **R2 Object Storage**.
   First use asks you to enable R2 billing (card on file; the 10 GB free tier and
   zero-egress still apply).
2. **Create bucket** → name it (e.g. `media`) → create.
3. **Manage R2 API Tokens** → **Create API Token**:
   - **Permissions:** **Object Read Only** (Castify never writes or deletes)
   - **Specify bucket(s):** your bucket
   - Create → copy the **Access Key ID** and **Secret Access Key** (shown once)
   - Note the **S3 endpoint**: `https://<account-id>.r2.cloudflarestorage.com`
4. Upload movies — dashboard drag-and-drop, or any S3 tool (rclone, Cyberduck,
   `aws s3 sync`).

In Castify — **Connections** → **S3-compatible storage**:

| Field             | Value                                            |
| ----------------- | ------------------------------------------------ |
| Endpoint          | `https://<account-id>.r2.cloudflarestorage.com`  |
| Region            | `auto`                                           |
| Bucket            | `media`                                          |
| Access key ID     | *(from step 3)*                                  |
| Secret access key | *(from step 3)*                                  |

Submit → verification → scan. Your library appears; playback streams browser-
direct from R2 — the Oracle server relays no video bytes. Full walkthrough and
troubleshooting: [`providers.md`](./providers.md) § S3-compatible storage.

## 8. Optional: transcoding (ffmpeg)

The stock image has no ffmpeg (see [`deploy.md`](./deploy.md) § Transcoding &
ffmpeg). To enable it, create `/opt/castify/docker-compose.ffmpeg.yml`:

```yaml
services:
  castify:
    build:
      context: .
      target: e2e-runtime
```

…and cap the transcode cache so it can't eat the ~47 GB boot volume. Append to
`/opt/castify/.env`:

```
CASTIFY_TRANSCODE_CACHE_MAX_BYTES=10737418240   # 10 GB
```

Then use the override for every `up`/`rebuild`:

```sh
docker compose -f docker-compose.yml -f docker-compose.ffmpeg.yml up -d --build
```

## 9. Ongoing care

- **Back up:** the volume holds your database — see [`deploy.md`](./deploy.md) §
  Data persistence for the one-liner. Do it before upgrades.
- **Upgrade:** `cd /opt/castify && sudo git pull && docker compose up -d --build`
  (add the `-f docker-compose.ffmpeg.yml` if you use it). Migrations run
  automatically on boot.
- **Locked out:** `docker compose exec castify /castify reset-password` prints a
  one-time temp password.
- **Cost check:** OCI billing should show compute at $0 (Always Free). R2 shows
  storage beyond 10 GB only.

## Troubleshooting

**Site unreachable (timeout) at `https://…`** — almost always the dual firewall:
re-check the security-list ingress rules (§ 3, layer 1) *and* the iptables rules
(§ 3, layer 2; `sudo iptables -L INPUT` should show your 80/443 ACCEPTs).

**Caddy: certificate errors** — DNS record wrong or still propagating. Check
`dig media.example.com` returns the instance IP; the record must be **DNS only**
(grey cloud) on Cloudflare.

**"Out of host capacity" at instance creation** — free-tier A1 availability in
Singapore fluctuates; retry off-peak or switch availability domains.

**Health check fails after `up -d`** — first build takes a while; `docker compose
logs -f` to watch progress before retesting `curl localhost:8427/api/health`.

**R2 connect: 403 / signature errors** — see [`providers.md`](./providers.md) §
Troubleshooting (S3 entries): wrong keys, missing read+list permission, wrong
endpoint account ID, or server clock drift (the ARM boards are NTP-synced by
default, but verify with `timedatectl`).
