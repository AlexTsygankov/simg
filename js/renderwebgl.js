/*
 * renderwebgl.js — GS.renderwebgl
 * Минимальный raw-WebGL рендерер: point sprites (gl_PointCoord-диск), линии для векторов,
 * опциональные трейлы через FBO ping-pong с alpha-затуханием.
 * Контракт идентичен render2d: init(canvas, view) / resize(view) / render(scene, view, opts) / dispose()
 */
(function () {
  'use strict';

  var GS = window.GS;
  var U = GS.util;

  var BG = [5 / 255, 7 / 255, 10 / 255];
  var FRAME_COLOR = [70 / 255, 90 / 255, 115 / 255, 0.35];
  var TRAIL_FADE = 0.86;
  var CURSOR_SEGMENTS = 48;

  /* ------------------------------------------------------------------ *
   * Шейдеры
   * ------------------------------------------------------------------ */

  var POINT_VS = [
    'attribute vec2 a_pos;',
    'attribute vec3 a_color;',
    'attribute float a_size;',
    'varying vec3 v_color;',
    'void main(void) {',
    '  gl_Position = vec4(a_pos, 0.0, 1.0);',
    '  gl_PointSize = a_size;',
    '  v_color = a_color;',
    '}'
  ].join('\n');

  var POINT_FS = [
    'precision mediump float;',
    'varying vec3 v_color;',
    'uniform float u_alpha;',
    'void main(void) {',
    '  vec2 c = gl_PointCoord - vec2(0.5, 0.5);',
    '  float d = length(c);',
    '  if (d > 0.5) discard;',
    '  float a = u_alpha * smoothstep(0.5, 0.44, d);',
    '  gl_FragColor = vec4(v_color, a);',
    '}'
  ].join('\n');

  var LINE_VS = [
    'attribute vec2 a_pos;',
    'attribute vec4 a_color;',
    'varying vec4 v_color;',
    'void main(void) {',
    '  gl_Position = vec4(a_pos, 0.0, 1.0);',
    '  v_color = a_color;',
    '}'
  ].join('\n');

  var LINE_FS = [
    'precision mediump float;',
    'varying vec4 v_color;',
    'void main(void) {',
    '  gl_FragColor = v_color;',
    '}'
  ].join('\n');

  var QUAD_VS = [
    'attribute vec2 a_quad;',
    'varying vec2 v_uv;',
    'void main(void) {',
    '  gl_Position = vec4(a_quad, 0.0, 1.0);',
    '  v_uv = a_quad * 0.5 + 0.5;',
    '}'
  ].join('\n');

  var FADE_FS = [
    'precision mediump float;',
    'varying vec2 v_uv;',
    'uniform sampler2D u_tex;',
    'uniform float u_fade;',
    'void main(void) {',
    '  vec3 c = texture2D(u_tex, v_uv).rgb;',
    '  gl_FragColor = vec4(c * u_fade, 1.0);',
    '}'
  ].join('\n');

  var BLIT_FS = [
    'precision mediump float;',
    'varying vec2 v_uv;',
    'uniform sampler2D u_tex;',
    'void main(void) {',
    '  vec4 c = texture2D(u_tex, v_uv);',
    '  gl_FragColor = vec4(c.rgb, 1.0);',
    '}'
  ].join('\n');

  /* ------------------------------------------------------------------ *
   * Утилиты GL
   * ------------------------------------------------------------------ */

  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error('Shader compile error: ' + log);
    }
    return s;
  }

  function program(gl, vsSrc, fsSrc, attrs, uniforms) {
    var vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
    var fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
    var p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      var log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error('Program link error: ' + log);
    }
    var out = { program: p, a: {}, u: {} };
    (attrs || []).forEach(function (name) { out.a[name] = gl.getAttribLocation(p, name); });
    (uniforms || []).forEach(function (name) { out.u[name] = gl.getUniformLocation(p, name); });
    return out;
  }

  /** Динамический float-буфер с автоматическим ростом. WebGL1-совместимая загрузка. */
  function makeDynBuffer(gl, target) {
    var buf = gl.createBuffer();
    var capacityFloats = 0;
    return {
      buffer: buf,
      upload: function (data, count) {
        gl.bindBuffer(target, buf);
        if (count > capacityFloats) {
          capacityFloats = Math.max(count, Math.ceil(count * 1.5));
          gl.bufferData(target, capacityFloats * 4, gl.DYNAMIC_DRAW);
        }
        // Только 3-аргументный bufferSubData: 5-аргументная форма — WebGL2.
        gl.bufferSubData(target, 0, data.subarray(0, count));
      },
      dispose: function () { gl.deleteBuffer(buf); }
    };
  }

  function makeScratchF32(initial) {
    var scratch = new Float32Array(initial);
    return function (need) {
      if (need > scratch.length) scratch = new Float32Array(Math.max(need, Math.ceil(need * 1.5)));
      return scratch;
    };
  }

  function makeFbo(gl, w, h) {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    var fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(BG[0], BG[1], BG[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return {
      fb: fb, tex: tex, w: w, h: h,
      resize: function (nw, nh) {
        if (nw === this.w && nh === this.h) return;
        this.w = nw; this.h = nh;
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, nw, nh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
        gl.clearColor(BG[0], BG[1], BG[2], 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      },
      dispose: function () {
        gl.deleteFramebuffer(this.fb);
        gl.deleteTexture(this.tex);
      }
    };
  }

  /* ------------------------------------------------------------------ *
   * Рендерер
   * ------------------------------------------------------------------ */

  function create() {
    var gl = null;
    var canvas = null;
    var view = null;
    var dpr = 1;
    var pixelW = 1, pixelH = 1;
    var inited = false;
    var trailsActive = false;

    var pointProg, lineProg, fadeProg, blitProg;
    var pointBuf, lineBuf, quadBuf;
    var fboA, fboB;
    var getPointScratch = makeScratchF32(4096);
    var getLineScratch = makeScratchF32(4096);
    var getQuadScratch = makeScratchF32(8);

    function glError(msg) {
      var e = gl.getError();
      if (e !== gl.NO_ERROR) console.warn('WebGL:', msg, '0x' + e.toString(16));
    }

    function init(cv, v) {
      canvas = cv;
      view = v;
      var attribs = { alpha: false, antialias: false, depth: false, stencil: false };
      gl = cv.getContext('webgl', attribs) || cv.getContext('experimental-webgl', attribs);
      if (!gl) return false;

      try {
        pointProg = program(gl, POINT_VS, POINT_FS,
          ['a_pos', 'a_color', 'a_size'], ['u_alpha']);
        lineProg = program(gl, LINE_VS, LINE_FS, ['a_pos', 'a_color'], []);
        fadeProg = program(gl, QUAD_VS, FADE_FS, ['a_quad'], ['u_tex', 'u_fade']);
        blitProg = program(gl, QUAD_VS, BLIT_FS, ['a_quad'], ['u_tex']);
      } catch (e) {
        console.error(e);
        return false;
      }

      pointBuf = makeDynBuffer(gl, gl.ARRAY_BUFFER);
      lineBuf = makeDynBuffer(gl, gl.ARRAY_BUFFER);

      quadBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

      fboA = makeFbo(gl, 1, 1);
      fboB = makeFbo(gl, 1, 1);

      gl.disable(gl.DEPTH_TEST);
      gl.clearColor(BG[0], BG[1], BG[2], 1);
      inited = true;
      resize(v);
      return true;
    }

    function dispose() {
      if (!gl) return;
      if (fboA) fboA.dispose();
      if (fboB) fboB.dispose();
      if (pointBuf) pointBuf.dispose();
      if (lineBuf) lineBuf.dispose();
      gl = null;
      inited = false;
    }

    function resize(v) {
      view = v;
      if (!gl) return;
      pixelW = canvas.width;
      pixelH = canvas.height;
      dpr = v.dpr || 1;
      gl.viewport(0, 0, pixelW, pixelH);
      fboA.resize(pixelW, pixelH);
      fboB.resize(pixelW, pixelH);
    }

    /* -------- world → NDC -------- */

    function ndcX(wx) {
      var px = (wx * view.scale + view.offsetX) * dpr;
      return (px / pixelW) * 2 - 1;
    }
    function ndcY(wy) {
      var px = (wy * view.scale + view.offsetY) * dpr;
      return 1 - (px / pixelH) * 2;
    }
    function pointSize(worldRadius) {
      return Math.max(2, worldRadius * view.scale * dpr * 2);
    }

    /* -------- построение данных -------- */

    function buildPoints(scene, opts) {
      var bodies = scene.bodies;
      var n = bodies.length;
      var scratch = getPointScratch(n * 6);
      var o = 0;
      var alpha = 1;
      for (var i = 0; i < n; i++) {
        var b = bodies[i];
        var c = U.hexToRgb(b.isBlackHole && opts.blackHoles !== false ? '#000000' : b.color);
        scratch[o++] = ndcX(b.x);
        scratch[o++] = ndcY(b.y);
        scratch[o++] = c.r;
        scratch[o++] = c.g;
        scratch[o++] = c.b;
        scratch[o++] = pointSize(b.radius);
      }
      void alpha;
      return { data: scratch, count: n * 6 };
    }

    function pushLine(arr, o, x0, y0, x1, y1, color, alpha) {
      arr[o++] = ndcX(x0); arr[o++] = ndcY(y0);
      arr[o++] = color[0]; arr[o++] = color[1]; arr[o++] = color[2]; arr[o++] = alpha;
      arr[o++] = ndcX(x1); arr[o++] = ndcY(y1);
      arr[o++] = color[0]; arr[o++] = color[1]; arr[o++] = color[2]; arr[o++] = alpha;
      return o;
    }

    function buildFrameAndVectors(scene, opts) {
      var bodies = scene.bodies;
      var n = bodies.length;
      var i, b;
      var bhCount = 0;
      if (opts.blackHoles !== false) {
        for (i = 0; i < n; i++) if (bodies[i].isBlackHole) bhCount++;
      }
      var cursorFloats = (opts.cursor && opts.cursor.visible) ? (CURSOR_SEGMENTS + 1) * 12 : 0;
      var need = 12 + n * 12 + n * 12 + bhCount * CURSOR_SEGMENTS * 12 + cursorFloats + 64;
      var arr = getLineScratch(need);
      var o = 0;
      var w = scene.width, h = scene.height;

      // рамка мира
      o = pushLine(arr, o, 0, 0, w, 0, FRAME_COLOR, 1);
      o = pushLine(arr, o, w, 0, w, h, FRAME_COLOR, 1);
      o = pushLine(arr, o, w, h, 0, h, FRAME_COLOR, 1);
      o = pushLine(arr, o, 0, h, 0, 0, FRAME_COLOR, 1);

      if (opts.vectors) {
        var vScale = opts.vectorScale == null ? 0.06 : opts.vectorScale;
        var vcol = [160 / 255, 220 / 255, 255 / 255];
        for (i = 0; i < n; i++) {
          b = bodies[i];
          o = pushLine(arr, o, b.x, b.y, b.x + b.vx * vScale, b.y + b.vy * vScale, vcol, 0.85);
        }
      }
      if (opts.vectorsA) {
        var aScale = opts.accelScale == null ? 0.0015 : opts.accelScale;
        var acol = [255 / 255, 170 / 255, 120 / 255];
        for (i = 0; i < n; i++) {
          b = bodies[i];
          o = pushLine(arr, o, b.x, b.y, b.x + b.ax * aScale, b.y + b.ay * aScale, acol, 0.75);
        }
      }

      var circles = buildCursorLines(arr, o, opts.cursor);
      o = circles;

      // ореолы чёрных дыр
      if (opts.blackHoles !== false) {
        var bhCol = [255 / 255, 150 / 255, 60 / 255];
        for (i = 0; i < n; i++) {
          b = bodies[i];
          if (!b.isBlackHole) continue;
          var rr = b.radius * 1.7;
          for (var s = 0; s < CURSOR_SEGMENTS; s++) {
            var t0 = (s / CURSOR_SEGMENTS) * U.TAU;
            var t1 = ((s + 1) / CURSOR_SEGMENTS) * U.TAU;
            o = pushLine(arr, o,
              b.x + Math.cos(t0) * rr, b.y + Math.sin(t0) * rr,
              b.x + Math.cos(t1) * rr, b.y + Math.sin(t1) * rr,
              bhCol, 0.55);
          }
        }
      }

      return { data: arr, count: o };
    }

    function buildCursorLines(arr, o, cur) {
      if (!cur || !cur.visible) return o;
      var col = U.hexToRgb(cur.color);
      var c3 = [col.r, col.g, col.b];
      var r = Math.max(cur.radius, 1);
      for (var s = 0; s < CURSOR_SEGMENTS; s++) {
        var t0 = (s / CURSOR_SEGMENTS) * U.TAU;
        var t1 = ((s + 1) / CURSOR_SEGMENTS) * U.TAU;
        o = pushLine(arr, o,
          cur.x + Math.cos(t0) * r, cur.y + Math.sin(t0) * r,
          cur.x + Math.cos(t1) * r, cur.y + Math.sin(t1) * r,
          c3, 0.8);
      }
      if (cur.launchX != null) {
        o = pushLine(arr, o, cur.x, cur.y, cur.launchX, cur.launchY, [1, 0.86, 0.5], 0.9);
      }
      return o;
    }

    /* -------- отрисовка -------- */

    function bindPointAttribs() {
      var a = pointProg.a;
      gl.bindBuffer(gl.ARRAY_BUFFER, pointBuf.buffer);
      gl.enableVertexAttribArray(a.a_pos);
      gl.vertexAttribPointer(a.a_pos, 2, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(a.a_color);
      gl.vertexAttribPointer(a.a_color, 3, gl.FLOAT, false, 24, 8);
      gl.enableVertexAttribArray(a.a_size);
      gl.vertexAttribPointer(a.a_size, 1, gl.FLOAT, false, 24, 20);
    }

    function bindLineAttribs() {
      var a = lineProg.a;
      gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf.buffer);
      gl.enableVertexAttribArray(a.a_pos);
      gl.vertexAttribPointer(a.a_pos, 2, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(a.a_color);
      gl.vertexAttribPointer(a.a_color, 4, gl.FLOAT, false, 24, 8);
    }

    function drawSceneContents(scene, opts) {
      var pts = buildPoints(scene, opts);
      gl.useProgram(pointProg.program);
      pointBuf.upload(pts.data, pts.count);
      bindPointAttribs();
      gl.uniform1f(pointProg.u.u_alpha, 1);
      gl.drawArrays(gl.POINTS, 0, pts.count / 6);

      var lines = buildFrameAndVectors(scene, opts);
      if (lines.count > 0) {
        gl.useProgram(lineProg.program);
        lineBuf.upload(lines.data, lines.count);
        bindLineAttribs();
        gl.drawArrays(gl.LINES, 0, lines.count / 6);
      }
    }

    function drawQuad(prog) {
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.enableVertexAttribArray(prog.a.a_quad);
      gl.vertexAttribPointer(prog.a.a_quad, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    function renderTrails(scene, opts) {
      var src = fboA, dst = fboB;

      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
      gl.viewport(0, 0, dst.w, dst.h);
      gl.disable(gl.BLEND);
      gl.useProgram(fadeProg.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(fadeProg.u.u_tex, 0);
      gl.uniform1f(fadeProg.u.u_fade, TRAIL_FADE);
      drawQuad(fadeProg);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      drawSceneContents(scene, opts);
      gl.disable(gl.BLEND);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, pixelW, pixelH);
      gl.useProgram(blitProg.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, dst.tex);
      gl.uniform1i(blitProg.u.u_tex, 0);
      drawQuad(blitProg);

      // ping-pong: dst становится источником следующего кадра
      fboA = dst;
      fboB = src;
    }

    function renderPlain(scene, opts) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, pixelW, pixelH);
      gl.clearColor(BG[0], BG[1], BG[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      drawSceneContents(scene, opts);
      gl.disable(gl.BLEND);
    }

    function render(scene, v, opts) {
      if (!inited || !gl) return;
      view = v;
      opts = opts || {};

      if (gl.canvas.width !== pixelW || gl.canvas.height !== pixelH) resize(v);

      if (opts.trails) {
        if (!trailsActive) {
          // Включение трейлов: стартуем с чистой истории.
          [fboA, fboB].forEach(function (f) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb);
            gl.viewport(0, 0, f.w, f.h);
            gl.clearColor(BG[0], BG[1], BG[2], 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
          });
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          trailsActive = true;
        }
        renderTrails(scene, opts);
      } else {
        trailsActive = false;
        renderPlain(scene, opts);
      }
      void glError;
    }

    return {
      kind: 'webgl',
      init: init,
      resize: resize,
      render: render,
      dispose: dispose,
      isReady: function () { return inited; }
    };
  }

  GS.renderwebgl = {
    create: create,
    BG: BG
  };
})();
