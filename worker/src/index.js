/**
 * Cloudflare Worker for webmail SPA
 *
 * Handles:
 * 1. SPA routing - returns index.html for navigation requests
 * 2. Cache headers - proper caching for different asset types
 *
 * This logic is portable to other edge providers (Vercel, Netlify, CloudFront)
 */

// SPA routes that should serve index.html
const SPA_ROUTES = ['/', '/mailbox', '/calendar', '/contacts', '/login'];

// Check if path matches an SPA route
const isSpaRoute = (path) => {
  if (path === '/') return true;
  return SPA_ROUTES.some(
    (route) => route !== '/' && (path === route || path.startsWith(route + '/')),
  );
};

// Check if this looks like a file request (has extension)
const isFileRequest = (path) => {
  const lastSegment = path.split('/').pop();
  return lastSegment.includes('.') && !lastSegment.startsWith('.');
};

// Determine cache control header based on path
const getCacheControl = (path) => {
  // HTML / SPA routes - never cache
  if (path === '/' || path === '/index.html') {
    return 'no-cache, no-store, must-revalidate';
  }

  // Fingerprinted assets (Vite adds hashes) - cache forever
  if (path.startsWith('/assets/')) {
    return 'public, max-age=31536000, immutable';
  }

  // Service worker files - always revalidate
  if (path === '/sw.js' || path.startsWith('/sw-') || path === '/version.json') {
    return 'no-cache, must-revalidate';
  }

  // Clear manifest - no browser cache, CDN caches for 1 year (purged on release)
  if (path === '/clear-manifest.json') {
    return 'public, s-maxage=31536000, max-age=0, must-revalidate';
  }

  // Manifest - short cache (1 hour)
  if (path === '/manifest.json') {
    return 'public, max-age=3600';
  }

  // Icons - medium cache (30 days)
  if (path.startsWith('/icons/')) {
    return 'public, max-age=2592000';
  }

  // Fonts - long cache (1 year, they're fingerprinted)
  if (path.match(/\.(woff2?|ttf|otf|eot)$/)) {
    return 'public, max-age=31536000, immutable';
  }

  // Default - short cache with revalidation
  return 'public, max-age=3600, must-revalidate';
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let path = url.pathname;

    // Normalize: remove trailing slash except for root
    if (path !== '/' && path.endsWith('/')) {
      path = path.slice(0, -1);
    }

    // Determine if we should serve index.html (SPA fallback)
    const isNavigation = request.headers.get('Accept')?.includes('text/html');
    const shouldServeSpa = isNavigation && isSpaRoute(path) && !isFileRequest(path);

    // The actual path to fetch from R2
    const r2Path = shouldServeSpa ? 'index.html' : path.slice(1); // Remove leading /

    try {
      // Fetch from R2
      const object = await env.BUCKET.get(r2Path);

      if (!object) {
        // Try index.html for any 404 on navigation (catch-all SPA fallback)
        if (isNavigation && !isFileRequest(path)) {
          const fallback = await env.BUCKET.get('index.html');
          if (fallback) {
            return createResponse(fallback, '/', request);
          }
        }
        return new Response('Not Found', { status: 404 });
      }

      return createResponse(object, path, request);
    } catch (err) {
      console.error('Worker error:', err);
      return new Response('Internal Error', { status: 500 });
    }
  },
};

/**
 * Check if path should never be cached (always serve fresh)
 */
function isNoCachePath(path) {
  // HTML / SPA routes - never cache, never 304
  if (path === '/' || path === '/index.html') return true;
  // Service worker files and clear manifest - always fresh
  if (
    path === '/sw.js' ||
    path.startsWith('/sw-') ||
    path === '/version.json' ||
    path === '/clear-manifest.json'
  )
    return true;
  // SPA routes served as index.html
  if (isSpaRoute(path) && !isFileRequest(path)) return true;
  return false;
}

/**
 * Create response with proper headers
 */
function createResponse(object, path, request) {
  const headers = new Headers();

  // Content type from R2 or infer from extension
  const contentType = object.httpMetadata?.contentType || inferContentType(path);
  headers.set('Content-Type', contentType);

  // Cache control based on path
  const cacheControl = getCacheControl(path);
  headers.set('Cache-Control', cacheControl);

  // Security headers
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  headers.set('X-Permitted-Cross-Domain-Policies', 'none');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');

  // CORS for fonts (needed for cross-origin font loading)
  if (path.match(/\.(woff2?|ttf|otf|eot)$/)) {
    headers.set('Access-Control-Allow-Origin', '*');
  }

  // For no-cache paths: don't send ETag/Last-Modified, don't return 304
  // This ensures HTML/SW files are always served fresh
  if (isNoCachePath(path)) {
    // Explicitly remove any caching headers that might enable 304
    headers.delete('ETag');
    headers.delete('Last-Modified');
    return new Response(object.body, { headers });
  }

  // For cacheable assets: support conditional requests with ETag and Last-Modified
  if (object.httpEtag) {
    headers.set('ETag', object.httpEtag);
  }
  if (object.httpMetadata?.lastModified) {
    headers.set('Last-Modified', object.httpMetadata.lastModified.toUTCString());
  }

  // Check If-None-Match (ETag)
  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifNoneMatch && object.httpEtag && ifNoneMatch === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }

  // Check If-Modified-Since
  const ifModifiedSince = request.headers.get('If-Modified-Since');
  if (ifModifiedSince && object.httpMetadata?.lastModified) {
    const clientDate = new Date(ifModifiedSince);
    if (object.httpMetadata.lastModified <= clientDate) {
      return new Response(null, { status: 304, headers });
    }
  }

  return new Response(object.body, { headers });
}

/**
 * Infer content type from file extension
 */
function inferContentType(path) {
  const ext = path.split('.').pop()?.toLowerCase();
  const types = {
    html: 'text/html; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    mjs: 'application/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    json: 'application/json; charset=utf-8',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
    eot: 'application/vnd.ms-fontobject',
    webp: 'image/webp',
    avif: 'image/avif',
    webmanifest: 'application/manifest+json',
  };
  return types[ext] || 'application/octet-stream';
}
