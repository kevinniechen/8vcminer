/* =============================================================================
   app.js — map, window selection, scan, telemetry, evidence panel, zoom loop
   -----------------------------------------------------------------------------
   Scoring is split into two channels that are kept visible throughout:
     • KNOWN  — proximity to catalogued deposits (USMIN + global districts)
     • SIGNAL — permissive / look-alike geology (the synthetic prospectivity field)
   The DISCOVERY BIAS (conservative / balanced / frontier) decides how they're
   combined into the ranked COMPOSITE. Macrostrat supplies real host-rock
   evidence for each window.
   ============================================================================= */

const SCALES = [
  { key: "CONTINENTAL", km: "~3,000 km", sub: "metallogenic province", lens: "craton / orogen setting + province endowment" },
  { key: "REGIONAL", km: "~700 km", sub: "mineral belt", lens: "host terrane + deposit clustering" },
  { key: "DISTRICT", km: "~150 km", sub: "prospect cluster", lens: "district structures + alteration footprint" },
  { key: "PROSPECT", km: "~30 km", sub: "drill target", lens: "target geometry + permissive host" },
  { key: "DEPOSIT", km: "~6 km", sub: "resource delineation", lens: "deposit footprint + grade continuity" },
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

/* ---- known-deposit markers --------------------------------------------- */
function depFeatures(mineral) {
  return {
    type: "FeatureCollection",
    features: (KNOWN_DEPOSITS[mineral.id] || []).map((d) => ({
      type: "Feature",
      properties: { name: d.n, src: d.src, status: d.status, w: _depW(d) },
      geometry: { type: "Point", coordinates: [d.lng, d.lat] },
    })),
  };
}
function refreshDeposits(mineral, bias) {
  if (!map || !map.getSource("deposits")) return;
  map.getSource("deposits").setData(depFeatures(mineral));
  map.setPaintProperty("dep-dot", "circle-color", mineral.color);
  // Frontier downweights known evidence → dim the catalogued deposits.
  const dim = bias === "frontier";
  map.setPaintProperty("dep-dot", "circle-opacity", dim ? 0.28 : 0.85);
  map.setPaintProperty("dep-dot", "circle-stroke-opacity", dim ? 0.3 : 0.85);
  if (map.getLayer("dep-label")) map.setPaintProperty("dep-label", "text-opacity", dim ? 0.25 : 0.8);
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
          tileSize: 256, attribution: "Imagery © Esri · Geology © Macrostrat · Deposits: USGS USMIN + public sources",
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

    const m = MINERALS[els.mineralSel.value];
    setHeatRamp(m.color);
    refreshDeposits(m, getBias());
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
const cellCentroid = (c) => [(c.bounds.s + c.bounds.n) / 2, (c.bounds.w + c.bounds.e) / 2];

/* ---- grid build + dual-channel scoring --------------------------------- */
function buildGrid(b, mineral, bias) {
  const cw = (b.e - b.w) / GRID_N, ch = (b.n - b.s) / GRID_N;
  const cells = []; let maxK = 1e-9, maxS = 1e-9;
  for (let r = 0; r < GRID_N; r++) {
    for (let c = 0; c < GRID_N; c++) {
      const cb = { w: b.w + c * cw, e: b.w + (c + 1) * cw, s: b.n - (r + 1) * ch, n: b.n - r * ch };
      const f = sampleFields(cb, mineral);
      cells.push({ index: r * GRID_N + c, bounds: cb, rawK: f.known, rawS: f.signal });
      if (f.known > maxK) maxK = f.known;
      if (f.signal > maxS) maxS = f.signal;
    }
  }
  let maxC = 1e-9;
  for (const cell of cells) {
    cell.known = clamp01(cell.rawK / maxK);
    cell.signal = clamp01(cell.rawS / maxS);
    cell.compRaw = composite(cell.known, cell.signal, bias);
    if (cell.compRaw > maxC) maxC = cell.compRaw;
  }
  for (const cell of cells) {
    cell.composite = clamp01(cell.compRaw / maxC);
    cell.score = cell.composite; // drives heat ramp
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

/* ---- telemetry table (Known vs Novel split) ---------------------------- */
function bar(pct, cls) { return `<span class="mini ${cls}"><i style="width:${Math.round(pct)}%"></i></span>`; }
function renderTelemetry(cells, scale) {
  els.telemetry.classList.add("show");
  els.tpSub.textContent = scale.key;
  els.tpCount.textContent = `${cells.length} cells`;
  els.tpThead.innerHTML =
    `<tr><th>cell</th><th>comp</th><th title="Known evidence — proximity to catalogued deposits">known</th>` +
    `<th title="Novel signal — permissive / look-alike geology">signal</th></tr>`;
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
function updateEvidence(cell, mineral, macro, decision) {
  const [lat, lng] = cellCentroid(cell);
  const near = nearestDeposits(lat, lng, mineral, 2);
  const gap = near[0] ? Math.round(near[0].distKm) : null;
  const host = macro && macro.ok
    ? [macro.name, macro.lith, macro.age && "(" + macro.age + ")"].filter(Boolean).join(" ")
    : "no Macrostrat unit returned";
  const nearHtml = near.length
    ? near.map((d) => `<li><b>${d.n}</b> · ${d.status} · <span class="src">${d.src}</span> · ${Math.round(d.distKm)} km</li>`).join("")
    : `<li class="none">none catalogued in range</li>`;
  const typeTag = decision
    ? `<span class="etype ${decision.type}">${decision.type === "known" ? "KNOWN-LED" : "NOVEL-LED"}</span>`
    : "";

  els.evidence.classList.add("show");
  els.evidence.innerHTML =
    `<div class="ev-head"><span>Evidence · C${String(cell.index).padStart(2, "0")}</span>${typeTag}</div>` +
    `<div class="ev-sec known">` +
      `<div class="ev-t"><i class="dot k"></i>Known evidence <em>${Math.round(cell.known * 100)}</em></div>` +
      `<ul class="ev-list">${nearHtml}</ul>` +
      `<div class="ev-kv"><label>Host (Macrostrat)</label><b>${host}</b></div>` +
    `</div>` +
    `<div class="ev-sec novel">` +
      `<div class="ev-t"><i class="dot s"></i>Novel signal <em>${Math.round(cell.signal * 100)}</em></div>` +
      `<div class="ev-kv"><label>Greenfield gap</label><b>${gap == null ? "—" : gap + " km to nearest known"}</b></div>` +
      `<div class="ev-kv"><label>Permissive terrain</label><b>${cell.signal > 0.55 ? "yes — look-alike host" : "moderate"}</b></div>` +
    `</div>`;
}

/* ---- Macrostrat fetch -------------------------------------------------- */
async function fetchMacrostrat(lat, lng) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 7000);
    const r = await fetch(`/api/macrostrat?lat=${lat.toFixed(3)}&lng=${lng.toFixed(3)}`, { signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) return { ok: false };
    return await r.json();
  } catch { return { ok: false }; }
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
function setBiasStatus(bias) { els.sbBias.textContent = (BIAS[bias] || BIAS.balanced).label; }
function showReticle(on) { els.reticle.classList.toggle("show", on); }

/* ---- main loop --------------------------------------------------------- */
async function run() {
  if (!currentBBox || running) return;
  running = true;
  els.begin.disabled = els.draw.disabled = els.mineralSel.disabled = els.biasSel.disabled = true;
  els.result.classList.remove("show");
  els.evidence.classList.remove("show");
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

  let bbox = currentBBox, lastDecision = null;

  for (let level = 0; level < SCALES.length; level++) {
    const scale = SCALES[level];
    setStatus(scale, level, bbox);
    await flyToBox(bbox, level === 0 ? 1600 : 2200);

    const cells = buildGrid(bbox, mineral, bias);
    renderGrid(cells);
    renderTelemetry(cells, scale);

    log(`${scale.key} · ${scale.km} · ${GRID_N}×${GRID_N} grid · ${scale.lens}`, "head");

    // real host-rock evidence for this window (best-effort)
    const wlat = (bbox.s + bbox.n) / 2, wlng = (bbox.w + bbox.e) / 2;
    const macro = await fetchMacrostrat(wlat, wlng);
    if (macro.ok) log(`macrostrat host: ${[macro.name, macro.lith, macro.age && "(" + macro.age + ")"].filter(Boolean).join(" ")}`, "dim");
    const nearby = nearestDeposits(wlat, wlng, mineral, 4);

    await scanReveal(cells);

    const body = log("", "agent");
    const decision = await Agent.analyze({ mineral, scale, level, bbox, cells, bias, macro, nearby }, (c) => streamInto(body, c));
    lastDecision = decision;

    cells.forEach((c) => map.setFeatureState({ source: "grid", id: c.index }, { lit: c.index === decision.cell }));
    setData("winner", rectFeature(cells[decision.cell].bounds));
    markWinnerRow(decision.cell);
    updateEvidence(cells[decision.cell], mineral, macro, decision);
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
  els.begin.disabled = els.draw.disabled = els.mineralSel.disabled = els.biasSel.disabled = false;
}

/* ---- final site -------------------------------------------------------- */
async function finalize(b, mineral, decision) {
  await flyToBox(b, 2400);
  const lat = (b.s + b.n) / 2, lng = (b.w + b.e) / 2;
  const peak = clamp01(signalField(lat, lng, mineral) / 1.8);
  const grade = mineral.grade.lo + (mineral.grade.hi - mineral.grade.lo) * peak;
  const tonnage = Math.round(mineral.tonnage.lo + (mineral.tonnage.hi - mineral.tonnage.lo) * peak);
  const near = nearestDeposits(lat, lng, mineral, 1)[0];
  const gap = near ? Math.round(near.distKm) : null;
  const macro = await fetchMacrostrat(lat, lng);
  const host = macro.ok ? [macro.lith, macro.age && "(" + macro.age + ")"].filter(Boolean).join(" ") : "—";
  const isNovel = decision.type === "novel";

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
    <div class="accent"><label>Est. grade</label><b>${grade.toFixed(2)} ${mineral.grade.unit}</b></div>
    <div class="accent"><label>Inferred tonnage</label><b>${tonnage.toLocaleString()} ${mineral.tonnage.unit}</b></div>
    <div><label>Confidence</label><b>${decision.confidence}%</b></div>
    <div><label>Classification</label><b>${isNovel ? "Novel signal" : "Known / brownfield"}</b></div>
    <div><label>Nearest known</label><b>${near ? `${near.n} · ${gap} km` : "none"}</b></div>
    <div class="r-wide"><label>Host (Macrostrat)</label><b>${host}</b></div>`;
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
    mineralSel: $("mineral"), biasSel: $("bias"), modelSel: $("model"), backendNote: $("backend-note"),
    draw: $("draw"), begin: $("begin"), log: $("log"),
    reticle: $("reticle"), hint: $("hint"),
    sbBias: $("sb-bias"), sbCommodity: $("sb-commodity"), sbScale: $("sb-scale"), sbWindow: $("sb-window"),
    sbLevel: $("sb-level"), sbConf: $("sb-conf"), sbTarget: $("sb-target"),
    sbCoords: $("sb-coords"), sbClock: $("sb-clock"),
    telemetry: $("telemetry"), tpSub: $("tp-sub"), tpThead: $("tp-thead"),
    tpTbody: $("tp-tbody"), tpCount: $("tp-count"),
    evidence: $("evidence"), result: $("result"),
  });

  els.modelSel.value = localStorage.getItem("anthropic_model") || "claude-haiku-4-5";
  els.modelSel.addEventListener("change", () => localStorage.setItem("anthropic_model", els.modelSel.value));

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

  els.draw.addEventListener("click", () => { if (!running) (drawMode ? exitDrawMode() : enterDrawMode()); });
  els.begin.addEventListener("click", run);
  $("resultClose").addEventListener("click", () => els.result.classList.remove("show"));

  initMap();
});
