/**
 * Lumen Studio — Vibe.
 *
 * Restyles the already-graded image: blocky mosaics, print/halftone texture,
 * traced ink outlines, procedural paper grain, and cutting pieces away.
 * Everything is deterministic (seeded), so the preview matches the export.
 * Original transparency from the cutout stage is preserved.
 */
(function () {
  "use strict";

  var IS = window.IS;
  var U = IS.util;

  var DEFAULT = {
    preset: "Original",
    posterize: 0, // 0/1 = off, 2..12 levels each channel
    mosaic: 0, // 0 = off, block size on a 1000px-wide reference
    halftone: 0, // 0..100 dot strength
    grain: 0, // 0..100
    paper: 0, // 0..100
    edge: 0, // 0..100 ink trace
    cut: 0, // 0..100
    cutStyle: "holes", // holes | stripes | blocks
  };

  var PRESETS = {
    Original: {},
    "Grain Mosaic": { mosaic: 15, grain: 46, posterize: 6 },
    Newsprint: { halftone: 84, paper: 55, grain: 18, posterize: 4 },
    "Ink Trace": { edge: 72, posterize: 4, paper: 22 },
    "Paper Grain": { paper: 82, grain: 28 },
    Risograph: { posterize: 3, halftone: 45, paper: 40, grain: 24 },
    "Cutout Collage": { cut: 32, posterize: 5, edge: 34 },
    Shredded: { cut: 46, cutStyle: "stripes", grain: 18 },
  };

  // ---- helpers ---------------------------------------------------------

  function mulberry(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hash2(x, y) {
    var n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
  }

  function isActive(p) {
    if (!p) return false;
    return (
      p.posterize > 1 ||
      p.mosaic > 0 ||
      p.halftone > 0 ||
      p.grain > 0 ||
      p.paper > 0 ||
      p.edge > 0 ||
      p.cut > 0
    );
  }

  // ---- passes ----------------------------------------------------------

  function mosaicPass(ctx, srcCanvas, w, h, block) {
    var sw = Math.max(1, Math.round(w / block));
    var sh = Math.max(1, Math.round(h / block));
    var small = U.cvs("vibeSmall", sw, sh);
    var sg = small.getContext("2d");
    sg.setTransform(1, 0, 0, 1, 0, 0);
    sg.globalCompositeOperation = "source-over";
    sg.clearRect(0, 0, sw, sh);
    sg.imageSmoothingEnabled = true;
    sg.imageSmoothingQuality = "high";
    sg.drawImage(srcCanvas, 0, 0, sw, sh);

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, w, h);
    ctx.restore();
  }

  function posterizePass(d, levels) {
    var n = Math.max(2, Math.min(12, Math.round(levels)));
    var step = 255 / (n - 1);
    var lut = new Uint8ClampedArray(256);
    for (var i = 0; i < 256; i++) lut[i] = Math.round(Math.round(i / step) * step);
    for (var k = 0; k < d.length; k += 4) {
      d[k] = lut[d[k]];
      d[k + 1] = lut[d[k + 1]];
      d[k + 2] = lut[d[k + 2]];
    }
  }

  function edgePass(d, w, h, amount) {
    var n = w * h;
    var lum = new Float32Array(n);
    var i, k;
    for (i = 0, k = 0; i < n; i++, k += 4) {
      lum[i] = 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2];
    }
    var strength = amount / 100;
    var thr = 76 - strength * 60;
    var soft = 44 + (1 - strength) * 60;

    for (var y = 1; y < h - 1; y++) {
      var row = y * w;
      for (var x = 1; x < w - 1; x++) {
        var p = row + x;
        var gx =
          -lum[p - w - 1] - 2 * lum[p - 1] - lum[p + w - 1] +
          lum[p - w + 1] + 2 * lum[p + 1] + lum[p + w + 1];
        var gy =
          -lum[p - w - 1] - 2 * lum[p - w] - lum[p - w + 1] +
          lum[p + w - 1] + 2 * lum[p + w] + lum[p + w + 1];
        var mag = Math.sqrt(gx * gx + gy * gy);
        if (mag <= thr) continue;
        var a = Math.min(0.9, ((mag - thr) / soft) * strength + 0.24 * strength);
        if (a <= 0) continue;
        var q = p * 4;
        d[q] = d[q] * (1 - a) + 15 * a;
        d[q + 1] = d[q + 1] * (1 - a) + 16 * a;
        d[q + 2] = d[q + 2] * (1 - a) + 22 * a;
      }
    }
  }

  function paperPass(d, w, h, amount, s) {
    var amt = amount / 100;
    var rnd = mulberry(0x9e3779b9);
    var g = Math.max(4, Math.round(20 * s));
    var cols = Math.ceil(w / g) + 2;
    var rows = Math.ceil(h / g) + 2;
    var blot = new Float32Array(cols * rows);
    var i;
    for (i = 0; i < blot.length; i++) blot[i] = rnd() - 0.5;

    var fiber = Math.max(5, Math.round(24 * s));

    // Column -> blot index, and a sine table for the fibre banding, so the
    // inner loop has no sin/divide per pixel.
    var colBlot = new Uint32Array(w);
    var colPhase = new Float32Array(w);
    for (i = 0; i < w; i++) {
      colBlot[i] = Math.floor(i / g);
      colPhase[i] = i / fiber;
    }
    var N = 2048;
    var sinT = new Float32Array(N);
    for (i = 0; i < N; i++) sinT[i] = Math.sin((i / N) * 6.283) * 0.5;

    for (var y = 0; y < h; y++) {
      var by = Math.floor(y / g) * cols;
      var rowPhase = (y * 0.35) / fiber;
      var q = y * w * 4;
      for (var x = 0; x < w; x++, q += 4) {
        var n = rnd() - 0.5;
        var low = blot[by + colBlot[x]];
        var phase = rowPhase + colPhase[x];
        var fib = sinT[(((phase - (phase | 0)) * N) | 0) & (N - 1)];
        var shade = n * 0.55 + low * 1.1 + fib * 0.22;
        var f = 1 + shade * amt * 0.55;
        d[q] = d[q] * f;
        d[q + 1] = d[q + 1] * f;
        d[q + 2] = d[q + 2] * f;
      }
    }
  }

  function grainPass(d, amount) {
    var amt = (amount / 100) * 44;
    var rnd = mulberry(0x1234abcd);
    for (var k = 0; k < d.length; k += 4) {
      if (d[k + 3] === 0) continue;
      var n = (rnd() - 0.5) * amt;
      d[k] += n;
      d[k + 1] += n;
      d[k + 2] += n;
    }
  }

  function halftonePass(ctx, img, w, h, amount, s) {
    var d = img.data;
    var cell = Math.max(3, Math.round(6.5 * s));
    var amt = amount / 100;
    var cols = Math.ceil(w / cell);
    var rows = Math.ceil(h / cell);
    var total = cols * rows;
    var buckets = 8;
    var sumR = new Float32Array(buckets);
    var sumG = new Float32Array(buckets);
    var sumB = new Float32Array(buckets);
    var count = new Float32Array(buckets);
    var bktOf = new Uint8Array(total);
    var lumOf = new Float32Array(total);
    var stride = Math.max(1, Math.floor(cell / 3));

    var cx, cy, x, y, q;
    for (cy = 0; cy < rows; cy++) {
      for (cx = 0; cx < cols; cx++) {
        var r = 0, g2 = 0, b = 0, c = 0;
        var x0 = cx * cell, y0 = cy * cell;
        for (y = y0; y < y0 + cell && y < h; y += stride) {
          for (x = x0; x < x0 + cell && x < w; x += stride) {
            q = (y * w + x) * 4;
            if (d[q + 3] < 8) continue;
            r += d[q]; g2 += d[q + 1]; b += d[q + 2]; c++;
          }
        }
        var idx = cy * cols + cx;
        if (!c) {
          bktOf[idx] = 255;
          lumOf[idx] = 1;
          continue;
        }
        r /= c; g2 /= c; b /= c;
        var lum = (0.2126 * r + 0.7152 * g2 + 0.0722 * b) / 255;
        var bi = Math.min(buckets - 1, Math.floor(lum * buckets));
        bktOf[idx] = bi;
        lumOf[idx] = lum;
        sumR[bi] += r; sumG[bi] += g2; sumB[bi] += b; count[bi]++;
      }
    }

    // Dot colours: the mean colour of each luminance band.
    var inkR = new Float32Array(buckets);
    var inkG = new Float32Array(buckets);
    var inkB = new Float32Array(buckets);
    var bgR = 250, bgG = 248, bgB = 243;
    var brightest = -1, bestLum = -1;
    for (var bI = 0; bI < buckets; bI++) {
      if (count[bI]) {
        inkR[bI] = sumR[bI] / count[bI];
        inkG[bI] = sumG[bI] / count[bI];
        inkB[bI] = sumB[bI] / count[bI];
        var mid = (bI + 0.5) / buckets;
        if (mid > bestLum) { bestLum = mid; brightest = bI; }
      } else {
        inkR[bI] = 40; inkG[bI] = 40; inkB[bI] = 46;
      }
    }
    if (brightest >= 0) {
      bgR = inkR[brightest] * 0.35 + 255 * 0.65;
      bgG = inkG[brightest] * 0.35 + 255 * 0.65;
      bgB = inkB[brightest] * 0.35 + 250 * 0.65;
    }

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "rgb(" + Math.round(bgR) + "," + Math.round(bgG) + "," + Math.round(bgB) + ")";
    ctx.fillRect(0, 0, w, h);

    var half = cell / 2;
    for (var bi2 = 0; bi2 < buckets; bi2++) {
      if (!count[bi2]) continue;
      ctx.beginPath();
      var drew = false;
      for (cy = 0; cy < rows; cy++) {
        for (cx = 0; cx < cols; cx++) {
          var i2 = cy * cols + cx;
          if (bktOf[i2] !== bi2) continue;
          var lum2 = lumOf[i2];
          var rad = half * Math.min(1, (1 - lum2) * 1.2) * amt;
          if (rad < 0.35) continue;
          ctx.moveTo(cx * cell + half + rad, cy * cell + half);
          ctx.arc(cx * cell + half, cy * cell + half, rad, 0, 6.283185307);
          drew = true;
        }
      }
      if (!drew) continue;
      ctx.fillStyle =
        "rgb(" + Math.round(inkR[bi2]) + "," + Math.round(inkG[bi2]) + "," + Math.round(inkB[bi2]) + ")";
      ctx.fill();
    }
    ctx.restore();
  }

  function cutPass(ctx, w, h, amount, style, s) {
    var amt = amount / 100;
    var img = ctx.getImageData(0, 0, w, h);
    var d = img.data;
    var x, y, q;

    if (style === "stripes") {
      var period = Math.max(6, Math.round(30 * s));
      var thick = Math.max(2, Math.round(period * amt * 1.15));
      // Precompute the wobble per 7px cell instead of hashing every pixel.
      var jg = 7;
      var jcols = Math.ceil(w / jg) + 1;
      var jrows = Math.ceil(h / jg) + 1;
      var jit = new Float32Array(jcols * jrows);
      for (y = 0; y < jrows; y++) {
        for (x = 0; x < jcols; x++) jit[y * jcols + x] = hash2(x, y);
      }
      for (y = 0; y < h; y++) {
        var t = (y * 0.69) % period;
        if (t < 0) t += period;
        var jrow = ((y / jg) | 0) * jcols;
        q = y * w * 4;
        for (x = 0; x < w; x++) {
          if (t < thick * (0.55 + jit[jrow + ((x / jg) | 0)] * 0.9)) d[q + 3] = 0;
          t += 0.72;
          if (t >= period) t -= period;
          q += 4;
        }
      }
    } else if (style === "blocks") {
      var cb = Math.max(10, Math.round(64 * s));
      var bcols = Math.ceil(w / cb);
      var brows = Math.ceil(h / cb);
      for (var by = 0; by < brows; by++) {
        for (var bx = 0; bx < bcols; bx++) {
          if (hash2(bx * 13.7, by * 7.3) > amt * 1.15) continue;
          var bx0 = bx * cb, by0 = by * cb;
          for (y = by0; y < by0 + cb && y < h; y++) {
            for (x = bx0; x < bx0 + cb && x < w; x++) {
              d[(y * w + x) * 4 + 3] = 0;
            }
          }
        }
      }
    } else {
      var cell = Math.max(10, Math.round(46 * s));
      var cols = Math.ceil(w / cell);
      var rows = Math.ceil(h / cell);
      for (var cy = 0; cy < rows; cy++) {
        for (var cx = 0; cx < cols; cx++) {
          var hsh = hash2(cx * 13.7, cy * 7.3);
          var ccx = Math.min(w - 1, Math.floor(cx * cell + cell / 2));
          var ccy = Math.min(h - 1, Math.floor(cy * cell + cell / 2));
          q = (ccy * w + ccx) * 4;
          var lum = (0.2126 * d[q] + 0.7152 * d[q + 1] + 0.0722 * d[q + 2]) / 255;
          // Holes favour the brighter, emptier areas of the picture.
          if (hsh > amt * (0.55 + lum * 0.9)) continue;
          var rad = cell * (0.22 + hsh * 0.34);
          var r2 = rad * rad;
          var px0 = Math.max(0, Math.floor(ccx - rad));
          var px1 = Math.min(w, Math.ceil(ccx + rad));
          var py0 = Math.max(0, Math.floor(ccy - rad));
          var py1 = Math.min(h, Math.ceil(ccy + rad));
          for (y = py0; y < py1; y++) {
            var dy = y - ccy;
            for (x = px0; x < px1; x++) {
              var dx = x - ccx;
              if (dx * dx + dy * dy <= r2) d[(y * w + x) * 4 + 3] = 0;
            }
          }
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // ---- entry -----------------------------------------------------------

  function render(target, p, w, h) {
    if (!target || !p || w < 1 || h < 1) return;
    if (!isActive(p)) return;

    var ctx = target.getContext("2d");
    var s = Math.max(0.3, w / 1000);

    // Remember the incoming alpha so earlier cutouts survive the restyle.
    var alpha = U.cvs("vibeAlpha", w, h);
    var actx = alpha.getContext("2d");
    actx.setTransform(1, 0, 0, 1, 0, 0);
    actx.globalCompositeOperation = "source-over";
    actx.clearRect(0, 0, w, h);
    actx.drawImage(target, 0, 0);

    if (p.mosaic > 0) {
      mosaicPass(ctx, alpha, w, h, Math.max(2, Math.round(p.mosaic * s)));
    }

    var img = ctx.getImageData(0, 0, w, h);
    if (p.posterize > 1) posterizePass(img.data, p.posterize);
    if (p.edge > 0) edgePass(img.data, w, h, p.edge);
    if (p.paper > 0) paperPass(img.data, w, h, p.paper, s);
    if (p.grain > 0) grainPass(img.data, p.grain);
    ctx.putImageData(img, 0, 0);

    if (p.halftone > 0) halftonePass(ctx, img, w, h, p.halftone, s);

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(alpha, 0, 0);
    ctx.restore();

    if (p.cut > 0) cutPass(ctx, w, h, p.cut, p.cutStyle, s);
  }

  window.IS.Vibe = {
    DEFAULT: DEFAULT,
    PRESETS: PRESETS,
    render: render,
    isActive: isActive,
  };
})();
