/*
 * presets.js — GS.presets
 * 4 фабрики сцен. Мир 1000x1000, G≈1, массы 1..100 (кроме центрального тяжёлого тела).
 */
(function () {
  'use strict';

  var GS = window.GS;
  var U = GS.util;

  var W = 1000, H = 1000;

  function baseScene(name) {
    var s = GS.makeScene(W, H);
    s.name = name;
    s.G = 1;
    s.softEpsilon = 4;
    s.collide = true;
    return s;
  }

  /**
   * Тело на круговой орбите вокруг центра с массой centralMass.
   * bodyWithOrbit(cx, cy, dist, angle, centralMass, hostMass, color, velOffset)
   * velOffset добавляется к орбитальной скорости (скорость самого центра).
   */
  function bodyWithOrbit(cx, cy, dist, angle, centralMass, hostMass, color, velOffset) {
    var G = 1;
    var x = cx + Math.cos(angle) * dist;
    var y = cy + Math.sin(angle) * dist;
    var v = GS.physics.circularSpeed(G, centralMass + hostMass, dist);
    var b = GS.makeBody({
      x: x, y: y,
      vx: -Math.sin(angle) * v + (velOffset ? velOffset.vx : 0),
      vy: Math.cos(angle) * v + (velOffset ? velOffset.vy : 0),
      mass: hostMass,
      color: color
    });
    return b;
  }

  /* ------------------------------------------------------------------ *
   * 1. Солнечная система
   * ------------------------------------------------------------------ */

  function solar(seed) {
    var s = baseScene('solar');
    s.softEpsilon = 6;
    var cx = 500, cy = 500;
    var sunMass = 9000;

    var sun = GS.makeBody({
      x: cx, y: cy, mass: sunMass, radius: 22,
      color: '#ffd479', fixed: true
    });
    s.bodies.push(sun);

    var palette = ['#7fd4ff', '#a6f28c', '#ff8f6b', '#c79bff', '#6bf0e0'];
    var distances = [90, 140, 200, 275, 360];
    for (var i = 0; i < distances.length; i++) {
      var m = 6 + i * 3;
      s.bodies.push(bodyWithOrbit(cx, cy, distances[i], i * 1.1, sunMass, m, palette[i]));
    }
    return s;
  }

  /* ------------------------------------------------------------------ *
   * 2. Двойная звезда
   * ------------------------------------------------------------------ */

  function binary(seed) {
    var s = baseScene('binary');
    s.softEpsilon = 5;
    var cx = 500, cy = 500;
    var m = 4000;
    var sep = 150;                 // расстояние между звёздами
    var r = sep / 2;               // радиус орбиты каждой вокруг барицентра
    // Две равные массы: v = sqrt(G·M/(2·sep))
    var v = Math.sqrt((1 * m) / (2 * sep));

    var starA = GS.makeBody({ x: cx - r, y: cy, vy: -v, mass: m, radius: 16, color: '#ffd479' });
    var starB = GS.makeBody({ x: cx + r, y: cy, vy: v, mass: m, radius: 16, color: '#ff9ecb' });
    s.bodies.push(starA, starB);

    // Тесные спутники вокруг звезды A (иерархическая система); скорость звезды добавляется.
    var moons = [
      { dist: 42, angle: 0.4, mass: 3, color: '#7fd4ff' },
      { dist: 66, angle: 3.1, mass: 5, color: '#a6f28c' }
    ];
    for (var i = 0; i < moons.length; i++) {
      s.bodies.push(bodyWithOrbit(starA.x, starA.y, moons[i].dist, moons[i].angle, m, moons[i].mass, moons[i].color, { vx: 0, vy: -v }));
    }

    // Широкие спутники вокруг барицентра: чувствуют бинарность пары.
    var wide = [
      { dist: 280, angle: 0.6, mass: 4, color: '#6bf0e0' },
      { dist: 340, angle: 2.2, mass: 6, color: '#8fa6ff' },
      { dist: 400, angle: 4.4, mass: 8, color: '#c79bff' }
    ];
    for (i = 0; i < wide.length; i++) {
      s.bodies.push(bodyWithOrbit(cx, cy, wide[i].dist, wide[i].angle, 2 * m, wide[i].mass, wide[i].color));
    }
    return s;
  }

  /* ------------------------------------------------------------------ *
   * 3. Хаос / скопление
   * ------------------------------------------------------------------ */

  function chaos(seed) {
    var s = baseScene('chaos');
    s.softEpsilon = 10;
    var rnd = U.makeRandom(seed || 1234567);
    var n = 48;
    var cx = W / 2, cy = H / 2;
    var spread = 300;

    // Плотный «центр масс» скопления
    for (var i = 0; i < n; i++) {
      var ang = rnd() * U.TAU;
      var rad = Math.sqrt(rnd()) * spread;
      var mass = 1 + Math.pow(rnd(), 2) * 30;
      var color = GS.DEFAULT_COLORS[i % GS.DEFAULT_COLORS.length];
      var b = GS.makeBody({
        x: cx + Math.cos(ang) * rad,
        y: cy + Math.sin(ang) * rad,
        vx: (rnd() - 0.5) * 24,
        vy: (rnd() - 0.5) * 24,
        mass: mass,
        color: color
      });
      s.bodies.push(b);
    }
    return s;
  }

  /* ------------------------------------------------------------------ *
   * 4. Пусто
   * ------------------------------------------------------------------ */

  function empty() {
    return baseScene('empty');
  }

  var registry = {
    solar: { label: 'Солнечная система', make: solar },
    binary: { label: 'Двойная звезда', make: binary },
    chaos: { label: 'Хаос / скопление', make: chaos },
    empty: { label: 'Пусто', make: empty }
  };

  GS.presets = {
    solar: solar,
    binary: binary,
    chaos: chaos,
    empty: empty,
    registry: registry,
    /** Универсальный фабричный вызов по имени. */
    make: function (name, seed) {
      var entry = registry[name];
      if (!entry) throw new Error('Неизвестный пресет: ' + name);
      return entry.make(seed);
    },
    list: function () {
      return Object.keys(registry).map(function (k) {
        return { id: k, label: registry[k].label };
      });
    },
    DEFAULT: 'solar'
  };
})();
