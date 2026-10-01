# Webmail CDN Worker

Cloudflare Worker that serves the webmail SPA from R2 with proper caching.

See the main [README.md](../README.md#deployment) for full deployment documentation.

## Local Development

```bash
# Install dependencies
pnpm install

# Login to Cloudflare (first time)
npx wrangler login

# Run worker locally (connects to real R2 bucket)
pnpm dev

# View live production logs
pnpm tail
```

## What it does

1. **SPA Routing**: Returns `index.html` for navigation requests (`/mailbox`, `/calendar`, etc.)
2. **Cache Headers**: Sets correct `Cache-Control` per asset type
3. **Security Headers**: `X-Content-Type-Options`, `X-Frame-Options`

## Files

```
worker/
├── wrangler.toml      # Cloudflare Worker config
├── src/index.js       # Worker logic
└── package.json       # Wrangler dependency
```

## Portability

The logic ports to other edge platforms:

| Feature       | Cloudflare | Vercel                 | Netlify      | CloudFront  |
| ------------- | ---------- | ---------------------- | ------------ | ----------- |
| SPA fallback  | Worker     | `vercel.json` rewrites | `_redirects` | Lambda@Edge |
| Cache headers | Worker     | `vercel.json` headers  | `_headers`   | Lambda@Edge |

To migrate, translate `getCacheControl()` and `isSpaRoute()` to the target platform's format.
