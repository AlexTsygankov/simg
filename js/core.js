/*
 * core.js — namespace, утилиты, модель данных (Body), Scene.
 * Мир — условные единицы 1000x1000; координаты мировые, не пиксельные.
 */
(function () {
  'use strict';

  var GS = (window.GS = window.GS || {});

  GS.VERSION = '1.0.0';

  /* ------------------------------------------------------------------ *
   * Математика
   * ------------------------------------------------------------------ */

  var TAU = Math.PI * 2;

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /** Детерминированный ГПСЧ (mulberry32) — чтобы save/load и пресеты совпадали. */
  function makeRandom(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ------------------------------------------------------------------ *
   * Векторные хелперы (плоские, без аллокаций)
   * ------------------------------------------------------------------ */

  var vec = {
    len: function (x, y) { return Math.hypot(x, y); },
    norm: function (x, y, out) {
      var l = Math.hypot(x, y);
      out = out || {};
      if (l > 1e-12) { out.x = x / l; out.y = y / l; }
      else { out.x = 0; out.y = 0; }
      return out;
    },
    /** Кратчайшая дельта с учётом wrap не используется — только прямая. */
    dist: function (ax, ay, bx, by) { return Math.hypot(bx - ax, by - ay); }
  };

  /* ------------------------------------------------------------------ *
   * Цвета
   * ------------------------------------------------------------------ */

  /** '#rrggbb' -> {r,g,b} (0..1). */
  function hexToRgb(hex) {
    var h = String(hex || '#ffffff').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (!isFinite(n)) n = 0xffffff;
    return {
      r: ((n >> 16) & 255) / 255,
      g: ((n >> 8) & 255) / 255,
      b: (n & 255) / 255
    };
  }

  /** Светлее/темнее: t<0 — темнее, t>0 — светлее. */
  function shade(hex, t) {
    var c = hexToRgb(hex);
    var f = t >= 0 ? function (v) { return v + (1 - v) * t; } : function (v) { return v * (1 + t); };
    return 'rgb(' + Math.round(f(c.r) * 255) + ',' + Math.round(f(c.g) * 255) + ',' + Math.round(f(c.b) * 255) + ')';
  }

  function rgbaStr(hex, a) {
    var c = hexToRgb(hex);
    return 'rgba(' + Math.round(c.r * 255) + ',' + Math.round(c.g * 255) + ',' + Math.round(c.b * 255) + ',' + a + ')';
  }

  /* ------------------------------------------------------------------ *
   * Body
   * ------------------------------------------------------------------ */

  var DEFAULT_COLORS = [
    '#7fd4ff', '#ffd479', '#ff8f6b', '#a6f28c', '#c79bff',
    '#6bf0e0', '#ff9ecb', '#e8e8e8', '#8fa6ff', '#f2e06b'
  ];

  var nextId = 1;

  /** Радиус по массе: r ∝ ∛m, с клампом. */
  function radiusForMass(mass, min, max) {
    var r = Math.cbrt(Math.max(mass, 0.0001)) * 2.2;
    return clamp(r, min == null ? 1.5 : min, max == null ? 40 : max);
  }

  function makeBody(opts) {
    opts = opts || {};
    var mass = opts.mass == null ? 20 : opts.mass;
    return {
      id: opts.id == null ? nextId++ : opts.id,
      x: opts.x || 0,
      y: opts.y || 0,
      vx: opts.vx || 0,
      vy: opts.vy || 0,
      ax: 0,
      ay: 0,
      mass: mass,
      radius: opts.radius == null ? radiusForMass(mass) : opts.radius,
      color: opts.color || '#ffffff',
      isBlackHole: !!opts.isBlackHole,
      fixed: !!opts.fixed
    };
  }

  /** Клон с новым id (для save/load и добавления копий). */
  function cloneBody(b) {
    return makeBody({
      x: b.x, y: b.y, vx: b.vx, vy: b.vy,
      mass: b.mass, radius: b.radius, color: b.color,
      isBlackHole: b.isBlackHole, fixed: b.fixed
    });
  }

  /* ------------------------------------------------------------------ *
   * Scene
   * ------------------------------------------------------------------ */

  function makeScene(width, height) {
    return {
      bodies: [],
      width: width == null ? 1000 : width,
      height: height == null ? 1000 : height,
      G: 1,
      softEpsilon: 4,
      collide: true,
      name: 'scene'
    };
  }

  function sceneBodyCount(scene) { return scene.bodies.length; }

  /** Хит-тест по мировым координатам: последнее (верхнее) тело выигрывает. */
  function pickBody(scene, wx, wy, pad) {
    pad = pad == null ? 0 : pad;
    var bodies = scene.bodies;
    for (var i = bodies.length - 1; i >= 0; i--) {
      var b = bodies[i];
      var hit = Math.max(b.radius, 3) + pad;
      var dx = b.x - wx, dy = b.y - wy;
      if (dx * dx + dy * dy <= hit * hit) return b;
    }
    return null;
  }

  /** Оценка энергии (условные единицы). Потенциальная — по прямым расстояниям, O(n²). */
  function measureEnergy(scene) {
    var bodies = scene.bodies, n = bodies.length, G = scene.G;
    var eps2 = scene.softEpsilon * scene.softEpsilon;
    var ke = 0, pe = 0;
    for (var i = 0; i < n; i++) {
      var b = bodies[i];
      ke += 0.5 * b.mass * (b.vx * b.vx + b.vy * b.vy);
    }
    for (i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        var a = bodies[i], c = bodies[j];
        var dx = c.x - a.x, dy = c.y - a.y;
        var r = Math.sqrt(dx * dx + dy * dy + eps2);
        pe -= (G * a.mass * c.mass) / r;
      }
    }
    return { ke: ke, pe: pe, total: ke + pe };
  }

  /* ------------------------------------------------------------------ *
   * Сериализация
   * ------------------------------------------------------------------ */

  function serializeScene(scene) {
    return {
      format: 'gravity-sandbox',
      version: 1,
      width: scene.width,
      height: scene.height,
      G: scene.G,
      softEpsilon: scene.softEpsilon,
      collide: scene.collide,
      name: scene.name,
      bodies: scene.bodies.map(function (b) {
        return {
          x: +b.x.toFixed(6), y: +b.y.toFixed(6),
          vx: +b.vx.toFixed(6), vy: +b.vy.toFixed(6),
          mass: +b.mass.toFixed(6),
          radius: +b.radius.toFixed(6),
          color: b.color,
          isBlackHole: !!b.isBlackHole,
          fixed: !!b.fixed
        };
      })
    };
  }

  /** Возвращает новую сцену; бросает Error при несоответствии формата. */
  function deserializeScene(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.bodies)) {
      throw new Error('Некорректный JSON сцены: нет массива bodies');
    }
    var scene = makeScene(Number(data.width) || 1000, Number(data.height) || 1000);
    scene.G = data.G == null ? 1 : Number(data.G);
    scene.softEpsilon = data.softEpsilon == null ? 4 : Number(data.softEpsilon);
    scene.collide = data.collide == null ? true : !!data.collide;
    scene.name = data.name || 'loaded';
    scene.bodies = data.bodies.map(function (raw) {
      var mass = Number(raw.mass);
      if (!isFinite(mass) || mass <= 0) mass = 1;
      return makeBody({
        x: Number(raw.x) || 0,
        y: Number(raw.y) || 0,
        vx: Number(raw.vx) || 0,
        vy: Number(raw.vy) || 0,
        mass: mass,
        radius: raw.radius == null ? radiusForMass(mass) : Number(raw.radius),
        color: raw.color || '#ffffff',
        isBlackHole: !!raw.isBlackHole,
        fixed: !!raw.fixed
      });
    });
    return scene;
  }

  /* ------------------------------------------------------------------ *
   * Экспорт
   * ------------------------------------------------------------------ */

  GS.util = {
    TAU: TAU,
    clamp: clamp,
    lerp: lerp,
    makeRandom: makeRandom,
    vec: vec,
    hexToRgb: hexToRgb,
    shade: shade,
    rgba: rgbaStr
  };

  GS.DEFAULT_COLORS = DEFAULT_COLORS;
  GS.radiusForMass = radiusForMass;
  GS.makeBody = makeBody;
  GS.cloneBody = cloneBody;
  GS.pickBody = pickBody;

  GS.makeScene = makeScene;
  GS.sceneBodyCount = sceneBodyCount;
  GS.measureEnergy = measureEnergy;
  GS.serializeScene = serializeScene;
  GS.deserializeScene = deserializeScene;

  if (typeof module === 'object' && module.exports) module.exports = GS;
})();
