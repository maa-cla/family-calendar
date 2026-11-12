// オフラインでもアプリ本体が開けるようにキャッシュするサービスワーカー
// オンライン時は常に最新版を取得し、オフライン（または通信が遅い）時だけ保存版を使う
const VERSION = 'fc-v3';
const SHELL = ['./', './index.html', './style.css', './app.js', './manifest.webmanifest',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // Google・天気APIはアプリ側で保存
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const fromCache = async () => (await cache.match(req, { ignoreSearch: true })) ||
      (req.mode === 'navigate' ? await cache.match('./index.html') : null);
    const network = fetch(req, { cache: 'no-cache' }).then(res => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    });
    try {
      // 4秒以内に返ってこなければ保存版を表示（裏で最新版の保存は続ける）
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000));
      return await Promise.race([network, timeout]);
    } catch (err) {
      e.waitUntil(network.catch(() => null));
      return (await fromCache()) ||
        new Response('オフラインです', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
