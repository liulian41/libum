// ============================================================
// Libum Service Worker
// ============================================================

const CACHE_NAME = 'libum-v2.1.9';
const PSYNC_SNAP_KEY = 'libum_snap';
const PSYNC_QUEUE_KEY = 'libum_queue';
const PSYNC_TAG = 'libum-offline-msg';
const PSYNC_SNAP_TTL = 7 * 24 * 60 * 60 * 1000;

const NOTIF_ICON = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="20" fill="#a58cf0"/><text x="48" y="62" font-size="42" fill="#fff" text-anchor="middle" font-family="sans-serif" font-weight="bold">L</text></svg>');

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try { await self.clients.claim(); } catch (e) {}
    try {
      if ('periodicSync' in self.registration) {
        try {
          const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
          if (status.state === 'granted') {
            await self.registration.periodicSync.register(PSYNC_TAG, {
              minInterval: 60 * 60 * 1000
            });
          }
        } catch (e) { console.log('[SW] PeriodicSync 注册失败'); }
      }
    } catch (e) {}
  })());
});

// 后台周期性唤醒
self.addEventListener('periodicsync', function (e) {
  if (e.tag !== PSYNC_TAG) return;
  e.waitUntil((async function () {
    const snap = await idbGet(PSYNC_SNAP_KEY);
    if (!snap || !Array.isArray(snap.texts) || !snap.texts.length) return;
    if (!snap.ts || Date.now() - snap.ts > PSYNC_SNAP_TTL) return;

    const pick = snap.texts[Math.floor(Math.random() * snap.texts.length)];
    const text = pick && pick.t ? String(pick.t) : '';
    if (!text) return;

    let arr = [];
    try { const q = await idbGet(PSYNC_QUEUE_KEY); if (Array.isArray(q)) arr = q; } catch (e2) {}
    arr.push({ t: text, cid: snap.cid || 'default', ts: Date.now(), k: pick.k || '' });
    while (arr.length > 20) arr.shift();
    await idbSet(PSYNC_QUEUE_KEY, arr);

    await self.registration.showNotification(snap.name || 'Libum', {
      body: text,
      tag: PSYNC_TAG,
      renotify: true,
      icon: NOTIF_ICON,
      badge: NOTIF_ICON,
      vibrate: [200, 100, 200],
      data: { cid: snap.cid || 'default' }
    });
  })().catch(function () {}));
});

// 页面消息
self.addEventListener('message', (event) => {
  const d = event.data || {};
  if (d.type === 'SHOW_NOTIFICATION') {
    event.waitUntil(
      self.registration.showNotification(d.title || 'Libum', {
        body: d.body || '',
        icon: d.icon || NOTIF_ICON,
        badge: d.badge || NOTIF_ICON,
        tag: d.tag || 'libum-msg',
        renotify: true,
        data: d.data || {},
        vibrate: d.vibrate || [80, 40, 80],
        requireInteraction: !!d.requireInteraction
      }).catch(err => console.warn('[SW] showNotification failed:', err))
    );
  }
  if (d.type === 'CHECK_UNREAD') {
    event.waitUntil(checkUnreadAndNotify());
  }
});

// 点击通知：有窗口只 postMessage，无窗口写 IDB 后 openWindow
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  const tag = (e.notification && e.notification.tag) || '';
  const data = e.notification.data || {};
  const cid = data.cid || null;

  e.waitUntil((async function () {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (cs && cs.length) {
      const c = cs[0];
      try { await c.focus(); } catch (x) {}
      try { c.postMessage({ type: 'MOCHI_NOTIFY_CLICK', cid: cid }); } catch (x) {}
      return;
    }
    if (tag || cid) {
      try { await idbSet('libum_notify_click', JSON.stringify({ tag, cid, ts: Date.now() })); } catch (x) {}
    }
    if (self.clients.openWindow) {
      const url = cid ? ('./#chat=' + encodeURIComponent(cid)) : './';
      try { await self.clients.openWindow(url); } catch (x) {}
    }
  })());
});

// --- IDB 封装 ---
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('libum_store', 1);
    req.onupgradeneeded = () => {
      try { if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv'); } catch (e) {}
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbGet(key) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly');
    const rq = tx.objectStore('kv').get(key);
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  }));
}
function idbSet(key, val) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  }));
}

async function checkUnreadAndNotify() {
  try {
    if (!('Notification' in self) || Notification.permission !== 'granted') return;
  } catch (e) {}
}