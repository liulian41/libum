// ============================================================
// Libum Service Worker
// 通知展示 + 点击跳转 + 后台定期检查未读
// ============================================================

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

// ------------------------------------------------------------
// 激活：接管页面 + 健壮注册周期同步
// ------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try { await self.clients.claim(); } catch (e) {}

    // 周期后台同步（仅部分浏览器支持，且受参与度门槛限制）
    try {
      if ('periodicSync' in self.registration) {
        try {
          const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
          if (status.state === 'granted') {
            await self.registration.periodicSync.register('libum-check', {
              minInterval: 15 * 60 * 1000
            });
          }
        } catch (e) {
          console.log('[SW] PeriodicSync 注册失败或未授权:', e);
        }
      }
    } catch (e) {}
  })());
});

// ------------------------------------------------------------
// 主线程消息：展示通知 / 检查未读
// ------------------------------------------------------------
self.addEventListener('message', (event) => {
  const d = event.data || {};

  // 展示通知（核心通道，支持 vibrate / renotify / data）
  if (d.type === 'SHOW_NOTIFICATION') {
    event.waitUntil(
      self.registration.showNotification(d.title || 'Libum', {
        body: d.body || '',
        icon: d.icon || undefined,
        badge: d.badge || undefined,
        tag: d.tag || 'libum-msg',
        renotify: !!d.renotify,
        requireInteraction: !!d.requireInteraction,
        silent: !!d.silent,
        vibrate: Array.isArray(d.vibrate) ? d.vibrate : [80, 40, 80],
        data: d.data || {}
      }).catch(err => console.warn('[SW] showNotification failed:', err))
    );
  }

  // 主线程要求检查未读（切后台时调用）
  if (d.type === 'CHECK_UNREAD') {
    event.waitUntil(checkUnreadAndNotify());
  }
});

// ------------------------------------------------------------
// 定期后台同步：浏览器周期性唤醒 SW 检查未读
// ------------------------------------------------------------
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'libum-check') {
    event.waitUntil(checkUnreadAndNotify());
  }
});

// ------------------------------------------------------------
// 一次性后台同步：切后台时注册，浏览器恢复网络/合适时机唤醒
// ------------------------------------------------------------
self.addEventListener('sync', (event) => {
  if (event.tag === 'libum-check') {
    event.waitUntil(checkUnreadAndNotify());
  }
});

// 通知节流：避免周期唤醒时重复轰炸同一条提醒
let __lastNotifTime = 0;

function canNotify() {
  try {
    if (!('Notification' in self)) return false;
    return Notification.permission === 'granted';
  } catch (e) { return false; }
}

async function checkUnreadAndNotify() {
  try {
    if (!canNotify()) return;

    // 5 分钟内不重复提醒
    const now = Date.now();
    if (now - __lastNotifTime < 5 * 60 * 1000) return;

    const db = await openLibumDB();
    if (!db) return;
    const state = await readLibumState(db);
    if (!state) return;

    let unreadCount = 0;
    let lastCid = null;
    let lastContact = null;
    if (state.unread && state.unread.chats) {
      for (const cid in state.unread.chats) {
        const n = state.unread.chats[cid] || 0;
        unreadCount += n;
        if (n > 0) {
          lastCid = cid;
          const c = (state.contacts || []).find(x => x.id === cid);
          if (c) lastContact = c;
        }
      }
    }
    if (unreadCount > 0 && lastContact) {
      __lastNotifTime = now;
      await self.registration.showNotification('Libum 有新消息', {
        body: `${lastContact.name} 给你发来了消息`,
        tag: 'libum-periodic',
        renotify: true,
        vibrate: [80, 40, 80],
        data: { cid: lastCid }
      });
    }
  } catch (e) {
    console.warn('[SW] checkUnread error:', e);
  }
}

function openLibumDB() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('libum_store', 1);
      req.onupgradeneeded = () => {
        try {
          if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv');
        } catch (e) {}
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      setTimeout(() => resolve(null), 3000);
    } catch (e) { resolve(null); }
  });
}

function readLibumState(db) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('kv', 'readonly');
      const r = tx.objectStore('kv').get('libum_data');
      r.onsuccess = () => {
        if (!r.result) return resolve(null);
        try {
          const d = JSON.parse(r.result);
          if (d && d.state) {
            // v2 格式：{ state, assets, savedAt }，assets 这里不展开，只读 unread/contacts
            const packed = d.state;
            const walk = (v) => {
              if (Array.isArray(v)) return v.map(walk);
              if (v && typeof v === 'object') {
                const o = {};
                for (const k in v) o[k] = walk(v[k]);
                return o;
              }
              return v;
            };
            resolve(walk(packed));
          } else {
            resolve(d.state || d);
          }
        } catch (e) { resolve(null); }
      };
      r.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}

// ------------------------------------------------------------
// 点击通知 → 聚焦窗口 / 跳聊天
// ------------------------------------------------------------
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const cid = data.cid || null;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          try { client.postMessage({ type: 'OPEN_CHAT', cid: cid }); } catch (e) {}
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        const url = cid ? ('./#chat=' + encodeURIComponent(cid)) : './';
        return self.clients.openWindow(url);
      }
    })
  );
});