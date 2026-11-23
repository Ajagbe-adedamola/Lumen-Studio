/**
 * Lumen Studio — image tools.
 *
 *  - removeBackground(): flood-fill from the image border to build an alpha
 *    mask, so a subject can be lifted off a fairly even background.
 *  - applyStroke(): the retouch brush. "heal" diffuses surrounding pixels
 *    into the painted area (good for watermarks on skies, walls, gradients);
 *    "clone" copies pixels from an offset you choose (good on texture).
 *
 * No dependencies, no network, no WASM.
 */
(function () {
  "use strict";

  var IS = (window.IS = window.IS || {});
  var U = IS.util;

  // ---- background removal ---------------------------------------------

  /**
   * Build an alpha mask (w*h, 255 = keep, 0 = remove) by flood filling
   * inwards from the border.
   *
   * opts: { tolerance: 0-100, feather: 0-24 }
   */
  function removeBackground(imgData, opts) {
    var w = imgData.width;
    var h = imgData.height;
    var d = imgData.data;
    var n = w * h;

    var tolerance = opts && opts.tolerance != null ? opts.tolerance : 32;
    var feather = opts && opts.feather != null ? opts.feather : 2;

    // Sample a border ring to estimate the background colour.
    var ring = Math.max(1, Math.round(Math.min(w, h) * 0.02));
    var sr = 0, sg = 0, sb = 0, sc = 0;
    var x, y, i, p;

    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        if (x < ring || x >= w - ring || y < ring || y >= h - ring) {
          i = (y * w + x) * 4;
          if (d[i + 3] === 0) continue;
          sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; sc++;
        }
      }
    }
    if (!sc) return new Uint8ClampedArray(n).fill(255);

    var mr = sr / sc, mg = sg / sc, mb = sb / sc;
    var maxDist = 5 + (tolerance / 100) * 135;
    var maxDist2 = maxDist * maxDist;

    var alpha = new Uint8ClampedArray(n).fill(255);
    var visited = new Uint8Array(n);
    var queue = new Int32Array(n);
    var qh = 0, qt = 0;

    function isBg(px) {
      var ii = px * 4;
      if (d[ii + 3] === 0) return true;
      var dr = d[ii] - mr;
      var dg = d[ii + 1] - mg;
      var db = d[ii + 2] - mb;
      return dr * dr + dg * dg + db * db <= maxDist2;
    }

    // Seed from the border wherever it looks like background.
    for (x = 0; x < w; x++) {
      if (isBg(x)) { visited[x] = 1; queue[qt++] = x; }
      p = (h - 1) * w + x;
      if (isBg(p)) { visited[p] = 1; queue[qt++] = p; }
    }
    for (y = 0; y < h; y++) {
      p = y * w;
      if (isBg(p)) { visited[p] = 1; queue[qt++] = p; }
      p = y * w + (w - 1);
      if (isBg(p)) { visited[p] = 1; queue[qt++] = p; }
    }

    while (qh < qt) {
      p = queue[qh++];
      alpha[p] = 0;
      x = p % w;
      y = (p - x) / w;

      if (x > 0) {
        var l = p - 1;
        if (!visited[l] && isBg(l)) { visited[l] = 1; queue[qt++] = l; }
      }
      if (x < w - 1) {
        var r = p + 1;
        if (!visited[r] && isBg(r)) { visited[r] = 1; queue[qt++] = r; }
      }
      if (y > 0) {
        var u = p - w;
        if (!visited[u] && isBg(u)) { visited[u] = 1; queue[qt++] = u; }
      }
      if (y < h - 1) {
        var dn = p + w;
        if (!visited[dn] && isBg(dn)) { visited[dn] = 1; queue[qt++] = dn; }
      }
    }

    if (feather > 0) boxBlurAlpha(alpha, w, h, Math.round(feather));
    return alpha;
  }

  /** Separable box blur over a single-channel alpha mask. */
  function boxBlurAlpha(a, w, h, r) {
    if (r < 1) return;
    var tmp = new Uint8ClampedArray(w * h);
    var x, y, k, s, c, xx, yy;

    for (y = 0; y < h; y++) {
      var row = y * w;
      for (x = 0; x < w; x++) {
        s = 0; c = 0;
        for (k = -r; k <= r; k++) {
          xx = x + k;
          if (xx >= 0 && xx < w) { s += a[row + xx]; c++; }
        }
        tmp[row + x] = s / c;
      }
    }
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        s = 0; c = 0;
        for (k = -r; k <= r; k++) {
          yy = y + k;
          if (yy >= 0 && yy < h) { s += tmp[yy * w + x]; c++; }
        }
        a[y * w + x] = s / c;
      }
    }
  }

  // ---- retouch brush ---------------------------------------------------

  /**
   * Paint one stroke into `imgData`.
   *
   * stroke = {
   *   mode: "heal" | "clone",
   *   points: [{x, y}, ...],
   *   radius: number (px),
   *   strength: number (1-10, heal iterations),
   *   dx, dy: number (clone source offset)
   * }
   */
  function applyStroke(imgData, w, h, stroke) {
    var pts = stroke.points;
    if (!pts || !pts.length) return;

    var d = imgData.data;
    var r = Math.max(1, stroke.radius || 20);

    // Bounding box around the stroke, padded so diffusion has a border.
    var pad = 2;
    var x0 = w, y0 = h, x1 = 0, y1 = 0, k;
    for (k = 0; k < pts.length; k++) {
      if (pts[k].x - r < x0) x0 = pts[k].x - r;
      if (pts[k].y - r < y0) y0 = pts[k].y - r;
      if (pts[k].x + r > x1) x1 = pts[k].x + r;
      if (pts[k].y + r > y1) y1 = pts[k].y + r;
    }
    x0 = Math.max(0, Math.floor(x0) - pad);
    y0 = Math.max(0, Math.floor(y0) - pad);
    x1 = Math.min(w, Math.ceil(x1) + pad);
    y1 = Math.min(h, Math.ceil(y1) + pad);

    var bw = x1 - x0;
    var bh = y1 - y0;
    if (bw <= 0 || bh <= 0) return;

    var mask = new Uint8Array(bw * bh);
    var r2 = r * r;

    for (k = 0; k < pts.length; k++) {
      var cx = pts[k].x;
      var cy = pts[k].y;
      var startX = Math.max(x0, Math.floor(cx - r));
      var endX = Math.min(x1 - 1, Math.ceil(cx + r));
      var startY = Math.max(y0, Math.floor(cy - r));
      var endY = Math.min(y1 - 1, Math.ceil(cy + r));
      for (var py = startY; py <= endY; py++) {
        var ddy = py - cy;
        for (var px = startX; px <= endX; px++) {
          var ddx = px - cx;
          if (ddx * ddx + ddy * ddy <= r2) {
            mask[(py - y0) * bw + (px - x0)] = 1;
          }
        }
      }
    }

    if (stroke.mode === "clone") {
      cloneFill(d, w, h, mask, bw, bh, x0, y0, stroke.dx || 0, stroke.dy || 0);
    } else {
      healFill(d, w, h, mask, bw, bh, x0, y0, Math.max(1, stroke.strength || 4));
    }
  }

  function cloneFill(d, w, h, mask, bw, bh, x0, y0, dx, dy) {
    for (var y = 0; y < bh; y++) {
      for (var x = 0; x < bw; x++) {
        if (!mask[y * bw + x]) continue;
        var sx = x0 + x + dx;
        var sy = y0 + y + dy;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        var di = ((y0 + y) * w + (x0 + x)) * 4;
        var si = (sy * w + sx) * 4;
        d[di] = d[si];
        d[di + 1] = d[si + 1];
        d[di + 2] = d[si + 2];
      }
    }
  }

  /**
   * Fill the masked pixels by diffusing the surrounding colour inwards.
   * Gauss-Seidel style: updating in place converges quickly and gives a
   * smooth patch that blends with whatever is around it.
   */
  function healFill(d, w, h, mask, bw, bh, x0, y0, strength) {
    // Seed masked pixels with the average of the unmasked pixels nearby.
    var sr = 0, sg = 0, sb = 0, sc = 0;
    var x, y;
    for (y = 0; y < bh; y++) {
      for (x = 0; x < bw; x++) {
        if (mask[y * bw + x]) continue;
        var i = ((y0 + y) * w + (x0 + x)) * 4;
        sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; sc++;
      }
    }
    if (!sc) return;
    var ar = sr / sc, ag = sg / sc, ab = sb / sc;

    for (y = 0; y < bh; y++) {
      for (x = 0; x < bw; x++) {
        if (!mask[y * bw + x]) continue;
        var j = ((y0 + y) * w + (x0 + x)) * 4;
        d[j] = ar; d[j + 1] = ag; d[j + 2] = ab;
      }
    }

    var iters = strength * 9;
    for (var it = 0; it < iters; it++) {
      for (y = 1; y < bh - 1; y++) {
        for (x = 1; x < bw - 1; x++) {
          var m = y * bw + x;
          if (!mask[m]) continue;
          var idx = ((y0 + y) * w + (x0 + x)) * 4;
          var rr = 0, gg = 0, bb = 0, cnt = 0, k, nidx;
          // 8 neighbours, wrapping around the bbox edge is prevented by the
          // 1px loop margin above.
          for (k = -1; k <= 1; k++) {
            nidx = idx + (k * w * 4) - 4;
            rr += d[nidx]; gg += d[nidx + 1]; bb += d[nidx + 2]; cnt++;
            nidx = idx + (k * w * 4);
            rr += d[nidx]; gg += d[nidx + 1]; bb += d[nidx + 2]; cnt++;
            nidx = idx + (k * w * 4) + 4;
            rr += d[nidx]; gg += d[nidx + 1]; bb += d[nidx + 2]; cnt++;
          }
          d[idx] = rr / cnt;
          d[idx + 1] = gg / cnt;
          d[idx + 2] = bb / cnt;
        }
      }
    }
  }

  // ---- export helpers --------------------------------------------------

  IS.Tools = {
    removeBackground: removeBackground,
    applyStroke: applyStroke,
    boxBlurAlpha: boxBlurAlpha,
  };
})();
