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
    try {
      const p = el.play();
      if (p && typeof p.then === 'function') {
        p.then(() => setMediaSession()).catch(() => {});
      }
    } catch (e) {}
  }

  function stopAudio() {
    if (audioEl) { try { audioEl.pause(); } catch (e) {} }
    try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none'; } catch (e) {}
  }

  // 首次用户交互时预热：获得自动播放授权，之后切后台才能顺利播放
  function primeAudio() {
    if (!config.keepAlive) return;
    ensureAudioEl();
    startAudio();
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

    // 首次触摸或点击时预热音频，拿到自动播放授权
    let primed = false;
    const prime = () => {
      if (primed) return;
      primed = true;
      document.removeEventListener('touchstart', prime);
      document.removeEventListener('click', prime);
      primeAudio();
    };
    if (config.keepAlive) {
      document.addEventListener('touchstart', prime);
      document.addEventListener('click', prime);
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
