/* =============================================================================
   app.js — map, window selection, scan, telemetry, evidence panel, zoom loop
   -----------------------------------------------------------------------------
   Scoring is split into two REAL channels that are kept visible throughout:
     • KNOWN  — proximity to catalogued deposits (USMIN + global districts)
     • SIGNAL — host-rock favourability from live Macrostrat geology per cell
   The DISCOVERY BIAS (conservative / balanced / frontier) decides how they're
   combined into the ranked COMPOSITE. No synthetic / fabricated field is used.
   ============================================================================= */

const SCALES = [
  { key: "CONTINENTAL", km: "~3,000 km", sub: "metallogenic province", lens: "craton / orogen setting + province endowment" },
  { key: "REGIONAL", km: "~700 km", sub: "mineral belt", lens: "host terrane + deposit clustering" },
  { key: "DISTRICT", km: "~150 km", sub: "prospect cluster", lens: "district structures + alteration footprint" },
  { key: "PROSPECT", km: "~30 km", sub: "drill target", lens: "target geometry + permissive host" },
  { key: "DEPOSIT", km: "~6 km", sub: "resource delineation", lens: "deposit footprint + grade continuity" },
];
const GRID_N = 4;

// short stepper labels per SCALES index (shown in the draw meter)
const SCALE_TAG = ["Coarse", "Regional", "District", "Prospect", "Site"];

// the size of the drawn window decides where analysis STARTS — a smaller box
// skips the coarser levels. Thresholds are the longer box dimension in km.
function boxSizeKm(b) {
  const midlat = (b.s + b.n) / 2;
  const wkm = Math.abs(b.e - b.w) * 111 * Math.cos((midlat * Math.PI) / 180);
  const hkm = Math.abs(b.n - b.s) * 111;
  return Math.max(wkm, hkm);
}
function levelForBox(b) {
  const km = boxSizeKm(b);
  if (km > 1500) return 0; // Coarse / Continental
  if (km > 400) return 1;  // Regional
  if (km > 80) return 2;   // District
  if (km > 15) return 3;   // Prospect
  return 4;                // Site / Deposit
}

const START_BOXES = {
  copper:     { w: -82, s: -40, e: -58, n: -8 },
  gold:       { w: 112, s: -36, e: 142, n: -14 },
  lithium:    { w: -72, s: -28, e: -64, n: -18 },
  rare_earth: { w: 95,  s: 30,  e: 122, n: 48 },
  nickel:     { w: -95, s: 42,  e: -72, n: 58 },
  uranium:    { w: -112, s: 52, e: -95, n: 62 },
};

const WORLD = { center: [10, 25], zoom: 1.4 };

/* datasets shown in the Data sources panel (counts filled from /api/meta) */
const DATASETS = {
  active: [
    { name: "USGS MRDS", tag: "149k occ.", desc: "Mineral Resources Data System — 149,000+ real mineral occurrences (commodity, development status, deposit type, host rock). Drives the KNOWN-endowment channel: occurrence density + nearest deposit per cell." },
    { name: "Subduction zones — Bird PB2002", tag: "tectonic", desc: "Global plate-boundary model with classified subduction arcs. Distance-to-arc grid drives convergent-margin prospectivity (porphyry Cu, epithermal Au)." },
    { name: "GEM Global Active Faults", tag: "13.7k", desc: "13,696 active fault traces. Distance-to-fault grid drives structural control (orogenic Au, fault-hosted systems)." },
    { name: "Sandwell free-air gravity", tag: "geophysics", desc: "Global 1-min free-air gravity. Horizontal-gradient grid (“gravity worms”) maps crustal-architecture edges that localise ore systems; gravity highs flag dense mafic-ultramafic crust (Ni)." },
    { name: "EMAG2 magnetic anomaly", tag: "geophysics", desc: "Global magnetic anomaly grid. Magnetic-gradient edges flag magnetite-bearing intrusions, IOCG, BIF and mafic-ultramafic bodies — key for buried / blind targets and Ni, REE, IOCG-U." },
    { name: "Macrostrat bedrock geology", tag: "live api", desc: "Surface lithology + age sampled per cell live. Host-rock favourability matched to each commodity's mineral-systems model." },
    { name: "Mineral-systems weighting", tag: "model", desc: "Per-commodity, per-scale weighting of the real layers (coarse → tectonic setting + endowment; fine → host lithology + structure)." },
    { name: "Esri World Imagery", tag: "basemap", desc: "Global satellite basemap, desaturated to a dark operational basemap." },
  ],
  soon: [
    { name: "ASTER / Sentinel-2 alteration", desc: "Multispectral mapping — clay, iron-oxide & silica alteration footprints at district scale." },
    { name: "USGS SGMC + global lithology", desc: "Higher-resolution bedrock lithology & structure polygons beyond Macrostrat coverage." },
    { name: "Craton & basement age", desc: "Archean/Proterozoic basement outlines for greenstone-Au and magmatic-Ni controls." },
    { name: "Copernicus DEM", desc: "Terrain & derived structural lineaments / drainage for placer & basin targeting." },
    { name: "National geochemical surveys", desc: "Stream-sediment & soil geochemistry pathfinder anomalies." },
  ],
};

const $ = (id) => document.getElementById(id);
const els = {};

let map;
let currentBBox = null;
let drawing = false, drawStart = null, running = false;
let runStart = 0, clockTimer = null;

function getBias() { return localStorage.getItem("discovery_bias") || "balanced"; }

/* ---- mission clock ----------------------------------------------------- */
function fmtClock() {
  const s = runStart ? Math.floor((Date.now() - runStart) / 1000) : 0;
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
function startClock() {
  runStart = Date.now();
  clockTimer = setInterval(() => { els.sbClock.textContent = `T+${fmtClock()}`; }, 1000);
}
function stopClock() { clearInterval(clockTimer); }

/* ---- colour utils ------------------------------------------------------ */
function hexToRgb(h) { const n = parseInt(h.replace("#", ""), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function rgbToHex(r) { return "#" + r.map((v) => Math.round(v).toString(16).padStart(2, "0")).join(""); }
function mixHex(a, b, t) {
  const x = hexToRgb(a), y = hexToRgb(b);
  return rgbToHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t));
}
function setHeatRamp(color) {
  if (!map || !map.getLayer("grid-fill")) return;
  const base = "#0a0e12";
  map.setPaintProperty("grid-fill", "fill-color", [
    "interpolate", ["linear"], ["coalesce", ["feature-state", "score"], 0],
    0, base,
    0.4, mixHex(base, color, 0.45),
    0.75, color,
    1, mixHex(color, "#ffffff", 0.4),
  ]);
}

/* ---- known-deposit markers (real USGS MRDS named deposits) -------------- */
const _depCache = {};
async function fetchDepositMarkers(id) {
  if (_depCache[id]) return _depCache[id];
  try {
    const r = await fetch(`/api/deposits?commodity=${id}`);
    const d = r.ok ? (await r.json()).deposits || [] : [];
    return (_depCache[id] = d);
  } catch { return (_depCache[id] = []); }
}
async function refreshDeposits(mineral, bias) {
  if (!map || !map.getSource("deposits")) return;
  const list = await fetchDepositMarkers(mineral.id);
  map.getSource("deposits").setData({
    type: "FeatureCollection",
    features: list.map((d) => ({
      type: "Feature",
      properties: { name: d.n, status: d.st, w: Math.max(0.4, d.w || 0.5) },
      geometry: { type: "Point", coordinates: [d.lng, d.lat] },
    })),
  });
  map.setPaintProperty("dep-dot", "circle-color", mineral.color);
  const dim = bias === "frontier"; // Frontier downweights known endowment
  map.setPaintProperty("dep-dot", "circle-opacity", dim ? 0.28 : 0.85);
  map.setPaintProperty("dep-dot", "circle-stroke-opacity", dim ? 0.3 : 0.85);
  if (map.getLayer("dep-label")) map.setPaintProperty("dep-label", "text-opacity", dim ? 0.25 : 0.78);
}

/* ---- map setup --------------------------------------------------------- */
function initMap() {
  map = new maplibregl.Map({
    container: "map",
    attributionControl: { compact: true },
    style: {
      version: 8,
      glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
      sources: {
        sat: {
          type: "raster",
          tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
          tileSize: 256,
          // Esri World Imagery lacks high-zoom tiles in remote areas (it serves a
          // "Map data not yet available" placeholder). Cap the native zoom so
          // MapLibre upscales an available lower tile instead of requesting it.
          maxzoom: 12,
          attribution: "Imagery © Esri · Geology © Macrostrat · Deposits: USGS MRDS + public sources",
        },
      },
      layers: [{ id: "sat", type: "raster", source: "sat" }],
    },
    center: WORLD.center, zoom: WORLD.zoom, minZoom: 1, maxZoom: 13,
  });

  map.on("load", () => {
    map.addSource("grid", { type: "geojson", data: empty() });
    map.addSource("bbox", { type: "geojson", data: empty() });
    map.addSource("sel", { type: "geojson", data: empty() });
    map.addSource("winner", { type: "geojson", data: empty() });
    map.addSource("deposits", { type: "geojson", data: empty() });

    map.addLayer({
      id: "grid-fill", type: "fill", source: "grid",
      paint: {
        "fill-color": "#0a0e12",
        "fill-opacity": ["case", ["boolean", ["feature-state", "lit"], false], 0.5, 0.05],
      },
    });
    map.addLayer({
      id: "grid-line", type: "line", source: "grid",
      paint: { "line-color": "rgba(190,202,214,0.9)", "line-opacity": 0.12, "line-width": 0.8 },
    });
    // cell id label so the log/telemetry "C09" ↔ the actual grid square
    map.addLayer({
      id: "grid-label", type: "symbol", source: "grid",
      layout: {
        "text-field": ["get", "label"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 12,
        "text-allow-overlap": true, "text-ignore-placement": true,
      },
      paint: {
        "text-color": ["case", ["boolean", ["feature-state", "lit"], false], "#ffffff", "#dfe8ef"],
        "text-halo-color": "#05070a", "text-halo-width": 1.5,
        "text-opacity": ["case", ["boolean", ["feature-state", "lit"], false], 1, 0.72],
      },
    });

    // known deposits (the "Known evidence" layer)
    map.addLayer({
      id: "dep-dot", type: "circle", source: "deposits",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, ["+", 2.5, ["*", 4, ["get", "w"]]], 8, ["+", 4, ["*", 8, ["get", "w"]]]],
        "circle-color": "#d68a3a",
        "circle-opacity": 0.85,
        "circle-stroke-width": 1,
        "circle-stroke-color": "#e7edf2",
        "circle-stroke-opacity": 0.85,
      },
    });
    map.addLayer({
      id: "dep-label", type: "symbol", source: "deposits",
      minzoom: 3.6,
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 10, "text-offset": [0, 1.0], "text-anchor": "top",
        "text-optional": true, "text-allow-overlap": false,
      },
      paint: {
        "text-color": "#d7dee4", "text-halo-color": "#070809", "text-halo-width": 1.3, "text-opacity": 0.8,
      },
    });

    map.addLayer({
      id: "bbox-glow", type: "line", source: "bbox",
      paint: { "line-color": "#22d97a", "line-opacity": 0.22, "line-width": 5, "line-blur": 3 },
    });
    map.addLayer({
      id: "bbox-core", type: "line", source: "bbox",
      paint: { "line-color": "#7af0ad", "line-width": 1.4 },
    });
    map.addLayer({
      id: "sel-fill", type: "fill", source: "sel",
      paint: { "fill-color": "#39d98a", "fill-opacity": 0.08 },
    });
    map.addLayer({
      id: "sel-line", type: "line", source: "sel",
      paint: { "line-color": "#54e29a", "line-width": 1.1, "line-dasharray": [3, 2] },
    });
    map.addLayer({
      id: "winner-glow", type: "line", source: "winner",
      paint: { "line-color": "#e7edf2", "line-opacity": 0.3, "line-width": 6, "line-blur": 4 },
    });
    map.addLayer({
      id: "winner-core", type: "line", source: "winner",
      paint: { "line-color": "#ffffff", "line-width": 1.75 },
    });

    const m = MINERALS[els.mineralSel.value];
    setHeatRamp(m.color);
    refreshDeposits(m, getBias());
    applyStartBox(false); // set a default window but stay zoomed out on first load
    map.getCanvas().style.cursor = "crosshair";
    els.hint.classList.add("show");
    setupTouchDraw();
    updateScaleBar();
  });
  map.on("move", updateScaleBar);

  // draw is always available — click-drag anywhere defines a window (no mode toggle)
  map.on("mousedown", (e) => {
    if (running) return;
    e.preventDefault(); drawing = true; drawStart = e.lngLat; map.dragPan.disable();
    els.hint.classList.remove("show");
  });
  map.on("mousemove", (e) => {
    if (drawing) {
      const b = boxFrom(drawStart, e.lngLat);
      setData("sel", rectFeature(b));
      updateDrawMeter(b);
      updateBoxLabel(b);
    } else els.sbCoords.textContent = fmtLL(e.lngLat.lat, e.lngLat.lng);
  });
  map.on("mouseup", (e) => {
    if (!drawing) return;
    drawing = false; map.dragPan.enable(); setData("sel", empty()); showDrawMeter(false); hideBoxLabel();
    const b = boxFrom(drawStart, e.lngLat);
    if (Math.abs(b.e - b.w) > 0.05 && Math.abs(b.n - b.s) > 0.05) {
      currentBBox = b;
      setData("bbox", rectFeature(b));
      els.hint.classList.remove("show");
      els.begin.disabled = false;
      els.sbWindow.textContent = `${spanKm(b)} km`;
    }
  });
}

/* ---- live draw meter: window size → starting analysis level ------------ */
function buildDrawSteps() {
  els.dmSteps.innerHTML = SCALES.map((s, i) =>
    `<div class="dm-step" data-i="${i}"><span class="dm-num">${i + 1}</span><span class="dm-lbl">${SCALE_TAG[i]}</span></div>`
  ).join("");
}
function showDrawMeter(on) { els.drawmeter.classList.toggle("show", on); }
function updateDrawMeter(b) {
  const km = boxSizeKm(b), lvl = levelForBox(b);
  els.dmKm.textContent = km >= 10 ? Math.round(km).toLocaleString() + " km" : km.toFixed(1) + " km";
  els.dmLevel.textContent = `L${lvl + 1} · ${SCALES[lvl].key} (${SCALES[lvl].km})`;
  els.dmSteps.querySelectorAll(".dm-step").forEach((s) => {
    const i = +s.dataset.i;
    s.classList.toggle("on", i === lvl);
    s.classList.toggle("past", i < lvl); // coarser levels that will be skipped
  });
  showDrawMeter(true);
}

/* ---- dynamic scale bar ------------------------------------------------- */
function niceRound(d) {
  const pow = Math.pow(10, Math.floor(Math.log10(d)));
  const f = d / pow;
  return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * pow;
}
function updateScaleBar() {
  if (!map || !els.sbBar) return;
  const lat = map.getCenter().lat;
  const mpp = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, map.getZoom());
  const dist = niceRound(mpp * 120); // metres for ~120px
  els.sbBar.style.width = Math.round(dist / mpp) + "px";
  els.sbDist.textContent = dist >= 1000 ? (dist / 1000).toLocaleString() + " km" : Math.round(dist) + " m";
}

/* ---- on-box dimensions while dragging ---------------------------------- */
function updateBoxLabel(b) {
  const p = map.project([(b.w + b.e) / 2, b.n]); // north edge centre
  const midlat = (b.s + b.n) / 2;
  const wkm = Math.round(Math.abs(b.e - b.w) * 111 * Math.cos((midlat * Math.PI) / 180));
  const hkm = Math.round(Math.abs(b.n - b.s) * 111);
  els.boxlabel.style.left = p.x + "px";
  els.boxlabel.style.top = p.y + "px";
  els.boxlabel.textContent = `${wkm.toLocaleString()} × ${hkm.toLocaleString()} km`;
  els.boxlabel.classList.add("show");
}
function hideBoxLabel() { els.boxlabel.classList.remove("show"); }

/* ---- touch: one finger draws a window, two fingers pan/zoom ------------
   We intercept on the map container in the CAPTURE phase (which runs before
   MapLibre's own handlers on the descendant canvas). A single-finger gesture
   is consumed for drawing (stopPropagation blocks the map's one-finger pan);
   two+ fingers fall through to MapLibre for pan/pinch-zoom. */
function setupTouchDraw() {
  const cont = map.getContainer();
  let tStart = null, tDrawing = false;
  const llFromTouch = (t) => {
    const r = map.getCanvas().getBoundingClientRect();
    return map.unproject([t.clientX - r.left, t.clientY - r.top]);
  };
  const cancel = () => { tDrawing = false; tStart = null; setData("sel", empty()); showDrawMeter(false); hideBoxLabel(); };

  cont.addEventListener("touchstart", (e) => {
    if (running) return;
    if (e.touches.length === 1) {
      tDrawing = true; tStart = llFromTouch(e.touches[0]);
      els.hint.classList.remove("show");
      e.stopPropagation(); e.preventDefault(); // consume — draw, don't pan
    } else {
      cancel(); // 2+ fingers → let MapLibre pan/zoom
    }
  }, { capture: true, passive: false });

  cont.addEventListener("touchmove", (e) => {
    if (!tDrawing) return;
    if (e.touches.length !== 1) { cancel(); return; }
    const b = boxFrom(tStart, llFromTouch(e.touches[0]));
    setData("sel", rectFeature(b));
    updateDrawMeter(b);
    updateBoxLabel(b);
    e.stopPropagation(); e.preventDefault();
  }, { capture: true, passive: false });

  const finish = (e) => {
    if (!tDrawing) return;
    const t = e.changedTouches && e.changedTouches[0];
    const start = tStart;
    cancel();
    if (!t || !start) return;
    const b = boxFrom(start, llFromTouch(t));
    if (Math.abs(b.e - b.w) > 0.05 && Math.abs(b.n - b.s) > 0.05) {
      currentBBox = b;
      setData("bbox", rectFeature(b));
      els.hint.classList.remove("show");
      els.begin.disabled = false;
      els.sbWindow.textContent = `${spanKm(b)} km`;
    }
    e.stopPropagation();
  };
  cont.addEventListener("touchend", finish, { capture: true, passive: false });
  cont.addEventListener("touchcancel", cancel, { capture: true });
}

/* ---- geometry helpers -------------------------------------------------- */
function empty() { return { type: "FeatureCollection", features: [] }; }
function setData(id, d) { const s = map.getSource(id); if (s) s.setData(d.type ? d : { type: "FeatureCollection", features: [d] }); }
function boxFrom(a, b) {
  return { w: Math.min(a.lng, b.lng), e: Math.max(a.lng, b.lng), s: Math.min(a.lat, b.lat), n: Math.max(a.lat, b.lat) };
}
function ring(b) { return [[b.w, b.s], [b.e, b.s], [b.e, b.n], [b.w, b.n], [b.w, b.s]]; }
function rectFeature(b, p = {}) { return { type: "Feature", properties: p, geometry: { type: "Polygon", coordinates: [ring(b)] } }; }
function spanKm(b) {
  const km = (b.e - b.w) * 111 * Math.cos(((b.s + b.n) / 2 * Math.PI) / 180);
  return Math.round(km).toLocaleString();
}
function fmtLL(lat, lng) {
  return `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lng).toFixed(3)}°${lng >= 0 ? "E" : "W"}`;
}
const cellCentroid = (c) => [(c.bounds.s + c.bounds.n) / 2, (c.bounds.w + c.bounds.e) / 2];

/* ---- grid build: REAL mineral-systems scoring -------------------------
   One /api/cells batch call returns, per cell, real features: distance to
   subduction arcs & GEM faults, USGS MRDS occurrence density + nearest deposit,
   and live Macrostrat host lithology. KNOWN = MRDS endowment; SIGNAL =
   mineral-systems favourability (tectonics+structure+lithology), scale-weighted. */
const EMPTY_FEAT = { dSub: null, dFault: null, dPlate: null, occDensity: 0, occCount: 0, occNearestKm: null, nearest: null, macro: { ok: false } };
async function buildGrid(b, mineral, bias, level, nLevels) {
  const cw = (b.e - b.w) / GRID_N, ch = (b.n - b.s) / GRID_N;
  const cells = [];
  for (let r = 0; r < GRID_N; r++) {
    for (let c = 0; c < GRID_N; c++) {
      const cb = { w: b.w + c * cw, e: b.w + (c + 1) * cw, s: b.n - (r + 1) * ch, n: b.n - r * ch };
      cells.push({ index: r * GRID_N + c, bounds: cb });
    }
  }
  let feats = [];
  try {
    const res = await fetch("/api/cells", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ commodity: mineral.id, cells: cells.map((c) => c.bounds) }),
    });
    if (res.ok) feats = (await res.json()).cells || [];
  } catch (_) { /* degrade to empty features */ }

  let maxC = 1e-9;
  cells.forEach((cell, i) => {
    const f = feats[i] || EMPTY_FEAT;
    cell.f = f;
    cell.macro = f.macro;
    cell.known = msKnown(f);                                  // real MRDS endowment
    cell.signal = msSignal(mineral.id, f, level, nLevels);    // mineral-systems favourability
    cell.composite = composite(cell.known, cell.signal, bias);
    if (cell.composite > maxC) maxC = cell.composite;
  });
  for (const cell of cells) cell.score = clamp01(cell.composite / maxC); // normalized for heat
  return cells;
}

function renderGrid(cells) {
  setData("grid", {
    type: "FeatureCollection",
    features: cells.map((c) => ({
      type: "Feature", id: c.index,
      properties: { label: "C" + String(c.index).padStart(2, "0"), comp: Math.round((c.composite || 0) * 100) },
      geometry: { type: "Polygon", coordinates: [ring(c.bounds)] },
    })),
  });
  cells.forEach((c) => map.setFeatureState({ source: "grid", id: c.index }, { score: 0, lit: false }));
  setData("winner", empty());
}

async function scanReveal(cells) {
  showReticle(true);
  for (const c of cells) {
    map.setFeatureState({ source: "grid", id: c.index }, { score: c.score, lit: true });
    await sleep(50);
  }
  await sleep(220);
  showReticle(false);
}

/* ---- telemetry table (Known vs Novel split) ---------------------------- */
function bar(pct, cls) { return `<span class="mini ${cls}"><i style="width:${Math.round(pct)}%"></i></span>`; }
function renderTelemetry(cells, scale) {
  els.telemetry.classList.add("show");
  els.tpSub.textContent = scale.key;
  els.tpCount.textContent = `${cells.length} cells`;
  els.tpThead.innerHTML =
    `<tr><th>cell</th><th>comp</th><th title="Known evidence — proximity to catalogued deposits">known</th>` +
    `<th title="Geological signal — host-rock favourability from live Macrostrat geology">signal</th></tr>`;
  const ranked = [...cells].sort((a, b) => b.composite - a.composite);
  els.tpTbody.innerHTML = ranked.map((c) => {
    const cp = Math.round(c.composite * 100), k = Math.round(c.known * 100), s = Math.round(c.signal * 100);
    return `<tr data-cell="${c.index}"><td class="tp-cell">C${String(c.index).padStart(2, "0")}</td>` +
      `<td>${cp}</td>` +
      `<td>${bar(k, "k")}${k}</td>` +
      `<td>${bar(s, "s")}${s}</td></tr>`;
  }).join("");
}
function markWinnerRow(idx) {
  els.tpTbody.querySelectorAll("tr").forEach((tr) =>
    tr.classList.toggle("win", +tr.dataset.cell === idx));
}

/* ---- evidence panel: Known evidence vs Novel signal -------------------- */
function updateEvidence(cell, mineral, decision) {
  const f = cell.f || EMPTY_FEAT;
  const near = f.nearest;
  const gap = f.occNearestKm != null ? Math.round(f.occNearestKm) : null;
  const host = macroSummary(cell.macro) || "no geologic-map coverage (offshore?)";
  const km = (v) => (v == null ? "—" : Math.round(v).toLocaleString() + " km");
  const nearHtml = near
    ? `<li><b>${near.n}</b> · ${near.st}${near.ct ? " · " + near.ct : ""} · ${Math.round(near.distKm)} km</li>`
    : `<li class="none">no catalogued occurrence in range</li>`;
  const typeTag = decision
    ? `<span class="etype ${decision.type}">${decision.type === "known" ? "KNOWN-LED" : "NOVEL-LED"}</span>`
    : "";

  els.evidence.classList.add("show");
  els.evidence.innerHTML =
    `<div class="ev-head"><span>Evidence · C${String(cell.index).padStart(2, "0")}</span>${typeTag}</div>` +
    `<div class="ev-sec known">` +
      `<div class="ev-t"><i class="dot k"></i>Known endowment <em>${Math.round(cell.known * 100)}</em></div>` +
      `<ul class="ev-list">${nearHtml}</ul>` +
      `<div class="ev-kv"><label>MRDS occurrences (in radius)</label><b>${f.occCount || 0}</b></div>` +
    `</div>` +
    `<div class="ev-sec novel">` +
      `<div class="ev-t"><i class="dot s"></i>Mineral-systems signal <em>${Math.round(cell.signal * 100)}</em></div>` +
      `<div class="ev-kv"><label>Subduction arc</label><b>${km(f.dSub)}</b></div>` +
      `<div class="ev-kv"><label>Nearest fault</label><b>${km(f.dFault)}</b></div>` +
      `<div class="ev-kv"><label>Gravity edge</label><b>${f.gravGrad == null ? "—" : Math.round(f.gravGrad) + " mGal/°"}</b></div>` +
      `<div class="ev-kv"><label>Magnetic edge</label><b>${f.magGrad == null ? "—" : Math.round(f.magGrad) + " nT/°"}</b></div>` +
      `<div class="ev-kv"><label>Host (Macrostrat)</label><b>${host}</b></div>` +
      `<div class="ev-kv"><label>Greenfield gap</label><b>${gap == null ? "—" : gap + " km to nearest occ."}</b></div>` +
    `</div>`;
}

/* ---- Macrostrat fetch (real host geology, client-cached) --------------- */
const _macroCache = new Map();
async function fetchMacro(lat, lng) {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  if (_macroCache.has(key)) return _macroCache.get(key);
  let out = { ok: false };
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 7000);
    const r = await fetch(`/api/macrostrat?lat=${lat.toFixed(3)}&lng=${lng.toFixed(3)}`, { signal: ctrl.signal });
    clearTimeout(to);
    if (r.ok) out = await r.json();
  } catch { /* keep {ok:false} */ }
  _macroCache.set(key, out);
  return out;
}
function macroSummary(m) {
  return m && m.ok ? [m.name, m.lith, m.age && "(" + m.age + ")"].filter(Boolean).join(" ") : null;
}

/* ---- camera ------------------------------------------------------------ */
function flyToBox(b, dur = 2200) {
  return new Promise((resolve) => {
    map.fitBounds([[b.w, b.s], [b.e, b.n]], { padding: 64, duration: dur, essential: true });
    map.once("moveend", resolve);
    setTimeout(resolve, dur + 400);
  });
}

/* ---- HUD --------------------------------------------------------------- */
function log(text, cls = "") {
  const line = document.createElement("div");
  line.className = "log-line " + cls;
  const ts = document.createElement("span"); ts.className = "ts"; ts.textContent = `T+${fmtClock()}`;
  const msg = document.createElement("span"); msg.className = "msg"; msg.textContent = text;
  line.append(ts, msg);
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
  return msg;
}
function streamInto(el, chunk) { el.textContent += chunk; els.log.scrollTop = els.log.scrollHeight; }
// compact monospace row (no timestamp) — used to dump the per-cell feature matrix
function logCell(text) {
  const line = document.createElement("div");
  line.className = "log-line cell";
  const msg = document.createElement("span"); msg.className = "msg"; msg.textContent = text;
  line.appendChild(msg);
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}
// dump the exact 16-cell feature matrix the agent receives this pass
function logFeatureMatrix(cells) {
  const withOcc = cells.filter((c) => (c.f.occCount || 0) > 0).length;
  const withGeol = cells.filter((c) => c.f.macro && c.f.macro.ok).length;
  log(`▦ feature matrix → agent · ${cells.length} cells (${withOcc} with MRDS, ${withGeol} with geology)`, "data");
  logCell("cell  arc  flt grav  mag MRDS  host");
  for (const c of cells) {
    const f = c.f || {};
    const n = (v) => (v == null ? "  —" : String(Math.round(v)).padStart(3));
    const lith = f.macro && f.macro.ok ? (f.macro.lith || f.macro.name || "unit") : "no-map";
    logCell(
      `C${String(c.index).padStart(2, "0")} ${n(f.dSub)} ${n(f.dFault)} ${String(Math.round(f.gravGrad || 0)).padStart(4)} ${String(Math.round(f.magGrad || 0)).padStart(4)} ${String(f.occCount || 0).padStart(4)}  ${String(lith).slice(0, 20)}`
    );
  }
}
function setStatus(scale, level, bbox) {
  els.sbScale.textContent = scale.key;
  els.sbWindow.textContent = `${spanKm(bbox)} km`;
  els.sbLevel.textContent = `${level + 1} / ${SCALES.length}`;
}
function setBiasStatus(bias) { els.sbBias.textContent = (BIAS[bias] || BIAS.balanced).label; }
function showReticle(on) { els.reticle.classList.toggle("show", on); }

/* ---- main loop --------------------------------------------------------- */
async function run() {
  if (!currentBBox || running) return;
  running = true;
  els.begin.disabled = els.mineralSel.disabled = els.biasSel.disabled = true;
  els.result.classList.remove("show");
  els.evidence.classList.remove("show");
  els.hint.classList.remove("show");
  els.log.innerHTML = "";
  startClock();

  const mineral = MINERALS[els.mineralSel.value];
  const bias = getBias();
  document.documentElement.style.setProperty("--commodity", mineral.color);
  setHeatRamp(mineral.color);
  refreshDeposits(mineral, bias);
  setBiasStatus(bias);
  els.sbCommodity.textContent = `${mineral.name} — ${mineral.symbol}`;

  log(`agent initialized · target ${mineral.name} (${mineral.symbol})`, "head");
  log(`backend ${await Agent.backend()}`, "dim");
  log(`discovery bias: ${BIAS[bias].label} — ${BIAS[bias].blurb}`, "dim");
  log(`▦ live data stack`, "data");
  log(`  · USGS MRDS — 149k mineral occurrences`, "data");
  log(`  · Bird PB2002 subduction arcs · GEM active faults`, "data");
  log(`  · Sandwell gravity + EMAG2 magnetics (geophysics)`, "data");
  log(`  · Macrostrat bedrock geology (live)`, "data");
  log(`  · mineral-systems weighting per commodity & scale`, "data");

  let bbox = currentBBox, lastDecision = null;
  const startLevel = levelForBox(currentBBox);
  if (startLevel > 0) log(`window sized for ${SCALES[startLevel].key} — skipping ${startLevel} coarser level${startLevel > 1 ? "s" : ""}`, "dim");

  for (let level = startLevel; level < SCALES.length; level++) {
    const scale = SCALES[level];
    setStatus(scale, level, bbox);
    await flyToBox(bbox, level === 0 ? 1600 : 2200);

    log(`${scale.key} · ${scale.km} · ${GRID_N}×${GRID_N} grid · ${scale.lens}`, "head");
    log(`▦ querying real data layers across ${GRID_N * GRID_N} cells…`, "data");

    const cells = await buildGrid(bbox, mineral, bias, level, SCALES.length);
    renderGrid(cells);
    renderTelemetry(cells, scale);

    // cite the REAL numbers this pass
    const occTot = cells.reduce((s, c) => s + (c.f.occCount || 0), 0);
    const top = cells.reduce((a, c) => (c.composite > a.composite ? c : a), cells[0]);
    log(`▦ USGS MRDS · ${occTot} ${mineral.name} occurrence${occTot === 1 ? "" : "s"} in view`, "data");
    if (top.f.dSub != null)
      log(`▦ geophysics (best cell) · subduction ${Math.round(top.f.dSub)} km · fault ${Math.round(top.f.dFault)} km · gravity-edge ${Math.round(top.f.gravGrad || 0)} mGal/° · magnetic-edge ${Math.round(top.f.magGrad || 0)} nT/°`, "data");
    const ms = macroSummary(top.macro);
    if (ms) log(`▦ Macrostrat host (best cell) · ${ms}`, "data");

    // explicit trajectory: the full per-cell feature matrix fed to the agent
    logFeatureMatrix(cells);

    await scanReveal(cells);

    const body = log("", "agent");
    const decision = await Agent.analyze({ mineral, scale, level, nLevels: SCALES.length, bbox, cells, bias }, (c) => streamInto(body, c));
    lastDecision = decision;

    cells.forEach((c) => map.setFeatureState({ source: "grid", id: c.index }, { lit: c.index === decision.cell }));
    setData("winner", rectFeature(cells[decision.cell].bounds));
    markWinnerRow(decision.cell);
    updateEvidence(cells[decision.cell], mineral, decision);
    els.sbConf.textContent = `${decision.confidence}%`;
    els.sbTarget.textContent = `C${String(decision.cell).padStart(2, "0")} — ${decision.headline}`;
    const tag = decision.type === "known" ? "known-led" : "novel-led";
    log(`commit C${String(decision.cell).padStart(2, "0")} · ${tag} · "${decision.headline}" · conf ${decision.confidence}%`, "ok");

    bbox = cells[decision.cell].bounds;
    if (level < SCALES.length - 1) await sleep(500);
  }

  await finalize(bbox, mineral, lastDecision);
  stopClock();
  running = false;
  els.begin.disabled = els.mineralSel.disabled = els.biasSel.disabled = false;
}

/* ---- final site (real geology + tectonics + MRDS; analogue ranges only) */
async function finalize(b, mineral, decision) {
  await flyToBox(b, 2400);
  const lat = (b.s + b.n) / 2, lng = (b.w + b.e) / 2;
  let f = EMPTY_FEAT;
  try {
    const res = await fetch("/api/cells", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ commodity: mineral.id, cells: [b] }),
    });
    if (res.ok) f = (await res.json()).cells[0] || EMPTY_FEAT;
  } catch (_) {}
  const macro = f.macro || { ok: false };
  const fav = Math.round(lithFavorability(mineral.id, macro) * 100);
  const host = macroSummary(macro) || "no geologic-map coverage";
  const near = f.nearest;
  const gap = near ? Math.round(near.distKm) : null;
  const km = (v) => (v == null ? "—" : Math.round(v).toLocaleString() + " km");
  const isNovel = decision.type === "novel";
  const g = mineral.grade, t = mineral.tonnage;

  const el = document.createElement("div");
  el.className = "site-marker";
  el.innerHTML = `<span class="ring"></span><span class="sq"></span><span class="lbl">SITE-01 · ${mineral.symbol}</span>`;
  if (window._siteMarker) window._siteMarker.remove();
  window._siteMarker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);

  log(`potential ${mineral.name} target delineated — SITE-01 (${isNovel ? "novel signal" : "known-belt"})`, "alert");
  els.evidence.classList.remove("show");

  els.result.querySelector(".r-title").textContent = `${mineral.name} target · ${decision.headline}`;
  els.result.querySelector(".r-grid").innerHTML = `
    <div><label>Coordinates</label><b>${fmtLL(lat, lng)}</b></div>
    <div><label>Confidence</label><b>${decision.confidence}%</b></div>
    <div class="accent"><label>Host favourability</label><b>${fav}%</b></div>
    <div><label>Classification</label><b>${isNovel ? "Novel signal" : "Known / brownfield"}</b></div>
    <div class="r-wide"><label>Host geology · Macrostrat</label><b>${host}</b></div>
    <div><label>Subduction arc</label><b>${km(f.dSub)}</b></div>
    <div><label>Nearest fault</label><b>${km(f.dFault)}</b></div>
    <div class="r-wide"><label>Nearest MRDS deposit</label><b>${near ? `${near.n} · ${near.st} · ${gap} km (${f.occCount} occ. nearby)` : "none in range"}</b></div>
    <div><label>Analogue grade · ${mineral.symbol}</label><b>${g.lo}–${g.hi} ${g.unit}</b></div>
    <div><label>Analogue tonnage</label><b>${t.lo.toLocaleString()}–${t.hi.toLocaleString()} ${t.unit}</b></div>
    <div class="r-note r-wide">Grade/tonnage are typical ranges for this deposit type (analogy only) — not measured here. Targeting uses real USGS MRDS, tectonic & Macrostrat layers.</div>`;
  els.result.classList.add("show");
}

/* ---- start box --------------------------------------------------------- */
function applyStartBox(fly = true) {
  currentBBox = { ...START_BOXES[els.mineralSel.value] };
  setData("bbox", rectFeature(currentBBox));
  if (fly) flyToBox(currentBBox, 0);
  els.begin.disabled = false;
  els.sbWindow.textContent = `${spanKm(currentBBox)} km`;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---- boot -------------------------------------------------------------- */
window.addEventListener("DOMContentLoaded", () => {
  Object.assign(els, {
    mineralSel: $("mineral"), biasSel: $("bias"), modelSel: $("model"), backendNote: $("backend-note"),
    begin: $("begin"), log: $("log"),
    datasetsBtn: $("datasets-btn"), datasets: $("datasets"),
    reticle: $("reticle"), hint: $("hint"),
    drawmeter: $("drawmeter"), dmKm: $("dm-km"), dmSteps: $("dm-steps"), dmLevel: $("dm-level"),
    sbBar: $("sb-bar"), sbDist: $("sb-dist"), boxlabel: $("boxlabel"),
    sbBias: $("sb-bias"), sbCommodity: $("sb-commodity"), sbScale: $("sb-scale"), sbWindow: $("sb-window"),
    sbLevel: $("sb-level"), sbConf: $("sb-conf"), sbTarget: $("sb-target"),
    sbCoords: $("sb-coords"), sbClock: $("sb-clock"),
    telemetry: $("telemetry"), tpSub: $("tp-sub"), tpThead: $("tp-thead"),
    tpTbody: $("tp-tbody"), tpCount: $("tp-count"),
    evidence: $("evidence"), result: $("result"),
  });

  // touch devices can't click-drag to draw — a default window is preloaded, so
  // they just pick a commodity/bias and Run; tune the hint accordingly.
  if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) {
    els.hint.textContent = "One finger to draw a window · two fingers to pan · pinch to zoom";
  }

  els.modelSel.value = localStorage.getItem("anthropic_model") || "claude-sonnet-5";
  els.modelSel.addEventListener("change", () => localStorage.setItem("anthropic_model", els.modelSel.value));

  buildDrawSteps();

  els.biasSel.value = getBias();
  setBiasStatus(getBias());
  els.biasSel.addEventListener("change", () => {
    if (running) return;
    localStorage.setItem("discovery_bias", els.biasSel.value);
    setBiasStatus(els.biasSel.value);
    refreshDeposits(MINERALS[els.mineralSel.value], els.biasSel.value);
  });

  // report whether the server has a key (real Claude) or we're in local sim
  Agent.configured().then((ok) => {
    els.backendNote.textContent = ok
      ? "Server has a Claude key — the agent performs real analysis. Pick a model above."
      : "No server key — running the local deterministic agent. Set ANTHROPIC_API_KEY on the server for real Claude analysis.";
  });

  els.mineralSel.addEventListener("change", () => {
    if (running) return;
    const m = MINERALS[els.mineralSel.value];
    document.documentElement.style.setProperty("--commodity", m.color);
    els.sbCommodity.textContent = `${m.name} — ${m.symbol}`;
    setHeatRamp(m.color);
    refreshDeposits(m, getBias());
    applyStartBox();
  });

  const m0 = MINERALS[els.mineralSel.value];
  document.documentElement.style.setProperty("--commodity", m0.color);
  els.sbCommodity.textContent = `${m0.name} — ${m0.symbol}`;

  els.begin.addEventListener("click", run);
  $("resultClose").addEventListener("click", () => els.result.classList.remove("show"));

  // zoom controls
  $("zin").addEventListener("click", () => map.zoomIn());
  $("zout").addEventListener("click", () => map.zoomOut());
  $("zworld").addEventListener("click", () => map.flyTo({ center: WORLD.center, zoom: WORLD.zoom, duration: 900, essential: true }));

  // data-sources modal
  renderDatasets();
  const openDS = () => els.datasets.classList.add("show");
  const closeDS = () => els.datasets.classList.remove("show");
  els.datasetsBtn.addEventListener("click", openDS);
  $("datasets-close").addEventListener("click", closeDS);
  els.datasets.addEventListener("click", (e) => { if (e.target === els.datasets) closeDS(); });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDS(); });

  initMap();
});

function renderDatasets() {
  $("ds-active").innerHTML = DATASETS.active.map((d) =>
    `<div class="ds-item"><div class="ds-row"><b>${d.name}</b><span class="ds-tag">${d.tag}</span></div><p>${d.desc}</p></div>`
  ).join("");
  $("ds-soon").innerHTML = DATASETS.soon.map((d) =>
    `<div class="ds-item soon"><div class="ds-row"><b>${d.name}</b><span class="ds-tag soon">soon</span></div><p>${d.desc}</p></div>`
  ).join("");
}
