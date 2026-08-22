// =========================================================================
// SERVICE WORKER — offline support for Cattle Claim Validator
// =========================================================================
// HOW VERSIONING WORKS (read this before re-training/replacing a model):
//   Every asset this app depends on (HTML, ONNX models, reference photos,
//   CDN libraries) is cached under CACHE_NAME below. As long as CACHE_NAME
//   stays the same, the service worker assumes the cache is up to date and
//   will keep serving the OLD cached files forever, even if you push new
//   ones to GitHub — browsers do not "notice" that a same-URL file changed.
//
//   So: any time you replace/re-train a .onnx model, add/change a reference
//   photo, or make a meaningful change to this file or index.html, BUMP
//   CACHE_VERSION below (e.g. 'v1' -> 'v2'). That forces every returning
//   user's browser to install a fresh service worker, wipe the old cache,
//   and re-download everything fresh next time they have a connection.
//   Forgetting to bump it means users keep silently using stale models.
// =========================================================================

const CACHE_VERSION = 'v22';
const CACHE_NAME = `cattle-claim-${CACHE_VERSION}`;

// ---- App shell: the local files this app is built from ----
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
];

// ---- CDN library entry points (tfjs, blazeface, onnxruntime-web, exifr) ----
const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs',
  'https://cdn.jsdelivr.net/npm/@tensorflow-models/blazeface',
  'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.min.js',
  'https://cdn.jsdelivr.net/npm/exifr/dist/lite.umd.js',
];

// ---- All trained ONNX models (from CATTLE_MODEL_CONFIG / COCO_MODEL_CONFIG
//      / SECONDARY_MODEL_CONFIG in index.html) ----
const MODEL_ASSETS = [
  'https://raw.githubusercontent.com/kshitij435/cattle/main/yolov8n.onnx',
  'https://raw.githubusercontent.com/kshitij435/cattle/main/left_right_flank_dead.onnx',
  'https://raw.githubusercontent.com/kshitij435/cattle/main/head_left_right.onnx',
  'https://raw.githubusercontent.com/kshitij435/cattle/main/eartags_horn.onnx',
  'https://raw.githubusercontent.com/kshitij435/cattle/main/left_right_live.onnx',
  'https://raw.githubusercontent.com/kshitij435/cattle/main/live_cattle_front_head.onnx',
  'https://raw.githubusercontent.com/kshitij435/cattle/main/best.onnx',
];

// ---- All reference/example photos (from REFERENCE_PHOTOS in index.html) ----
const REFERENCE_PHOTO_ASSETS = [
  'https://raw.githubusercontent.com/kshitij435/cattle/main/ref_flank_left.jpg',
  'https://raw.githubusercontent.com/kshitij435/cattle/main/ref_flank_right.jpg',
  'https://raw.githubusercontent.com/kshitij435/cattle/main/ref_head_left.jpg',
  'https://raw.githubusercontent.com/kshitij435/cattle/main/ref_head_right.jpg',
  'https://raw.githubusercontent.com/kshitij435/cattle/main/ref_muzzle.png',
  'https://raw.githubusercontent.com/kshitij435/cattle/main/ref_ear_tag.png',
  'https://raw.githubusercontent.com/kshitij435/cattle/main/ref_scar_injury.png',
  'https://raw.githubusercontent.com/kshitij435/cattle/main/ref_flank_live_left.jpg',
  'https://raw.githubusercontent.com/kshitij435/cattle/main/ref_flank_live_right.jpg',
  'https://raw.githubusercontent.com/kshitij435/cattle/main/ref_front_view_live.jpg',
  'https://raw.githubusercontent.com/kshitij435/cattle/main/ref_rear_view_live.jpg',
  'https://raw.githubusercontent.com/kshitij435/cattle/main/ref_muzzle_live.png',
  'https://raw.githubusercontent.com/kshitij435/cattle/main/ref_owner_photo_live.jpg',
];

const PRECACHE_ASSETS = [
  ...SHELL_ASSETS,
  ...CDN_ASSETS,
  ...MODEL_ASSETS,
  ...REFERENCE_PHOTO_ASSETS,
];

// Origins it's safe/useful to cache-as-we-go at runtime. onnxruntime-web
// dynamically fetches its .wasm binaries from jsdelivr AFTER ort.min.js
// runs (the exact wasm filename depends on the resolved package version,
// so it can't be listed above by name) — this is a known gotcha: without
// runtime-caching this origin, the app would look fully cached but still
// silently fail offline the moment it tries to actually run a model.
const RUNTIME_CACHE_ORIGINS = [
  'cdn.jsdelivr.net',
  'raw.githubusercontent.com',
];

// =========================================================================
// INSTALL — precache everything. Uses allSettled + individual reload-fetch
// (not cache.addAll) so one flaky/missing asset doesn't abort the whole
// install — we log failures instead of failing silently or fully.
// =========================================================================
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const results = await Promise.allSettled(
      PRECACHE_ASSETS.map(async (url) => {
        const req = new Request(url, { cache: 'reload', mode: 'cors' });
        const resp = await fetch(req);
        if (!resp.ok && resp.type !== 'opaque') {
          throw new Error(`Bad response ${resp.status} for ${url}`);
        }
        await cache.put(url, resp);
      })
    );
    const failed = results
      .map((r, i) => (r.status === 'rejected' ? PRECACHE_ASSETS[i] : null))
      .filter(Boolean);
    if (failed.length) {
      console.warn('[sw] Some assets failed to precache (will retry at runtime):', failed);
    }
    self.skipWaiting();
  })());
});

// =========================================================================
// ACTIVATE — delete any cache from a previous CACHE_VERSION.
// =========================================================================
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n.startsWith('cattle-claim-') && n !== CACHE_NAME)
        .map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

// =========================================================================
// FETCH
//   - Navigations (the HTML page itself): network-first, falling back to
//     the cached shell when offline, so online users still get app updates
//     immediately without waiting for a new CACHE_VERSION.
//   - Everything else we control (CDN libs, models, reference photos):
//     cache-first, since these are large/static and shouldn't be
//     re-downloaded on every load.
//   - Runtime-cache origins (jsdelivr, raw.githubusercontent.com) not
//     already in PRECACHE_ASSETS: cache-first, caching on first successful
//     fetch — covers onnxruntime-web's dynamically-fetched .wasm files.
//   - Anything else (e.g. nominatim.openstreetmap.org reverse geocoding):
//     left alone, network-only, no caching — that data is inherently
//     online-only and index.html already handles it failing gracefully.
// =========================================================================
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1. Page navigations — network-first, and critically bypasses the
  //    browser's own HTTP cache (not just our SW cache) via {cache:
  //    'no-store'}. Without this, GitHub Pages' Cache-Control headers can
  //    make the browser silently reuse a stale HTML response for several
  //    minutes even though this handler IS trying to fetch fresh — the
  //    plain `fetch(req)` below was still subject to normal HTTP caching
  //    rules, which is exactly the kind of stale-reload issue that made
  //    earlier fixes look like they "didn't take" when they actually had.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: 'no-store' });
        const cache = await caches.open(CACHE_NAME);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch (err) {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match('./index.html')) || (await cache.match('./'));
      }
    })());
    return;
  }

  // 2. Precached + runtime-cacheable origins: cache-first
  const isSameOrigin = url.origin === self.location.origin;
  const isRuntimeOrigin = RUNTIME_CACHE_ORIGINS.includes(url.hostname);
  if (isSameOrigin || isRuntimeOrigin) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req, { ignoreVary: true });
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        if (fresh.ok || fresh.type === 'opaque') {
          cache.put(req, fresh.clone());
        }
        return fresh;
      } catch (err) {
        // Not cached and no network — nothing we can do for this asset.
        return new Response('', { status: 504, statusText: 'Offline and not cached' });
      }
    })());
    return;
  }

  // 3. Everything else (nominatim, maps links, etc.) — network only.
});
