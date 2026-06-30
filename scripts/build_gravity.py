#!/usr/bin/env python3
"""
Build 0.5° gravity layers from Sandwell & Smith global free-air gravity
(grav_33.1.img, 1-min Mercator int16, 0.1 mGal). No GDAL — numpy memmap.
  grid_gravity.f32.gz    free-air anomaly (mGal)
  grid_grav_grad.f32.gz  horizontal gradient magnitude (mGal/°) — crustal
                         architecture / structural edges ("gravity worms")
Same layout as the tectonic grids: row-major north->south, lon -180..180.
"""
import numpy as np, math, gzip, os
from scipy.ndimage import gaussian_filter

RAW = os.path.join(os.path.dirname(__file__), "..", "data", "raw")
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "processed")
IMG = os.path.join(RAW, "grav_33.1.img")
NCOL = 21600
NROW = os.path.getsize(IMG) // 2 // NCOL
g = np.memmap(IMG, dtype=">i2", mode="r", shape=(NROW, NCOL))
DY = math.pi / (180 * 60)

RES = 0.5
nx, ny = int(360 / RES), int(180 / RES)
out = np.zeros((ny, nx), dtype="float64")
for j in range(ny):
    lat = 90 - (j + 0.5) * RES
    y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    row = min(NROW - 1, max(0, int(round(NROW / 2 - y / DY))))  # row 0 = north
    for i in range(nx):
        lng = -180 + (i + 0.5) * RES
        col = int(round(((lng % 360) + 360) % 360 * 60)) % NCOL
        out[j, i] = g[row, col] * 0.1  # mGal

grav = gaussian_filter(out, 1.0)                      # mild smoothing
gy, gx = np.gradient(grav)                            # per 0.5° step
grad = np.sqrt(gx * gx + gy * gy) / RES               # mGal per degree

for name, arr in [("gravity", grav), ("grav_grad", grad)]:
    with gzip.open(os.path.join(OUT, f"grid_{name}.f32.gz"), "wb") as fh:
        fh.write(arr.astype("<f4").tobytes())

def samp(a, lat, lng):
    return float(a[int((90 - lat) / RES), int((lng + 180) / RES)])
for n, la, lo in [("Hawaii", 19.6, -155.5), ("Andes", -22, -68), ("Sahara", 23, 10), ("Norilsk Ni", 69.3, 88.2)]:
    print(f"{n:12} gravity={samp(grav,la,lo):7.1f} mGal  grad={samp(grad,la,lo):6.1f} mGal/deg")
print("done")
