/**
 * Lumen Studio — light & tone engine.
 *
 * One pass of per-pixel colour grading followed by a few additive light
 * composites. Everything is plain Canvas 2D + typed arrays so the tool runs
 * offline on the user's device with no dependencies.
 */
(function () {
  "use strict";

  var IS = (window.IS = window.IS || {});

  // ---- shared helpers -------------------------------------------------

  var pool = new Map();

  function cvs(key, w, h) {
    var c = pool.get(key);
    if (!c) {
      c = document.createElement("canvas");
      pool.set(key, c);
    }
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    return c;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function clamp255(v) {
    return v < 0 ? 0 : v > 255 ? 255 : v;
  }

  function sstep(e0, e1, x) {
    var t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function hexToRgb(hex) {
    var h = String(hex || "#000000").replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) return [0, 0, 0];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function hslToRgb(h, s, l) {
    h = ((h % 1) + 1) % 1;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h * 6) % 2) - 1));
    var m = l - c / 2;
    var r = 0, g = 0, b = 0;
    if (h < 1 / 6) { r = c; g = x; }
    else if (h < 2 / 6) { r = x; g = c; }
    else if (h < 3 / 6) { g = c; b = x; }
    else if (h < 4 / 6) { g = x; b = c; }
    else if (h < 5 / 6) { r = x; b = c; }
    else { r = c; b = x; }
    return [
      Math.round((r + m) * 255),
      Math.round((g + m) * 255),
      Math.round((b + m) * 255),
    ];
  }

  /** Colours a split-tone pushes each channel towards, centred on zero. */
  function hueOffsets(deg) {
    var rgb = hslToRgb(((deg % 360) + 360) % 360 / 360, 1, 0.5);
    var mean = (rgb[0] + rgb[1] + rgb[2]) / 3;
    return [(rgb[0] - mean) / 255, (rgb[1] - mean) / 255, (rgb[2] - mean) / 255];
  }

  IS.util = { cvs: cvs, clamp: clamp, clamp255: clamp255, sstep: sstep, hexToRgb: hexToRgb, hslToRgb: hslToRgb };

  // ---- defaults & presets ---------------------------------------------

  var DEFAULT = {
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    saturation: 0,
    vibrance: 0,
    temperature: 0,
    tint: 0,
    fade: 0,
    clarity: 0,
    bloom: 0,
    grain: 0,
    vignette: 0,
    lightLeak: 0,
    leakHue: 30,
    splitAmount: 0,
    splitShadow: 208,
    splitHighlight: 38,
    duotone: 0,
    duotoneA: "#1d2b4a",
    duotoneB: "#f3b562",
  };

  var PRESETS = {
    Original: {},
    "Golden Hour": { exposure: 0.24, temperature: 38, highlights: -18, shadows: 15, saturation: 8, vibrance: 12, bloom: 28, lightLeak: 24, leakHue: 32, vignette: 14, fade: 6 },
    Cinematic: { contrast: 14, temperature: -15, shadows: 12, highlights: -12, saturation: -8, clarity: 14, splitAmount: 26, splitShadow: 205, splitHighlight: 36, bloom: 14, vignette: 26 },
    Noir: { contrast: 22, saturation: -100, clarity: 22, vignette: 42, grain: 24, shadows: -8 },
    "Neon Night": { temperature: -30, tint: 14, saturation: 22, contrast: 10, bloom: 44, vignette: 38, lightLeak: 26, leakHue: 305 },
    "Film Fade": { contrast: -12, fade: 46, saturation: -4, grain: 18, shadows: 18, highlights: -14 },
    "Soft Bloom": { exposure: 0.12, bloom: 52, highlights: -12, shadows: 10, saturation: 4, vignette: 8 },
    Duotone: { duotone: 100, duotoneA: "#1d2b4a", duotoneB: "#f3b562", contrast: 6 },
  };

  // ---- noise tile for grain -------------------------------------------

  var noiseTile = null;

  function getNoise() {
    if (noiseTile) return noiseTile;
    var size = 160;
    var c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    var cx = c.getContext("2d");
    var img = cx.createImageData(size, size);
    var d = img.data;
    for (var i = 0; i < d.length; i += 4) {
      var v = 128 + (Math.random() - 0.5) * 255;
      d[i] = v;
      d[i + 1] = v;
      d[i + 2] = v;
      d[i + 3] = 255;
    }
    cx.putImageData(img, 0, 0);
    noiseTile = c;
    return c;
  }

  // ---- tone pass -------------------------------------------------------

  function tonePass(img, p, w, h) {
    var d = img.data;
    var expMul = p.exposure ? Math.pow(2, p.exposure) : 1;
    var contrast = 1 + (p.contrast || 0) / 100;
    var hi = (p.highlights || 0) / 100;
    var sh = (p.shadows || 0) / 100;
    var sat = 1 + (p.saturation || 0) / 100;
    var vib = (p.vibrance || 0) / 100;
    var temp = (p.temperature || 0) / 100;
    var tint = (p.tint || 0) / 100;
    var fade = (p.fade || 0) / 100;
    var vig = (p.vignette || 0) / 100;
    var leak = (p.lightLeak || 0) / 100;
    var splitAmt = (p.splitAmount || 0) / 100;
    var duo = (p.duotone || 0) / 100;

    if (!expMul && !contrast && !hi && !sh && !vib && !temp && !tint &&
        !fade && !vig && !leak && !splitAmt && !duo && sat === 1) {
      return;
    }

    var duoA = hexToRgb(p.duotoneA);
    var duoB = hexToRgb(p.duotoneB);
    var shOff = hueOffsets(p.splitShadow);
    var hiOff = hueOffsets(p.splitHighlight);
    var leakRGB = hslToRgb(((p.leakHue || 30) % 360) / 360, 1, 0.6);

    var invW = 1 / w;
    var invH = 1 / h;
    var needDist = vig > 0 || leak > 0;

    for (var y = 0; y < h; y++) {
      var ny = y * invH;
      for (var x = 0; x < w; x++) {
        var i = (y * w + x) * 4;
        if (d[i + 3] === 0) continue;

        var r = d[i] / 255;
        var g = d[i + 1] / 255;
        var b = d[i + 2] / 255;

        if (expMul !== 1) { r *= expMul; g *= expMul; b *= expMul; }

        if (temp !== 0) { r += temp * 0.09; b -= temp * 0.09; }
        if (tint !== 0) { g -= tint * 0.07; r += tint * 0.02; b += tint * 0.02; }

        if (contrast !== 1) {
          r = (r - 0.5) * contrast + 0.5;
          g = (g - 0.5) * contrast + 0.5;
          b = (b - 0.5) * contrast + 0.5;
        }

        var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;

        if (hi !== 0 || sh !== 0) {
          var add = hi * sstep(0.45, 1.0, lum) * 0.42 + sh * sstep(0.55, 0.0, lum) * 0.42;
          r += add; g += add; b += add;
          lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        }

        if (sat !== 1) {
          r = lum + (r - lum) * sat;
          g = lum + (g - lum) * sat;
          b = lum + (b - lum) * sat;
        }

        if (vib !== 0) {
          var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
          var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
          var s = clamp(mx - mn, 0, 1);
          var k = 1 + vib * (1 - s);
          r = lum + (r - lum) * k;
          g = lum + (g - lum) * k;
          b = lum + (b - lum) * k;
        }

        if (fade > 0) {
          r = r * (1 - fade * 0.55) + fade * 0.17;
          g = g * (1 - fade * 0.55) + fade * 0.17;
          b = b * (1 - fade * 0.55) + fade * 0.17;
        }

        if (splitAmt > 0) {
          var sl = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          var shW = clamp(1 - sl * 1.7, 0, 1);
          var hiW = clamp(sl * 1.7 - 0.7, 0, 1);
          r += (shOff[0] * shW + hiOff[0] * hiW) * 0.22 * splitAmt;
          g += (shOff[1] * shW + hiOff[1] * hiW) * 0.22 * splitAmt;
          b += (shOff[2] * shW + hiOff[2] * hiW) * 0.22 * splitAmt;
        }

        if (duo > 0) {
          var dl = clamp(0.2126 * r + 0.7152 * g + 0.0722 * b, 0, 1);
          var tr = (duoA[0] + (duoB[0] - duoA[0]) * dl) / 255;
          var tg = (duoA[1] + (duoB[1] - duoA[1]) * dl) / 255;
          var tb = (duoA[2] + (duoB[2] - duoA[2]) * dl) / 255;
          r += (tr - r) * duo;
          g += (tg - g) * duo;
          b += (tb - b) * duo;
        }

        if (needDist) {
          if (vig > 0) {
            var dx = x * invW - 0.5;
            var dy = y * invH - 0.5;
            var dist = Math.sqrt(dx * dx + dy * dy) / 0.7071;
            var vf = 1 - vig * Math.pow(clamp(dist, 0, 1), 1.6) * 0.92;
            r *= vf; g *= vf; b *= vf;
          }
          if (leak > 0) {
            var lx = x * invW - 0.86;
            var ly = y * invH - 0.14;
            var ld = Math.sqrt(lx * lx + ly * ly) / 0.95;
            var la = 1 - clamp(ld, 0, 1);
            var lk = leak * la * la * 0.95;
            r += (leakRGB[0] / 255) * lk;
            g += (leakRGB[1] / 255) * lk;
            b += (leakRGB[2] / 255) * lk;
          }
        }

        d[i] = clamp255(r * 255);
        d[i + 1] = clamp255(g * 255);
        d[i + 2] = clamp255(b * 255);
      }
    }
  }

  // ---- clarity (unsharp on luminance) ---------------------------------

  function clarityPass(d, w, h, amount) {
    var n = w * h;
    var lum = new Float32Array(n);
    var i, p;
    for (p = 0, i = 0; p < n; p++, i += 4) {
      lum[p] = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    }
    var tmp = new Float32Array(n);
    var res = new Float32Array(n);
    var rad = 2;
    var x, y, k, xx, yy, s, c;

    for (y = 0; y < h; y++) {
      var row = y * w;
      for (x = 0; x < w; x++) {
        s = 0; c = 0;
        for (k = -rad; k <= rad; k++) {
          xx = x + k;
          if (xx >= 0 && xx < w) { s += lum[row + xx]; c++; }
        }
        tmp[row + x] = s / c;
      }
    }
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        s = 0; c = 0;
        for (k = -rad; k <= rad; k++) {
          yy = y + k;
          if (yy >= 0 && yy < h) { s += tmp[yy * w + x]; c++; }
        }
        res[y * w + x] = s / c;
      }
    }

    var amt = amount * 1.25;
    for (p = 0, i = 0; p < n; p++, i += 4) {
      if (d[i + 3] === 0) continue;
      var diff = (lum[p] - res[p]) * amt;
      if (diff === 0) continue;
      d[i] = clamp255(d[i] + diff);
      d[i + 1] = clamp255(d[i + 1] + diff);
      d[i + 2] = clamp255(d[i + 2] + diff);
    }
  }

  // ---- render ----------------------------------------------------------

  /**
   * Draw `source` onto `target` with the full light & tone stack applied.
   * Alpha from the source is preserved, so cutouts stay cut out.
   */
  function render(target, source, p, w, h) {
    var tctx = target.getContext("2d");
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.globalCompositeOperation = "source-over";
    tctx.globalAlpha = 1;
    tctx.clearRect(0, 0, w, h);
    tctx.drawImage(source, 0, 0, w, h);

    var img = tctx.getImageData(0, 0, w, h);
    tonePass(img, p, w, h);
    if (p.clarity > 0) clarityPass(img.data, w, h, p.clarity / 100);
    tctx.putImageData(img, 0, 0);

    // Bloom: bright pass of a downscaled copy, scaled back up (which blurs it),
    // added on top with "lighter".
    if (p.bloom > 0) {
      var bw = Math.max(2, Math.round(w / 4));
      var bh = Math.max(2, Math.round(h / 4));
      var small = cvs("bloom", bw, bh);
      var sctx = small.getContext("2d");
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.globalCompositeOperation = "source-over";
      sctx.clearRect(0, 0, bw, bh);
      sctx.filter = "brightness(0.92) contrast(1.75)";
      sctx.drawImage(target, 0, 0, bw, bh);
      sctx.filter = "none";

      tctx.globalCompositeOperation = "lighter";
      tctx.globalAlpha = (p.bloom / 100) * 0.6;
      tctx.imageSmoothingEnabled = true;
      tctx.imageSmoothingQuality = "high";
      tctx.drawImage(small, 0, 0, w, h);
      tctx.globalAlpha = 1;
      tctx.globalCompositeOperation = "source-over";
    }

    // Grain, then restore the original alpha so transparent areas stay clear.
    if (p.grain > 0) {
      var tile = getNoise();
      var pattern = tctx.createPattern(tile, "repeat");
      if (pattern) {
        tctx.save();
        tctx.globalCompositeOperation = "overlay";
        tctx.globalAlpha = (p.grain / 100) * 0.5;
        var ox = Math.random() * tile.width;
        var oy = Math.random() * tile.height;
        tctx.translate(-ox, -oy);
        tctx.fillStyle = pattern;
        tctx.fillRect(0, 0, w + tile.width, h + tile.height);
        tctx.restore();
      }
    }

    if (p.bloom > 0 || p.grain > 0) {
      var maskSrc = cvs("alphaMask", w, h);
      var mctx = maskSrc.getContext("2d");
      mctx.setTransform(1, 0, 0, 1, 0, 0);
      mctx.globalCompositeOperation = "source-over";
      mctx.clearRect(0, 0, w, h);
      mctx.drawImage(source, 0, 0, w, h);
      tctx.globalCompositeOperation = "destination-in";
      tctx.drawImage(maskSrc, 0, 0, w, h);
      tctx.globalCompositeOperation = "source-over";
    }
  }

  IS.Effects = {
    DEFAULT: DEFAULT,
    PRESETS: PRESETS,
    render: render,
  };
})();
