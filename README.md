# GAIA-1 · Autonomous Mineral Exploration Demo

An interactive AI demo: pick a commodity, draw a bounding box on a world map, and
an LLM agent progressively analyzes geoscience data, zooming from continental
scale down to a drill target — narrating its reasoning at every level — until it
flags a potential new mining site.

![scales](continental → regional → district → prospect → deposit)

## What it does

1. **Select** a commodity (Cu, Au, Li, REE, Ni, U) and a search region (draw one,
   or use the auto-loaded starting box).
2. The agent runs **5 levels** of analysis (~3,000 km → ~6 km). At each level the
   window is split into a 4×4 grid; each cell is scored across scale-appropriate
   data layers (tectonics → lithology → alteration → assays → drill intercepts).
3. The agent **streams a field-log analysis**, picks the single most prospective
   cell, and the map **flies in** to it. Repeat at the next scale.
4. Final level reveals a **POTENTIAL MINING SITE** with coordinates, estimated
   grade, inferred tonnage, and confidence.

## The AI

- **With an Anthropic API key**, the agent really calls the Claude Messages API
  **directly from your browser** (streaming, via the
  `anthropic-dangerous-direct-browser-access` header) to plan each zoom. Model is
  selectable in the sidebar → *Inference backend* — Haiku 4.5 (fast, default),
  Sonnet 4.6, or Opus 4.8.
- A key is pre-seeded from `js/config.local.js` (see below). You can also paste
  one into the sidebar, which persists in `localStorage`.
- **Without a key**, a built-in deterministic agent runs the same loop so the
  system still operates. The real path also falls back to it on any API error.

### `js/config.local.js` — holds the API key ⚠️

This file seeds your Anthropic key into the browser on load so the agent does
real analysis. **It contains a secret** — don't commit it, share it, or deploy
it to a public host (anyone who can open the page can use the key). Rotate the
key at console.anthropic.com if it leaks. For anything public, drop the
direct-browser-access approach and proxy calls through a small backend instead.

> ⚠️ Putting an API key in a browser exposes it to that page. This is fine for a
> local personal demo; for anything public, proxy the calls through a small
> backend instead of using the direct-browser-access header.

## The geology model

There is no real exploration dataset here. A deterministic *prospectivity field*
is generated from Gaussian "hotspots" placed at **real mineral provinces** for
each commodity (e.g. the Chilean Andes for copper, the Lithium Triangle for Li)
plus fractal noise for texture — so the zoom-in converges on a believable target
and selecting the right continent lands you in the right belt.

## Run it

It's a static site. Serve the folder over HTTP (the satellite tiles and the
Anthropic API both need a real origin):

```bash
cd /Users/kevin/Code/gis
python3 -m http.server 8000
# open http://localhost:8000
```

## Files

- `index.html` — layout, status strip, telemetry panel
- `css/styles.css` — dense operations-platform theme (Palantir/Anduril register)
- `js/data.js` — minerals, real provinces, synthetic prospectivity field
- `js/agent.js` — Claude API agent (streaming) + deterministic fallback
- `js/app.js` — MapLibre map, window drawing, scan, telemetry table, zoom loop
- `js/config.local.js` — local API-key seed (sensitive; do not share)
