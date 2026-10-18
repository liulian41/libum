// ============================================================
// Libum Service Worker Ultimate (v4.0)
// ============================================================

const CACHE_NAME = 'libum-cache-v4.0';
const PSYNC_SNAP_KEY = 'libum_snap';
const PSYNC_QUEUE_KEY = 'libum_queue';
const PSYNC_TAG = 'libum-offline-msg';

// 内置高亮图标，防止系统因资源缺失拒绝弹窗
const NOTIF_ICON = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="20" fill="#a58cf0"/><text x="48" y="62" font-size="42" fill="#fff" text-anchor="middle" font-family="sans-serif" font-weight="bold">L</text></svg>');

// 需要极致缓存的静态资源（确保秒开）
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// --- 1. 安装阶段：预缓存静态资源，接管控制权 ---
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // 容错预缓存：就算某个资源 404 也不影响整体安装
      return Promise.allSettled(
        PRECACHE_ASSETS.map(url => cache.add(url).catch(() => {}))
      );
    })
  );
});

// --- 2. 激活阶段：清理旧缓存，注册定时唤醒 ---
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try { await self.clients.claim(); } catch (e) {}
    
    // 清理老版本缓存
    const keys = await caches.keys();
    await Promise.all(keys.map(k => { if (k !== CACHE_NAME) return caches.delete(k); }));

    // 注册系统级定时唤醒 (仅安卓支持)
    if ('periodicSync' in self.registration) {
      try {
        const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
        if (status.state === 'granted') {
          // 最低15分钟唤醒一次
          await self.registration.periodicSync.register(PSYNC_TAG, { minInterval: 15 * 60 * 1000 });
        }
      } catch (e) {}
    }
  })());
});

// --- 3. 极速网络拦截：Stale-While-Revalidate 策略 ---
// 优先从缓存拿（秒开），同时后台悄悄去网络拉最新的，下次生效。
self.addEventListener('fetch', (event) => {
  const req = event.request;
  
  // 只拦截 GET 请求，且忽略本地调试或特殊协议
  if (req.method !== 'GET' || !req.url.startsWith('http')) return;
  
  // 如果有实时动态数据（比如 API），不拦截，直接走网络
  if (req.url.includes('/api/') || req.url.includes('web3forms')) return;

  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      const fetchPromise = fetch(req).then((networkResponse) => {
        // 只要网络返回正常，就更新缓存
        if (networkResponse && networkResponse.status === 200) {
          const cacheCopy = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, cacheCopy));
        }
        return networkResponse;
      }).catch(() => {
        // 断网状态下的兜底，如果有 HTML 请求，返回缓存的 index.html
        if (req.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });

      // 有缓存用缓存（秒开），没有等网络
      return cachedResponse || fetchPromise;
    })
  );
});

// --- 4. 系统定时唤醒 (Periodic Sync) ---
self.addEventListener('periodicsync', function (e) {
  if (e.tag !== PSYNC_TAG) return;
  e.waitUntil((async function () {
    const snap = await idbGet(PSYNC_SNAP_KEY);
    if (!snap || !Array.isArray(snap.texts) || !snap.texts.length) return;
    
    const pick = snap.texts[Math.floor(Math.random() * snap.texts.length)];
    const text = pick && pick.t ? String(pick.t) : '';
    if (!text) return;

    // 写入待同步队列，等用户打开网页时爆发补偿
    let arr = [];
    try { const q = await idbGet(PSYNC_QUEUE_KEY); if (Array.isArray(q)) arr = q; } catch (e2) {}
    arr.push({ t: text, cid: snap.cid || 'default', ts: Date.now(), k: pick.k || '' });
    while (arr.length > 50) arr.shift(); // 限制队列长度防爆
    await idbSet(PSYNC_QUEUE_KEY, arr);

    // 强制弹窗
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

// --- 5. 接收主线程消息 (接管 LibumEngine 发出的通知) ---
self.addEventListener('message', (event) => {
  const d = event.data || {};
  
  // 主线程要求显示通知
  if (d.type === 'SHOW_NOTIFICATION') {
    event.waitUntil(
      (async () => {
        try {
          // 清除旧通知，避免同 tag 静默替换导致不亮屏
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
  
  // 主线程要求跳过等待，立即接管
  if (d.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// --- 6. 预留：真实 Web Push (极强扩展) ---
// 如果你未来接了后端推送，这里可以直接接管
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

// --- 7. 点击通知：狂暴拉起网页，并精准跳转 ---
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  const data = e.notification.data || {};
  const cid = data.cid || null;

  e.waitUntil((async function () {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    
    if (cs && cs.length) {
      // 网页已经在后台运行，直接叫醒它
      const c = cs[0];
      try { await c.focus(); } catch (x) {}
      // 发送消息让主程序处理跳转
      try { c.postMessage({ type: 'MOCHI_NOTIFY_CLICK', cid: cid, data: data }); } catch (x) {}
      return;
    }
    
    // 网页没运行，直接通过 URL 参数拉起（需要主程序配合解析）
    if (self.clients.openWindow) {
      try { 
        const url = cid ? ('./?page=chatRoom&id=' + encodeURIComponent(cid)) : './';
        await self.clients.openWindow(url); 
      } catch (x) {}
    }
  })());
});

// --- IDB 极致封装 (给 periodicSync 用的) ---
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