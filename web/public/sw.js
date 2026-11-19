// Service worker do Wescc Chat: deixa o app instalável e mostra as notificações push com o chat fechado.
// Não guarda o app em cache (ele precisa do servidor para funcionar e assim nunca fica com versão velha). Guarda só
// a página offline.html, mostrada quando o servidor não responde ao abrir o app ou recarregar a página.

const OFFLINE_CACHE = 'wescc-offline-v1'; // mudou a offline.html? troque o número para os navegadores buscarem de novo
const OFFLINE_URL = '/offline.html';

// Sem a página guardada (servidor fora na instalação) o service worker instala do mesmo jeito: o push não depende dela.
const cacheOffline = () =>
  caches
    .open(OFFLINE_CACHE)
    .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: 'reload' })))
    .catch(() => {});

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(cacheOffline());
});
self.addEventListener('activate', (event) =>
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith('wescc-offline-') && key !== OFFLINE_CACHE) await caches.delete(key);
      if (!(await caches.match(OFFLINE_URL))) await cacheOffline();
      // A abertura da página não espera o service worker acordar (o pedido vai à rede ao mesmo tempo).
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => {});
      await self.clients.claim();
    })(),
  ),
);

// Só a abertura de páginas (GET): se a rede falhar, a página offline no lugar do erro do navegador.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.mode !== 'navigate' || req.method !== 'GET') return;
  event.respondWith(
    (async () => {
      try {
        const preload = await event.preloadResponse;
        if (preload) return preload;
        return await fetch(req);
      } catch {
        return (await caches.match(OFFLINE_URL)) || Response.error();
      }
    })(),
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Wescc Chat', body: event.data ? event.data.text() : '' };
  }
  const url = typeof data.url === 'string' && data.url.startsWith('/') && !data.url.startsWith('//') ? data.url : '/home';
  event.waitUntil(
    self.registration.showNotification(data.title || 'Wescc Chat', {
      body: data.body || '',
      tag: data.tag || undefined,
      renotify: !!data.tag,
      icon: '/icons/icon-192.png',
      // Selo da barra de status do Android: só o alfa conta, por isso o símbolo branco sem fundo.
      badge: '/icons/badge-96.png',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/home', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        if ('navigate' in open) return open.navigate(url);
        return undefined;
      }
      return self.clients.openWindow(url);
    })(),
  );
});
