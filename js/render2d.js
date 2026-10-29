/*
 * render2d.js — GS.render2d
 * Рендерер Canvas 2D (минимализм: круг заливкой цветом, без градиентов по умолчанию).
 * Контракт бэкенда: init(canvas, view) / resize(view) / render(scene, view, opts) / dispose()
 * opts = { trails, vectors, vectorsA, glow, blackHoles }
 */
(function () {
  'use strict';

  var GS = window.GS;
  var U = GS.util;

  var BG = '#05070a';

  function createRenderer() {
    var canvas = null;
    var ctx = null;
    var view = null;
    var inited = false;

    function init(cv, v) {
      canvas = cv;
      ctx = cv.getContext('2d', { alpha: false });
      view = v;
      inited = true;
      // Старт без трейлов — сразу чистый фон.
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, cv.width, cv.height);
      return !!ctx;
    }

    function dispose() {
      ctx = null;
      canvas = null;
      view = null;
      inited = false;
    }

    /* ---------------- world → screen ---------------- */

    function screenX(b, v) { return b.x * v.scale + v.offsetX; }
    function screenY(b, v) { return b.y * v.scale + v.offsetY; }

    function clear(opts) {
      var w = canvas.width, h = canvas.height;
      // Трейлы: полупрозрачная заливка фона создаёт затухающий след.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      if (opts.trails) {
        ctx.fillStyle = U.rgba(BG, 0.15);
      } else {
        ctx.fillStyle = BG;
      }
      ctx.fillRect(0, 0, w, h);
    }

    function drawWorldFrame(v) {
      ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
      ctx.strokeStyle = 'rgba(70, 90, 115, 0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(v.offsetX + 0.5, v.offsetY + 0.5, v.worldW * v.scale, v.worldH * v.scale);
    }

    function drawVectors(scene, v, opts) {
      var bodies = scene.bodies;
      var n = bodies.length;
      var vScale = opts.vectorScale == null ? 0.06 : opts.vectorScale;
      var aScale = opts.accelScale == null ? 0.0015 : opts.accelScale;
      var drawA = !!opts.vectorsA;

      ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
      ctx.lineWidth = 1.2;

      for (var i = 0; i < n; i++) {
        var b = bodies[i];
        var sx = screenX(b, v), sy = screenY(b, v);

        if (opts.vectors) {
          var vx = b.vx * vScale, vy = b.vy * vScale;
          if (vx * vx + vy * vy > 0.25) {
            ctx.strokeStyle = 'rgba(160, 220, 255, 0.85)';
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(sx + vx, sy + vy);
            ctx.stroke();
          }
        }

        if (drawA) {
          var axx = b.ax * aScale, ayy = b.ay * aScale;
          if (axx * axx + ayy * ayy > 0.25) {
            ctx.strokeStyle = 'rgba(255, 170, 120, 0.75)';
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(sx + axx, sy + ayy);
            ctx.stroke();
          }
        }
      }
    }

    function drawBodies(scene, v, opts) {
      var bodies = scene.bodies;
      var n = bodies.length;
      var glow = !!opts.glow;
      var showBH = opts.blackHoles !== false;

      ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);

      for (var i = 0; i < n; i++) {
        var b = bodies[i];
        var sx = screenX(b, v), sy = screenY(b, v);
        var r = Math.max(1.5, b.radius * v.scale);
        var maxR = Math.max(r, 0.5);

        if (b.isBlackHole && showBH) {
          // Аккреционный ореол
          if (glow && maxR > 3) {
            var g = ctx.createRadialGradient(sx, sy, maxR, sx, sy, maxR * 3.2);
            g.addColorStop(0, 'rgba(255, 160, 60, 0.55)');
            g.addColorStop(0.5, 'rgba(200, 80, 220, 0.22)');
            g.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(sx, sy, maxR * 3.2, 0, U.TAU);
            ctx.fill();
          } else {
            ctx.strokeStyle = 'rgba(255, 150, 60, 0.55)';
            ctx.lineWidth = Math.max(1, maxR * 0.35);
            ctx.beginPath();
            ctx.arc(sx, sy, maxR * 1.7, 0, U.TAU);
            ctx.stroke();
          }
          ctx.fillStyle = '#000000';
          ctx.beginPath();
          ctx.arc(sx, sy, maxR, 0, U.TAU);
          ctx.fill();
          continue;
        }

        if (glow && maxR > 2.5) {
          var gg = ctx.createRadialGradient(sx, sy, 0, sx, sy, maxR * 2.6);
          gg.addColorStop(0, U.rgba(b.color, 0.9));
          gg.addColorStop(0.35, U.rgba(b.color, 0.35));
          gg.addColorStop(1, U.rgba(b.color, 0));
          ctx.fillStyle = gg;
          ctx.beginPath();
          ctx.arc(sx, sy, maxR * 2.6, 0, U.TAU);
          ctx.fill();
        }

        ctx.fillStyle = b.color;
        ctx.beginPath();
        ctx.arc(sx, sy, maxR, 0, U.TAU);
        ctx.fill();
      }
    }

    function drawBrushPreview(v, cursor) {
      if (!cursor || !cursor.visible) return;
      var r = Math.max(1.5, cursor.radius * v.scale);
      ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
      ctx.strokeStyle = U.rgba(cursor.color, 0.8);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, r, 0, U.TAU);
      ctx.stroke();

      if (cursor.launchX != null) {
        ctx.strokeStyle = 'rgba(255, 220, 130, 0.9)';
        ctx.beginPath();
        ctx.moveTo(cursor.x, cursor.y);
        ctx.lineTo(cursor.launchX, cursor.launchY);
        ctx.stroke();
      }
    }

    function render(scene, v, opts) {
      if (!inited) return;
      opts = opts || {};
      view = v;

      clear(opts);
      drawWorldFrame(v);
      drawBodies(scene, v, opts);
      drawVectors(scene, v, opts);
      if (opts.cursor) drawBrushPreview(v, opts.cursor);

      // Композит после сброса трансформа в clear.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    return {
      kind: '2d',
      init: init,
      resize: function (v) { view = v; },
      render: render,
      dispose: dispose,
      isReady: function () { return inited; }
    };
  }

  GS.render2d = {
    create: createRenderer,
    BG: BG
  };
})();
