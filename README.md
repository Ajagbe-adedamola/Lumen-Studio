# Lumen Studio

A photo editor that runs entirely in your browser. Lift a subject off its background, paint a watermark away, grade the light, then push the whole picture into a different look  mosaic, print texture, traced ink, or cut pieces clean away.

No install, no build step, no account, and no uploads: every pixel is processed on your own machine with the canvas API. There is no server and no AI model to download.

## Running it

Double-click `index.html`. That's it.

If you'd rather serve it over HTTP:

```bash
npx serve .
# or: python -m http.server 8000
```

## The tools

**Cutout** — removes the background automatically. It floods in from the borders and clears everything close to the edge colour, with *Sensitivity* and *Edge softness* sliders. Clean up afterwards with the **Erase** and **Restore** brushes; the result is real transparency, not a white fill.

**Retouch** — paint over a watermark, logo or dust spot and it blends away.
*Heal* pulls surrounding pixels into the stroke, which suits skies, walls and gradients. *Clone* copies from a source point you click, which holds up better on fabric, grass and skin.

**Light & Tone** — non-destructive colour grading: exposure, contrast, highlights, shadows, clarity, temperature, tint, saturation, vibrance, fade, bloom/glow, light leak with hue control, vignette, grain, split toning and duotone. Eight preset looks (Golden Hour, Cinematic, Noir, Neon Night, Film Fade, Soft Bloom, Duotone, Original) get you close in one click. The original pixels are never modified.

**Vibe** — turns the picture into a different object. Mosaic blocks, halftone print dots, posterised flats, procedural paper grain, ink-traced outlines, and cut-away **holes / stripes / blocks** that punch genuine transparency so whatever sits behind shows through. Everything is seeded, so the preview matches the export exactly.

**Export** — PNG (keeps transparency) or JPEG with a quality slider, rendered at full working resolution rather than upscaled from the preview.

## How it works

```
original pixels
  └── + retouch strokes        → retouched image
        └── + cutout alpha mask → composed image
              └── tone pass     → graded image
                    └── vibe pass → final image
```

Each stage is a separate pass over plain `ImageData`, so the pipeline stays lossless and always re-computes from the original — nothing is baked in until you export. The preview renders at a reduced size for responsiveness (and smaller again while you're dragging a slider); the export re-runs the identical pipeline at full resolution.

| File | Role |
| --- | --- |
| `index.html` | App shell: top bar, tool rail, stage, panel |
| `styles.css` | Dark UI and layout |
| `src/tools.js` | Background removal (border flood fill + feather) and heal/clone brushing |
| `src/effects.js` | Light and tone: tone curve, clarity, bloom, grain, vignette, leak, split tone |
| `src/vibe.js` | Mosaic, halftone, ink trace, paper texture, cut-away shapes |
| `src/app.js` | State, history, rendering, panels, pointer handling, export |

## Good to know

- The automatic cutout assumes a fairly even background. Busy scenes need the manual brushes, and that's expected — it's a fast first pass, not a magic wand.
- Heal works best on smooth, low-detail areas. For strong texture, switch to Clone and pick a clean source.
- Images larger than 2000 px on the long edge are scaled down on load to keep editing responsive.
- Undo keeps the last 12 steps (`Ctrl/Cmd+Z` too), and **Compare** shows the untouched original while held.
- Built for Chromium-based browsers; also fine in Firefox and Safari.
