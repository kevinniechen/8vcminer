/* =============================================================================
   data.js — mineral metadata + synthetic geospatial "prospectivity" model
   -----------------------------------------------------------------------------
   There is no real exploration dataset behind this demo. Instead we generate a
   deterministic, geology-flavoured prospectivity field: a sum of Gaussian
   "hotspots" placed at REAL mineral provinces for each commodity, plus fractal
   value-noise for texture. Because it's deterministic, the agent's zoom-in
   converges on a believable target every time, and selecting (say) South
   America for copper drives you into the Andes.
   ============================================================================= */

const MINERALS = {
  copper: {
    id: "copper",
    name: "Copper",
    symbol: "Cu",
    color: "#d68a3a",
    model:
      "Porphyry & sediment-hosted Cu. Favoured by magmatic arcs above subduction zones, " +
      "large fault corridors, and potassic/phyllic alteration haloes.",
    grade: { lo: 0.3, hi: 1.6, unit: "% Cu" },
    tonnage: { lo: 80, hi: 1800, unit: "Mt" },
    provinces: [
      { lat: -24.3, lng: -69.0, s: 5.5, k: 1.0 }, // Chilean Andes (Escondida/Chuqui)
      { lat: -14.0, lng: -72.0, s: 4.5, k: 0.8 }, // Southern Peru
      { lat: 33.2, lng: -110.8, s: 4.5, k: 0.8 }, // Arizona porphyry belt
      { lat: -11.5, lng: 27.5, s: 4.0, k: 0.9 }, // DRC/Zambia Copperbelt
      { lat: -4.1, lng: 137.1, s: 3.0, k: 0.85 }, // Grasberg, Indonesia
      { lat: 43.0, lng: 106.9, s: 3.5, k: 0.75 }, // Oyu Tolgoi, Mongolia
    ],
  },
  gold: {
    id: "gold",
    name: "Gold",
    symbol: "Au",
    color: "#c9a227",
    model:
      "Orogenic & epithermal Au. Vectors: crustal-scale shear zones, greenstone belts, " +
      "epithermal quartz veins in volcanic arcs, and arsenic/antimony geochem anomalies.",
    grade: { lo: 0.8, hi: 9.5, unit: "g/t Au" },
    tonnage: { lo: 5, hi: 220, unit: "Mt ore" },
    provinces: [
      { lat: -26.6, lng: 27.2, s: 4.0, k: 1.0 }, // Witwatersrand, South Africa
      { lat: 40.8, lng: -116.3, s: 4.0, k: 0.9 }, // Carlin Trend, Nevada
      { lat: -30.7, lng: 121.5, s: 4.5, k: 0.95 }, // Kalgoorlie, W. Australia
      { lat: -6.9, lng: -78.5, s: 3.5, k: 0.8 }, // Yanacocha, Peru
      { lat: 6.2, lng: -2.0, s: 3.5, k: 0.75 }, // Ashanti, Ghana
    ],
  },
  lithium: {
    id: "lithium",
    name: "Lithium",
    symbol: "Li",
    color: "#5b9bd5",
    model:
      "Brine salars in closed high-altitude basins + LCT pegmatites. Vectors: evaporitic " +
      "playa geochem, fractionated granites, and arid endorheic drainage.",
    grade: { lo: 0.4, hi: 2.1, unit: "% Li2O" },
    tonnage: { lo: 10, hi: 320, unit: "Mt" },
    provinces: [
      { lat: -23.5, lng: -68.2, s: 4.0, k: 1.0 }, // Salar de Atacama, Chile
      { lat: -20.3, lng: -67.0, s: 3.5, k: 0.9 }, // Salar de Uyuni, Bolivia
      { lat: -33.9, lng: 116.1, s: 3.0, k: 0.85 }, // Greenbushes, Australia
      { lat: 37.8, lng: -117.6, s: 3.0, k: 0.8 }, // Clayton Valley, Nevada
      { lat: 30.3, lng: 103.0, s: 3.5, k: 0.75 }, // Sichuan, China
    ],
  },
  rare_earth: {
    id: "rare_earth",
    name: "Rare Earths",
    symbol: "REE",
    color: "#9a7bc0",
    model:
      "REE in carbonatites & alkaline complexes. Vectors: ring-shaped intrusive bodies, " +
      "radiometric Th/U highs, and ionic-adsorption laterite caps.",
    grade: { lo: 0.8, hi: 7.0, unit: "% TREO" },
    tonnage: { lo: 8, hi: 250, unit: "Mt" },
    provinces: [
      { lat: 41.8, lng: 109.9, s: 3.5, k: 1.0 }, // Bayan Obo, China
      { lat: 35.5, lng: -115.5, s: 3.0, k: 0.9 }, // Mountain Pass, USA
      { lat: -28.9, lng: 122.5, s: 3.0, k: 0.85 }, // Mt Weld, Australia
      { lat: -19.6, lng: -46.9, s: 3.0, k: 0.8 }, // Araxá, Brazil
    ],
  },
  nickel: {
    id: "nickel",
    name: "Nickel",
    symbol: "Ni",
    color: "#6fae7f",
    model:
      "Magmatic Ni-sulphide & laterite. Vectors: mafic/ultramafic intrusions, komatiite " +
      "belts, and tropical weathering profiles over ophiolites.",
    grade: { lo: 0.5, hi: 2.6, unit: "% Ni" },
    tonnage: { lo: 20, hi: 400, unit: "Mt" },
    provinces: [
      { lat: 46.5, lng: -81.0, s: 3.5, k: 0.95 }, // Sudbury, Canada
      { lat: 69.3, lng: 88.2, s: 3.5, k: 1.0 }, // Norilsk, Russia
      { lat: -2.5, lng: 121.0, s: 3.5, k: 0.85 }, // Sulawesi laterites
      { lat: -27.0, lng: 121.0, s: 3.5, k: 0.8 }, // W. Australia komatiites
    ],
  },
  uranium: {
    id: "uranium",
    name: "Uranium",
    symbol: "U",
    color: "#5fae9e",
    model:
      "Unconformity & IOCG-hosted U. Vectors: Proterozoic basin margins, reactivated " +
      "basement faults, and radiometric uranium-channel anomalies.",
    grade: { lo: 0.05, hi: 14.0, unit: "% U3O8" },
    tonnage: { lo: 2, hi: 120, unit: "Mt ore" },
    provinces: [
      { lat: 58.0, lng: -105.0, s: 3.5, k: 1.0 }, // Athabasca Basin, Canada
      { lat: -30.4, lng: 136.9, s: 3.0, k: 0.9 }, // Olympic Dam, Australia
      { lat: 44.0, lng: 67.0, s: 3.5, k: 0.85 }, // Kazakhstan
      { lat: -22.5, lng: 15.0, s: 3.0, k: 0.75 }, // Rössing, Namibia
    ],
  },
};

/* ---- deterministic fractal value-noise ---------------------------------- */
function _hash(x, y) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}
function _noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const tl = _hash(xi, yi), tr = _hash(xi + 1, yi);
  const bl = _hash(xi, yi + 1), br = _hash(xi + 1, yi + 1);
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return tl * (1 - u) * (1 - v) + tr * u * (1 - v) + bl * (1 - u) * v + br * u * v;
}
function _fbm(x, y) {
  let a = 0, amp = 0.5, f = 1;
  for (let i = 0; i < 4; i++) { a += amp * _noise(x * f, y * f); f *= 2; amp *= 0.5; }
  return a; // ~0..1
}

/* ---- raw prospectivity at a point --------------------------------------- */
function prospectivity(lat, lng, mineral) {
  let p = 0;
  for (const h of mineral.provinces) {
    const dLat = lat - h.lat;
    const dLng = (lng - h.lng) * Math.cos((lat * Math.PI) / 180);
    const d2 = dLat * dLat + dLng * dLng;
    p += h.k * Math.exp(-d2 / (2 * h.s * h.s));
  }
  // fine-scale texture, keyed per-commodity so layers differ between minerals
  const seed = mineral.id.length * 7.3;
  const n = _fbm(lng * 0.6 + seed, lat * 0.6 - seed);
  p = p * (0.82 + 0.34 * n) + 0.05 * n;
  return p;
}

/* sample the field across a cell (averaged) and capture its peak */
function sampleCell(b, mineral) {
  let sum = 0, peak = 0;
  const offs = [0.2, 0.5, 0.8];
  for (const fy of offs) {
    for (const fx of offs) {
      const lng = b.w + (b.e - b.w) * fx;
      const lat = b.s + (b.n - b.s) * fy;
      const v = prospectivity(lat, lng, mineral);
      sum += v;
      if (v > peak) peak = v;
    }
  }
  return { mean: sum / (offs.length * offs.length), peak };
}

/* a secondary noise channel for per-layer variation */
function layerNoise(lat, lng, salt) {
  return _fbm(lng * 1.3 + salt * 4.1, lat * 1.3 - salt * 2.7);
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
