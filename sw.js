'use strict';

/* ==========================================================================
 * 后台代班 Service Worker
 * --------------------------------------------------------------------------
 * 职责：
 *   1. 主线程切后台前，把未来 5 分钟内的任务用 postMessage 交接过来
 *      message = { type: 'SCHEDULE_TASKS', tasks: [...] }
 *   2. 用 setTimeout + event.waitUntil 把 SW 保活，到点延时触发
 *   3. 触发时先把消息写入 IndexedDB 队列，再弹系统通知
 *   4. Cache-First 缓存，避免切回前台白屏
 *
 * 可靠性说明：
 *   浏览器会对后台 SW 的 setTimeout 做节流，并可能在几十秒后终止 SW，
 *   waitUntil 最长也只能保活约 5 分钟。因此这套“交接 + 定时器”方案
 *   适合未来 1~2 分钟内、最多 5 分钟内的提醒。要更久或更稳定，
 *   请启用 showLibumNotification 里的原生延时通知，或改用推送。
 * ========================================================================== */

const DB_NAME      = 'pwa_kv_store';
const DB_VERSION   = 1;
const STORE_NAME   = 'kv';
const STATIC_CACHE = 'pwa-static-v1';

const FALLBACK_ICON = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">' +
  '<rect width="96" height="96" rx="20" fill="#5b7cfa"/>' +
  '<text x="48" y="62" font-size="42" fill="#fff" text-anchor="middle" ' +
  'font-family="sans-serif" font-weight="bold">✓</text></svg>'
);

const HORIZON_MS   = 5 * 60 * 1000;        // 只接收未来 5 分钟内的任务
const DONE_KEEP_MS = 24 * 3600 * 1000;     // 已完成任务保留 24h，用于去重
const QUEUE_LIMIT  = 200;

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

async function loadJSON(key, fallback) {
  const raw = await idbGet(key);
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}

async function loadTasks() { return loadJSON('tasks', []); }
async function saveTasks(tasks) { return idbSet('tasks', tasks); }

async function loadQueue() { return loadJSON('queue', []); }
async function pushQueue(item) {
  const q = await loadQueue();
  if (q.some(x => x && x.id === item.id)) return true; // 幂等去重
  q.push(item);
  while (q.length > QUEUE_LIMIT) q.shift();
  return idbSet('queue', q);
}

/* ============================ 通知 ======================================= */

// 原生延时通知：不依赖 SW 存活，浏览器到点自动弹出，最可靠
function supportsTrigger() {
  try { return !!(self.NotificationTrigger && self.TimestampTrigger); } catch (e) { return false; }
}

async function showLibumNotification(title, body, tag, data, fireAt) {
  const opts = {
    body: body || '你有新消息',
    icon: FALLBACK_ICON,
    badge: FALLBACK_ICON,
    tag: tag || ('pwa-' + Date.now()),
    renotify: true,
    vibrate: [80, 40, 80],
    data: data || {},
    requireInteraction: true
  };
  // 传入未来时间且浏览器支持时，用系统原生延时通知
  if (fireAt && supportsTrigger()) {
    opts.showTrigger = new self.TimestampTrigger(fireAt);
  }
  try {
    await self.registration.showNotification(title || '提醒', opts);
    return true;
  } catch (e) {
    // 部分浏览器不支持 showTrigger，去掉后走普通通知
    try {
      const { showTrigger, ...plain } = opts;
      await self.registration.showNotification(title || '提醒', plain);
      return true;
    } catch (e2) { return false; }
  }
}

/* ============================ 任务调度 =================================== */

const timers = new Map(); // taskId -> setTimeout 句柄
const locks  = new Map(); // taskId -> resolve，用于 waitUntil 保活

function releaseLock(id) {
  const t = timers.get(id); if (t) { clearTimeout(t); timers.delete(id); }
  const l = locks.get(id);  if (l) { locks.delete(id); try { l(); } catch (e) {} }
}

async function fireTask(task) {
  if (!task || !task.id) return;
  const tasks = await loadTasks();
  const cur = tasks.find(t => t.id === task.id);
  if (!cur || cur.done) { releaseLock(task.id); return; }

  const now = Date.now();
  const d = task.data || {};

  // 1) 先把消息写进队列，用户打开页面后一定能看到
  if (d.cid) {
    await pushQueue({ id: task.id, cid: d.cid, text: task.body || '', ts: now, tag: task.tag || '' });
  }
  // 2) 弹系统通知
  await showLibumNotification(task.title || '提醒', task.body || '你有新消息', task.tag, d);

  // 3) 标记完成，避免重复触发
  const idx = tasks.findIndex(t => t.id === task.id);
  if (idx >= 0) { tasks[idx].done = true; tasks[idx].doneAt = now; await saveTasks(tasks); }
  releaseLock(task.id);
}

// 把单个任务装进 setTimeout，并返回一个只在该任务触发后才 resolve 的 Promise
function armTask(task) {
  if (!task || !task.id || task.done) return null;
  if (timers.has(task.id)) return null;
  const delay = task.fireAt - Date.now();
  if (delay > HORIZON_MS || delay < 0) return null;

  return new Promise(resolve => {
    locks.set(task.id, resolve);
    const timer = setTimeout(() => { fireTask(task); }, delay);
    timers.set(task.id, timer);
  });
}

async function handleSchedule(incoming) {
  const now = Date.now();
  const existing = await loadTasks();
  const map = new Map(existing.map(t => [t.id, t]));

  for (const t of incoming || []) {
    if (!t || !t.id || !t.fireAt) continue;
    if (t.fireAt > now + HORIZON_MS) continue; // 只接管未来 5 分钟内
    const old = map.get(t.id);
    if (old && old.done && t.fireAt > (old.doneAt || 0)) {
      map.set(t.id, Object.assign({}, t, { done: false, scheduledAt: now }));
    } else if (old && old.done) {
      continue; // 已触发过，跳过
    } else {
      map.set(t.id, Object.assign({}, t, { done: false, scheduledAt: now }));
    }
  }

  const all = Array.from(map.values()).filter(t => {
    if (t.done) return now - (t.doneAt || t.fireAt) < DONE_KEEP_MS;
    return true;
  });
  await saveTasks(all);

  // 关键：waitUntil 保活，直到所有已交接任务触发完毕
  const pending = [];
  for (const t of all) { if (t.done) continue; const p = armTask(t); if (p) pending.push(p); }
  if (pending.length) await Promise.all(pending);
}

// SW 被唤醒时补跑：把漏掉的、已到点的任务触发掉
async function recover() {
  const tasks = await loadTasks();
  const now = Date.now();
  const pending = [];
  for (const t of tasks) {
    if (t.done) continue;
    if (t.fireAt <= now) { fireTask(t); continue; }
    const p = armTask(t); if (p) pending.push(p);
  }
  if (pending.length) await Promise.all(pending);
}

async function cancelTasks(ids) {
  let tasks = await loadTasks();
  let changed = false;
  tasks = tasks.filter(t => {
    if (!ids.includes(t.id)) return true;
    if (t.done) return true;
    releaseLock(t.id); changed = true; return false;
  });
  if (changed) await saveTasks(tasks);
}

/* ============================ 事件绑定 =================================== */

self.addEventListener('message', (event) => {
  const d = event.data || {};
  if (d.type === 'SCHEDULE_TASKS' && Array.isArray(d.tasks)) {
    event.waitUntil(handleSchedule(d.tasks));
    return;
  }
  if (d.type === 'PING_SW') { event.waitUntil(recover()); return; }
  if (d.type === 'CANCEL_TASKS' && Array.isArray(d.ids)) { event.waitUntil(cancelTasks(d.ids)); return; }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = (event.notification && event.notification.data) || {};
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins && wins.length) {
      const w = wins[0];
      try { await w.focus(); } catch (e) {}
      try { w.postMessage({ type: 'OPEN_TARGET', cid: data.cid, msgId: data.msgId }); } catch (e) {}
      return;
    }
    const url = data.cid ? './index.html?cid=' + encodeURIComponent(data.cid) : './index.html';
    try { await self.clients.openWindow(url); } catch (e) {}
  })());
});

// 周期性后台同步 / 后台同步：SW 被系统唤醒时补跑任务
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'libum-wake') event.waitUntil(recover());
});
self.addEventListener('sync', (event) => {
  if (event.tag === 'libum-wake') event.waitUntil(recover());
});

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try { await self.clients.claim(); } catch (e) {}
    try { await recover(); } catch (e) {}
  })());
});

/* ============================ 缓存优先 =================================== */

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url; try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(STATIC_CACHE);
    const isHtml = /\.html$/i.test(url.pathname) || url.pathname.endsWith('/');
    if (isHtml) {
      const cached = await cache.match(req);
      if (cached) {
        fetch(req).then(res => { if (res && res.ok) cache.put(req, res); }).catch(() => {});
        return cached;
      }
    }
    try {
      const res = await fetch(req);
      if (res && res.ok) { try { cache.put(req, res.clone()); } catch (e) {} }
      return res;
    } catch (e) {
      const cached = await cache.match(req);
      if (cached) return cached;
      throw e;
    }
  })());
});
