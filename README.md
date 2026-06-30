# 8vcminer · Autonomous Mineral Exploration Demo

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

- **With an Anthropic API key on the server**, the agent calls the Claude
  Messages API through a **same-origin proxy** (`/api/messages`) — the key stays
  server-side and never reaches the browser. Streaming SSE is passed through.
  Model is selectable in the sidebar → *Inference backend* — Haiku 4.5 (fast,
  default), Sonnet 4.6, or Opus 4.8.
- **Without a key**, a built-in deterministic agent runs the same loop so the
  system still operates. The real path also falls back to it on any API error.
- The key is set as the `ANTHROPIC_API_KEY` env var (Railway service variable in
  prod, `.env` locally). If it ever leaks, rotate it at console.anthropic.com.

## The data model — real datasets, mineral-systems scoring

There is **no synthetic/fabricated field**. Every cell is scored from real
geoscience layers, combined with commodity-specific, scale-aware
**mineral-systems** weights and the selected **discovery bias**
(Conservative / Balanced / Frontier).

**Real layers** (built by `scripts/`, raw sources in `data/raw/` kept local;
compact indexed artifacts committed in `data/processed/`):

- **USGS MRDS** — 149,436 real mineral occurrences (development status, deposit
  type, host rock). Per-commodity occurrence-density field + nearest deposit.
- **Bird (2003) PB2002** plate boundaries — classified **subduction arcs**.
- **GEM Global Active Faults** — 13,696 fault traces.
- **Sandwell & Smith free-air gravity** — crustal architecture; the
  horizontal-gradient grid ("gravity worms") maps crustal edges that localise
  ore systems.
- **Macrostrat** — live bedrock lithology + age per cell.

Precomputed 0.5° great-circle distance / gravity grids (scipy KDTree, gzipped)
are loaded by `geodata.js`; the server answers a batch real-feature query at
`POST /api/cells`.

**Two channels, kept separate:**

- **KNOWN** = MRDS occurrence endowment (real brownfield evidence).
- **SIGNAL** = mineral-systems favourability from tectonics + structure +
  gravity + host lithology, **scale-weighted** (coarse → tectonic setting &
  province endowment; fine → host rock & structure). Copper keys on subduction
  arcs, gold on faults + greenstone, nickel on dense mafic-ultramafic crust, etc.

The **Frontier** bias ranks high-SIGNAL / low-KNOWN cells — favourable
mineral-systems geology with no catalogued deposit = a genuine **greenfield**
target. Grade/tonnage on the final card are *typical analogue ranges* for the
deposit type (by analogy), not measured assays. See the in-app **Data sources &
roadmap** panel (or `GET /api/meta`) for the live dataset manifest.

## Live

**https://8vcminer.up.railway.app** — deployed on Railway, auto-deploys on every
push to `main` of `kevinniechen/8vcminer`.

## Run it locally

It's a Node server (serves the site **and** proxies Claude so the key stays
server-side). Node 18+.

```bash
cd /Users/kevin/Code/gis
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env   # optional; omit to run the local sim
npm start                                     # → http://localhost:3000
```

Without a key (or if you just open the files statically) the agent runs the
built-in deterministic backend so the system still operates.

## Deployment (Railway, GitHub-connected)

- The Railway service is connected to the GitHub repo, so `git push` to `main`
  triggers a build + deploy automatically — no extra step.
- The Anthropic key lives only as the Railway service variable
  `ANTHROPIC_API_KEY` (and locally in `.env`). It is **never** in the repo or
  shipped to the browser; the browser calls the same-origin `/api/messages`
  proxy. `.env` and `js/config.local.js` are git-ignored.
- The proxy caps `max_tokens`, restricts the model list, and rate-limits per IP
  (`RATE_LIMIT_PER_MIN`, default 40) to bound abuse of the public endpoint.

Redeploy / manage:

```bash
railway status            # service + latest deployment
railway logs              # build/deploy logs
railway variable list     # service variables
```

## Files

- `index.html` — layout, status strip, telemetry panel
- `css/styles.css` — dense operations-platform theme (Palantir/Anduril register)
- `js/data.js` — mineral metadata (deposit model, analogue grade/tonnage ranges)
- `js/deposits.js` — real deposits (USMIN + global) + host-rock favourability scorer
- `js/agent.js` — Claude API agent (streaming) + deterministic fallback
- `js/app.js` — MapLibre map, window drawing, scan, telemetry, evidence, zoom loop
- `server.js` — static server + Claude proxy (`/api/messages`) + Macrostrat proxy
