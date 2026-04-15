const pkg = require('./package.json');

const CACHE_VERSION = `v${pkg.version.replace(/\./g, '-')}`;

module.exports = {
  globDirectory: 'dist',
  // Precache the app shell (HTML, fonts, icons) for offline-first support.
  // JS/CSS bundles have content hashes so browser HTTP cache handles them,
  // but we precache them too so the app can load fully offline.
  globPatterns: [
    'index.html',
    'assets/*.{js,css}',
    '**/*.{woff2,woff,png,svg,ico}',
    'manifest.json',
    'sw-*.js',
    'email-iframe.js',
  ],
  swDest: 'dist/sw.js',
  // Import sync handler for background sync
  importScripts: ['sw-sync.js'],
  // SPA fallback — serve index.html for all navigation requests when offline.
  // Enables the app to load from cache when the network is unavailable.
  navigateFallback: '/index.html',
  navigateFallbackDenylist: [/^\/api\//, /^\/v1\//, /\/clear-manifest\.json$/],
  globIgnores: ['clear-manifest.json'],
  cleanupOutdatedCaches: true,
  // Aggressive updates - safe because JS/CSS have content hashes
  skipWaiting: true,
  clientsClaim: true,
  runtimeCaching: [
    {
      urlPattern: /\.(?:png|jpg|jpeg|svg|gif|ico)$/,
      handler: 'CacheFirst',
      options: {
        cacheName: `images-${CACHE_VERSION}`,
        expiration: {
          maxEntries: 60,
          maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
        },
        cacheableResponse: {
          statuses: [0, 200],
        },
      },
    },
    {
      // App icons: Reduced from 1 year to 30 days for branding updates
      urlPattern: /\/icons\/.*\.(?:png|svg|ico)$/i,
      handler: 'CacheFirst',
      options: {
        cacheName: `app-icons-${CACHE_VERSION}`,
        expiration: {
          maxEntries: 20,
          maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days (reduced from 1 year)
        },
        cacheableResponse: {
          statuses: [0, 200],
        },
      },
    },
  ],
};
