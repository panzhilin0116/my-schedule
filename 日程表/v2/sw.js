const CACHE = 'schedule-v6';
// 预缓存只放"壳"：图片/文字导入的自有模块都在列；
// vendor/tesseract 约 10MB 不进清单（没用到图片功能的访客不该被迫下载），
// 由下方 fetch 事件运行时缓存：首用后离线可复用。
const ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/main.js',
  '/lib/dom.js',
  '/lib/feedback.js',
  '/lib/router.js',
  '/lib/space.js',
  '/lib/store.js',
  '/lib/courseStore.js',
  '/lib/time.js',
  '/lib/weeks.js',
  '/lib/import/tokenize.js',
  '/lib/import/parseText.js',
  '/lib/import/imageHandler.js',
  '/lib/import/ocr.js',
  '/lib/import/preprocess.js',
  '/lib/import/grid.js',
  '/views/home.js',
  '/views/tasks.js',
  '/views/timetable.js',
  '/components/courseDetail.js',
  '/components/courseForm.js',
  '/components/emptyState.js',
  '/components/importOverlay.js',
  '/components/miniCalendar.js',
  '/components/taskForm.js',
  '/data/semester.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
      if (r.ok && e.request.url.startsWith(self.location.origin)) {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return r;
    }))
  );
});
