const CACHE = 'schedule-v4';
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
  '/views/home.js',
  '/views/tasks.js',
  '/views/timetable.js',
  '/components/courseDetail.js',
  '/components/courseForm.js',
  '/components/emptyState.js',
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
