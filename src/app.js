/**
 * Lumen Studio — application shell.
 *
 * State model:
 *   baseData     original pixels (never touched)
 *   retouchData  baseData + retouch strokes
 *   mask         per-pixel alpha for the cutout (255 keep / 0 remove)
 *   composedData retouchData with mask applied  -> source for the effect stack
 *   params       light & tone settings (non-destructive)
 *
 * Preview is rendered at a reduced size for responsiveness; export runs the
 * same pipeline at full working resolution.
 */
(function () {
  "use strict";

  var IS = window.IS;
  var U = IS.util;
  var fx = IS.Effects;
  var tools = IS.Tools;

  var MAX_DIM = 2000;
  var PREVIEW_DIM = 1080;
  var PREVIEW_DIM_FAST = 700;

  var $ = function (id) { return document.getElementById(id); };

  var canvas = $("canvas");
  var ctx = canvas.getContext("2d", { willReadFrequently: true });
  var stage = $("stage");
  var emptyState = $("emptyState");
  var brushCursor = $("brushCursor");
  var stageBadge = $("stageBadge");
  var statusText = $("statusText");
  var sizeText = $("sizeText");
  var panelBody = $("panelBody");
  var fileInput = $("fileInput");

  var S = {
    loaded: false,
    w: 0,
    h: 0,
    baseData: null,
    retouchData: null,
    composedData: null,
    composedCanvas: null,
    composedCtx: null,
    mask: null,
    strokes: [],
    params: Object.assign({}, fx.DEFAULT),
    vibe: Object.assign({}, (IS.Vibe && IS.Vibe.DEFAULT) || {}),
    tool: "cut",
    maskMode: "erase",
    brushSize: 60,
    healMode: "heal",
    healSize: 46,
    healStrength: 4,
    cloneDx: 0,
    cloneDy: 0,
    cloneSet: false,
    settingSource: false,
    history: [],
    dirty: true,
    interacting: false,
    comparing: false,
    previewMax: PREVIEW_DIM,
  };

  var rafId = 0;

  // ---- rendering -------------------------------------------------------

  function scheduleRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(function () {
      rafId = 0;
      render();
    });
  }

  function render() {
    if (!S.loaded) return;

    if (S.dirty) rebuildComposed();

    var src = S.composedCanvas;

    if (S.comparing) {
      // Show the untouched original.
      var cw = Math.min(PREVIEW_DIM, S.w);
      var ch = Math.round(cw * (S.h / S.w));
      canvas.width = cw;
      canvas.height = ch;
      ctx.clearRect(0, 0, cw, ch);
      ctx.drawImage(S.baseCanvas, 0, 0, cw, ch);
      return;
    }

    var maxDim = S.interacting ? PREVIEW_DIM_FAST : PREVIEW_DIM;
    var scale = Math.min(1, maxDim / Math.max(S.w, S.h));
    var pw = Math.max(1, Math.round(S.w * scale));
    var ph = Math.max(1, Math.round(S.h * scale));

    var prev = U.cvs("previewSrc", pw, ph);
    var pctx = prev.getContext("2d");
    pctx.setTransform(1, 0, 0, 1, 0, 0);
    pctx.globalCompositeOperation = "source-over";
    pctx.clearRect(0, 0, pw, ph);
    pctx.imageSmoothingEnabled = true;
    pctx.imageSmoothingQuality = "high";
    pctx.drawImage(src, 0, 0, pw, ph);

    canvas.width = pw;
    canvas.height = ph;
    fx.render(canvas, prev, S.params, pw, ph);
    IS.Vibe.render(canvas, S.vibe, pw, ph);
  }

  function rebuildComposed() {
    if (!S.retouchData) return;
    var w = S.w, h = S.h;
    var src = S.retouchData.data;
    var out = new Uint8ClampedArray(src.length);
    var m = S.mask;
    for (var i = 0, p = 0; i < src.length; i += 4, p++) {
      out[i] = src[i];
      out[i + 1] = src[i + 1];
      out[i + 2] = src[i + 2];
      out[i + 3] = (src[i + 3] * m[p]) / 255;
    }
    S.composedData = new ImageData(out, w, h);
    if (!S.composedCanvas) {
      S.composedCanvas = U.cvs("composed", w, h);
      S.composedCtx = S.composedCanvas.getContext("2d", { willReadFrequently: true });
    } else if (S.composedCanvas.width !== w || S.composedCanvas.height !== h) {
      S.composedCanvas.width = w;
      S.composedCanvas.height = h;
    }
    S.composedCtx.putImageData(S.composedData, 0, 0);
    S.dirty = false;
  }

  /** Refresh only a rectangle of the composed buffer (keeps brushing smooth). */
  function updateComposedRect(x0, y0, x1, y1) {
    if (!S.composedData) return;
    x0 = Math.max(0, Math.floor(x0));
    y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(S.w, Math.ceil(x1));
    y1 = Math.min(S.h, Math.ceil(y1));
    if (x1 <= x0 || y1 <= y0) return;

    var w = S.w;
    var src = S.retouchData.data;
    var out = S.composedData.data;
    var m = S.mask;

    for (var y = y0; y < y1; y++) {
      var row = y * w;
      for (var x = x0; x < x1; x++) {
        var p = row + x;
        var i = p * 4;
        out[i] = src[i];
        out[i + 1] = src[i + 1];
        out[i + 2] = src[i + 2];
        out[i + 3] = (src[i + 3] * m[p]) / 255;
      }
    }
    S.composedCtx.putImageData(S.composedData, 0, 0, x0, y0, x1 - x0, y1 - y0);
  }

  function rebuildRetouch() {
    if (!S.baseData) return;
    var src = S.baseData.data;
    S.retouchData = new ImageData(new Uint8ClampedArray(src), S.w, S.h);
    for (var i = 0; i < S.strokes.length; i++) {
      tools.applyStroke(S.retouchData, S.w, S.h, S.strokes[i]);
    }
    S.dirty = true;
  }

  // ---- history ---------------------------------------------------------

  function pushHistory() {
    if (!S.loaded) return;
    S.history.push({
      mask: S.mask ? new Uint8ClampedArray(S.mask) : null,
      strokes: S.strokes.slice(),
      params: Object.assign({}, S.params),
      vibe: Object.assign({}, S.vibe),
    });
    if (S.history.length > 12) S.history.shift();
    updateTopButtons();
  }

  function undo() {
    if (!S.history.length) return;
    var snap = S.history.pop();
    var strokesChanged = snap.strokes.length !== S.strokes.length;
    S.mask = snap.mask ? new Uint8ClampedArray(snap.mask) : S.mask;
    S.strokes = snap.strokes;
    S.params = snap.params;
    if (snap.vibe) S.vibe = Object.assign({}, snap.vibe);
    if (strokesChanged) rebuildRetouch();
    else S.dirty = true;
    buildPanel();
    scheduleRender();
    updateTopButtons();
  }

  function resetAll() {
    if (!S.loaded) return;
    pushHistory();
    S.strokes = [];
    S.params = Object.assign({}, fx.DEFAULT);
    S.vibe = Object.assign({}, IS.Vibe.DEFAULT);
    S.mask = new Uint8ClampedArray(S.w * S.h).fill(255);
    rebuildRetouch();
    buildPanel();
    scheduleRender();
    setStatus("Reset to original");
  }

  function updateTopButtons() {
    $("btnUndo").disabled = !S.loaded || !S.history.length;
    $("btnReset").disabled = !S.loaded;
    $("btnCompare").disabled = !S.loaded;
  }

  // ---- loading ---------------------------------------------------------

  function loadFile(file) {
    if (!file || !/^image\//.test(file.type || "")) {
      setStatus("That doesn't look like an image file");
      return;
    }
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      initFromImage(img, file.name);
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      setStatus("Couldn't read that image");
    };
    img.src = url;
  }

  function initFromImage(img, name) {
    var iw = img.naturalWidth || img.width;
    var ih = img.naturalHeight || img.height;
    var scale = Math.min(1, MAX_DIM / Math.max(iw, ih));
    var w = Math.max(1, Math.round(iw * scale));
    var h = Math.max(1, Math.round(ih * scale));

    var tmp = U.cvs("source", w, h);
    var tctx = tmp.getContext("2d");
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.clearRect(0, 0, w, h);
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = "high";
    tctx.drawImage(img, 0, 0, w, h);

    S.w = w;
    S.h = h;
    S.baseData = tctx.getImageData(0, 0, w, h);
    S.retouchData = new ImageData(new Uint8ClampedArray(S.baseData.data), w, h);
    S.baseCanvas = tmp;
    S.mask = new Uint8ClampedArray(w * h).fill(255);
    S.strokes = [];
    S.history = [];
    S.params = Object.assign({}, fx.DEFAULT);
    S.vibe = Object.assign({}, IS.Vibe.DEFAULT);
    S.loaded = true;
    S.dirty = true;
    S.cloneSet = false;
    S.settingSource = false;

    emptyState.hidden = true;
    canvas.hidden = false;
    stageBadge.hidden = false;

    buildPanel();
    render();
    updateTopButtons();

    setStatus("Loaded " + (name || "image"));
    sizeText.textContent = w + " × " + h + " px" + (scale < 1 ? " (scaled from " + iw + " × " + ih + ")" : "");
  }

  // ---- mask brushing ---------------------------------------------------

  function paintMask(pt, value) {
    var r = S.brushSize;
    var x0 = Math.max(0, Math.floor(pt.x - r));
    var y0 = Math.max(0, Math.floor(pt.y - r));
    var x1 = Math.min(S.w, Math.ceil(pt.x + r));
    var y1 = Math.min(S.h, Math.ceil(pt.y + r));
    var r2 = r * r;
    var w = S.w;

    for (var y = y0; y < y1; y++) {
      var dy = y + 0.5 - pt.y;
      for (var x = x0; x < x1; x++) {
        var dx = x + 0.5 - pt.x;
        if (dx * dx + dy * dy <= r2) S.mask[y * w + x] = value;
      }
    }
    updateComposedRect(x0, y0, x1, y1);
  }

  function segPaintMask(a, b, value) {
    var dist = Math.hypot(b.x - a.x, b.y - a.y);
    var steps = Math.max(1, Math.ceil(dist / Math.max(2, S.brushSize * 0.35)));
    for (var i = 0; i <= steps; i++) {
      var t = steps === 0 ? 0 : i / steps;
      paintMask({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, value);
    }
  }

  // ---- pointer ---------------------------------------------------------

  var drawing = false;
  var lastPt = null;
  var lastPt2 = null;

  function toImage(e) {
    var r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return {
      x: ((e.clientX - r.left) / r.width) * S.w,
      y: ((e.clientY - r.top) / r.height) * S.h,
    };
  }

  function onPointerDown(e) {
    if (!S.loaded) return;
    var pt = toImage(e);
    if (!pt) return;

    if (S.tool === "cut") {
      e.preventDefault();
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
      pushHistory();
      drawing = true;
      lastPt = pt;
      S.interacting = true;
      paintMask(pt, S.maskMode === "restore" ? 255 : 0);
      scheduleRender();
      return;
    }

    if (S.tool === "retouch") {
      if (S.settingSource) {
        S.settingSource = false;
        setStatus("Clone source set — now paint over the watermark");
        buildPanel();
        return;
      }
      e.preventDefault();
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
      pushHistory();
      drawing = true;
      lastPt = pt;
      lastPt2 = pt;
      S.interacting = true;
      applyRetouchSegment(pt, pt);
      scheduleRender();
    }
  }

  function onPointerMove(e) {
    if (!S.loaded) return;

    // Brush cursor follows the pointer over the canvas.
    if (S.tool === "cut" || S.tool === "retouch") {
      var rect = canvas.getBoundingClientRect();
      var inside =
        e.clientX >= rect.left && e.clientX <= rect.right &&
        e.clientY >= rect.top && e.clientY <= rect.bottom;
      if (inside && rect.width) {
        var sizeImg = S.tool === "cut" ? S.brushSize : S.healSize;
        var cssSize = sizeImg * (rect.width / S.w);
        brushCursor.hidden = false;
        brushCursor.style.width = cssSize + "px";
        brushCursor.style.height = cssSize + "px";
        var srect = stage.getBoundingClientRect();
        brushCursor.style.left = (e.clientX - srect.left + stage.scrollLeft) + "px";
        brushCursor.style.top = (e.clientY - srect.top + stage.scrollTop) + "px";
      } else {
        brushCursor.hidden = true;
      }
    } else {
      brushCursor.hidden = true;
    }

    if (!drawing) return;
    var pt = toImage(e);
    if (!pt) return;

    if (S.tool === "cut") {
      segPaintMask(lastPt, pt, S.maskMode === "restore" ? 255 : 0);
      lastPt = pt;
      scheduleRender();
    } else if (S.tool === "retouch") {
      applyRetouchSegment(lastPt, pt);
      lastPt = pt;
      scheduleRender();
    }
  }

  function onPointerUp() {
    if (!drawing) return;
    drawing = false;
    S.interacting = false;
    scheduleRender();
  }

  function applyRetouchSegment(a, b) {
    var stroke = {
      mode: S.healMode,
      points: [a, b],
      radius: S.healSize,
      strength: S.healStrength,
      dx: S.cloneDx,
      dy: S.cloneDy,
    };
    if (S.healMode === "clone" && !S.cloneSet) {
      // Sensible default: sample from directly above the stroke.
      stroke.dx = 0;
      stroke.dy = -Math.round(S.healSize * 2.2);
    }
    if (S.healMode === "clone" && S.cloneSet) {
      stroke.dx = S.cloneDx;
      stroke.dy = S.cloneDy;
    }
    tools.applyStroke(S.retouchData, S.w, S.h, stroke);

    var pad = S.healSize + 3;
    updateComposedRect(
      Math.min(a.x, b.x) - pad,
      Math.min(a.y, b.y) - pad,
      Math.max(a.x, b.x) + pad,
      Math.max(a.y, b.y) + pad
    );
  }

  // ---- panel: cutout ---------------------------------------------------

  function buildPanel() {
    panelBody.innerHTML = "";
    if (S.tool === "cut") buildCutPanel();
    else if (S.tool === "retouch") buildRetouchPanel();
    else if (S.tool === "fx") buildFxPanel();
    else if (S.tool === "vibe") buildVibePanel();
    else buildExportPanel();
    updateBadge();
  }

  function updateBadge() {
    if (!S.loaded) return;
    var labels = {
      cut: "Cutout — paint to erase or restore background",
      retouch: "Retouch — paint over a watermark to heal it",
      fx: "Light & Tone — grade the image",
      vibe: "Vibe — restyle, texture and cut pieces away",
      export: "Export — save for your portfolio",
    };
    stageBadge.textContent = labels[S.tool] || "";
  }

  function addTitle(title, note) {
    var h = document.createElement("h2");
    h.className = "panel-title";
    h.textContent = title;
    panelBody.appendChild(h);
    if (note) {
      var p = document.createElement("p");
      p.className = "panel-note";
      p.textContent = note;
      panelBody.appendChild(p);
    }
  }

  function addGroup(label) {
    var g = document.createElement("div");
    g.className = "group";
    if (label) {
      var l = document.createElement("div");
      l.className = "group-label";
      l.textContent = label;
      g.appendChild(l);
    }
    panelBody.appendChild(g);
    return g;
  }

  function addSlider(parent, label, value, min, max, step, onChange) {
    var field = document.createElement("div");
    field.className = "field";

    var head = document.createElement("div");
    head.className = "field-head";
    var name = document.createElement("span");
    name.className = "field-name";
    name.textContent = label;
    var val = document.createElement("span");
    val.className = "field-val";
    val.textContent = step < 1 ? Number(value).toFixed(2) : String(Math.round(value));
    head.appendChild(name);
    head.appendChild(val);

    var input = document.createElement("input");
    input.type = "range";
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = value;
    input.addEventListener("pointerdown", function () { S.interacting = true; });
    input.addEventListener("pointerup", function () { S.interacting = false; scheduleRender(); });
    input.addEventListener("input", function () {
      var v = parseFloat(input.value);
      val.textContent = step < 1 ? v.toFixed(2) : String(Math.round(v));
      onChange(v);
    });

    field.appendChild(head);
    field.appendChild(input);
    parent.appendChild(field);
    return input;
  }

  function addButtons(parent, buttons) {
    var row = document.createElement("div");
    row.className = "row-btns";
    buttons.forEach(function (b) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn" + (b.active ? " is-active" : "");
      btn.textContent = b.label;
      btn.addEventListener("click", b.onClick);
      row.appendChild(btn);
    });
    parent.appendChild(row);
    return row;
  }

  function addHint(text, warn) {
    var p = document.createElement("p");
    p.className = "hint" + (warn ? " warn" : "");
    p.textContent = text;
    panelBody.appendChild(p);
  }

  function buildCutPanel() {
    addTitle("Cutout", "Lifts the subject off a fairly even background.");

    var g1 = addGroup("Automatic");
    var sliderTol = 32;
    var sliderFea = 2;

    addSlider(g1, "Sensitivity", sliderTol, 1, 100, 1, function (v) { sliderTol = v; });
    addSlider(g1, "Edge softness", sliderFea, 0, 24, 1, function (v) { sliderFea = v; });

    addButtons(g1, [
      {
        label: "Remove background",
        active: true,
        onClick: function () {
          if (!S.loaded) return;
          pushHistory();
          setStatus("Detecting background…");
          setTimeout(function () {
            var mask = tools.removeBackground(S.baseData, {
              tolerance: sliderTol,
              feather: sliderFea,
            });
            S.mask = mask;
            S.dirty = true;
            scheduleRender();
            setStatus("Background removed — refine with the brushes below");
          }, 30);
        },
      },
      {
        label: "Restore all",
        onClick: function () {
          if (!S.loaded) return;
          pushHistory();
          S.mask = new Uint8ClampedArray(S.w * S.h).fill(255);
          S.dirty = true;
          scheduleRender();
          setStatus("Mask cleared");
        },
      },
    ]);

    var g2 = addGroup("Brush fix-up");
    addButtons(g2, [
      {
        label: "Erase",
        active: S.maskMode === "erase",
        onClick: function () { S.maskMode = "erase"; buildPanel(); },
      },
      {
        label: "Restore",
        active: S.maskMode === "restore",
        onClick: function () { S.maskMode = "restore"; buildPanel(); },
      },
    ]);
    addSlider(g2, "Brush size", S.brushSize, 8, 320, 1, function (v) { S.brushSize = v; });

    addHint("Erase paints the background away. Restore brings pixels back. Paint along the edges to clean up the cut.");
  }

  // ---- panel: retouch --------------------------------------------------

  function buildRetouchPanel() {
    addTitle("Retouch", "Paint over a watermark, logo or dust spot to remove it.");

    var g1 = addGroup("Method");
    addButtons(g1, [
      {
        label: "Heal",
        active: S.healMode === "heal",
        onClick: function () { S.healMode = "heal"; buildPanel(); },
      },
      {
        label: "Clone",
        active: S.healMode === "clone",
        onClick: function () { S.healMode = "clone"; buildPanel(); },
      },
    ]);

    var g2 = addGroup("Brush");
    addSlider(g2, "Size", S.healSize, 8, 220, 1, function (v) { S.healSize = v; });
    addSlider(g2, "Strength", S.healStrength, 1, 10, 1, function (v) { S.healStrength = v; });

    if (S.healMode === "clone") {
      addButtons(g2, [
        {
          label: S.settingSource ? "Click the image…" : (S.cloneSet ? "Source set" : "Set source point"),
          active: S.settingSource || S.cloneSet,
          onClick: function () {
            S.settingSource = true;
            setStatus("Click a clean area to sample from");
            buildPanel();
          },
        },
      ]);
    }

    addHint(
      S.healMode === "heal"
        ? "Heal works best on skies, walls, gradients and soft backgrounds — it blends surrounding pixels into the stroke."
        : "Clone copies pixels from your source point — better on textured areas like fabric, grass or skin."
    );
  }

  // ---- panel: light & tone --------------------------------------------

  function buildFxPanel() {
    addTitle("Light & Tone", "Non-destructive grading — the original is always kept.");

    var pg = addGroup("Look");
    var presets = document.createElement("div");
    presets.className = "presets";
    Object.keys(fx.PRESETS).forEach(function (key) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "preset";
      btn.textContent = key;
      btn.addEventListener("click", function () {
        pushHistory();
        S.params = Object.assign({}, fx.DEFAULT, fx.PRESETS[key]);
        buildPanel();
        scheduleRender();
        setStatus("Look: " + key);
      });
      presets.appendChild(btn);
    });
    pg.appendChild(presets);

    var gl = addGroup("Light");
    addSlider(gl, "Exposure", S.params.exposure, -2, 2, 0.01, function (v) { S.params.exposure = v; scheduleRender(); });
    addSlider(gl, "Contrast", S.params.contrast, -100, 100, 1, function (v) { S.params.contrast = v; scheduleRender(); });
    addSlider(gl, "Highlights", S.params.highlights, -100, 100, 1, function (v) { S.params.highlights = v; scheduleRender(); });
    addSlider(gl, "Shadows", S.params.shadows, -100, 100, 1, function (v) { S.params.shadows = v; scheduleRender(); });
    addSlider(gl, "Clarity", S.params.clarity, 0, 100, 1, function (v) { S.params.clarity = v; scheduleRender(); });

    var gc = addGroup("Colour");
    addSlider(gc, "Temperature", S.params.temperature, -100, 100, 1, function (v) { S.params.temperature = v; scheduleRender(); });
    addSlider(gc, "Tint", S.params.tint, -100, 100, 1, function (v) { S.params.tint = v; scheduleRender(); });
    addSlider(gc, "Saturation", S.params.saturation, -100, 100, 1, function (v) { S.params.saturation = v; scheduleRender(); });
    addSlider(gc, "Vibrance", S.params.vibrance, -100, 100, 1, function (v) { S.params.vibrance = v; scheduleRender(); });
    addSlider(gc, "Fade", S.params.fade, 0, 100, 1, function (v) { S.params.fade = v; scheduleRender(); });

    var ga = addGroup("Light effects");
    addSlider(ga, "Bloom / glow", S.params.bloom, 0, 100, 1, function (v) { S.params.bloom = v; scheduleRender(); });
    addSlider(ga, "Light leak", S.params.lightLeak, 0, 100, 1, function (v) { S.params.lightLeak = v; scheduleRender(); });
    addSlider(ga, "Leak hue", S.params.leakHue, 0, 360, 1, function (v) { S.params.leakHue = v; scheduleRender(); });
    addSlider(ga, "Vignette", S.params.vignette, 0, 100, 1, function (v) { S.params.vignette = v; scheduleRender(); });
    addSlider(ga, "Grain", S.params.grain, 0, 100, 1, function (v) { S.params.grain = v; scheduleRender(); });

    var gs = addGroup("Stylise");
    addSlider(gs, "Split tone", S.params.splitAmount, 0, 100, 1, function (v) { S.params.splitAmount = v; scheduleRender(); });
    addSlider(gs, "Shadow hue", S.params.splitShadow, 0, 360, 1, function (v) { S.params.splitShadow = v; scheduleRender(); });
    addSlider(gs, "Highlight hue", S.params.splitHighlight, 0, 360, 1, function (v) { S.params.splitHighlight = v; scheduleRender(); });
    addSlider(gs, "Duotone", S.params.duotone, 0, 100, 1, function (v) { S.params.duotone = v; scheduleRender(); });

    var colorRow = document.createElement("div");
    colorRow.className = "row-btns";
    ["duotoneA", "duotoneB"].forEach(function (key) {
      var wrap = document.createElement("label");
      wrap.className = "btn";
      wrap.style.display = "flex";
      wrap.style.alignItems = "center";
      wrap.style.gap = "6px";
      wrap.textContent = key === "duotoneA" ? "Shadow" : "Light";
      var input = document.createElement("input");
      input.type = "color";
      input.value = S.params[key];
      input.style.width = "22px";
      input.style.height = "22px";
      input.style.border = "0";
      input.style.padding = "0";
      input.style.background = "transparent";
      input.addEventListener("input", function () {
        S.params[key] = input.value;
        scheduleRender();
      });
      wrap.appendChild(input);
      colorRow.appendChild(wrap);
    });
    gs.appendChild(colorRow);

    addButtons(addGroup(""), [
      { label: "Reset grade", onClick: function () {
        pushHistory();
        S.params = Object.assign({}, fx.DEFAULT);
        buildPanel();
        scheduleRender();
      } },
    ]);
  }

  // ---- panel: vibe -----------------------------------------------------

  function buildVibePanel() {
    addTitle("Vibe", "Restyle the photo into a different look — mosaic, print, trace, or cut pieces away.");

    var pg = addGroup("Look");
    var presets = document.createElement("div");
    presets.className = "presets";
    Object.keys(IS.Vibe.PRESETS).forEach(function (key) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "preset" + (S.vibe.preset === key ? " is-active" : "");
      btn.textContent = key;
      btn.addEventListener("click", function () {
        pushHistory();
        S.vibe = Object.assign({}, IS.Vibe.DEFAULT, IS.Vibe.PRESETS[key]);
        S.vibe.preset = key;
        buildPanel();
        render();
        setStatus("Vibe: " + key);
      });
      presets.appendChild(btn);
    });
    pg.appendChild(presets);

    function mark() { S.vibe.preset = "Custom"; }

    var gs = addGroup("Structure");
    addSlider(gs, "Mosaic blocks", S.vibe.mosaic, 0, 48, 1, function (v) {
      S.vibe.mosaic = v; mark(); scheduleRender();
    });
    addSlider(gs, "Halftone dots", S.vibe.halftone, 0, 100, 1, function (v) {
      S.vibe.halftone = v; mark(); scheduleRender();
    });
    addSlider(gs, "Posterize", S.vibe.posterize, 0, 12, 1, function (v) {
      S.vibe.posterize = v; mark(); scheduleRender();
    });

    var gt = addGroup("Texture");
    addSlider(gt, "Grain", S.vibe.grain, 0, 100, 1, function (v) {
      S.vibe.grain = v; mark(); scheduleRender();
    });
    addSlider(gt, "Paper texture", S.vibe.paper, 0, 100, 1, function (v) {
      S.vibe.paper = v; mark(); scheduleRender();
    });
    addSlider(gt, "Ink trace", S.vibe.edge, 0, 100, 1, function (v) {
      S.vibe.edge = v; mark(); scheduleRender();
    });

    var gc = addGroup("Cut away");
    addButtons(gc, [
      {
        label: "Holes",
        active: S.vibe.cutStyle === "holes",
        onClick: function () { S.vibe.cutStyle = "holes"; buildPanel(); render(); },
      },
      {
        label: "Stripes",
        active: S.vibe.cutStyle === "stripes",
        onClick: function () { S.vibe.cutStyle = "stripes"; buildPanel(); render(); },
      },
      {
        label: "Blocks",
        active: S.vibe.cutStyle === "blocks",
        onClick: function () { S.vibe.cutStyle = "blocks"; buildPanel(); render(); },
      },
    ]);
    addSlider(gc, "Amount", S.vibe.cut, 0, 100, 1, function (v) {
      S.vibe.cut = v; mark(); scheduleRender();
    });

    addButtons(addGroup(""), [
      {
        label: "Clear vibe",
        onClick: function () {
          pushHistory();
          S.vibe = Object.assign({}, IS.Vibe.DEFAULT);
          buildPanel();
          render();
        },
      },
    ]);

    addHint("Mosaic blocks the whole picture into chunks, Halftone turns it into print dots, Ink trace draws the outlines, and Cut makes parts transparent — so whatever sits behind shows through.");
  }

  // ---- panel: export ---------------------------------------------------

  function buildExportPanel() {
    addTitle("Export", "Save a portfolio-ready file.");

    var g = addGroup("Output");

    var fmtField = document.createElement("div");
    fmtField.className = "field";
    var fmtName = document.createElement("div");
    fmtName.className = "field-name";
    fmtName.textContent = "Format";
    var sel = document.createElement("select");
    [["image/png", "PNG — keeps transparency"], ["image/jpeg", "JPEG — smaller file"]].forEach(function (o) {
      var opt = document.createElement("option");
      opt.value = o[0];
      opt.textContent = o[1];
      sel.appendChild(opt);
    });
    fmtField.appendChild(fmtName);
    fmtField.appendChild(sel);
    g.appendChild(fmtField);

    var quality = 92;
    var qField = addSlider(g, "JPEG quality", quality, 50, 100, 1, function (v) { quality = v; });

    var nameField = document.createElement("div");
    nameField.className = "field";
    var nameLabel = document.createElement("div");
    nameLabel.className = "field-name";
    nameLabel.textContent = "File name";
    var nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = "lumen-edit";
    nameField.appendChild(nameLabel);
    nameField.appendChild(nameInput);
    g.appendChild(nameField);

    function syncQuality() {
      var isJpeg = sel.value === "image/jpeg";
      qField.parentElement.style.display = isJpeg ? "" : "none";
    }
    sel.addEventListener("change", syncQuality);
    syncQuality();

    var exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.className = "btn btn-primary";
    exportBtn.style.width = "100%";
    exportBtn.style.marginTop = "4px";
    exportBtn.textContent = "Export image";
    exportBtn.addEventListener("click", function () {
      doExport(sel.value, quality / 100, nameInput.value);
    });
    g.appendChild(exportBtn);

    var info = addGroup("Details");
    var p = document.createElement("p");
    p.className = "panel-note";
    p.style.margin = "0";
    p.textContent = S.loaded
      ? S.w + " × " + S.h + " px working size · " + (S.mask && hasTransparency() ? "transparent background" : "opaque")
      : "Load an image first.";
    info.appendChild(p);

    addHint("Everything is processed on your device. Nothing is uploaded anywhere.");
  }

  function hasTransparency() {
    if (!S.mask) return false;
    for (var i = 0; i < S.mask.length; i += 97) {
      if (S.mask[i] < 255) return true;
    }
    return false;
  }

  function doExport(mime, quality, name) {
    if (!S.loaded) return;
    setStatus("Rendering full resolution…");
    S.interacting = true;

    setTimeout(function () {
      rebuildComposed();
      var full = U.cvs("export", S.w, S.h);
      var fctx = full.getContext("2d");
      fctx.setTransform(1, 0, 0, 1, 0, 0);
      fctx.globalCompositeOperation = "source-over";
      fctx.clearRect(0, 0, S.w, S.h);
      fctx.drawImage(S.composedCanvas, 0, 0);

      if (mime === "image/jpeg") {
        // JPEG has no alpha: flatten onto white.
        var flat = U.cvs("exportFlat", S.w, S.h);
        var flctx = flat.getContext("2d");
        flctx.setTransform(1, 0, 0, 1, 0, 0);
        flctx.globalCompositeOperation = "source-over";
        flctx.fillStyle = "#ffffff";
        flctx.fillRect(0, 0, S.w, S.h);
        flctx.drawImage(full, 0, 0);
        full = flat;
      }

      var out = U.cvs("exportFinal", S.w, S.h);
      fx.render(out, full, S.params, S.w, S.h);
      IS.Vibe.render(out, S.vibe, S.w, S.h);

      out.toBlob(function (blob) {
        S.interacting = false;
        scheduleRender();
        if (!blob) {
          setStatus("Export failed");
          return;
        }
        var ext = mime === "image/png" ? "png" : "jpg";
        var safe = (name || "lumen-edit").replace(/[^\w\-]+/g, "-").replace(/^-+|-+$/g, "") || "lumen-edit";
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = safe + "." + ext;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
          URL.revokeObjectURL(a.href);
          a.remove();
        }, 4000);
        setStatus("Exported " + safe + "." + ext);
      }, mime, quality);
    }, 30);
  }

  // ---- misc ------------------------------------------------------------

  function setStatus(msg) {
    statusText.textContent = msg;
  }

  // ---- wiring ----------------------------------------------------------

  function openPicker() { fileInput.click(); }

  $("btnOpen").addEventListener("click", openPicker);
  $("btnEmptyOpen").addEventListener("click", openPicker);
  fileInput.addEventListener("change", function () {
    if (fileInput.files && fileInput.files.length) {
      loadFile(fileInput.files[0]);
      fileInput.value = "";
    }
  });

  $("btnUndo").addEventListener("click", undo);
  $("btnReset").addEventListener("click", resetAll);

  var compareBtn = $("btnCompare");
  function startCompare() {
    if (!S.loaded) return;
    S.comparing = true;
    render();
  }
  function endCompare() {
    if (!S.comparing) return;
    S.comparing = false;
    scheduleRender();
  }
  compareBtn.addEventListener("pointerdown", function (e) { e.preventDefault(); startCompare(); });
  window.addEventListener("pointerup", endCompare);
  compareBtn.addEventListener("pointerleave", endCompare);

  Array.prototype.forEach.call(document.querySelectorAll(".rail-btn"), function (btn) {
    btn.addEventListener("click", function () {
      Array.prototype.forEach.call(document.querySelectorAll(".rail-btn"), function (b) {
        b.classList.toggle("is-active", b === btn);
      });
      S.tool = btn.getAttribute("data-tool");
      brushCursor.hidden = true;
      buildPanel();
    });
  });

  canvas.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("pointerleave", function () { brushCursor.hidden = true; });

  // Drag & drop anywhere on the stage.
  ["dragenter", "dragover"].forEach(function (evt) {
    stage.addEventListener(evt, function (e) {
      e.preventDefault();
      stage.classList.add("is-dragover");
    });
  });
  ["dragleave", "drop"].forEach(function (evt) {
    stage.addEventListener(evt, function (e) {
      e.preventDefault();
      stage.classList.remove("is-dragover");
    });
  });
  stage.addEventListener("drop", function (e) {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      loadFile(e.dataTransfer.files[0]);
    }
  });

  // Keyboard shortcuts.
  document.addEventListener("keydown", function (e) {
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undo();
    }
  });

  // Initial state.
  buildPanel();
  updateTopButtons();

  // Expose for debugging.
  window.__lumen = { state: S, render: render, loadFile: loadFile };
})();
