const pkg = require('./package.json');

const CACHE_VERSION = `v${pkg.version.replace(/\./g, '-')}`;

module.exports = {
  globDirectory: 'dist',
  // Precache the app shell (HTML, icons) for offline-first support.
  // JS/CSS bundles have content hashes so browser HTTP cache handles them,
  // but we precache them too so the app can load fully offline.
  //
  // Fonts are deliberately NOT precached: the runtime lazy-loads them only
  // when the user picks a non-system font (font-loader.js), yet the old
  // glob shipped all 118 files (~2 MB) to every install and re-downloaded
  // them on every release because the cache version tracks pkg.version.
  // The runtime route below keeps a chosen font available offline instead.
  globPatterns: [
    'index.html',
    'assets/*.{js,css}',
    '**/*.{png,svg,ico}',
    'manifest.json',
    'sw-*.js',
    'email-iframe.js',
  ],
  swDest: 'dist/sw.js',
  // Import sync handler for background sync. sw-message-normalize.js defines the
  // shared message normalizer and MUST load first so sw-sync.js can call it.
  importScripts: ['sw-message-normalize.js', 'sw-sync.js'],
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
      // Fonts load lazily and rarely change; cache on first use so a chosen
      // custom font keeps working offline without precaching the whole set.
      urlPattern: /\.(?:woff2?|ttf|otf)$/,
      handler: 'CacheFirst',
      options: {
        cacheName: 'fonts-v1',
        expiration: {
          maxEntries: 24,
          maxAgeSeconds: 365 * 24 * 60 * 60, // 1 year; font files are content-hashed
        },
        cacheableResponse: {
          statuses: [0, 200],
        },
      },
    },
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
