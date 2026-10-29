/*
 * ui.js — GS.ui
 * Панель управления, обработчики мыши (add/drag/launch), save/load JSON, метрики.
 * Работает через публичный API GS.main и привязывается к canvas заново при его замене.
 */
(function () {
  'use strict';

  var GS = window.GS;
  var U = GS.util;

  var els = {};
  var mouseMode = 'add';
  var brush = {
    mass: 20,
    radius: 6,
    radiusMode: 'auto',
    color: '#7fd4ff',
    blackHole: false
  };

  var dragState = null;    // { body, grabDX, grabDY, wasRunning }
  var launchState = null;  // { wx, wy, sx, sy }

  /* ------------------------------------------------------------------ *
   * Поиск элементов
   * ------------------------------------------------------------------ */

  function $(id) { return document.getElementById(id); }

  function cacheEls() {
    var ids = [
      'panel', 'panel-toggle', 'panel-body',
      'btn-play', 'btn-step', 'btn-reset', 'sel-preset',
      'rng-mass', 'out-mass', 'sel-radius', 'rng-radius', 'out-radius', 'inp-color',
      'sel-mode', 'chk-blackhole',
      'rng-g', 'out-g', 'rng-speed', 'out-speed', 'rng-soft', 'out-soft',
      'chk-collide', 'chk-trails', 'chk-vectors', 'chk-vectors-a', 'chk-glows',
      'sel-renderer',
      'btn-save', 'btn-load', 'btn-clear', 'inp-load',
      'out-fps', 'out-bodies', 'out-ke', 'out-pe', 'out-substeps'
    ];
    ids.forEach(function (id) { els[id] = $(id); });
  }

  /* ------------------------------------------------------------------ *
   * Кисть
   * ------------------------------------------------------------------ */

  /** Слайдер массы: log-scale 0.1 .. 100. */
  function massFromSlider(v) { return Math.pow(10, Number(v)); }
  function sliderFromMass(m) { return Math.log10(Math.max(m, 0.1)); }

  function syncBrushFromInputs() {
    brush.mass = massFromSlider(els['rng-mass'].value);
    els['out-mass'].value = brush.mass.toFixed(1);

    brush.radiusMode = els['sel-radius'].value;
    els['rng-radius'].disabled = brush.radiusMode !== 'manual';
    if (brush.radiusMode === 'manual') {
      brush.radius = Number(els['rng-radius'].value);
    } else {
      brush.radius = 0; // 0 = вычислять из массы
    }
    els['out-radius'].value = brush.radiusMode === 'manual'
      ? brush.radius.toFixed(1)
      : GS.radiusForMass(brush.mass).toFixed(1);

    brush.color = els['inp-color'].value;
    brush.blackHole = els['chk-blackhole'].checked;
    mouseMode = els['sel-mode'].value;

    var cur = GS.main.cursor;
    cur.color = brush.color;
    cur.radius = currentBrushRadius();
  }

  function currentBrushRadius() {
    if (brush.radiusMode === 'manual') return brush.radius;
    return GS.radiusForMass(brush.mass);
  }

  function addBodyAt(wx, wy, vx, vy) {
    var scene = GS.main.scene;
    var radius = brush.blackHole
      ? Math.max(currentBrushRadius(), 10)
      : currentBrushRadius();
    var b = GS.makeBody({
      x: wx, y: wy, vx: vx || 0, vy: vy || 0,
      mass: brush.blackHole ? Math.max(brush.mass, 200) : brush.mass,
      radius: radius,
      color: brush.color,
      isBlackHole: brush.blackHole
    });
    scene.bodies.push(b);
    GS.physics.refreshAccelerations(scene);
    return b;
  }

  /* ------------------------------------------------------------------ *
   * Мышь
   * ------------------------------------------------------------------ */

  function eventToWorld(ev) {
    var rect = ev.target.getBoundingClientRect();
    var sx = ev.clientX - rect.left;
    var sy = ev.clientY - rect.top;
    return GS.view.screenToWorld(sx, sy, {});
  }

  function bindCanvas(cv) {
    cv.addEventListener('mousedown', onMouseDown);
    cv.addEventListener('mousemove', onMouseMove);
    cv.addEventListener('mouseup', onMouseUp);
    cv.addEventListener('mouseleave', onMouseLeave);
    cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    cv.addEventListener('wheel', onWheel, { passive: false });
  }

  function onMouseDown(ev) {
    if (ev.button !== 0) return;
    var scene = GS.main.scene;
    var p = eventToWorld(ev);
    var inWorld = p.x >= 0 && p.x <= scene.width && p.y >= 0 && p.y <= scene.height;

    if (mouseMode === 'drag') {
      var hit = GS.pickBody(scene, p.x, p.y, 4 / GS.view.state.scale);
      if (hit) {
        dragState = {
          body: hit,
          grabDX: p.x - hit.x,
          grabDY: p.y - hit.y,
          wasFixed: hit.fixed,
          savedVx: hit.vx,
          savedVy: hit.vy
        };
        hit.vx = 0;
        hit.vy = 0;
        ev.target.classList.add('grabbing');
      }
      return;
    }

    if (mouseMode === 'launch') {
      if (!inWorld) return;
      launchState = { wx: p.x, wy: p.y, sx: p.x, sy: p.y };
      var cur = GS.main.cursor;
      cur.visible = true;
      cur.x = p.x; cur.y = p.y;
      cur.launchX = p.x; cur.launchY = p.y;
      return;
    }

    // add
    if (inWorld) addBodyAt(p.x, p.y, 0, 0);
  }

  function onMouseMove(ev) {
    var p = eventToWorld(ev);
    var cur = GS.main.cursor;
    cur.visible = true;
    cur.x = p.x;
    cur.y = p.y;
    cur.color = brush.color;
    cur.radius = currentBrushRadius();

    if (launchState) {
      launchState.sx = p.x;
      launchState.sy = p.y;
      cur.launchX = p.x;
      cur.launchY = p.y;
      return;
    }

    if (dragState) {
      dragState.body.x = p.x - dragState.grabDX;
      dragState.body.y = p.y - dragState.grabDY;
    }
  }

  function onMouseUp(ev) {
    if (ev.button !== 0) return;

    if (dragState) {
      dragState = null;
      ev.target.classList.remove('grabbing');
      GS.physics.refreshAccelerations(GS.main.scene);
      return;
    }

    if (launchState) {
      var dx = launchState.sx - launchState.wx;
      var dy = launchState.sy - launchState.wy;
      var k = 0.35; // drag → скорость
      addBodyAt(launchState.wx, launchState.wy, dx * k, dy * k);
      launchState = null;
      var cur = GS.main.cursor;
      cur.launchX = null;
      cur.launchY = null;
    }
  }

  function onMouseLeave() {
    var cur = GS.main.cursor;
    cur.visible = false;
    cur.launchX = null;
    cur.launchY = null;
    if (launchState) launchState = null;
    if (dragState) {
      dragState = null;
      if (GS.main.canvas) GS.main.canvas.classList.remove('grabbing');
    }
  }

  /** Колесо резервируем под массу кисти (фикс. вид — zoom не нужен). */
  function onWheel(ev) {
    ev.preventDefault();
    var rng = els['rng-mass'];
    var step = ev.deltaY < 0 ? 0.06 : -0.06;
    rng.value = U.clamp(Number(rng.value) + step, Number(rng.min), Number(rng.max));
    syncBrushFromInputs();
  }

  /* ------------------------------------------------------------------ *
   * Панель
   * ------------------------------------------------------------------ */

  function bindPanel() {
    els['panel-toggle'].addEventListener('click', function () {
      els.panel.classList.toggle('collapsed');
      // Панель анимируется ~180мс — по окончании просто пересчитываем размеры канваса.
      setTimeout(function () { GS.main.resize(); }, 220);
    });

    els['btn-play'].addEventListener('click', function () {
      var s = GS.main.settings;
      s.running = !s.running;
      els['btn-play'].textContent = s.running ? 'Пауза' : 'Пуск';
      els['btn-play'].classList.toggle('primary', !s.running);
    });

    els['btn-step'].addEventListener('click', function () {
      GS.main.requestStep(1);
    });

    els['btn-reset'].addEventListener('click', function () {
      var name = els['sel-preset'].value;
      loadPreset(name);
    });

    els['sel-preset'].addEventListener('change', function () {
      loadPreset(els['sel-preset'].value);
    });

    // Кисть
    els['rng-mass'].addEventListener('input', syncBrushFromInputs);
    els['sel-radius'].addEventListener('change', syncBrushFromInputs);
    els['rng-radius'].addEventListener('input', syncBrushFromInputs);
    els['inp-color'].addEventListener('input', syncBrushFromInputs);
    els['chk-blackhole'].addEventListener('change', syncBrushFromInputs);
    els['sel-mode'].addEventListener('change', function () {
      syncBrushFromInputs();
      var cv = GS.main.canvas;
      if (cv) cv.className = 'mode-' + mouseMode;
      var cur = GS.main.cursor;
      cur.launchX = null;
      cur.launchY = null;
    });

    // Мир
    els['rng-g'].addEventListener('input', function () {
      var v = Number(els['rng-g'].value);
      els['out-g'].value = v.toFixed(2);
      if (GS.main.scene) {
        GS.main.scene.G = v;
        GS.physics.refreshAccelerations(GS.main.scene);
      }
    });
    els['rng-speed'].addEventListener('input', function () {
      var v = Number(els['rng-speed'].value);
      els['out-speed'].value = v.toFixed(2);
      GS.main.settings.speed = v;
    });
    els['rng-soft'].addEventListener('input', function () {
      var v = Number(els['rng-soft'].value);
      els['out-soft'].value = v.toFixed(1);
      if (GS.main.scene) GS.main.scene.softEpsilon = v;
    });

    els['chk-collide'].addEventListener('change', function () {
      if (GS.main.scene) GS.main.scene.collide = this.checked;
    });
    els['chk-trails'].addEventListener('change', function () {
      GS.main.settings.trails = this.checked;
    });
    els['chk-vectors'].addEventListener('change', function () {
      GS.main.settings.vectors = this.checked;
    });
    els['chk-vectors-a'].addEventListener('change', function () {
      GS.main.settings.vectorsA = this.checked;
    });
    els['chk-glows'].addEventListener('change', function () {
      GS.main.settings.glow = this.checked;
    });

    // Рендерер
    els['sel-renderer'].addEventListener('change', function () {
      var kind = GS.main.setRenderer(this.value);
      this.value = kind;
    });

    // Сцена
    els['btn-save'].addEventListener('click', saveJson);
    els['btn-load'].addEventListener('click', function () { els['inp-load'].click(); });
    els['inp-load'].addEventListener('change', onFileChosen);
    els['btn-clear'].addEventListener('click', function () {
      var scene = GS.main.scene;
      scene.bodies.length = 0;
      GS.physics.refreshAccelerations(scene);
      GS.main.toast('Сцена очищена', true);
    });
  }

  /* ------------------------------------------------------------------ *
   * Пресеты
   * ------------------------------------------------------------------ */

  function loadPreset(name) {
    try {
      var scene = GS.presets.make(name);
      GS.main.setScene(scene, { announce: 'Пресет: ' + GS.presets.registry[name].label });
      syncWorldControls();
    } catch (e) {
      console.error(e);
      GS.main.toast('Не удалось загрузить пресет: ' + e.message, false);
    }
  }

  function syncWorldControls() {
    var scene = GS.main.scene;
    els['rng-g'].value = scene.G;
    els['out-g'].value = Number(scene.G).toFixed(2);
    els['rng-soft'].value = scene.softEpsilon;
    els['out-soft'].value = Number(scene.softEpsilon).toFixed(1);
    els['chk-collide'].checked = !!scene.collide;
  }

  /* ------------------------------------------------------------------ *
   * Save / Load
   * ------------------------------------------------------------------ */

  function saveJson() {
    var scene = GS.main.scene;
    var data = GS.serializeScene(scene);
    data.settings = {
      vectors: GS.main.settings.vectors,
      vectorsA: GS.main.settings.vectorsA,
      trails: GS.main.settings.trails,
      glow: GS.main.settings.glow,
      speed: GS.main.settings.speed
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'gravity-scene-' + Date.now() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    GS.main.toast('Сцена сохранена (' + scene.bodies.length + ' тел)', true);
  }

  function onFileChosen(ev) {
    var file = ev.target.files && ev.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(String(reader.result));
        var scene = GS.deserializeScene(data);
        GS.main.setScene(scene, { announce: 'Загружено тел: ' + scene.bodies.length });
        syncWorldControls();
        if (data.settings) {
          var st = GS.main.settings;
          if (data.settings.vectors != null) { st.vectors = !!data.settings.vectors; els['chk-vectors'].checked = st.vectors; }
          if (data.settings.vectorsA != null) { st.vectorsA = !!data.settings.vectorsA; els['chk-vectors-a'].checked = st.vectorsA; }
          if (data.settings.trails != null) { st.trails = !!data.settings.trails; els['chk-trails'].checked = st.trails; }
          if (data.settings.glow != null) { st.glow = !!data.settings.glow; els['chk-glows'].checked = st.glow; }
          if (data.settings.speed != null) {
            st.speed = Number(data.settings.speed);
            els['rng-speed'].value = st.speed;
            els['out-speed'].value = st.speed.toFixed(2);
          }
        }
      } catch (e) {
        console.error(e);
        GS.main.toast('Ошибка загрузки JSON: ' + e.message, false);
      } finally {
        ev.target.value = '';
      }
    };
    reader.onerror = function () {
      GS.main.toast('Не удалось прочитать файл', false);
      ev.target.value = '';
    };
    reader.readAsText(file);
  }

  /* ------------------------------------------------------------------ *
   * Метрики
   * ------------------------------------------------------------------ */

  function fmt(v) {
    var a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'e6';
    if (a >= 1e4) return (v / 1e3).toFixed(1) + 'k';
    if (a >= 1) return v.toFixed(1);
    return v.toFixed(3);
  }

  function onStats(s) {
    els['out-fps'].value = s.fps || 0;
    els['out-bodies'].value = s.bodies;
    els['out-ke'].value = fmt(s.ke);
    els['out-pe'].value = fmt(s.pe);
    els['out-substeps'].value = s.substeps;
  }

  /* ------------------------------------------------------------------ *
   * init
   * ------------------------------------------------------------------ */

  function init() {
    cacheEls();
    bindPanel();
    syncBrushFromInputs();

    var cv = GS.main.canvas;
    if (cv) cv.className = 'mode-' + mouseMode;
    GS.main.onCanvasReady(bindCanvas);

    GS.main.onStats(onStats);
    syncWorldControls();
  }

  GS.ui = {
    init: init,
    currentMouseMode: function () { return mouseMode; },
    brush: brush,
    loadPreset: loadPreset
  };
})();
