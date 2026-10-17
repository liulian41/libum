// ============================================================
// Libum Service Worker
// 通知展示 + 点击跳转 + 后台定期检查未读
// ============================================================

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
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

async function checkUnreadAndNotify() {
  try {
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
          resolve(d.state || d);
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