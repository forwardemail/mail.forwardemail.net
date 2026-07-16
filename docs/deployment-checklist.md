# Deployment Checklist

Complete setup guide for deploying the webmail app from scratch using Cloudflare
(R2 + Workers) and GitHub Actions.

```mermaid
flowchart LR
    A["pnpm release"] --> B["np: lint, test, build, bump, tag"] --> C["Release workflow"]
    C --> D["E2E + desktop/mobile builds"]
    D --> E["Inline R2 sync, Worker deploy, cache purge"]
    E --> F["Publish GitHub Release + checksums"]
    E --> G["Static PWA served from Cloudflare edge"]
```

## Prerequisites

- Cloudflare account with a domain configured
- GitHub repository with Actions enabled
- Node.js 20+ and pnpm 9+ installed locally

---

## 1. Cloudflare Setup

### 1.1 Create R2 Bucket

```
 Cloudflare Dashboard → R2 Object Storage → Create bucket
```

| Setting  | Value          |
| -------- | -------------- |
| Name     | `webmail-prod` |
| Location | Default        |

### 1.2 Create R2 API Token

```
 R2 → Manage R2 API Tokens → Create API token
```

| Setting      | Value                 |
| ------------ | --------------------- |
| Token name   | `webmail-deploy`      |
| Permissions  | Object Read & Write   |
| Bucket scope | Your bucket           |
| TTL          | No expiry (for CI/CD) |

Save these credentials:

| Credential        | Secret Name          |
| ----------------- | -------------------- |
| Access Key ID     | R2_ACCESS_KEY_ID     |
| Secret Access Key | R2_SECRET_ACCESS_KEY |

### 1.3 Get Account and Zone IDs

```
 Cloudflare Dashboard → Any domain → Overview → Right sidebar
```

| ID         | Secret Name        |
| ---------- | ------------------ |
| Account ID | R2_ACCOUNT_ID      |
| Zone ID    | CLOUDFLARE_ZONE_ID |

### 1.4 Create Cloudflare API Token

```
 My Profile → API Tokens → Create Token → Custom token
```

| Permission                   | Access |
| ---------------------------- | ------ |
| Account / Workers Scripts    | Edit   |
| Account / Workers R2 Storage | Edit   |
| Zone / Cache Purge           | Purge  |
| Zone / Workers Routes        | Edit   |

- **Zone Resources:** Include → Specific zone → Your domain
- **Account Resources:** Include → Your account
- Save the token → `CLOUDFLARE_API_TOKEN`

---

## 2. GitHub Repository Setup

The tagged release pipeline also builds and signs desktop and mobile applications. This deployment checklist repeats only the Cloudflare values; provision the complete platform-signing, push, store-upload, release-control, and notification inventory from [SECRETS.md](./SECRETS.md).

### 2.1 Web deployment secrets

Store these values in the **`release`** GitHub Actions environment:

```
Settings → Secrets and variables → Actions → Environments → release
```

| Secret                 | Source   | Description                 |
| ---------------------- | -------- | --------------------------- |
| `R2_ACCESS_KEY_ID`     | Step 1.2 | R2 API access key           |
| `R2_SECRET_ACCESS_KEY` | Step 1.2 | R2 API secret key           |
| `R2_ACCOUNT_ID`        | Step 1.3 | Cloudflare account ID       |
| `CLOUDFLARE_API_TOKEN` | Step 1.4 | API token for Workers/cache |
| `CLOUDFLARE_ZONE_ID`   | Step 1.3 | Zone ID for cache purge     |

Optional `MATRIX_TOKEN` is different: store it as a **repository Actions secret**, because notification jobs do not attach the `release` environment.

### 2.2 Web deployment variable

```
Settings → Secrets and variables → Actions → Variables
```

| Variable    | Value          | Description    |
| ----------- | -------------- | -------------- |
| `R2_BUCKET` | `webmail-prod` | R2 bucket name |

The same Actions Variables page also holds release values such as `VAPID_PUBLIC_KEY`, optional `PLAY_TRACK` and `IOS_SIGNING_IDENTITY`, and the emergency-only `ALLOW_NO_UPDATER` override. See [SECRETS.md](./SECRETS.md) before running a tagged release.

---

## 3. Worker Configuration

### 3.1 wrangler.toml

```toml
name = "webmail-cdn"
main = "src/index.js"
compatibility_date = "2024-01-01"

routes = [
  { pattern = "mail.yourdomain.com/*", zone_name = "yourdomain.com" }
]

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "webmail-prod"   # Updated by CI/CD
```

### 3.2 Worker Responsibilities

```mermaid
flowchart LR
    subgraph Cloudflare Worker - worker/src/index.js
        A["SPA routing:<br/>return index.html<br/>for navigation requests"]
        B["Cache headers<br/>per asset type"]
        C["Security headers<br/>CSP, X-Frame-Options, etc."]
        D["Serve assets<br/>from R2 bucket"]
    end
```

---

## 4. DNS Configuration

```
 Your Domain → DNS → Add record
```

| Type | Name   | Content     | Proxy   |
| ---- | ------ | ----------- | ------- |
| `A`  | `mail` | `192.0.2.1` | Proxied |

Traffic routes through the Worker — the A record is a placeholder.

---

## 5. Environment Variables

### Build-time

```bash
# .env or CI environment
VITE_WEBMAIL_API_BASE=https://api.forwardemail.net
```

The following variables are injected automatically by `vite.config.js` at build
time via the `define` option (no manual configuration needed):

| Variable           | Source            | Purpose                                 |
| ------------------ | ----------------- | --------------------------------------- |
| `VITE_PKG_VERSION` | `package.json`    | Semver for clear-site-data version gate |
| `VITE_APP_VERSION` | `version + hash`  | Full version for cache busting          |
| `VITE_BUILD_HASH`  | MD5 of version+ts | Unique per-build fingerprint            |

See [Technology Stack — Build-Time Environment Variables](building-webmail-technology-stack.md#build-time-environment-variables) for details.

### Runtime

None needed — the app is entirely client-side after build.

---

## 6. CI/CD Pipeline

Three workflow entry points are relevant:

### CI (`.github/workflows/ci.yml`)

Runs on pushes and pull requests. It performs the standard validation suite and **does not deploy**.

### Release (`.github/workflows/release.yml`)

Runs for `v*` tags and by manual dispatch. It gates the release with WebView E2E, calls the reusable desktop and mobile build workflows, deploys the web application inline, publishes the GitHub Release, generates checksums, and optionally notifies Matrix.

The web deployment is inline because release events created with the automatic `GITHUB_TOKEN` do not trigger another workflow.

### Manual redeploy (`.github/workflows/deploy.yml`)

Runs only through `workflow_dispatch`. Use it as a recovery path to rebuild and redeploy the current web application without creating another tagged release.

```mermaid
flowchart TD
    subgraph CI ["CI workflow (push / PR)"]
        A1["Install"] --> A2["Lint + Format"] --> A3["Unit tests"] --> A4["Build"]
    end
    T["v* tag"] --> R1["Release: WebView E2E"]
    R1 --> R2["Desktop + mobile builds"]
    R2 --> R3["Inline R2 + Worker deploy"]
    R3 --> R4["Publish release + checksums"]
    M["Manual workflow_dispatch"] --> D1["deploy.yml recovery redeploy"]
```

### Releasing

Releases are managed locally using [np](https://github.com/sindresorhus/np):

```bash
pnpm release
```

This will:

1. Verify a clean working tree and up-to-date `main` branch
2. Run lint, format, tests, and build
3. Bump the version in `package.json` and create a git tag
4. Push the commit and tag to GitHub
5. Trigger the unified Release workflow, which builds all platforms, deploys the web application inline, and publishes the GitHub Release

---

## 7. First Deployment

```mermaid
flowchart TD
    A["1. pnpm release"] --> B["2. Monitor GitHub Actions (Release workflow)"] --> C["3. Verify"]
    C --> D["R2 bucket has files?"]
    C --> E["Worker deployed?<br/>npx wrangler deployments list"]
    C --> F["Site loads?<br/>https://mail.yourdomain.com"]
```

---

## 8. Post-Deployment Verification

### Functional Checks

- [ ] App loads at https://mail.yourdomain.com
- [ ] Login works
- [ ] Can view mailbox
- [ ] Can compose and send email
- [ ] Can view calendar
- [ ] Service worker registers (DevTools → Application)

### Performance Checks

- [ ] Assets cached (check Cache-Control headers)
- [ ] Lighthouse score > 90
- [ ] No console errors

### Security Checks

- [ ] HTTPS enforced
- [ ] Security headers present
- [ ] No mixed content warnings

---

## 9. Troubleshooting

| Problem                     | Fix                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| Worker not serving files    | `cd worker && pnpm tail` — Check wrangler.toml routes                                                   |
| R2 bucket empty             | `aws --endpoint-url "$ENDPOINT" s3 ls "s3://${R2_BUCKET}/"`                                             |
| Cache not clearing          | Manual purge: `curl -X POST ".../purge_cache" --data '{"purge_everything":true}'`                       |
| Deploy 403 error            | Verify API token has: Workers Scripts: Edit, Workers R2: Edit, Cache Purge: Purge, Workers Routes: Edit |
| Release not triggering      | Ensure `pnpm release` pushed a `v*` tag and inspect the **Release** workflow in the Actions tab         |
| Manual redeploy unavailable | Run `.github/workflows/deploy.yml` with `workflow_dispatch`; it is not triggered by release publication |

---

## 10. Staging Environment (Optional)

```mermaid
flowchart TD
    A["1. Create R2 bucket: webmail-staging"] --> B["2. Create Worker: update wrangler.toml name"]
    B --> C["3. Add route: staging-mail.yourdomain.com/*"]
    C --> D["4. Create GitHub environment with separate secrets"]
    D --> E["5. Route both release.yml inline deploy and deploy.yml recovery jobs to that environment"]
```

---

## Quick Reference

| Resource         | Location                                  |
| ---------------- | ----------------------------------------- |
| R2 Bucket        | Cloudflare Dashboard → R2                 |
| Worker           | Cloudflare Dashboard → Workers & Pages    |
| DNS              | Cloudflare Dashboard → Your Domain → DNS  |
| Secrets          | GitHub → Settings → Secrets and variables |
| CI Workflow      | `.github/workflows/ci.yml`                |
| Release Workflow | `.github/workflows/release.yml`           |
| Manual Redeploy  | `.github/workflows/deploy.yml`            |
| Worker Config    | `worker/wrangler.toml`                    |
