/* =============================================================================
   deposits.js — MINERAL-SYSTEMS prospectivity model (real-data driven)
   -----------------------------------------------------------------------------
   Scoring runs on REAL feature vectors returned by the server's /api/cells
   (see geodata.js): distance to subduction arcs (Bird PB2002), distance to GEM
   active faults, USGS MRDS occurrence density + nearest deposit, and live
   Macrostrat host lithology. We combine them with commodity-specific
   mineral-systems weights that shift with exploration SCALE (coarse → fine),
   mirroring how explorers vector from tectonic setting down to host rock.

   Two channels are kept separate:
     • KNOWN  — MRDS occurrence endowment (brownfield evidence)
     • SIGNAL — mineral-systems favourability from tectonics + structure +
                lithology, INDEPENDENT of known occurrences (the novel channel:
                right geology where nothing is yet catalogued = greenfield)
   ============================================================================= */

/* host-rock favourability from live Macrostrat lithology (real) */
const HOST_AFFINITY = {
  copper: [
    [/(intermediate|granodiorit|diorit|andesit|dacit|porphyr|tonalit|monzonit)/, 1.0],
    [/(volcanic|intrusive|igneous|granit|felsic)/, 0.72],
    [/(sandstone|shale|clastic|sediment)/, 0.5],
    [/(carbonate|limestone|dolo)/, 0.38],
  ],
  gold: [
    [/(greenstone|mafic volcan|metavolcan|basalt|komatiit)/, 1.0],
    [/(schist|metased|slate|phyllite|turbidite|greywacke|quartz)/, 0.85],
    [/(rhyolit|dacit|andesit|felsic volcan|tuff)/, 0.78],
    [/(granit|intrusive|igneous)/, 0.55],
    [/(sandstone|conglomerate|sediment)/, 0.45],
  ],
  lithium: [
    [/(pegmatit|leucogranit|aplite)/, 1.0],
    [/(evaporit|playa|salt|brine|lacustrine|saline)/, 1.0],
    [/(rhyolit|tuff|ash|felsic volcan)/, 0.78],
    [/(granit|felsic intrusive)/, 0.68],
    [/(clay|mudstone|alluvi|sediment)/, 0.52],
  ],
  rare_earth: [
    [/(carbonatit|alkalin|syenit|nephelin|phonolit|ijolite|foid)/, 1.0],
    [/(laterit|regolith|weather)/, 0.8],
    [/(granit|pegmatit|gneiss|felsic intrusive)/, 0.58],
    [/(intrusive|igneous)/, 0.44],
  ],
  nickel: [
    [/(ultramafic|komatiit|dunit|peridotit|serpentin|pyroxenit)/, 1.0],
    [/(mafic|gabbro|basalt|norite|troctolite)/, 0.85],
    [/(laterit|regolith|weather)/, 0.7],
    [/(intrusive|igneous|volcanic)/, 0.44],
  ],
  uranium: [
    [/(sandstone|arkose|conglomerate|arenite)/, 1.0],
    [/(unconformity|regolith)/, 0.8],
    [/(granit|felsic intrusive|rhyolit|pegmatit)/, 0.74],
    [/(mudstone|shale|clastic|sediment)/, 0.5],
  ],
};
function lithFavorability(mineralId, macro) {
  if (!macro || !macro.ok) return 0.05;
  const hay = ((macro.lith || "") + " " + (macro.name || "")).toLowerCase();
  if (!hay.trim()) return 0.2;
  let best = 0.2;
  for (const [re, w] of (HOST_AFFINITY[mineralId] || [])) if (w > best && re.test(hay)) best = w;
  return best;
}

/* ---- mineral-systems config: which real controls matter, and how far ----
   halfwidths (km) set the proximity decay; w = signal component weights.
   Notes are surfaced to the agent so it cites real exploration criteria. */
const MS = {
  copper: { sub: 600, fault: 120, plate: 0,
    w: { sub: 0.42, fault: 0.13, plate: 0, grad: 0.10, mag: 0.08, lith: 0.32 },
    note: "porphyry/sediment-hosted & IOCG Cu — convergent-margin arcs; intermediate intrusions; magnetic/fault corridors" },
  gold: { sub: 900, fault: 60, plate: 0,
    w: { sub: 0.13, fault: 0.42, plate: 0, grad: 0.10, mag: 0.06, lith: 0.30 },
    note: "orogenic/epithermal Au — crustal-scale shear zones & greenstone belts; arc epithermal" },
  lithium: { sub: 0, fault: 200, plate: 0,
    w: { sub: 0, fault: 0.13, plate: 0, grad: 0.07, mag: 0, lith: 0.80 },
    note: "LCT pegmatite & brine/clay Li — fractionated granites, evaporitic basins, felsic volcanics" },
  rare_earth: { sub: 0, fault: 250, plate: 600,
    w: { sub: 0, fault: 0.12, plate: 0.20, grad: 0.12, mag: 0.12, lith: 0.45 },
    note: "carbonatite/alkaline REE — rift & craton-margin alkaline complexes; magnetic/gravity-edge intrusions" },
  nickel: { sub: 0, fault: 150, plate: 0,
    w: { sub: 0, fault: 0.16, plate: 0, grad: 0.16, mag: 0.14, lith: 0.54 },
    note: "magmatic Ni-sulphide/laterite — dense magnetic mafic-ultramafic intrusions, komatiites, ophiolite weathering" },
  uranium: { sub: 0, fault: 150, plate: 0,
    w: { sub: 0, fault: 0.20, plate: 0, grad: 0.08, mag: 0.10, lith: 0.62 },
    note: "unconformity/sandstone & IOCG-U — Proterozoic basin margins, reactivated basement faults, magnetic highs" },
};

const prox = (d, hw) => (hw > 0 && d != null ? Math.exp(-d / hw) : 0);

/* KNOWN channel: real MRDS occurrence endowment (0..1) */
function msKnown(f) {
  const occK = 1 - Math.exp(-(f.occDensity || 0) / 3);
  const nearK = f.occNearestKm != null ? Math.exp(-f.occNearestKm / 60) : 0;
  return clamp01(Math.max(occK, 0.85 * nearK));
}

/* SIGNAL channel: mineral-systems favourability from tectonics+structure+lith,
   scale-weighted (coarse → tectonic setting, fine → host lithology). 0..1 */
function msSignal(commodityId, f, level, nLevels) {
  const ms = MS[commodityId] || MS.copper;
  const t = nLevels > 1 ? level / (nLevels - 1) : 0; // 0 coarse .. 1 fine
  const sSub = prox(f.dSub, ms.sub);
  const sFault = prox(f.dFault, ms.fault);
  const sPlate = prox(f.dPlate, ms.plate);
  const sGrad = clamp01((f.gravGrad || 0) / 80);          // crustal-architecture edges (gravity worms)
  const sMag = clamp01((f.magGrad || 0) / 60);            // magnetic edges (magnetite intrusions, IOCG, BIF)
  const sLith = lithFavorability(commodityId, f.macro);
  let wSub = (ms.w.sub || 0) * (1 - 0.7 * t);
  let wPlate = (ms.w.plate || 0) * (1 - 0.7 * t);
  let wFault = (ms.w.fault || 0) * (0.7 + 0.6 * t);
  let wGrad = (ms.w.grad || 0) * (1.1 - 0.4 * t);         // gradients matter most regional→district
  let wMag = (ms.w.mag || 0) * (1.1 - 0.4 * t);
  let wLith = (ms.w.lith || 0) * (0.5 + 1.0 * t);
  const sum = wSub + wPlate + wFault + wGrad + wMag + wLith || 1;
  return clamp01((wSub * sSub + wPlate * sPlate + wFault * sFault + wGrad * sGrad + wMag * sMag + wLith * sLith) / sum);
}

/* discovery-bias ranking (known/signal normalized 0..1) */
function composite(known, signal, bias) {
  if (bias === "conservative") return 0.78 * known + 0.22 * signal;
  if (bias === "frontier") return signal * (1 - 0.85 * known);
  return 0.45 * known + 0.55 * signal;
}

const BIAS = {
  conservative: { label: "Conservative", blurb: "rank known & brownfield ground" },
  balanced: { label: "Balanced", blurb: "permissive terrain near known deposits" },
  frontier: { label: "Frontier", blurb: "downweight known; rank look-alike geology" },
};
