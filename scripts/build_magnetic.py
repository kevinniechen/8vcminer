#!/usr/bin/env python3
"""
Build 0.5° magnetic-anomaly layers from the GMT/EMAG2-derived global magnetic
grid (earth_mag_20m, netCDF4 via h5py — no GDAL).
  grid_magnetic.f32.gz   magnetic anomaly (nT)
  grid_mag_grad.f32.gz   gradient magnitude (nT/°) — magnetic edges: magnetite-
                         bearing intrusions, IOCG, BIF, mafic-ultramafic bodies
Same layout as the other grids: row-major north->south, lon -180..180.
"""
import h5py, numpy as np, gzip, os, math
from scipy.ndimage import gaussian_filter, distance_transform_edt
from scipy.interpolate import RegularGridInterpolator

RAW = os.path.join(os.path.dirname(__file__), "..", "data", "raw")
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "processed")

f = h5py.File(os.path.join(RAW, "earth_mag_20m.grd"), "r")
lon = f["lon"][:].astype("float64")
lat = f["lat"][:].astype("float64")
zd = f["z"]
raw = zd[:]
sf = float(np.array(zd.attrs.get("scale_factor", [1.0])).ravel()[0])
ao = float(np.array(zd.attrs.get("add_offset", [0.0])).ravel()[0])
fv = int(np.array(zd.attrs.get("_FillValue", [-32768])).ravel()[0])
f.close()
z = raw.astype("float64") * sf + ao     # unpack to nT
z[raw == fv] = np.nan                    # nodata
# nearest-fill gaps so the field stays continuous (no spurious gradient edges)
mask = ~np.isfinite(z)
idx = distance_transform_edt(mask, return_distances=False, return_indices=True)
z = z[tuple(idx)]

# ensure ascending lat for the interpolator
if lat[0] > lat[-1]:
    lat = lat[::-1]; z = z[::-1, :]
interp = RegularGridInterpolator((lat, lon), z, bounds_error=False, fill_value=np.nanmedian(z))

RES = 0.5
nx, ny = int(360 / RES), int(180 / RES)
olat = 90 - (np.arange(ny) + 0.5) * RES
olon = -180 + (np.arange(nx) + 0.5) * RES
LON, LAT = np.meshgrid(olon, olat)
mag = interp(np.stack([LAT.ravel(), LON.ravel()], axis=-1)).reshape(ny, nx)

mag = gaussian_filter(mag, 0.8)
gy, gx = np.gradient(mag)
grad = np.sqrt(gx * gx + gy * gy) / RES   # nT per degree

for name, arr in [("magnetic", mag), ("mag_grad", grad)]:
    with gzip.open(os.path.join(OUT, f"grid_{name}.f32.gz"), "wb") as fh:
        fh.write(arr.astype("<f4").tobytes())

def samp(a, la, lo):
    return float(a[int((90 - la) / RES), int((lo + 180) / RES)])
for n, la, lo in [("Kiruna IOCG", 67.85, 20.22), ("Bushveld mafic", -25.0, 29.5),
                  ("Sahara", 23, 10), ("Pilbara BIF", -22.5, 117.5), ("MidPacific", 0, -150)]:
    print(f"{n:16} mag={samp(mag,la,lo):8.0f} nT  grad={samp(grad,la,lo):7.0f} nT/deg")
print("done")
