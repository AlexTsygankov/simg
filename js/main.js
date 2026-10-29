/*
 * main.js — GS.main
 * Инициализация, вьюпорт (фиксированный вид + letterbox), цикл requestAnimationFrame
 * с аккумулятором фиксированного dt, выбор и переключение рендереров.
 */
(function () {
  'use strict';

  var GS = window.GS;
  var U = GS.util;

  var DT = 1 / 120;
  var MAX_SUBSTEPS = 8;
  var STAGE_BG = '#05070a';

  /* ------------------------------------------------------------------ *
   * Viewport: world (1000x1000) → screen с сохранением пропорций
   * ------------------------------------------------------------------ */

  var view = {
    dpr: 1,
    cssW: 1, cssH: 1,
    worldW: 1000, worldH: 1000,
    scale: 1,
    offsetX: 0, offsetY: 0
  };

  function computeView(cssW, cssH, worldW, worldH) {
    var scale = Math.min(cssW / worldW, cssH / worldH);
    view.dpr = window.devicePixelRatio || 1;
    view.cssW = cssW;
    view.cssH = cssH;
    view.worldW = worldW;
    view.worldH = worldH;
    view.scale = scale;
    view.offsetX = (cssW - worldW * scale) / 2;
    view.offsetY = (cssH - worldH * scale) / 2;
    return view;
  }

  function worldToScreen(wx, wy, out) {
    out = out || {};
    out.x = wx * view.scale + view.offsetX;
    out.y = wy * view.scale + view.offsetY;
    return out;
  }

  function screenToWorld(sx, sy, out) {
    out = out || {};
    out.x = (sx - view.offsetX) / view.scale;
    out.y = (sy - view.offsetY) / view.scale;
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Состояние
   * ------------------------------------------------------------------ */

  var canvas = null;
  var stage = null;
  var toastEl = null;
  var rafId = 0;
  var canvasBinders = [];

  var scene = null;
  var settings = {
    dt: DT,
    maxSubsteps: MAX_SUBSTEPS,
    speed: 1,
    running: true,
    rendererKind: '2d',
    trails: false,
    vectors: false,
    vectorsA: false,
    glow: false,
    blackHoles: true,
    vectorScale: 0.06,
    accelScale: 0.0015,
    substepsLast: 0
  };

  var renderer = null;
  var cursor = { visible: false, x: 0, y: 0, radius: 6, color: '#7fd4ff', launchX: null, launchY: null };

  var accumulator = 0;
  var lastTime = 0;
  var fps = 0;
  var fpsSmooth = 0;
  var frameCount = 0;
  var fpsTimer = 0;
  var energyTimer = 0;
  var energy = { ke: 0, pe: 0, total: 0 };
  var stepRequested = 0;
  var listeners = { onStats: [] };
  var toastTimer = 0;

  /* ------------------------------------------------------------------ *
   * Toast
   * ------------------------------------------------------------------ */

  function toast(msg, ok) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.hidden = false;
    toastEl.className = ok ? 'ok' : '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 4200);
  }

  /* ------------------------------------------------------------------ *
   * Canvas / resize
   * ------------------------------------------------------------------ */

  /**
   * Канвас может держать только один тип контекста, поэтому при переключении
   * 2D <-> WebGL элемент заменяется целиком, а подписчики перепривязываются.
   */
  function installCanvas() {
    var old = canvas || document.getElementById('canvas');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var cv = document.createElement('canvas');
    cv.id = 'canvas';
    cv.style.width = '100%';
    cv.style.height = '100%';
    cv.style.display = 'block';
    stage.insertBefore(cv, toastEl);
    canvas = cv;

    for (var i = 0; i < canvasBinders.length; i++) {
      try { canvasBinders[i](cv); } catch (e) { console.error(e); }
    }
    return cv;
  }

  function onCanvasReady(fn) {
    canvasBinders.push(fn);
    if (canvas) fn(canvas);
  }

  function resizeCanvas() {
    var rect = stage.getBoundingClientRect();
    var cssW = Math.max(1, Math.floor(rect.width));
    var cssH = Math.max(1, Math.floor(rect.height));
    var dpr = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';

    computeView(cssW, cssH, scene ? scene.width : 1000, scene ? scene.height : 1000);
    view.dpr = dpr;

    if (renderer && renderer.resize) renderer.resize(view);
  }

  /* ------------------------------------------------------------------ *
   * Рендерер
   * ------------------------------------------------------------------ */

  function buildOpts() {
    return {
      trails: settings.trails,
      vectors: settings.vectors,
      vectorsA: settings.vectorsA,
      glow: settings.glow,
      blackHoles: settings.blackHoles,
      vectorScale: settings.vectorScale,
      accelScale: settings.accelScale,
      cursor: cursor
    };
  }

  function webglAvailable() {
    try {
      var c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext &&
        (c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (e) {
      return false;
    }
  }

  function setRenderer(kind, silent) {
    if (kind === 'webgl' && !webglAvailable()) {
      if (!silent) toast('WebGL недоступен — переключение на Canvas 2D', false);
      kind = '2d';
    }

    if (renderer && renderer.dispose) renderer.dispose();
    renderer = null;

    // Свежий canvas: контекст нельзя сменить на существующем элементе.
    installCanvas();
    resizeCanvas();

    if (kind === 'webgl') {
      if (GS.renderwebgl && GS.renderwebgl.create) {
        renderer = GS.renderwebgl.create();
      }
    }
    if (!renderer) {
      kind = '2d';
      renderer = GS.render2d.create();
    }

    var ok = renderer.init(canvas, view);
    if (!ok && renderer.kind === 'webgl') {
      renderer.dispose();
      installCanvas();
      resizeCanvas();
      renderer = GS.render2d.create();
      renderer.init(canvas, view);
      kind = '2d';
      if (!silent) toast('Не удалось создать WebGL-контекст — Canvas 2D', false);
    }

    settings.rendererKind = kind;

    // Первый кадр сразу, чтобы переключение не мигало и не давало «прыжков».
    if (canvas) {
      canvas.className = 'mode-' + (GS.ui && GS.ui.currentMouseMode ? GS.ui.currentMouseMode() : 'add');
    }
    if (renderer.resize) renderer.resize(view);
    if (scene) renderer.render(scene, view, buildOpts());
    return kind;
  }

  /* ------------------------------------------------------------------ *
   * Симуляция
   * ------------------------------------------------------------------ */

  function setScene(newScene, opts) {
    scene = newScene;
    GS.physics.refreshAccelerations(scene);
    accumulator = 0;
    energy = GS.measureEnergy(scene);
    // Сцена может иметь свои размеры мира — вьюпорт нужно пересобрать.
    resizeCanvas();
    if (renderer) renderer.render(scene, view, buildOpts());
    if (opts && opts.announce) toast(opts.announce, true);
  }

  function stepOnce(mult) {
    if (!scene) return;
    var n = mult || 1;
    for (var i = 0; i < n; i++) GS.physics.step(scene, settings.dt);
  }

  function update(dtReal) {
    if (!scene) return;

    if (stepRequested > 0) {
      stepOnce(stepRequested);
      stepRequested = 0;
      accumulator = 0;
      energy = GS.measureEnergy(scene);
      return;
    }
    if (!settings.running) return;

    accumulator += dtReal * settings.speed;

    var steps = 0;
    var budget = settings.maxSubsteps;
    while (accumulator >= settings.dt && steps < budget) {
      GS.physics.step(scene, settings.dt);
      accumulator -= settings.dt;
      steps++;
    }
    // Дробим остаток: слишком большой лаг не должен «догоняться» бесконечно.
    if (accumulator >= settings.dt) accumulator = 0;
    settings.substepsLast = steps;
  }

  /* ------------------------------------------------------------------ *
   * Статистика
   * ------------------------------------------------------------------ */

  function pushStats() {
    var s = {
      fps: Math.round(fpsSmooth),
      bodies: scene ? scene.bodies.length : 0,
      ke: energy.ke,
      pe: energy.pe,
      total: energy.total,
      substeps: settings.substepsLast,
      renderer: settings.rendererKind
    };
    for (var i = 0; i < listeners.onStats.length; i++) {
      try { listeners.onStats[i](s); } catch (e) { /* UI не должен ломать цикл */ }
    }
  }

  function onStats(fn) { listeners.onStats.push(fn); }

  /* ------------------------------------------------------------------ *
   * Цикл
   * ------------------------------------------------------------------ */

  function frame(now) {
    rafId = requestAnimationFrame(frame);
    if (!lastTime) lastTime = now;

    var dtReal = (now - lastTime) / 1000;
    lastTime = now;
    if (dtReal > 0.25) dtReal = 0.25; // окно было в фоне

    update(dtReal);
    if (renderer && scene) renderer.render(scene, view, buildOpts());

    frameCount++;
    fpsTimer += dtReal;
    if (fpsTimer >= 0.5) {
      fps = frameCount / fpsTimer;
      fpsSmooth = fpsSmooth ? U.lerp(fpsSmooth, fps, 0.5) : fps;
      frameCount = 0;
      fpsTimer = 0;
    }

    energyTimer += dtReal;
    if (energyTimer >= 0.4) {
      energyTimer = 0;
      if (scene) energy = GS.measureEnergy(scene);
    }

    pushStats();
  }

  /* ------------------------------------------------------------------ *
   * init
   * ------------------------------------------------------------------ */

  function init(opts) {
    opts = opts || {};
    stage = document.getElementById('stage');
    toastEl = document.getElementById('toast');

    scene = opts.scene || GS.presets.solar();

    installCanvas();
    resizeCanvas();
    window.addEventListener('resize', function () {
      resizeCanvas();
    });
    window.addEventListener('orientationchange', function () {
      setTimeout(resizeCanvas, 220);
    });

    setupTelegram();

    setRenderer(settings.rendererKind);

    lastTime = 0;
    rafId = requestAnimationFrame(frame);
    return scene;
  }

  /* ------------------------------------------------------------------ *
   * Telegram Mini App
   * ------------------------------------------------------------------ */

  function setViewportHeightVar(h) {
    if (h > 0) document.documentElement.style.setProperty('--tg-viewport-stable-height', h + 'px');
  }

  function setupTelegram() {
    var wa = window.Telegram && window.Telegram.WebApp;
    if (!wa) return;

    try {
      wa.ready();
      wa.expand();
      if (wa.disableVerticalSwipes) wa.disableVerticalSwipes();
      if (wa.setHeaderColor) wa.setHeaderColor('#0a0d12');
      if (wa.setBackgroundColor) wa.setBackgroundColor('#0a0d12');
      if (wa.enableClosingConfirmation) wa.enableClosingConfirmation();
    } catch (e) {
      console.error(e);
    }

    // Стабильная высота: на iOS/Android шапка Telegram меняет размер при скролле,
    // поэтому 100vh без этого «прыгает» и канвас уезжает.
    var applyHeight = function () {
      var h = wa.viewportStableHeight || wa.viewportHeight;
      setViewportHeightVar(h);
      resizeCanvas();
    };
    applyHeight();

    if (wa.onEvent) {
      wa.onEvent('viewportChanged', applyHeight);
      wa.onEvent('safeAreaChanged', function () { GS.main.resize(); });
      wa.onEvent('contentSafeAreaChanged', function () { GS.main.resize(); });
    }
  }

  GS.view = {
    state: view,
    compute: computeView,
    worldToScreen: worldToScreen,
    screenToWorld: screenToWorld,
    BG: STAGE_BG
  };

  GS.main = {
    init: init,
    settings: settings,
    get scene() { return scene; },
    get canvas() { return canvas; },
    setScene: setScene,
    step: stepOnce,
    requestStep: function (n) { stepRequested = (n || 1); },
    setRenderer: setRenderer,
    resize: resizeCanvas,
    onCanvasReady: onCanvasReady,
    toast: toast,
    onStats: onStats,
    get cursor() { return cursor; },
    get fps() { return fpsSmooth; },
    DEFAULT_DT: DT,
    MAX_SUBSTEPS: MAX_SUBSTEPS
  };

  /* ------------------------------------------------------------------ *
   * Bootstrap
   * ------------------------------------------------------------------ */

  function boot() {
    GS.main.init({ scene: GS.presets.make(GS.presets.DEFAULT) });
    if (GS.ui && GS.ui.init) GS.ui.init();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
