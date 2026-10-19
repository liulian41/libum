// ============================================================
// Libum Service Worker Ultimate (v4.1)
// ============================================================

const CACHE_NAME = 'libum-cache-v4.1';
const PSYNC_SNAP_KEY = 'libum_snap';
const PSYNC_QUEUE_KEY = 'libum_queue';
const PSYNC_TAG = 'libum-offline-msg';

const NOTIF_ICON = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="20" fill="#a58cf0"/><text x="48" y="62" font-size="42" fill="#fff" text-anchor="middle" font-family="sans-serif" font-weight="bold">L</text></svg>');

const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(
        PRECACHE_ASSETS.map(url => cache.add(url).catch(() => {}))
      );
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try { await self.clients.claim(); } catch (e) {}
    const keys = await caches.keys();
    await Promise.all(keys.map(k => { if (k !== CACHE_NAME) return caches.delete(k); }));
    if ('periodicSync' in self.registration) {
      try {
        const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
        if (status.state === 'granted') {
          await self.registration.periodicSync.register(PSYNC_TAG, { minInterval: 15 * 60 * 1000 });
        }
      } catch (e) {}
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || !req.url.startsWith('http')) return;
  if (req.url.includes('/api/') || req.url.includes('web3forms')) return;

  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      const fetchPromise = fetch(req).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const cacheCopy = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, cacheCopy));
        }
        return networkResponse;
      }).catch(() => {
        if (req.mode === 'navigate') return caches.match('./index.html');
      });
      return cachedResponse || fetchPromise;
    })
  );
});

self.addEventListener('periodicsync', function (e) {
  if (e.tag !== PSYNC_TAG) return;
  e.waitUntil((async function () {
    const snap = await idbGet(PSYNC_SNAP_KEY);
    if (!snap || !Array.isArray(snap.texts) || !snap.texts.length) return;
    const pick = snap.texts[Math.floor(Math.random() * snap.texts.length)];
    const text = pick && pick.t ? String(pick.t) : '';
    if (!text) return;
    let arr = [];
    try { const q = await idbGet(PSYNC_QUEUE_KEY); if (Array.isArray(q)) arr = q; } catch (e2) {}
    arr.push({ t: text, cid: snap.cid || 'default', ts: Date.now(), k: pick.k || '' });
    while (arr.length > 50) arr.shift();
    await idbSet(PSYNC_QUEUE_KEY, arr);
    await self.registration.showNotification(snap.name || 'Libum', {
      body: text,
      tag: 'libum-msg-' + Date.now(),
      renotify: true,
      silent: false,
      requireInteraction: true,
      icon: NOTIF_ICON,
      badge: NOTIF_ICON,
      vibrate: [200, 100, 200, 100, 200],
      data: { cid: snap.cid || 'default', type: 'OFFLINE_MSG' }
    });
  })().catch(function () {}));
});

/* ============================================================
 *  定时任务调度（尽力而为版）
 * ============================================================ */
const TASK_KEY     = 'libum_scheduled_tasks';
const TASK_HORIZON = 10 * 60 * 1000;
const MAX_HOLD_MS  = 5 * 60 * 1000;

let __wakePromise = null;
const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));

async function loadTasks() {
  try { const v = await idbGet(TASK_KEY); return Array.isArray(v) ? v : []; }
  catch(e){ return []; }
}
async function saveTasks(list) {
  try { await idbSet(TASK_KEY, list); } catch(e){}
}

async function fireOne(t) {
  try {
    await self.registration.showNotification(t.title || 'Libum', {
      body: t.body || '',
      icon: NOTIF_ICON, badge: NOTIF_ICON,
      tag: t.tag || ('libum-task-' + t.id),
      renotify: true,
      silent: false,
      requireInteraction: false,
      vibrate: [180, 90, 180],
      data: t.data || {}
    });
  } catch(e){}

  try {
    if (t.data && t.data.cid && t.body) {
      let q = [];
      try { const raw = await idbGet(PSYNC_QUEUE_KEY); if (Array.isArray(raw)) q = raw; } catch(e){}
      q.push({ t: t.body, cid: t.data.cid, ts: Date.now(), k: t.id });
      while (q.length > 60) q.shift();
      await idbSet(PSYNC_QUEUE_KEY, q);
    }
  } catch(e){}
}

async function runDueTasks() {
  const now = Date.now();
  const tasks = await loadTasks();
  const due = tasks.filter(t => !t.done && t.fireAt <= now + 1500);
  if (!due.length) return 0;
  for (const t of due) {
    await fireOne(t);
    t.done = true;
    t.firedAt = Date.now();
  }
  await saveTasks(tasks.filter(t => !t.done || (now - (t.firedAt || 0) < TASK_HORIZON)));
  return due.length;
}

function wakeLoop() {
  if (__wakePromise) return __wakePromise;
  __wakePromise = (async () => {
    const started = Date.now();
    try {
      while (Date.now() - started < MAX_HOLD_MS) {
        await runDueTasks();
        const next = (await loadTasks()).filter(t => !t.done).sort((a, b) => a.fireAt - b.fireAt)[0];
        if (!next) return;
        const delay = next.fireAt - Date.now();
        if (delay > 0) await sleep(delay);
      }
    } finally {
      __wakePromise = null;
    }
  })();
  return __wakePromise;
}

/* ============================================================
 *  message 监听
 * ============================================================ */
self.addEventListener('message', (event) => {
  const d = event.data || {};

  /* ===== 新增：接收定时任务 ===== */
  if (d.type === 'SCHEDULE_TASKS') {
    event.waitUntil((async () => {
      const now = Date.now();
      const incoming = (Array.isArray(d.tasks) ? d.tasks : [])
        .filter(t => t && t.fireAt > now && t.fireAt <= now + TASK_HORIZON);
      const existing = await loadTasks();
      const seen = new Set(existing.filter(t => !t.done).map(t => t.id));
      await saveTasks(existing.concat(incoming.filter(t => !seen.has(t.id))));
      await wakeLoop();
    })());
    return;
  }

  /* ===== 新增：取消任务 ===== */
  if (d.type === 'CANCEL_TASKS') {
    event.waitUntil((async () => {
      const ids = new Set(d.ids || []);
      const all = await loadTasks();
      await saveTasks(all.filter(t => !ids.has(t.id)));
    })());
    return;
  }

  /* ===== 新增：催一次补发 ===== */
  if (d.type === 'PING_SW') {
    event.waitUntil(wakeLoop());
    return;
  }

  /* ===== 保留：SHOW_NOTIFICATION ===== */
  if (d.type === 'SHOW_NOTIFICATION') {
    event.waitUntil(
      (async () => {
        try {
          const oldNotifs = await self.registration.getNotifications({ tag: d.tag });
          oldNotifs.forEach(n => n.close());
        } catch(e) {}

        return self.registration.showNotification(d.title || 'Libum', {
          body: d.body || '',
          icon: d.icon || NOTIF_ICON,
          badge: d.badge || NOTIF_ICON,
          tag: d.tag || 'libum-msg-' + Date.now(),
          renotify: true,
          silent: false,
          requireInteraction: true,
          data: d.data || {},
          vibrate: d.vibrate || [200, 100, 200, 100, 200]
        });
      })().catch(err => console.warn('[SW] showNotification failed:', err))
    );
  }

  /* ===== 保留：SKIP_WAITING ===== */
  if (d.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* ===== 保留：Web Push ===== */
self.addEventListener('push', function(event) {
  if (!event.data) return;
  try {
    const data = event.data.json();
    event.waitUntil(
      self.registration.showNotification(data.title || 'Libum', {
        body: data.body || '',
        icon: data.icon || NOTIF_ICON,
        badge: data.badge || NOTIF_ICON,
        tag: data.tag || 'libum-push',
        renotify: true,
        data: data.data || {}
      })
    );
  } catch(e) {}
});

/* ===== 保留：通知点击 ===== */
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  const data = e.notification.data || {};
  const cid = data.cid || null;

  e.waitUntil((async function () {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (cs && cs.length) {
      const c = cs[0];
      try { await c.focus(); } catch (x) {}
      try { c.postMessage({ type: 'MOCHI_NOTIFY_CLICK', cid: cid, data: data }); } catch (x) {}
      return;
    }
    if (self.clients.openWindow) {
      try {
        const url = cid ? ('./?page=chatRoom&id=' + encodeURIComponent(cid)) : './';
        await self.clients.openWindow(url);
      } catch (x) {}
    }
  })());
});

/* ===== IDB 封装 ===== */
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