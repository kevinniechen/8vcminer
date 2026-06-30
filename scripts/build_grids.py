#!/usr/bin/env python3
"""
Precompute global 0.5° distance-to-feature grids (great-circle km) for the
first-order tectonic controls used in mineral-systems exploration:
  grid_dist_subduction.f32.gz  -> convergent-margin arcs (porphyry Cu, epithermal Au)
  grid_dist_plate.f32.gz       -> any plate boundary
  grid_dist_fault.f32.gz       -> GEM active faults (structural control)
Grid: row-major, north->south, lon -180..180. Float32 km, gzipped.
"""
import numpy as np, json, gzip, os
from scipy.spatial import cKDTree

RAW = os.path.join(os.path.dirname(__file__), "..", "data", "raw")
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "processed")
RES = 0.5
nx, ny = int(360 / RES), int(180 / RES)            # 720 x 360
lons = -180 + (np.arange(nx) + 0.5) * RES
lats = 90 - (np.arange(ny) + 0.5) * RES            # north -> south
LON, LAT = np.meshgrid(lons, lats)

def to_xyz(lat, lng):
    la, lo = np.radians(lat), np.radians(lng)
    return np.stack([np.cos(la)*np.cos(lo), np.cos(la)*np.sin(lo), np.sin(la)], axis=-1)

grid_xyz = to_xyz(LAT.ravel(), LON.ravel())

def densify(coords, step=0.25):
    out = []
    for i in range(len(coords) - 1):
        a, b = coords[i], coords[i + 1]
        n = max(1, int(max(abs(b[0]-a[0]), abs(b[1]-a[1])) / step))
        for k in range(n):
            t = k / n
            out.append((a[1] + (b[1]-a[1])*t, a[0] + (b[0]-a[0])*t))  # (lat,lng)
    if coords:
        out.append((coords[-1][1], coords[-1][0]))
    return out

def collect(path, filt=None):
    pts = []
    d = json.load(open(path))
    for f in d["features"]:
        if filt and not filt(f):
            continue
        g = f["geometry"]; t = g["type"]
        lines = [g["coordinates"]] if t == "LineString" else (g["coordinates"] if t == "MultiLineString" else [])
        for ln in lines:
            if len(ln) >= 2:
                pts += densify(ln)
    return np.array(pts, dtype="float64")

def dist_grid(latlng):
    tree = cKDTree(to_xyz(latlng[:, 0], latlng[:, 1]))
    chord, _ = tree.query(grid_xyz, k=1)
    arc = 2 * np.arcsin(np.clip(chord, 0, 2) / 2)
    return (arc * 6371.0).astype("<f4").reshape(ny, nx)

jobs = [
    ("dist_subduction", os.path.join(RAW, "plates.json"), lambda f: f["properties"].get("Type") == "subduction"),
    ("dist_plate",      os.path.join(RAW, "plates.json"), None),
    ("dist_fault",      os.path.join(RAW, "faults.geojson"), None),
]
for name, path, filt in jobs:
    arr = collect(path, filt)
    g = dist_grid(arr)
    with gzip.open(os.path.join(OUT, f"grid_{name}.f32.gz"), "wb") as fh:
        fh.write(g.tobytes())
    print(f"{name:16} verts={len(arr):>7}  km[min/median/max]={g.min():.0f}/{np.median(g):.0f}/{g.max():.0f}")

json.dump({"res": RES, "nx": nx, "ny": ny, "lon0": -180.0, "lat0": 90.0,
           "order": "row-major north-to-south, lon -180..180"},
          open(os.path.join(OUT, "grids_meta.json"), "w"), indent=2)
print("done")
