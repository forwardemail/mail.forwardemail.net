# Deployment Checklist

Complete setup guide for deploying the webmail app from scratch using Cloudflare
(R2 + Workers) and GitHub Actions.

```mermaid
flowchart LR
    A["pnpm release"] --> B["np: lint, test, build, bump, tag"] --> C["GitHub Release published"]
    C --> D["Deploy workflow: build, R2 sync, Worker deploy, cache purge"]
    D --> E["Result: Static PWA served from Cloudflare edge"]
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

### 2.1 Secrets

```
 Settings → Secrets and variables → Actions → Secrets
```

| Secret                 | Source   | Description                 |
| ---------------------- | -------- | --------------------------- |
| `R2_ACCESS_KEY_ID`     | Step 1.2 | R2 API access key           |
| `R2_SECRET_ACCESS_KEY` | Step 1.2 | R2 API secret key           |
| `R2_ACCOUNT_ID`        | Step 1.3 | Cloudflare account ID       |
| `CLOUDFLARE_API_TOKEN` | Step 1.4 | API token for Workers/cache |
| `CLOUDFLARE_ZONE_ID`   | Step 1.3 | Zone ID for cache purge     |

### 2.2 Variables

```
 Settings → Secrets and variables → Actions → Variables
```

| Variable    | Value          | Description    |
| ----------- | -------------- | -------------- |
| `R2_BUCKET` | `webmail-prod` | R2 bucket name |

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

There are two separate GitHub Actions workflows:

### CI (`.github/workflows/ci.yml`)

Runs on every push to `main` and on pull requests. Performs lint, format, unit tests, build, and E2E tests (PRs only). **Does not deploy.**

### Deploy (`.github/workflows/deploy.yml`)

Runs only when a GitHub Release is published. Builds the app, syncs to R2, deploys the Worker, and purges the Cloudflare cache.

```mermaid
flowchart TD
    subgraph CI ["CI workflow (push / PR)"]
        A1["Install"] --> A2["Lint + Format"] --> A3["Unit tests"] --> A4["Build"]
        A4 --> A5["E2E tests (PR only)"]
    end
    subgraph Deploy ["Deploy workflow (release published)"]
        B1["Install + Build"] --> B2["Deploy to R2"] --> B3["Deploy Worker"] --> B4["Purge CDN cache"]
    end
    R["pnpm release → GitHub Release published"] --> Deploy
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
5. Publish a GitHub Release, which triggers the Deploy workflow

---

## 7. First Deployment

```mermaid
flowchart TD
    A["1. pnpm release"] --> B["2. Monitor GitHub Actions (Deploy workflow)"] --> C["3. Verify"]
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

| Problem                  | Fix                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| Worker not serving files | `cd worker && pnpm tail` — Check wrangler.toml routes                                                   |
| R2 bucket empty          | `aws --endpoint-url "$ENDPOINT" s3 ls "s3://${R2_BUCKET}/"`                                             |
| Cache not clearing       | Manual purge: `curl -X POST ".../purge_cache" --data '{"purge_everything":true}'`                       |
| Deploy 403 error         | Verify API token has: Workers Scripts: Edit, Workers R2: Edit, Cache Purge: Purge, Workers Routes: Edit |
| Deploy not triggering    | Ensure `pnpm release` published a GitHub Release (check the Releases tab), not just a tag               |

---

## 10. Staging Environment (Optional)

```mermaid
flowchart TD
    A["1. Create R2 bucket: webmail-staging"] --> B["2. Create Worker: update wrangler.toml name"]
    B --> C["3. Add route: staging-mail.yourdomain.com/*"]
    C --> D["4. Create GitHub environment with separate secrets"]
    D --> E["5. Add environment filter to deploy.yml"]
```

---

## Quick Reference

| Resource        | Location                                  |
| --------------- | ----------------------------------------- |
| R2 Bucket       | Cloudflare Dashboard → R2                 |
| Worker          | Cloudflare Dashboard → Workers & Pages    |
| DNS             | Cloudflare Dashboard → Your Domain → DNS  |
| Secrets         | GitHub → Settings → Secrets and variables |
| CI Workflow     | `.github/workflows/ci.yml`                |
| Deploy Workflow | `.github/workflows/deploy.yml`            |
| Worker Config   | `worker/wrangler.toml`                    |
