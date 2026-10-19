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

const HORIZON_MS     = 2 * 3600 * 1000;   // 只给 2 小时内的任务安排 setTimeout
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
         