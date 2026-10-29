/*
 * physics.js — GS.physics
 * Ньютоновская гравитация: попарное суммирование ускорений O(n²) с softening,
 * интегратор — полу-неявный Эйлер, wrap мира по тору, слияния при столкновении.
 */
(function () {
  'use strict';

  var GS = window.GS;
  var U = GS.util;

  /** Приращение ускорения прерывает расчёт, если тела реально совпали (защита от inf). */
  var MIN_R2 = 1e-6;

  /* ------------------------------------------------------------------ *
   * Ускорения
   * ------------------------------------------------------------------ */

  /**
   * Заполняет ax/ay всех тел (прямые расстояния, без minimum-image через границу).
   * Тела с fixed=true ускорение не получают и не притягивают остальные изменения
   * своего состояния — но притягивают других как обычная масса.
   */
  function computeAccelerations(scene) {
    var bodies = scene.bodies;
    var n = bodies.length;
    var G = scene.G;
    var eps2 = scene.softEpsilon * scene.softEpsilon;

    for (var i = 0; i < n; i++) {
      bodies[i].ax = 0;
      bodies[i].ay = 0;
    }
    if (G === 0) return;

    for (i = 0; i < n; i++) {
      var a = bodies[i];
      for (var j = i + 1; j < n; j++) {
        var b = bodies[j];
        var dx = b.x - a.x;
        var dy = b.y - a.y;
        var r2 = dx * dx + dy * dy + eps2;
        if (r2 < MIN_R2) r2 = MIN_R2;

        var invR = 1 / Math.sqrt(r2);
        var invR3 = (G * invR) / r2; // G / r³

        // a += G·m_b·d̂ / r²  →  a += (G/r³)·m_b·d
        var fa = invR3 * b.mass;
        var fb = invR3 * a.mass;

        if (!a.fixed) { a.ax += dx * fa; a.ay += dy * fa; }
        if (!b.fixed) { b.ax -= dx * fb; b.ay -= dy * fb; }
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Интеграция + wrap
   * ------------------------------------------------------------------ */

  function wrapAxis(v, size) {
    var m = v % size;
    return m < 0 ? m + size : m;
  }

  function wrapBody(b, w, h) {
    b.x = wrapAxis(b.x, w);
    b.y = wrapAxis(b.y, h);
  }

  function integrate(scene, dt) {
    var bodies = scene.bodies;
    var w = scene.width, h = scene.height;
    for (var i = 0; i < bodies.length; i++) {
      var b = bodies[i];
      if (b.fixed) { b.ax = 0; b.ay = 0; continue; }
      b.vx += b.ax * dt;
      b.vy += b.ay * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      wrapBody(b, w, h);
    }
  }

  /* ------------------------------------------------------------------ *
   * Слияния
   * ------------------------------------------------------------------ */

  /** Поглощение: absorbed уходит в host. Масса, импульс и центр масс сохраняются. */
  function absorb(host, absorbed, w, h) {
    var m = host.mass + absorbed.mass;
    if (!host.fixed) {
      host.vx = (host.mass * host.vx + absorbed.mass * absorbed.vx) / m;
      host.vy = (host.mass * host.vy + absorbed.mass * absorbed.vy) / m;
      host.x = (host.mass * host.x + absorbed.mass * absorbed.x) / m;
      host.y = (host.mass * host.y + absorbed.mass * absorbed.y) / m;
      if (w && h) {
        host.x = wrapAxis(host.x, w);
        host.y = wrapAxis(host.y, h);
      }
    }
    host.mass = m;
    if (!host.isBlackHole) {
      host.radius = GS.radiusForMass(m, host.radius, null);
    }
    return host;
  }

  /**
   * Разрешение столкновений за один проход.
   * Пара сливается при r < r1 + r2. Чёрная дыра поглощает всё, к чему прикасается.
   * Возвращает число слияний.
   */
  function resolveCollisions(scene) {
    var bodies = scene.bodies;
    var n = bodies.length;
    if (n < 2) return 0;

    var dead = null;
    var merges = 0;
    var w = scene.width, h = scene.height;

    for (var i = 0; i < n; i++) {
      var a = bodies[i];
      if (!a || (dead && dead[i])) continue;
      for (var j = i + 1; j < n; j++) {
        var b = bodies[j];
        if (!b || (dead && dead[j])) continue;
        if (!a || (dead && dead[i])) break;

        var dx = b.x - a.x, dy = b.y - a.y;
        var sum = a.radius + b.radius;
        if (dx * dx + dy * dy > sum * sum) continue;

        // Выбор хозяина: чёрная дыра > большая масса; при равенстве — раньше в массиве.
        var host, gone;
        if (a.isBlackHole && !b.isBlackHole) { host = a; gone = b; }
        else if (b.isBlackHole && !a.isBlackHole) { host = b; gone = a; }
        else if (a.mass >= b.mass) { host = a; gone = b; }
        else { host = b; gone = a; }

        absorb(host, gone, w, h);

        var gi = (gone === a) ? i : j;
        if (!dead) dead = {};
        dead[gi] = true;
        merges++;

        if (gone === a) break; // текущее a поглощено, переходим к следующему i
      }
    }

    if (merges > 0) {
      var kept = [];
      for (i = 0; i < n; i++) {
        if (!dead || !dead[i]) kept.push(bodies[i]);
      }
      scene.bodies = kept;
    }
    return merges;
  }

  /* ------------------------------------------------------------------ *
   * Шаг симуляции
   * ------------------------------------------------------------------ */

  /**
   * Один полный шаг dt: ускорения → интеграция → wrap уже внутри интеграции → слияния.
   * Возвращает число слияний за шаг.
   */
  function step(scene, dt) {
    computeAccelerations(scene);
    integrate(scene, dt);
    if (scene.collide) return resolveCollisions(scene);
    return 0;
  }

  /** Прогрев ускорений, чтобы векторы ускорения были валидны до первого шага. */
  function refreshAccelerations(scene) {
    computeAccelerations(scene);
  }

  /** Круговая скорость для тела на радиусе r вокруг массы M. */
  function circularSpeed(G, M, r) {
    return Math.sqrt((G * M) / Math.max(r, 1e-6));
  }

  GS.physics = {
    computeAccelerations: computeAccelerations,
    integrate: integrate,
    resolveCollisions: resolveCollisions,
    step: step,
    refreshAccelerations: refreshAccelerations,
    circularSpeed: circularSpeed,
    wrapAxis: wrapAxis
  };
})();
