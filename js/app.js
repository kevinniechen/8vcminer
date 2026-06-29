/* =============================================================================
   app.js — map, window selection, scan, telemetry table, and the zoom loop
   ============================================================================= */

const SCALES = [
  { key: "CONTINENTAL", km: "~3,000 km", sub: "metallogenic province",
    layers: ["Tectonic Setting", "Crustal Architecture", "Regional Geophysics", "Known Occurrences"] },
  { key: "REGIONAL", km: "~700 km", sub: "mineral belt",
    layers: ["Host Lithology", "Structural Corridors", "Regional Geochem", "Gravity/Magnetics"] },
  { key: "DISTRICT", km: "~150 km", sub: "prospect cluster",
    layers: ["Alteration (ASTER)", "Fault Intersections", "Soil Geochem", "IP Chargeability"] },
  { key: "PROSPECT", km: "~30 km", sub: "drill target",
    layers: ["Rock-chip Assays", "Detailed Magnetics", "Vein Density", "Gossan / Outcrop"] },
  { key: "DEPOSIT", km: "~6 km", sub: "resource delineation",
    layers: ["Drill Intercepts", "Grade Continuity", "Ore Geometry", "Metallurgy"] },
];
const GRID_N = 4;

const START_BOXES = {
  copper:     { w: -82, s: -40, e: -58, n: -8 },
  gold:       { w: 112, s: -36, e: 142, n: -14 },
  lithium:    { w: -72, s: -28, e: -64, n: -18 },
  rare_earth: { w: 95,  s: 30,  e: 122, n: 48 },
  nickel:     { w: -95, s: 42,  e: -72, n: 58 },
  uranium:    { w: -112, s: 52, e: -95, n: 62 },
};

const $ = (id) => document.getElementById(id);
const els = {};

let map;
let currentBBox = null;
let drawMode = false, drawing = false, drawStart = null, running = false;
let runStart = 0, clockTimer = null;

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

/* ---- map setup --------------------------------------------------------- */
function initMap() {
  map = new maplibregl.Map({
    container: "map",
    attributionControl: { compact: true },
    style: {
      version: 8,
      sources: {
        sat: {
          type: "raster",
          tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
          tileSize: 256, attribution: "Imagery © Esri",
        },
      },
      layers: [{ id: "sat", type: "raster", source: "sat" }],
    },
    center: [-69, -24], zoom: 3, maxZoom: 13,
  });

  map.on("load", () => {
    map.addSource("grid", { type: "geojson", data: empty() });
    map.addSource("bbox", { type: "geojson", data: empty() });
    map.addSource("sel", { type: "geojson", data: empty() });
    map.addSource("winner", { type: "geojson", data: empty() });

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
    map.addLayer({
      id: "bbox-glow", type: "line", source: "bbox",
      paint: { "line-color": "#d68a3a", "line-opacity": 0.16, "line-width": 5, "line-blur": 3 },
    });
    map.addLayer({
      id: "bbox-core", type: "line", source: "bbox",
      paint: { "line-color": "#e9b277", "line-width": 1.25 },
    });
    map.addLayer({
      id: "sel-fill", type: "fill", source: "sel",
      paint: { "fill-color": "#d68a3a", "fill-opacity": 0.06 },
    });
    map.addLayer({
      id: "sel-line", type: "line", source: "sel",
      paint: { "line-color": "#d68a3a", "line-width": 1, "line-dasharray": [3, 2] },
    });
    map.addLayer({
      id: "winner-glow", type: "line", source: "winner",
      paint: { "line-color": "#e7edf2", "line-opacity": 0.3, "line-width": 6, "line-blur": 4 },
    });
    map.addLayer({
      id: "winner-core", type: "line", source: "winner",
      paint: { "line-color": "#ffffff", "line-width": 1.75 },
    });

    setHeatRamp(MINERALS[els.mineralSel.value].color);
    applyStartBox();
  });

  map.on("mousedown", (e) => {
    if (!drawMode || running) return;
    e.preventDefault(); drawing = true; drawStart = e.lngLat; map.dragPan.disable();
  });
  map.on("mousemove", (e) => {
    if (drawing) setData("sel", rectFeature(boxFrom(drawStart, e.lngLat)));
    if (!drawing) els.sbCoords.textContent = fmtLL(e.lngLat.lat, e.lngLat.lng);
  });
  map.on("mouseup", (e) => {
    if (!drawing) return;
    drawing = false; map.dragPan.enable(); setData("sel", empty());
    const b = boxFrom(drawStart, e.lngLat);
    if (Math.abs(b.e - b.w) > 0.05 && Math.abs(b.n - b.s) > 0.05) {
      currentBBox = b;
      setData("bbox", rectFeature(b));
      exitDrawMode();
      els.begin.disabled = false;
      els.sbWindow.textContent = `${spanKm(b)} km`;
    } else exitDrawMode();
  });
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

/* ---- grid build + scoring --------------------------------------------- */
function buildGrid(b, mineral) {
  const cw = (b.e - b.w) / GRID_N, ch = (b.n - b.s) / GRID_N;
  const cells = []; let max = 1e-9;
  for (let r = 0; r < GRID_N; r++) {
    for (let c = 0; c < GRID_N; c++) {
      const cb = { w: b.w + c * cw, e: b.w + (c + 1) * cw, s: b.n - (r + 1) * ch, n: b.n - r * ch };
      const { mean, peak } = sampleCell(cb, mineral);
      cells.push({ index: r * GRID_N + c, bounds: cb, mean, peak });
      if (mean > max) max = mean;
    }
  }
  for (const cell of cells) {
    cell.score = clamp01(cell.mean / max);
    const clat = (cell.bounds.s + cell.bounds.n) / 2, clng = (cell.bounds.w + cell.bounds.e) / 2;
    cell.layers = [0, 1, 2, 3].map((i) =>
      Math.round(clamp01(cell.score * (0.65 + 0.25 * i / 3) + 0.35 * layerNoise(clat, clng, i + 1)) * 100));
  }
  return cells;
}

function renderGrid(cells) {
  setData("grid", {
    type: "FeatureCollection",
    features: cells.map((c) => ({ type: "Feature", id: c.index, properties: {}, geometry: { type: "Polygon", coordinates: [ring(c.bounds)] } })),
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

/* ---- telemetry table --------------------------------------------------- */
function abbr(name) {
  return name.replace(/[^A-Za-z ]/g, "").trim().split(/\s+/)[0].slice(0, 3).toUpperCase();
}
function renderTelemetry(cells, scale) {
  els.telemetry.classList.add("show");
  els.tpSub.textContent = scale.key;
  els.tpCount.textContent = `${cells.length} cells`;
  els.tpThead.innerHTML =
    "<tr><th>cell</th><th>score</th>" + scale.layers.map((l) => `<th title="${l}">${abbr(l)}</th>`).join("") + "</tr>";
  const ranked = [...cells].sort((a, b) => b.score - a.score);
  els.tpTbody.innerHTML = ranked.map((c) => {
    const pct = Math.round(c.score * 100);
    return `<tr data-cell="${c.index}"><td class="tp-cell">C${String(c.index).padStart(2, "0")}</td>` +
      `<td><span class="mini"><i style="width:${pct}%"></i></span>${pct}</td>` +
      c.layers.map((v) => `<td>${v}</td>`).join("") + "</tr>";
  }).join("");
}
function markWinnerRow(idx) {
  els.tpTbody.querySelectorAll("tr").forEach((tr) =>
    tr.classList.toggle("win", +tr.dataset.cell === idx));
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
function setStatus(scale, level, bbox) {
  els.sbScale.textContent = scale.key;
  els.sbWindow.textContent = `${spanKm(bbox)} km`;
  els.sbLevel.textContent = `${level + 1} / ${SCALES.length}`;
}
function showReticle(on) { els.reticle.classList.toggle("show", on); }

/* ---- main loop --------------------------------------------------------- */
async function run() {
  if (!currentBBox || running) return;
  running = true;
  els.begin.disabled = els.draw.disabled = els.mineralSel.disabled = true;
  els.result.classList.remove("show");
  els.log.innerHTML = "";
  startClock();

  const mineral = MINERALS[els.mineralSel.value];
  document.documentElement.style.setProperty("--commodity", mineral.color);
  setHeatRamp(mineral.color);
  els.sbCommodity.textContent = `${mineral.name} — ${mineral.symbol}`;

  log(`agent initialized · target ${mineral.name} (${mineral.symbol})`, "head");
  log(`backend ${await Agent.backend()}`, "dim");

  let bbox = currentBBox, lastDecision = null;

  for (let level = 0; level < SCALES.length; level++) {
    const scale = SCALES[level];
    setStatus(scale, level, bbox);
    await flyToBox(bbox, level === 0 ? 1600 : 2200);

    const cells = buildGrid(bbox, mineral);
    renderGrid(cells);
    renderTelemetry(cells, scale);

    log(`${scale.key} · ${scale.km} · ${GRID_N}×${GRID_N} grid · layers: ${scale.layers.join(", ")}`, "head");
    await scanReveal(cells);

    const body = log("", "agent");
    const decision = await Agent.analyze({ mineral, scale, level, bbox, cells }, (c) => streamInto(body, c));
    lastDecision = decision;

    cells.forEach((c) => map.setFeatureState({ source: "grid", id: c.index }, { lit: c.index === decision.cell }));
    setData("winner", rectFeature(cells[decision.cell].bounds));
    markWinnerRow(decision.cell);
    els.sbConf.textContent = `${decision.confidence}%`;
    els.sbTarget.textContent = `C${String(decision.cell).padStart(2, "0")} — ${decision.headline}`;
    log(`commit C${String(decision.cell).padStart(2, "0")} · "${decision.headline}" · conf ${decision.confidence}%`, "ok");

    bbox = cells[decision.cell].bounds;
    if (level < SCALES.length - 1) await sleep(500);
  }

  await finalize(bbox, mineral, lastDecision);
  stopClock();
  running = false;
  els.begin.disabled = els.draw.disabled = els.mineralSel.disabled = false;
}

/* ---- final site -------------------------------------------------------- */
async function finalize(b, mineral, decision) {
  await flyToBox(b, 2400);
  const lat = (b.s + b.n) / 2, lng = (b.w + b.e) / 2;
  const peak = clamp01(prospectivity(lat, lng, mineral) / 1.2);
  const grade = mineral.grade.lo + (mineral.grade.hi - mineral.grade.lo) * peak;
  const tonnage = Math.round(mineral.tonnage.lo + (mineral.tonnage.hi - mineral.tonnage.lo) * peak);

  const el = document.createElement("div");
  el.className = "site-marker";
  el.innerHTML = `<span class="ring"></span><span class="sq"></span><span class="lbl">SITE-01 · ${mineral.symbol}</span>`;
  if (window._siteMarker) window._siteMarker.remove();
  window._siteMarker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);

  log(`potential ${mineral.name} target delineated — SITE-01`, "alert");

  els.result.querySelector(".r-title").textContent = `${mineral.name} target · ${decision.headline}`;
  els.result.querySelector(".r-grid").innerHTML = `
    <div><label>Coordinates</label><b>${fmtLL(lat, lng)}</b></div>
    <div class="accent"><label>Est. grade</label><b>${grade.toFixed(2)} ${mineral.grade.unit}</b></div>
    <div class="accent"><label>Inferred tonnage</label><b>${tonnage.toLocaleString()} ${mineral.tonnage.unit}</b></div>
    <div><label>Confidence</label><b>${decision.confidence}%</b></div>
    <div><label>Deposit model</label><b>${mineral.symbol} · ${SCALES[SCALES.length - 1].sub}</b></div>
    <div><label>Levels run</label><b>${SCALES.length}</b></div>`;
  els.result.classList.add("show");
}

/* ---- draw mode & start box -------------------------------------------- */
function enterDrawMode() { drawMode = true; map.getCanvas().style.cursor = "crosshair"; els.draw.classList.add("active"); els.hint.classList.add("show"); }
function exitDrawMode() { drawMode = false; map.getCanvas().style.cursor = ""; els.draw.classList.remove("active"); els.hint.classList.remove("show"); }
function applyStartBox() {
  currentBBox = { ...START_BOXES[els.mineralSel.value] };
  setData("bbox", rectFeature(currentBBox));
  flyToBox(currentBBox, 0);
  els.begin.disabled = false;
  els.sbWindow.textContent = `${spanKm(currentBBox)} km`;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---- boot -------------------------------------------------------------- */
window.addEventListener("DOMContentLoaded", () => {
  Object.assign(els, {
    mineralSel: $("mineral"), modelSel: $("model"), backendNote: $("backend-note"),
    draw: $("draw"), begin: $("begin"), log: $("log"),
    reticle: $("reticle"), hint: $("hint"),
    sbCommodity: $("sb-commodity"), sbScale: $("sb-scale"), sbWindow: $("sb-window"),
    sbLevel: $("sb-level"), sbConf: $("sb-conf"), sbTarget: $("sb-target"),
    sbCoords: $("sb-coords"), sbClock: $("sb-clock"),
    telemetry: $("telemetry"), tpSub: $("tp-sub"), tpThead: $("tp-thead"),
    tpTbody: $("tp-tbody"), tpCount: $("tp-count"),
    result: $("result"),
  });

  els.modelSel.value = localStorage.getItem("anthropic_model") || "claude-haiku-4-5";
  els.modelSel.addEventListener("change", () => localStorage.setItem("anthropic_model", els.modelSel.value));

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
    applyStartBox();
  });

  const m0 = MINERALS[els.mineralSel.value];
  document.documentElement.style.setProperty("--commodity", m0.color);
  els.sbCommodity.textContent = `${m0.name} — ${m0.symbol}`;

  els.draw.addEventListener("click", () => { if (!running) (drawMode ? exitDrawMode() : enterDrawMode()); });
  els.begin.addEventListener("click", run);
  $("resultClose").addEventListener("click", () => els.result.classList.remove("show"));

  initMap();
});
