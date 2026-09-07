# Connecting cloud providers

Castify scans your cloud storage (Google Drive, Dropbox, OneDrive, plus any S3-compatible object storage) and unifies the videos into one library. The OAuth providers (Google, Dropbox, OneDrive) require registering an **app** and handing its credentials to Castify via environment variables. S3-compatible storage (Cloudflare R2, Backblaze B2, MinIO, AWS S3, …) skips all of that — you paste per-connection credentials into the UI.

This guide walks through every provider end to end. For the full environment-variable reference, see [`docs/config.md`](./config.md).

## How provider OAuth works

Connections use two separate layers — understanding the split answers most "why?" questions up front.

**1. App credentials (client ID / secret) — one-time, identifies Castify itself.**

Registered once per provider in that provider's developer console. These prove *"the Castify app is asking for access"* so the provider can show a named consent screen and enforce limits. Set them as environment variables on the server — they must not ship in the browser bundle. Both halves (ID **and** secret) are required, or the provider stays unconfigured.

**2. Account tokens — per user, obtained when they click Connect.**

When someone clicks **Connect**, Castify redirects to the provider's consent screen. The user logs into **their** account and approves. The provider returns an access/refresh token tied to **that account**, which Castify encrypts (`CASTIFY_TOKEN_KEY`) and stores. Different accounts → different tokens, each only ever scanning its own storage.

This split is why users can't bring their own client ID/secret: the credentials are tied to the *app* and to the host's redirect URI, not to any one account. In Castify's single-owner model the same person does both steps.

**Cost & approval.** Registering an OAuth app is free on all three providers, and you create it yourself — there's no application-approval gate. The one wrinkle: while your Google app stays in **Testing** (unverified) mode, only accounts you add as **test users** can grant consent, and the consent screen shows a "Google hasn't verified this app" warning. Click **Advanced → Go to castify (unsafe)** to proceed. Formal verification is only needed for 100+ public users or restricted scopes; Castify uses `drive.readonly`, which is *sensitive*, not *restricted*.

## The redirect URI

The three OAuth providers each need this exact redirect URI, where `{provider}` is `google_drive`, `dropbox`, or `onedrive` — **S3-compatible storage doesn't need one** (no OAuth, no redirect):

```
{CASTIFY_APP_BASE_URL}/api/connections/{provider}/callback
```

`CASTIFY_APP_BASE_URL` must match the host you registered. Examples:

| Environment | `CASTIFY_APP_BASE_URL` | Google Drive redirect URI |
| ----------- | ---------------------- | ------------------------- |
| Local dev   | `http://localhost:8427` | `http://localhost:8427/api/connections/google_drive/callback` |
| Production  | `https://media.example.com` | `https://media.example.com/api/connections/google_drive/callback` |

## Google Drive

1. **Create a project** — [Google Cloud Console](https://console.cloud.google.com/) → top-bar **project picker** → **New Project** → name it → **Create** → select it.
2. **Enable the Drive API** — ☰ menu → **APIs & Services** → **Library** → search `Google Drive API` → **Enable**.
3. **Configure the consent screen** — **APIs & Services** → **OAuth consent screen**:
   - **User type** → **External** → **Create**.
   - **Branding** — App name `castify`, your email in *User support email* and *Developer contact information* → **Save**.
   - **Data access** (left column) → **Add or remove scopes** → filter `drive.readonly` → tick `https://www.googleapis.com/auth/drive.readonly` → **Save**. *(Optional in Testing mode — Castify requests the scope at runtime — but recommended. The scope only appears if step 2 is done.)*
   - **Audience** (left column) → **Test users** → **Add users** → paste the Gmail you'll connect → **Save**.
4. **Create the client ID** — **APIs & Services** → **Credentials** → top **+ Create Credentials** → **OAuth client ID**:
   - **Application type** → **Web application**.
   - **Authorized redirect URIs** → **Add URI** → your Google Drive redirect URI (above).
   - **Create** → copy the **Client ID** and **Client secret** (also visible later under Credentials → the client).
5. **Set the environment variables and restart:**

   ```sh
   export CASTIFY_APP_BASE_URL="http://localhost:8427"
   export CASTIFY_GOOGLE_CLIENT_ID="....apps.googleusercontent.com"
   export CASTIFY_GOOGLE_CLIENT_SECRET="GOCSPX-..."
   cargo run -p castify-api
   ```

## Dropbox

1. **Create an app** — [Dropbox App Console](https://www.dropbox.com/developers/apps) → **Create app**.
2. Choose **Dropbox API** → access type (**Full Dropbox** for your whole drive, or **App folder** for a scoped folder) → name it → **Create app**.
3. **Add the redirect URI** — **Settings** → **OAuth 2** → **Redirect URIs** → add `{CASTIFY_APP_BASE_URL}/api/connections/dropbox/callback`.
4. Copy the **App key** and **App secret** (Settings page).
5. **Set the environment variables and restart:**

   ```sh
   export CASTIFY_DROPBOX_CLIENT_ID="your-app-key"
   export CASTIFY_DROPBOX_CLIENT_SECRET="your-app-secret"
   cargo run -p castify-api
   ```

## OneDrive

1. **Register an app** — [Azure portal](https://portal.azure.com/) → **App registrations** → **New registration** → name it → **Register**.
2. **Add the redirect URI** — **Authentication** → **Add a platform** → **Web** → add `{CASTIFY_APP_BASE_URL}/api/connections/onedrive/callback`.
3. **Add Microsoft Graph permissions** — **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions** → add `Files.Read.All` and `offline_access`.
4. **Create a client secret** — **Certificates & secrets** → **New client secret** → copy the **Value** immediately (it's hidden afterward). The **Application (client) ID** is on the **Overview** page.
5. **Set the environment variables and restart:**

   ```sh
   export CASTIFY_MS_CLIENT_ID="your-client-id"
   export CASTIFY_MS_CLIENT_SECRET="your-client-secret"
   cargo run -p castify-api
   ```

## S3-compatible storage (Cloudflare R2, Backblaze B2, MinIO, AWS S3, …)

No app registration, no environment variables, no redirect URI. You enter credentials **per connection** in the UI; Castify verifies them (a `HeadBucket` + one list page), encrypts them at rest (`CASTIFY_TOKEN_KEY`), and starts scanning. One connection = one bucket; connect several endpoints (an R2 bucket *and* a MinIO box) and they appear as separate connections.

The connect form asks for: **Endpoint, Region, Bucket, Access key ID, Secret access key**, and an optional **Key prefix**.

**Streaming posture:** playback prefers presigned URLs — the browser pulls video bytes **directly from the provider**, your Castify server relays none of them (proxy fallback exists). On R2 that also means zero egress fees. Videos without browser-compatible codecs still need ffmpeg for transcoding — see [`docs/deploy.md`](./deploy.md) § Transcoding & ffmpeg.

### Cloudflare R2 (recommended for video — zero egress fees)

1. **Create a bucket** — [Cloudflare dashboard](https://dash.cloudflare.com/) → **R2 Object Storage** → **Create bucket** → name it (e.g. `media`) → upload your videos (any tool that speaks S3, or the dashboard drag-and-drop).
2. **Create a read-only API token** — R2 overview → **Manage R2 API Tokens** → **Create API Token**:
   - **Permissions** → **Object Read Only** — Castify never writes or deletes.
   - Scope it to your bucket under **Specify bucket(s)** if you want it tight.
   - Create → copy the **Access Key ID** and **Secret Access Key** (shown once).
3. **Find your endpoint** — on the token page (or bucket **Settings** → **S3 API**): `https://<account-id>.r2.cloudflarestorage.com`.
4. **Connect in Castify** — Connections → **S3-compatible storage**:
   | Form field      | Value                                          |
   | --------------- | ---------------------------------------------- |
   | Endpoint        | `https://<account-id>.r2.cloudflarestorage.com` |
   | Region          | `auto`                                          |
   | Bucket          | `media`                                         |
   | Access key ID   | *(from step 2)*                                 |
   | Secret access key | *(from step 2)*                               |

### Backblaze B2

1. **Create a bucket** — [B2 Cloud Storage](https://secure.backblaze.com/b2_buckets.htm) → **Create a Bucket** → set **Files in Bucket are: Private**.
2. **Create an application key** — **App Keys** → **Add a New Application Key** → name it, allow access to just that bucket, capabilities: **read + list only** (e.g. `listFiles`, `readFiles`) → copy the **keyID** and **applicationKey** (shown once).
3. **Connect in Castify** — the endpoint follows the pattern `https://s3.<region>.backblazeb2.com` (region is shown on the bucket page, e.g. `us-west-004`); use the same region in the form.

### MinIO (self-hosted)

Endpoint `http://127.0.0.1:9000` (or your LAN address), region `us-east-1` unless configured otherwise, plus any access key/secret pair you created (`mc admin user` or the console). Plain `http://` endpoints are accepted **only** on loopback — everything else must be `https://`.

### AWS S3

Endpoint can be left to the SDK default style (`https://s3.<region>.amazonaws.com`), region = your bucket's region. Create an IAM user or role scoped to read-only on that one bucket (`s3:ListBucket`, `s3:GetObject`).

## Connect an account

After the env vars are set and the backend restarted, `GET /api/connections/available` reports each OAuth provider as configured and its **Connect** button on the Connections page goes live. (S3-compatible storage is always available — no server config needed.)

**OAuth providers (Google / Dropbox / OneDrive):**

1. Open **Connections** → click **Connect** on the provider card.
2. Approve the provider's consent screen. *(Google in Testing mode: dismiss the "Google hasn't verified this app" warning via **Advanced → Go to castify (unsafe)**.)*
3. You're redirected back; Castify stores the encrypted token and starts scanning. Re-scan anytime from the card.

**S3-compatible storage:** click **Connect**, fill in the form (see above), submit — verification runs, then the scan starts. No consent screen, no redirect.

## Environment variables

| Provider    | Client ID variable             | Client secret variable             |
| ----------- | ------------------------------ | ----------------------------------- |
| Google Drive | `CASTIFY_GOOGLE_CLIENT_ID`    | `CASTIFY_GOOGLE_CLIENT_SECRET`     |
| Dropbox     | `CASTIFY_DROPBOX_CLIENT_ID`   | `CASTIFY_DROPBOX_CLIENT_SECRET`    |
| OneDrive    | `CASTIFY_MS_CLIENT_ID`        | `CASTIFY_MS_CLIENT_SECRET`         |

Both halves are required. `load_provider_oauth` returns `None` if either is missing, leaving the provider unconfigured. S3-compatible storage has no row here — its credentials are per-connection (entered in the UI), not server-level env config.

## Troubleshooting

**The scope picker is empty / `drive.readonly` doesn't appear.**
The Google Drive API isn't enabled in the project. **APIs & Services → Library → Google Drive API → Enable**, then retry.

**`access_denied` / "Access blocked" / 403 during Google consent.**
The account isn't on the app's test-user list while the app is in Testing mode. **OAuth consent screen → Audience → Test users** → add the Gmail → retry.

**`redirect_uri_mismatch`.**
The URI in the provider console doesn't exactly match `CASTIFY_APP_BASE_URL` + `/api/connections/{provider}/callback`. Check the scheme (`http` vs `https`), port, trailing slash, and that `CASTIFY_APP_BASE_URL` is set.

**Provider still shows "unconfigured" after setting the variables.**
Both the client ID **and** secret must be set. Confirm both are exported in the environment the backend actually reads and that you **restarted** the process. The configured check is `config.<provider>_oauth.is_some()`, exposed at `GET /api/connections/available`.

**Scans stop with Unauthorized.**
Castify stores a refresh token and refreshes automatically. If the grant was revoked at the provider (e.g. you disconnected there, or Google expired it after 6 months of inactivity), disconnect and reconnect from the Connections page.

**S3 connect fails with 403 / signature errors.**
Most commonly: wrong access key or secret (they're shown only once at creation — regenerate if unsure), or the token lacks read+list permission on that bucket. On R2, also check the endpoint contains **your account ID** (`https://<account-id>.r2.cloudflarestorage.com`) and the region is `auto`. Signature errors can also come from a server clock that has drifted — NTP-sync the host and retry.

**S3 connect rejected: endpoint not allowed.**
Endpoints must be `https://`; plain `http://` is accepted only on loopback (local MinIO). Hostnames resolving to private/link-local ranges are rejected for non-loopback connections.
