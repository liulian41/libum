'use strict';

/* ==========================================================================
 * 主线程后台保活模块 keep-alive.js
 * --------------------------------------------------------------------------
 * 职责：
 *   1. 切后台前，把未来 5 分钟内的任务 postMessage 交接给 Service Worker
 *   2. 添加到主屏幕 A2HS 引导
 *   3. 循环播放静音音频，尝试防止页面被冻结
 *   4. 接收 SW 点击通知后回传的消息
 *
 * 用法：
 *   KEEP.init({
 *     keepAlive: true,                      // 切后台时是否播放静音音频
 *     collectTasks: () => [                 // 返回未来 horizonMs 内要交给 SW 的任务
 *       { id, fireAt, title, body, tag, data }
 *     ]
 *   });
 *   KEEP.initA2HS(inst => { ... });         // 可选，监听可安装事件
 *   KEEP.promptInstall();                   // 用户点“添加到主屏幕”按钮时调用
 * ========================================================================== */

const KEEP = (() => {

  const config = {
    swPath: 'sw.js',
    horizonMs: 5 * 60 * 1000,
    syncTag: 'libum-wake',
    keepAlive: false,
    mediaTitle: '保持后台连接',   // 媒体卡片上显示的标题
    mediaArtist: 'KeepAlive',     // 媒体卡片上显示的副标题
    // 把这里换成你的真实取任务函数，返回 future 内要交接的任务数组
    collectTasks: () => []
  };

  /* ---------------- 1. 任务交接给 SW ---------------- */
  function handoff() {
    if (!('serviceWorker' in navigator)) return;
    const tasks = (config.collectTasks() || []).filter(t => t && t.id && t.fireAt);
    if (!tasks.length) return;
    navigator.serviceWorker.ready.then(reg => {
      const sw = reg.active || navigator.serviceWorker.controller;
      if (!sw) return;
      sw.postMessage({ type: 'SCHEDULE_TASKS', tasks });
      sw.postMessage({ type: 'PING_SW' });
    }).catch(() => {});
  }

  /* ---------------- 2. 添加到主屏幕 A2HS 引导 ---------------- */
  let deferredPrompt = null;

  function initA2HS(onInstallable) {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      if (typeof onInstallable === 'function') onInstallable(e);
    });
    window.addEventListener('appinstalled', () => {
      deferredPrompt = null;
      if (typeof onInstallable === 'function') onInstallable(null);
    });
  }

  function promptInstall() {
    if (!deferredPrompt) return false;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(() => { deferredPrompt = null; });
    return true;
  }

  /* ---------------- 3. 循环静音音频防冻结 + 媒体卡片 ---------------- */
  const SILENT_WAV = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
  let audioEl = null;
  let mediaReady = false; // 音频是否真正跑起来、媒体卡片是否可显示

  // 设置系统媒体卡片，并把控制按钮全部拦住，防止被暂停
  function setMediaSession() {
    try {
      if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: config.mediaTitle || '保持后台连接',
        artist: config.mediaArtist || 'KeepAlive',
        album: 'KeepAlive'
      });
      navigator.mediaSession.playbackState = 'playing';
      const guard = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        navigator.mediaSession.playbackState = 'playing';
        if (audioEl && audioEl.paused) audioEl.play().catch(() => {});
      };
      ['play', 'pause', 'stop', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward'].forEach(a => {
        try { navigator.mediaSession.setActionHandler(a, guard); } catch (e) {}
      });
    } catch (e) {}
  }

  // 创建并复用同一个音频元素。关键点：必须在用户首次交互时启动，
  // 这样才拿到自动播放授权，切后台时再次播放才不会被打断。
  function ensureAudioEl() {
    if (audioEl) return audioEl;
    try {
      audioEl = new Audio(SILENT_WAV);
      audioEl.loop = true;
      audioEl.volume = 0.01; // 极小音量，骗过系统保活判定
      return audioEl;
    } catch (e) { return null; }
  }

  function startAudio() {
    const el = ensureAudioEl();
    if (!el) return;
    if (mediaReady && !el.paused) return; // 已在播放则复用，避免重启空档
    try {
      const p = el.play();
      if (p && typeof p.then === 'function') {
        p.then(() => { mediaReady = true; setMediaSession(); }).catch(() => { mediaReady = false; });
      } else {
        mediaReady = true;
        setMediaSession();
      }
    } catch (e) {}
  }

  function stopAudio() {
    if (audioEl) { try { audioEl.pause(); } catch (e) {} }
    try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none'; } catch (e) {}
    mediaReady = false;
  }

  // 进站即触发：一进页面就尝试启动音频并弹出媒体卡片，不要求先交互。
  // 若被浏览器自动播放策略拦截，挂在用户首次触摸/点击时再补启动；
  // 只有真正跑起来才解绑，避免失败后失去重试机会。
  function primeAudio() {
    if (!config.keepAlive) return;
    ensureAudioEl();
    setMediaSession();
    startAudio();
    if (mediaReady) {
      document.removeEventListener('touchstart', primeAudio);
      document.removeEventListener('click', primeAudio);
    }
  }

  /* ---------------- 4. 接收 SW 回传 ---------------- */
  function onSWMessage(handler) {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('message', (e) => {
      const d = e.data || {};
      if (d.type === 'OPEN_TARGET' && typeof handler === 'function') handler(d);
    });
  }

  /* ---------------- 初始化 ---------------- */
  function init(opts) {
    if (opts) Object.assign(config, opts);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        if (config.keepAlive) startAudio();
        handoff(); // 切后台前把任务交给 SW
      } else {
        stopAudio();
      }
    });

    // 进站立即触发，不等用户交互
    if (config.keepAlive) {
      primeAudio();
      // 兜底：自动播放被浏览器拦截时，用户首次触摸/点击再补启动
      document.addEventListener('touchstart', primeAudio);
      document.addEventListener('click', primeAudio);
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register(config.swPath).then(reg => {
        if ('PeriodicSyncManager' in window) {
          navigator.permissions.query({ name: 'periodic-background-sync' }).then(s => {
            if (s.state === 'granted') {
              reg.periodicSync.register(config.syncTag, { minInterval: 60 * 60 * 1000 });
            }
          }).catch(() => {});
        }
      }).catch(() => {});
    }

    return KEEP;
  }

  return { init, handoff, initA2HS, promptInstall, startAudio, stopAudio, onSWMessage, config };
})();
