/* =============================================================================
   geodata.js — loads the REAL precomputed geoscience layers and answers
   per-point feature queries. Zero deps (built-in zlib/fs).

   Layers (data/processed/, built by scripts/build_*.py):
     • occ_<c>.f32            USGS MRDS occurrence points [lat,lng,weight]
     • deposits_<c>.json      named significant deposits (markers / nearest evidence)
     • grid_dist_*.f32.gz     0.5° great-circle distance grids (km) to
                              subduction zones / plate boundaries / GEM faults
   ============================================================================= */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const DIR = path.join(__dirname, "data", "processed");
const COMMODITIES = ["copper", "gold", "lithium", "rare_earth", "nickel", "uranium"];

let grids = {};        // name -> {data:Float32Array, nx,ny,res,lon0,lat0}
let occ = {};          // commodity -> {pts:Float32Array(n*3), index:Map}
let deposits = {};     // commodity -> [{n,lat,lng,w,st,dt,ct,hr}]
let META = { ok: false };

function loadGrid(name) {
  const meta = JSON.parse(fs.readFileSync(path.join(DIR, "grids_meta.json"), "utf8"));
  const buf = zlib.gunzipSync(fs.readFileSync(path.join(DIR, `grid_${name}.f32.gz`)));
  const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return { data, ...meta };
}

function loadOcc(c) {
  const buf = fs.readFileSync(path.join(DIR, `occ_${c}.f32`));
  const pts = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const index = new Map(); // "latFloor_lngFloor" -> [pointIndex,...]
  for (let i = 0; i < pts.length; i += 3) {
    const k = Math.floor(pts[i]) + "_" + Math.floor(pts[i + 1]);
    (index.get(k) || index.set(k, []).get(k)).push(i);
  }
  return { pts, index, count: pts.length / 3 };
}

function init() {
  try {
    for (const n of ["dist_subduction", "dist_plate", "dist_fault", "gravity", "grav_grad", "magnetic", "mag_grad"]) grids[n] = loadGrid(n);
    const counts = {};
    for (const c of COMMODITIES) {
      occ[c] = loadOcc(c);
      deposits[c] = JSON.parse(fs.readFileSync(path.join(DIR, `deposits_${c}.json`), "utf8"));
      counts[c] = { occurrences: occ[c].count, named: deposits[c].length };
    }
    const mrds = JSON.parse(fs.readFileSync(path.join(DIR, "mrds_meta.json"), "utf8"));
    META = {
      ok: true,
      sources: {
        occurrences: { name: "USGS MRDS", note: "Mineral Resources Data System — real occurrences", counts },
        subduction: { name: "Bird (2003) PB2002 plate boundaries", note: "convergent-margin arcs" },
        faults: { name: "GEM Global Active Faults", note: "crustal structure proximity" },
        gravity: { name: "Sandwell & Smith free-air gravity", note: "crustal architecture + gradient edges" },
        magnetic: { name: "EMAG2 magnetic anomaly (GMT)", note: "magnetite-bearing intrusions, IOCG, BIF" },
        geology: { name: "Macrostrat", note: "live bedrock lithology + age (per query)" },
      },
      totalOccurrences: Object.values(counts).reduce((a, b) => a + b.occurrences, 0),
    };
    console.log(`geodata: ${META.totalOccurrences} MRDS occurrences + ${Object.keys(grids).length} feature grids loaded`);
  } catch (e) {
    META = { ok: false, error: String(e) };
    console.log("geodata: layers unavailable —", String(e));
  }
  return META.ok;
}

/* bilinear sample of a 0.5° grid (cell centres at +0.5) */
function sampleGrid(g, lat, lng) {
  if (!g) return null;
  const fx = (lng - g.lon0) / g.res - 0.5;
  const fy = (g.lat0 - lat) / g.res - 0.5;
  const i0 = Math.max(0, Math.min(g.nx - 1, Math.floor(fx)));
  const j0 = Math.max(0, Math.min(g.ny - 1, Math.floor(fy)));
  const i1 = Math.min(g.nx - 1, i0 + 1), j1 = Math.min(g.ny - 1, j0 + 1);
  const tx = Math.max(0, Math.min(1, fx - i0)), ty = Math.max(0, Math.min(1, fy - j0));
  const d = g.data;
  const a = d[j0 * g.nx + i0], b = d[j0 * g.nx + i1], c = d[j1 * g.nx + i0], e = d[j1 * g.nx + i1];
  return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + e * tx * ty;
}

function distKm(aLat, aLng, bLat, bLng) {
  const dLat = aLat - bLat;
  const dLng = (aLng - bLng) * Math.cos(((aLat + bLat) / 2 * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng) * 111;
}

/* weighted occurrence density + nearest occurrence within radiusKm */
function occDensity(c, lat, lng, radiusKm) {
  const o = occ[c]; if (!o) return { density: 0, count: 0, nearestKm: null };
  const rDeg = radiusKm / 111 + 0.05;
  const span = Math.ceil(rDeg);
  let density = 0, count = 0, nearest = Infinity;
  const lat0 = Math.floor(lat), lng0 = Math.floor(lng);
  for (let dj = -span; dj <= span; dj++) {
    for (let di = -span; di <= span; di++) {
      const arr = o.index.get((lat0 + dj) + "_" + (lng0 + di));
      if (!arr) continue;
      for (const idx of arr) {
        const d = distKm(lat, lng, o.pts[idx], o.pts[idx + 1]);
        if (d < nearest) nearest = d;
        if (d <= radiusKm) {
          density += o.pts[idx + 2] * Math.exp(-(d * d) / (radiusKm * radiusKm));
          count++;
        }
      }
    }
  }
  return { density, count, nearestKm: nearest === Infinity ? null : nearest };
}

function nearestDeposit(c, lat, lng) {
  const list = deposits[c]; if (!list || !list.length) return null;
  let best = null, bd = Infinity;
  for (const d of list) {
    const dist = distKm(lat, lng, d.lat, d.lng);
    if (dist < bd) { bd = dist; best = d; }
  }
  return best && { ...best, distKm: bd };
}

/* full real feature vector for a point */
function features(c, lat, lng, radiusKm) {
  const od = occDensity(c, lat, lng, radiusKm);
  return {
    dSub: sampleGrid(grids.dist_subduction, lat, lng),
    dPlate: sampleGrid(grids.dist_plate, lat, lng),
    dFault: sampleGrid(grids.dist_fault, lat, lng),
    gravMgal: sampleGrid(grids.gravity, lat, lng),
    gravGrad: sampleGrid(grids.grav_grad, lat, lng),
    magNt: sampleGrid(grids.magnetic, lat, lng),
    magGrad: sampleGrid(grids.mag_grad, lat, lng),
    occDensity: od.density,
    occCount: od.count,
    occNearestKm: od.nearestKm,
    nearest: nearestDeposit(c, lat, lng),
  };
}

function depositMarkers(c, cap = 200) {
  const list = deposits[c] || [];
  return list.slice(0, cap); // already sorted by weight in the build step
}

module.exports = { init, meta: () => META, features, depositMarkers, COMMODITIES };
