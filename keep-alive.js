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
  const SILENT_WAV = "data:audio/wav;base64,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";
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
      audioEl.volume = 0.4; // 轻柔但可闻，浏览器才判定在播放并弹卡片
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
