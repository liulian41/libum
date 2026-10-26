'use strict';

/* ==========================================================================
 * Libum Service Worker
 * --------------------------------------------------------------------------
 * 核心职责（与 index.html 契约）：
 *   1. 后台任务调度  ← 页面 postMessage({type:'SCHEDULE_TASKS', tasks})
 *                      任务持久化在 IDB: libum_scheduled_tasks
 *   2. 到期触发：showNotification + 写 libum_queue
 *   3. 回写 libum_data 中的 nextAutoMsgTime / nextMomentTime / nextLetterTime
 *   4. 通知点击 → 已开窗口 postMessage，否则 openWindow
 *   5. periodicSync(tag:'libum-offline-msg') / push / sync 兜底
 *
 * IDB 结构（与页面共用 libum_store / kv）：
 *   libum_data              ← 页面状态（packed JSON 字符串）
 *   libum_scheduled_tasks   ← SW 待执行任务数组
 *   libum_queue             ← 已触发但页面未读的消息队列
 *   libum_notif_fallback    ← showNotification 失败时的兜底
 * ========================================================================== */

const DB_NAME        = 'libum_store';
const DB_VERSION     = 1;
const STORE_NAME     = 'kv';
const STATIC_CACHE   = 'libum-static-v2';
const NOTIF_ICON     = './icon-192.png';
const FALLBACK_ICON  = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">' +
  '<rect width="96" height="96" rx="20" fill="#a58cf0"/>' +
  '<text x="48" y="62" font-size="42" fill="#fff" text-anchor="middle" ' +
  'font-family="sans-serif" font-weight="bold">L</text></svg>'
);

const HORIZON_MS     = 2 * 3600 * 1000;   // 只接受 2 小时内的任务
const ARM_WINDOW_MS  = 5 * 60 * 1000;     // 5 分钟内会到期的，本次 waitUntil 内 armOne 并等待
const DONE_KEEP_MS   = 24 * 3600 * 1000;  // done 标记保留 1 天，供页面 syncBackFromSW 读取
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

async function idbDelete(key) {
  const db = await openDB();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
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
async function saveTasks(tasks) {
  return idbSet('libum_scheduled_tasks', tasks);
}
async function loadQueue() {
  const v = await loadJSON('libum_queue', []);
  return Array.isArray(v) ? v : [];
}
async function pushQueue(item) {
  const q = await loadQueue();
  q.push(item);
  while (q.length > QUEUE_LIMIT) q.shift();
  return idbSet('libum_queue', q);
}

/* ============================ 状态回写 =================================== */

/**
 * 回写 libum_data 中某个联系人的 next* 时间
 * 只改数值字段，不解包/重打包 assets（数值不涉及 @@asset: 引用）
 */
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
  } else {
    return;
  }
  data.savedAt = now;
  await idbSet('libum_data', JSON.stringify(data));
}

/**
 * 回写 libum_data 全局设置
 */
async function bumpGlobalSetting(key, now) {
  const raw = await idbGet('libum_data');
  if (!raw) return;
  let data;
  try { data = (typeof raw === 'string') ? JSON.parse(raw) : raw; } catch (e) { return; }
  if (!data || !data.state || typeof data.state !== 'object') return;
  const s = data.state.settings;
  if (!s || typeof s !== 'object') return;

  if (key === 'nextLetterTime') {
    const min = Number(s.letterMinHours) || 2;
    const max = Math.max(min, Number(s.letterMaxHours) || 6);
    s.nextLetterTime = now + rnd(min * 3600000, max * 3600000);
  } else if (key === 'nextVisitorTime') {
    // 访客触发页面前台会自己处理，这里保守不写
    return;
  } else {
    return;
  }
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
    // 图标失效 / 权限异常时用内联 SVG 重试
    try {
      opts.icon  = FALLBACK_ICON;
      opts.badge = FALLBACK_ICON;
      await self.registration.showNotification(title || 'Libum', opts);
      return true;
    } catch (e2) {
      // 彻底失败：留给页面下次打开补发
      try {
        await idbSet('libum_notif_fallback', {
          title: title || 'Libum',
          body: body || '有新消息',
          tag: tag || ('libum-' + Date.now()),
          data: data || {},
          ts: Date.now()
        });
      } catch (e3) {}
      return false;
    }
  }
}

/* ============================================================================
 * 任务调度核心
 * ========================================================================== */

/* 内存态：当前在某个事件的 waitUntil 里挂起的任务 */
const __inflightTimers = new Map();   // taskId -> setTimeout handle
const __inflightLocks  = new Map();   // taskId -> resolve（用于释放 waitUntil）

/* ---------------- 触发一个到期任务 ---------------- */
async function fireTask(task) {
  if (!task || !task.id) return;

  /* 二次检查是否已被其他路径（PING_SW / periodicSync）触发过 */
  const tasksNow = await loadTasks();
  const cur = tasksNow.find(t => t.id === task.id);
  if (!cur || cur.done) {
    /* 已做过，直接释放 lock */
    const lock = __inflightLocks.get(task.id);
    if (lock) { __inflightLocks.delete(task.id); try { lock(); } catch (e) {} }
    const tm = __inflightTimers.get(task.id);
    if (tm) { try { clearTimeout(tm); } catch (e) {} __inflightTimers.delete(task.id); }
    return;
  }

  const now = Date.now();
  const d = task.data || {};

  try {
    /* 1) 弹通知（内部已处理图标 fallback） */
    await showLibumNotification(
      task.title || 'Libum',
      task.body || '有新消息',
      task.tag || ('libum-' + task.id),
      d
    );

    /* 2) 按类型处理数据回写 */
    if (d.type === 'AUTO_MSG' && d.cid) {
      /* 聊天消息：写入队列供页面回前台补进聊天，并推进 nextAutoMsgTime */
      await pushQueue({
        id: task.id,
        cid: d.cid,
        type: 'AUTO_MSG',
        t: task.body || '',
        ts: now,
        tag: task.tag || ''
      });
      await bumpChatSetting(d.cid, 'nextAutoMsgTime', now);
    } else if (d.type === 'MOMENT' && d.cid) {
      /* 朋友圈：只弹通知。回前台后主线程 tick 用旧（已过期）nextMomentTime
         生成真实动态并推进时间，避免重复数据 */
      // 不 bump
    } else if (d.type === 'LETTER') {
      /* 来信：只弹通知。回前台后主线程 tick 用旧（已过期）nextLetterTime
         生成真实信件并推进时间 */
      // 不 bump
    }

    /* 3) 标记 done，供页面 syncBackFromSW 读取 + 避免重复触发 */
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
    if (lock) {
      __inflightLocks.delete(task.id);
      try { lock(); } catch (e) {}
    }
  }
}

/* ---------------- 把一个任务挂进当前事件的 waitUntil ----------------
 * 只挂"ARM_WINDOW_MS 内会到期"的任务，避免 waitUntil 无限期等待。
 * 远期任务靠下一次 handoff / PING_SW / periodicSync 再次唤醒。
 * ------------------------------------------------------------------ */
function armOne(task) {
  if (!task || !task.id) return null;
  if (task.done) return null;
  if (__inflightTimers.has(task.id)) return null;      // 已挂起，别重复
  const delay = task.fireAt - Date.now();
  if (delay > ARM_WINDOW_MS) return null;               // 超 5 分钟，本次不排
  if (delay < -60 * 1000) return null;                  // 超 1 分钟未触发，视为过期丢弃

  return new Promise(resolve => {
    __inflightLocks.set(task.id, resolve);
    const timer = setTimeout(() => {
      fireTask(task);   // fireTask 内部 finally 会 resolve lock
    }, Math.max(0, delay));
    __inflightTimers.set(task.id, timer);
  });
}

/* ---------------- 处理 SCHEDULE_TASKS ---------------- */
async function handleSchedule(incoming) {
  const now = Date.now();
  const existing = await loadTasks();
  const map = new Map(existing.map(t => [t.id, t]));

  for (const t of incoming) {
    if (!t || !t.id || !t.fireAt) continue;
    if (t.fireAt > now + HORIZON_MS) continue;   // 超 2h，本次不收
    const old = map.get(t.id);
    /* 同一任务 fireAt 变了 → 清掉旧 timer，否则旧时间会先生效 */
    if (old && old.fireAt !== t.fireAt) {
      const tm = __inflightTimers.get(t.id);
      if (tm) { try { clearTimeout(tm); } catch (e) {} __inflightTimers.delete(t.id); }
      const lk = __inflightLocks.get(t.id);
      if (lk) { __inflightLocks.delete(t.id); try { lk(); } catch (e) {} }
    }
    /* done 任务保留；但如果这次页面发来的 fireAt 更新（> 旧 doneAt），
       说明是新一轮任务，重新激活 */
    if (old && old.done && t.fireAt > (old.doneAt || 0)) {
      map.set(t.id, Object.assign({}, t, { done: false, scheduledAt: now }));
    } else if (old && old.done) {
      /* 同一 id 且 done 已过 → 保持 done，不重排 */
      continue;
    } else {
      map.set(t.id, Object.assign({}, t, { done: false, scheduledAt: now }));
    }
  }

  /* 清理：done 只留 1 天，未完成留 7 天 */
  const all = Array.from(map.values()).filter(t => {
    if (t.done) return now - (t.doneAt || t.fireAt) < DONE_KEEP_MS;
    return now - t.fireAt < TASK_KEEP_MS;
  });
  await saveTasks(all);

  /* 只给 5 分钟内的任务挂 waitUntil */
  const promises = [];
  for (const t of all) {
    if (t.done) continue;
    const p = armOne(t);
    if (p) promises.push(p);
  }
  if (promises.length) await Promise.all(promises);
}

/* ---------------- PING_SW 时的恢复（补偿 SW 内存被系统回收） ---------------- */
async function pingRecover() {
  const tasks = await loadTasks();
  const now = Date.now();
  const promises = [];

  /* 顺便补发一次已过期但没 done 的任务（容错） */
  for (const t of tasks) {
    if (t.done) continue;
    if (t.fireAt <= now && t.fireAt > now - ARM_WINDOW_MS) {
      fireTask(t).catch(() => {});
      continue;
    }
    const p = armOne(t);
    if (p) promises.push(p);
  }
  if (promises.length) await Promise.all(promises);
}

/* ============================================================================
 * 事件绑定
 * ========================================================================== */

/* ---------------- message：页面 → SW ---------------- */
self.addEventListener('message', (event) => {
  const data = event.data || {};

  if (data.type === 'SCHEDULE_TASKS' && Array.isArray(data.tasks)) {
    event.waitUntil(handleSchedule(data.tasks));
    return;
  }

  /* 页面发来的 ping：恢复挂起任务（补偿 SW 被终止后内存丢失） */
  if (data.type === 'PING_SW') {
    event.waitUntil(pingRecover());
    return;
  }

  /* 手动清空（例如页面「清空全部数据」后） */
  if (data.type === 'CLEAR_TASKS') {
    event.waitUntil((async () => {
      for (const tm of __inflightTimers.values()) { try { clearTimeout(tm); } catch (e) {} }
      __inflightTimers.clear();
      for (const r of __inflightLocks.values()) { try { r(); } catch (e) {} }
      __inflightLocks.clear();
      await saveTasks([]);
    })());
  }
});

/* ---------------- 通知点击 ---------------- */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = (event.notification && event.notification.data) || {};

  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins && wins.length) {
      /* 优先复用已打开的窗口 */
      const w = wins[0];
      try { await w.focus(); } catch (e) {}
      try { w.postMessage({ type: 'OPEN_CHAT', cid: data.cid }); } catch (e) {}
      return;
    }
    /* 没窗口 → 打开新页面（带参数让 index.html 直接进聊天） */
    const url = data.cid
      ? `./index.html?page=chatRoom&id=${encodeURIComponent(data.cid)}`
      : './index.html';
    try { await self.clients.openWindow(url); } catch (e) {}
  })());
});

/* ---------------- periodicSync / sync 兜底（Chrome Android 等） ---------------- */
async function drainOverdueTasks() {
  const tasks = await loadTasks();
  const now = Date.now();
  for (const t of tasks) {
    if (t.done) continue;
    if (t.fireAt <= now) await fireTask(t);   // 全部补发
  }
  /* 清理 */
  const cleaned = (await loadTasks()).filter(t => {
    if (t.done) return now - (t.doneAt || t.fireAt) < DONE_KEEP_MS;
    return now - t.fireAt < TASK_KEEP_MS;
  });
  await saveTasks(cleaned);
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'libum-offline-msg') {
    event.waitUntil(drainOverdueTasks());
  }
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'libum-offline-msg') {
    event.waitUntil(drainOverdueTasks());
  }
});

/* ---------------- push（有服务器时用，纯静态可忽略） ---------------- */
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) {}
  const title = payload.title || 'Libum';
  const body  = payload.body  || '有新消息';
  const tag   = payload.tag   || 'libum-push';
  const data  = payload.data  || {};
  event.waitUntil(showLibumNotification(title, body, tag, data));
});

/* ---------------- install / activate ---------------- */
self.addEventListener('install', () => {
  self.skipWaiting();   // 立即接管，避免 update 时任务中断
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try { await self.clients.claim(); } catch (e) {}
    /* 清理过期任务 */
    try {
      const tasks = await loadTasks();
      const now = Date.now();
      const kept = tasks.filter(t => {
        if (t.done) return now - (t.doneAt || t.fireAt) < DONE_KEEP_MS;
        return now - t.fireAt < TASK_KEEP_MS;
      });
      if (kept.length !== tasks.length) await saveTasks(kept);
    } catch (e) {}
  })());
});

/* ---------------- fetch（可选） ----------------
 * 若你原本 sw.js 已有 fetch 事件，请删掉这段避免重复拦截。
 * 作用：PWA 安装后离线也能打开壳页面。
 * -------------------------------------------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(STATIC_CACHE);
    try {
      const res = await fetch(req);
      if (res && res.ok && /\.(html|js|css|json|png|svg|ico|webp)$/i.test(url.pathname)) {
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