/* =============================================================================
   deposits.js — KNOWN EVIDENCE layer
   -----------------------------------------------------------------------------
   Real, named deposits/districts for each commodity. US entries are tagged
   "USMIN" (USGS Mineral Deposit Database / MRDS register of mining features);
   the rest are tagged "Global" (major producing districts from public literature
   / company resource statements). Coordinates are approximate district centroids.

   Two derived fields drive the system, kept deliberately SEPARATE:
     • knownField   — sharp kernels on actual deposits → "what's already known"
     • signalField  — broad permissive-terrain + fractal texture → "novel signal"
                      (favorable geology that also lights up look-alike ground
                       away from any known deposit)
   Discovery-bias modes combine them differently (see composite()).
   ============================================================================= */

const KNOWN_DEPOSITS = {
  copper: [
    { n: "Bingham Canyon", lat: 40.523, lng: -112.150, status: "producing", size: "giant", src: "USMIN" },
    { n: "Morenci", lat: 33.05, lng: -109.36, status: "producing", size: "giant", src: "USMIN" },
    { n: "Resolution", lat: 33.30, lng: -111.05, status: "dev", size: "giant", src: "USMIN" },
    { n: "Bagdad", lat: 34.58, lng: -113.20, status: "producing", size: "major", src: "USMIN" },
    { n: "Ray", lat: 33.15, lng: -111.01, status: "producing", size: "major", src: "USMIN" },
    { n: "Butte (Continental)", lat: 46.00, lng: -112.51, status: "producing", size: "major", src: "USMIN" },
    { n: "Pebble", lat: 59.90, lng: -155.30, status: "deposit", size: "giant", src: "USMIN" },
    { n: "Escondida", lat: -24.27, lng: -69.07, status: "producing", size: "giant", src: "Global" },
    { n: "Chuquicamata", lat: -22.30, lng: -68.90, status: "producing", size: "giant", src: "Global" },
    { n: "Collahuasi", lat: -20.98, lng: -68.68, status: "producing", size: "giant", src: "Global" },
    { n: "El Teniente", lat: -34.08, lng: -70.36, status: "producing", size: "giant", src: "Global" },
    { n: "Los Pelambres", lat: -31.73, lng: -70.49, status: "producing", size: "major", src: "Global" },
    { n: "Antamina", lat: -9.54, lng: -77.05, status: "producing", size: "giant", src: "Global" },
    { n: "Cerro Verde", lat: -16.53, lng: -71.60, status: "producing", size: "major", src: "Global" },
    { n: "Grasberg", lat: -4.06, lng: 137.11, status: "producing", size: "giant", src: "Global" },
    { n: "Oyu Tolgoi", lat: 43.00, lng: 106.85, status: "producing", size: "giant", src: "Global" },
    { n: "Kamoa-Kakula", lat: -10.77, lng: 25.42, status: "producing", size: "giant", src: "Global" },
    { n: "Cananea", lat: 30.98, lng: -110.30, status: "producing", size: "major", src: "Global" },
  ],
  gold: [
    { n: "Goldstrike (Betze)", lat: 40.95, lng: -116.35, status: "producing", size: "giant", src: "USMIN" },
    { n: "Cortez", lat: 40.27, lng: -116.62, status: "producing", size: "giant", src: "USMIN" },
    { n: "Carlin", lat: 40.80, lng: -116.13, status: "producing", size: "major", src: "USMIN" },
    { n: "Round Mountain", lat: 38.71, lng: -117.07, status: "producing", size: "major", src: "USMIN" },
    { n: "Homestake", lat: 44.35, lng: -103.75, status: "past", size: "major", src: "USMIN" },
    { n: "Witwatersrand", lat: -26.40, lng: 27.40, status: "producing", size: "giant", src: "Global" },
    { n: "Muruntau", lat: 41.50, lng: 64.60, status: "producing", size: "giant", src: "Global" },
    { n: "Boddington", lat: -32.75, lng: 116.36, status: "producing", size: "giant", src: "Global" },
    { n: "Kalgoorlie (Super Pit)", lat: -30.78, lng: 121.50, status: "producing", size: "giant", src: "Global" },
    { n: "Lihir", lat: -3.12, lng: 152.64, status: "producing", size: "giant", src: "Global" },
    { n: "Olimpiada", lat: 59.00, lng: 93.00, status: "producing", size: "giant", src: "Global" },
    { n: "Yanacocha", lat: -6.93, lng: -78.51, status: "producing", size: "major", src: "Global" },
    { n: "Pueblo Viejo", lat: 18.93, lng: -70.16, status: "producing", size: "major", src: "Global" },
    { n: "Obuasi (Ashanti)", lat: 6.20, lng: -1.67, status: "producing", size: "major", src: "Global" },
  ],
  lithium: [
    { n: "Silver Peak (Clayton Valley)", lat: 37.75, lng: -117.64, status: "producing", size: "mid", src: "USMIN" },
    { n: "Thacker Pass", lat: 41.70, lng: -118.05, status: "dev", size: "giant", src: "USMIN" },
    { n: "Kings Mountain", lat: 35.23, lng: -81.34, status: "deposit", size: "mid", src: "USMIN" },
    { n: "Greenbushes", lat: -33.86, lng: 116.06, status: "producing", size: "giant", src: "Global" },
    { n: "Salar de Atacama", lat: -23.50, lng: -68.20, status: "producing", size: "giant", src: "Global" },
    { n: "Salar de Uyuni", lat: -20.30, lng: -67.00, status: "deposit", size: "giant", src: "Global" },
    { n: "Salar del Hombre Muerto", lat: -25.40, lng: -67.00, status: "producing", size: "major", src: "Global" },
    { n: "Pilgangoora", lat: -21.05, lng: 118.90, status: "producing", size: "major", src: "Global" },
    { n: "Jadar", lat: 44.50, lng: 19.30, status: "deposit", size: "major", src: "Global" },
    { n: "Manono", lat: -7.30, lng: 27.40, status: "deposit", size: "giant", src: "Global" },
    { n: "Jianxiawo (Yichun)", lat: 28.20, lng: 114.40, status: "producing", size: "major", src: "Global" },
  ],
  rare_earth: [
    { n: "Mountain Pass", lat: 35.48, lng: -115.53, status: "producing", size: "giant", src: "USMIN" },
    { n: "Bear Lodge", lat: 44.50, lng: -104.45, status: "deposit", size: "major", src: "USMIN" },
    { n: "Bokan Mountain", lat: 54.92, lng: -132.13, status: "deposit", size: "mid", src: "USMIN" },
    { n: "Bayan Obo", lat: 41.78, lng: 109.97, status: "producing", size: "giant", src: "Global" },
    { n: "Mount Weld", lat: -28.87, lng: 122.55, status: "producing", size: "giant", src: "Global" },
    { n: "Lovozero", lat: 67.83, lng: 34.88, status: "producing", size: "major", src: "Global" },
    { n: "Araxá", lat: -19.59, lng: -46.94, status: "producing", size: "major", src: "Global" },
    { n: "Nechalacho", lat: 62.60, lng: -112.50, status: "deposit", size: "mid", src: "Global" },
    { n: "Kvanefjeld", lat: 60.97, lng: -45.95, status: "deposit", size: "major", src: "Global" },
    { n: "Nolans Bore", lat: -22.60, lng: 133.30, status: "deposit", size: "mid", src: "Global" },
  ],
  nickel: [
    { n: "Stillwater", lat: 45.38, lng: -109.88, status: "producing", size: "major", src: "USMIN" },
    { n: "Eagle", lat: 46.78, lng: -87.88, status: "producing", size: "mid", src: "USMIN" },
    { n: "Tamarack", lat: 46.65, lng: -93.13, status: "deposit", size: "mid", src: "USMIN" },
    { n: "Norilsk-Talnakh", lat: 69.33, lng: 88.22, status: "producing", size: "giant", src: "Global" },
    { n: "Sudbury", lat: 46.60, lng: -81.10, status: "producing", size: "giant", src: "Global" },
    { n: "Voisey's Bay", lat: 56.30, lng: -62.10, status: "producing", size: "major", src: "Global" },
    { n: "Jinchuan", lat: 38.50, lng: 102.18, status: "producing", size: "giant", src: "Global" },
    { n: "Sorowako", lat: -2.53, lng: 121.36, status: "producing", size: "giant", src: "Global" },
    { n: "Mount Keith", lat: -27.25, lng: 120.55, status: "producing", size: "major", src: "Global" },
    { n: "Goro", lat: -22.30, lng: 166.97, status: "producing", size: "major", src: "Global" },
  ],
  uranium: [
    { n: "Grants (Ambrosia Lake)", lat: 35.40, lng: -107.90, status: "past", size: "major", src: "USMIN" },
    { n: "Smith Ranch-Highland", lat: 43.10, lng: -105.30, status: "producing", size: "mid", src: "USMIN" },
    { n: "Lisbon Valley", lat: 38.00, lng: -109.30, status: "past", size: "mid", src: "USMIN" },
    { n: "McArthur River", lat: 57.77, lng: -105.50, status: "producing", size: "giant", src: "Global" },
    { n: "Cigar Lake", lat: 58.06, lng: -104.53, status: "producing", size: "giant", src: "Global" },
    { n: "Olympic Dam", lat: -30.44, lng: 136.88, status: "producing", size: "giant", src: "Global" },
    { n: "Rössing", lat: -22.48, lng: 15.04, status: "producing", size: "major", src: "Global" },
    { n: "Husab", lat: -22.70, lng: 15.10, status: "producing", size: "major", src: "Global" },
    { n: "Inkai", lat: 45.00, lng: 67.00, status: "producing", size: "major", src: "Global" },
    { n: "Ranger", lat: -12.68, lng: 132.92, status: "past", size: "major", src: "Global" },
  ],
};

const _STATUS_W = { producing: 1.0, past: 0.7, dev: 0.66, deposit: 0.55, prospect: 0.45 };
const _SIZE_W = { giant: 1.0, major: 0.82, mid: 0.6, small: 0.45 };
const _depW = (d) => (_STATUS_W[d.status] || 0.5) * (_SIZE_W[d.size] || 0.6);

function depsFor(mineral) { return KNOWN_DEPOSITS[mineral.id] || []; }

function distKm(aLat, aLng, bLat, bLng) {
  const dLat = aLat - bLat;
  const dLng = (aLng - bLng) * Math.cos(((aLat + bLat) / 2 * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng) * 111;
}

/* sharp deposit kernels — "known" */
function knownField(lat, lng, mineral) {
  let p = 0;
  for (const d of depsFor(mineral)) {
    const dLat = lat - d.lat, dLng = (lng - d.lng) * Math.cos((lat * Math.PI) / 180);
    const s = d.sig || 1.3;
    p += _depW(d) * Math.exp(-(dLat * dLat + dLng * dLng) / (2 * s * s));
  }
  return p;
}

/* broad permissive terrain + fractal texture — "novel signal" */
function signalField(lat, lng, mineral) {
  let belt = 0;
  for (const d of depsFor(mineral)) {
    const dLat = lat - d.lat, dLng = (lng - d.lng) * Math.cos((lat * Math.PI) / 180);
    belt += _depW(d) * Math.exp(-(dLat * dLat + dLng * dLng) / (2 * 5.5 * 5.5));
  }
  const seed = mineral.id.length * 7.3;
  const n = _fbm(lng * 0.5 + seed, lat * 0.5 - seed); // ~0..1 look-alike texture
  return belt * (0.7 + 0.3 * n) + 0.55 * n;
}

function nearestDeposits(lat, lng, mineral, n = 3) {
  return depsFor(mineral)
    .map((d) => ({ ...d, distKm: distKm(lat, lng, d.lat, d.lng) }))
    .sort((a, b) => a.distKm - b.distKm)
    .slice(0, n);
}

/* averaged known/signal over a cell */
function sampleFields(b, mineral) {
  const offs = [0.25, 0.5, 0.75];
  let k = 0, s = 0, sp = 0;
  for (const fy of offs) for (const fx of offs) {
    const lng = b.w + (b.e - b.w) * fx, lat = b.s + (b.n - b.s) * fy;
    k += knownField(lat, lng, mineral);
    const sv = signalField(lat, lng, mineral);
    s += sv; if (sv > sp) sp = sv;
  }
  const n = offs.length * offs.length;
  return { known: k / n, signal: s / n, signalPeak: sp };
}

/* discovery-bias ranking. known/signal are normalized 0..1 per window. */
function composite(known, signal, bias) {
  if (bias === "conservative") return 0.78 * known + 0.22 * signal; // brownfield / known
  if (bias === "frontier") return signal * (1 - 0.85 * known);       // look-alike, away from known
  return 0.45 * known + 0.55 * signal;                               // balanced: nearby permissive
}

const BIAS = {
  conservative: { label: "Conservative", blurb: "rank known & brownfield ground" },
  balanced: { label: "Balanced", blurb: "permissive terrain near known deposits" },
  frontier: { label: "Frontier", blurb: "downweight known; rank look-alike geology" },
};
