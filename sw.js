'use strict';

/* ==========================================================================
 * Libum Service Worker (强化缓存秒开版 + 后台代班补发)
 * ========================================================================== */

const DB_NAME        = 'libum_store';
const DB_VERSION     = 1;
const STORE_NAME     = 'kv';
const STATIC_CACHE   = 'libum-static-v6'; // 版本号升级

const FALLBACK_ICON  = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">' +
  '<rect width="96" height="96" rx="20" fill="#a58cf0"/>' +
  '<text x="48" y="62" font-size="42" fill="#fff" text-anchor="middle" ' +
  'font-family="sans-serif" font-weight="bold">L</text></svg>'
);
const NOTIF_ICON     = FALLBACK_ICON;

const HORIZON_MS     = 2 * 3600 * 1000;
const ARM_WINDOW_MS  = 5 * 60 * 1000;
const DONE_KEEP_MS   = 24 * 3600 * 1000;
const TASK_KEEP_MS   = 7  * 24 * 3600 * 1000;
const QUEUE_LIMIT    = 200;

/* ============================ IndexedDB ================================== */

let __dbPromise = null;
function openDB() {
  if (__dbPromise) return __dbPromise;
  __dbPromise = new Promise((resolve) => {
    try {
      if (!self.indexedDB) { resolve(null); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        try {
          if (!req.result.objectStoreNames.contains(STORE_NAME)) {
            req.result.createObjectStore(STORE_NAME);
          }
        } catch (e) {}
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => resolve(null);
      req.onblocked = () => resolve(null);
      setTimeout(() => resolve(null), 4000);
    } catch (e) { resolve(null); }
  });
  return __dbPromise;
}

async function idbGet(key) {
  const db = await openDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const r  = tx.objectStore(STORE_NAME).get(key);
      r.onsuccess = () => resolve(r.result ?? null);
      r.onerror   = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}

async function idbSet(key, val) {
  const db = await openDB();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(val, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror    = () => resolve(false);
      tx.onabort    = () => resolve(false);
    } catch (e) { resolve(false); }
  });
}

/* ============================ 工具函数 =================================== */

const rnd = (a, b) => a + Math.random() * (b - a);

async function loadJSON(key, fallback) {
  const raw = await idbGet(key);
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}

async function loadTasks() {
  const v = await loadJSON('libum_scheduled_tasks', []);
  return Array.isArray(v) ? v : [];
}
async function saveTasks(tasks) { return idbSet('libum_scheduled_tasks', tasks); }
async function loadQueue() {
  const v = await loadJSON('libum_queue', []);
  return Array.isArray(v) ? v : [];
}
async function pushQueue(item) {
  const q = await loadQueue();
  // 幂等：相同 id 或 (cid+t+ts) 已存在则跳过
  if (q.some(x => x && (x.id === item.id || (x.cid === item.cid && x.t === item.t && Math.abs((x.ts||0)-(item.ts||0)) < 2000)))) {
    return true;
  }
  q.push(item);
  while (q.length > QUEUE_LIMIT) q.shift();
  return idbSet('libum_queue', q);
}

/* ============================ 状态回写 =================================== */

async function bumpChatSetting(cid, key, now) {
  if (!cid) return;
  const raw = await idbGet('libum_data');
  if (!raw) return;
  let data;
  try { data = (typeof raw === 'string') ? JSON.parse(raw) : raw; } catch (e) { return; }
  if (!data || !data.state || typeof data.state !== 'object') return;

  if (!data.state.chatSettings || typeof data.state.chatSettings !== 'object') {
    data.state.chatSettings = {};
  }
  let cs = data.state.chatSettings[cid];
  if (!cs || typeof cs !== 'object') { cs = {}; data.state.chatSettings[cid] = cs; }

  if (key === 'nextAutoMsgTime') {
    const unit = cs.autoMsgUnit || 'hours';
    const mul  = unit === 'minutes' ? 60000 : 3600000;
    const min  = Number(cs.autoMsgMin) || 2;
    const max  = Math.max(min, Number(cs.autoMsgMax) || 6);
    cs.nextAutoMsgTime = now + rnd(min * mul, max * mul);
  } else if (key === 'nextMomentTime') {
    const min = Number(cs.momentMinHours) || 4;
    const max = Math.max(min, Number(cs.momentMaxHours) || 12);
    cs.nextMomentTime = now + rnd(min * 3600000, max * 3600000);
  } else { return; }
  data.savedAt = now;
  await idbSet('libum_data', JSON.stringify(data));
}

/* ============================ 通知 ======================================= */

async function showLibumNotification(title, body, tag, data) {
  const opts = {
    body: body || '有新消息',
    icon: NOTIF_ICON,
    badge: NOTIF_ICON,
    tag: tag || ('libum-' + Date.now()),
    renotify: true,
    vibrate: [80, 40, 80],
    data: data || {},
    requireInteraction: true
  };
  try {
    await self.registration.showNotification(title || 'Libum', opts);
    return true;
  } catch (e) {
    try {
      opts.icon  = FALLBACK_ICON;
      opts.badge = FALLBACK_ICON;
      await self.registration.showNotification(title || 'Libum', opts);
      return true;
    } catch (e2) {
      try {
        await idbSet('libum_notif_fallback', {
          title: title || 'Libum', body: body || '有新消息',
          tag: tag || ('libum-' + Date.now()), data: data || {}, ts: Date.now()
        });
      } catch (e3) {}
      return false;
    }
  }
}

/* ============================================================================
 * 任务调度核心
 * ========================================================================== */

const __inflightTimers = new Map();
const __inflightLocks  = new Map();

async function fireTask(task) {
  if (!task || !task.id) return;

  const tasksNow = await loadTasks();
  const cur = tasksNow.find(t => t.id === task.id);
  if (!cur || cur.done) {
    const lock = __inflightLocks.get(task.id);
    if (lock) { __inflightLocks.delete(task.id); try { lock(); } catch (e) {} }
    const tm = __inflightTimers.get(task.id);
    if (tm) { try { clearTimeout(tm); } catch (e) {} __inflightTimers.delete(task.id); }
    return;
  }

  const now = Date.now();
  const d = task.data || {};

  try {
    /* 关键修复：先把消息写入队列，再发通知。
     * 这样即使通知点击后立刻关闭页面，消息也已经落盘，
     * 打开 App 后一定能看到这条消息，不会出现“点进去没有”。 */
    if (d.type === 'AUTO_MSG' && d.cid) {
      await pushQueue({
        id: task.id, cid: d.cid, type: 'AUTO_MSG',
        t: task.body || '', ts: now, tag: task.tag || ''
      });
      await bumpChatSetting(d.cid, 'nextAutoMsgTime', now);
    }

    await showLibumNotification(
      task.title || 'Libum', task.body || '有新消息',
      task.tag || ('libum-' + task.id), d
    );

    const tasks = await loadTasks();
    const idx = tasks.findIndex(t => t.id === task.id);
    if (idx >= 0) {
      tasks[idx].done = true;
      tasks[idx].doneAt = now;
      await saveTasks(tasks);
    }
  } catch (e) {
    console.warn('[SW] fireTask error:', e);
  } finally {
    const tm = __inflightTimers.get(task.id);
    if (tm) { try { clearTimeout(tm); } catch (e) {} __inflightTimers.delete(task.id); }
    const lock = __inflightLocks.get(task.id);
    if (lock) { __inflightLocks.delete(task.id); try { lock(); } catch (e) {} }
  }
}

function armOne(task) {
  if (!task || !task.id || task.done) return null;
  if (__inflightTimers.has(task.id)) return null;
  const delay = task.fireAt - Date.now();
  if (delay > ARM_WINDOW_MS || delay < 0) return null;

  return new Promise(resolve => {
    __inflightLocks.set(task.id, resolve);
    const timer = setTimeout(() => { fireTask(task); }, Math.max(0, delay));
    __inflightTimers.set(task.id, timer);
  });
}

async function handleSchedule(incoming) {
  const now = Date.now();
  const existing = await loadTasks();
  const map = new Map(existing.map(t => [t.id, t]));

  for (const t of incoming) {
    if (!t || !t.id || !t.fireAt) continue;
    if (t.fireAt > now + HORIZON_MS) continue;
    const old = map.get(t.id);
    if (old && old.fireAt !== t.fireAt) {
      const tm = __inflightTimers.get(t.id);
      if (tm) { try { clearTimeout(tm); } catch (e) {} __inflightTimers.delete(t.id); }
      const lk = __inflightLocks.get(t.id);
      if (lk) { __inflightLocks.delete(t.id); try { lk(); } catch (e) {} }
    }
    if (old && old.done && t.fireAt > (old.doneAt || 0)) {
      map.set(t.id, Object.assign({}, t, { done: false, scheduledAt: now }));
    } else if (old && old.done) {
      continue;
    } else {
      map.set(t.id, Object.assign({}, t, { done: false, scheduledAt: now }));
    }
  }

  const all = Array.from(map.values()).filter(t => {
    if (t.done) return now - (t.doneAt || t.fireAt) < DONE_KEEP_MS;
    return now - t.fireAt < TASK_KEEP_MS;
  });
  await saveTasks(all);

  const promises = [];
  for (const t of all) {
    if (t.done) continue;
    const p = armOne(t);
    if (p) promises.push(p);
  }
  if (promises.length) await Promise.all(promises);
}

async function pingRecover() {
  const tasks = await loadTasks();
  const now = Date.now();
  const promises = [];

  for (const t of tasks) {
    if (t.done) continue;
    if (t.fireAt <= now) {
      fireTask(t).catch(() => {});
      continue;
    }
    const p = armOne(t);
    if (p) promises.push(p);
  }
  if (promises.length) await Promise.all(promises);
}

/* ============================ 事件绑定 =================================== */

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SCHEDULE_TASKS' && Array.isArray(data.tasks)) {
    event.waitUntil(handleSchedule(data.tasks));
    return;
  }
  if (data.type === 'PING_SW') {
    event.waitUntil(pingRecover());
    return;
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = (event.notification && event.notification.data) || {};

  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins && wins.length) {
      const w = wins[0];
      try { await w.focus(); } catch (e) {}
      try { w.postMessage({ type: 'OPEN_CHAT', cid: data.cid, msgId: data.msgId }); } catch (e) {}
      return;
    }
    const url = data.cid
      ? `./index.html?page=chatRoom&id=${encodeURIComponent(data.cid)}`
      : './index.html';
    try { await self.clients.openWindow(url); } catch (e) {}
  })());
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'libum-offline-msg') event.waitUntil(pingRecover());
});
self.addEventListener('sync', (event) => {
  if (event.tag === 'libum-offline-msg') event.waitUntil(pingRecover());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) {}
  event.waitUntil(showLibumNotification(
    payload.title || 'Libum', payload.body || '有新消息',
    payload.tag || 'libum-push', payload.data || {}
  ));
});

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try { await self.clients.claim(); } catch (e) {}
    try { await pingRecover(); } catch (e) {}
  })());
});

/* ============================================================================
 * 缓存优先策略 (Cache-First) 解决切回前台的白屏
 * ========================================================================== */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(STATIC_CACHE);
    
    const isHtml = /\.(html)$/i.test(url.pathname) || url.pathname.endsWith('/');
    
    if (isHtml) {
      const cached = await cache.match(req);
      if (cached) {
        fetch(req).then(res => {
          if (res && res.ok) cache.put(req, res);
        }).catch(()=>{});
        return cached;
      }
    }

    try {
      const res = await fetch(req);
      if (res && res.ok) {
        try { cache.put(req, res.clone()); } catch (e) {}
      }
      return res;
    } catch (e) {
      const cached = await cache.match(req);
      if (cached) return cached;
      throw e;
    }
  })());
});