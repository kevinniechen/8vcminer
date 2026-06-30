#!/usr/bin/env python3
"""
Build real per-commodity occurrence layers from USGS MRDS.
Outputs (data/processed/):
  occ_<c>.f32        flat float32 [lat,lng,weight] for ALL valid occurrences (density field)
  deposits_<c>.json  significant NAMED subset for map markers / nearest-deposit evidence
  mrds_meta.json     per-commodity counts
No GDAL/geo deps — pure pandas/numpy.
"""
import pandas as pd, numpy as np, json, os, struct

RAW = os.path.join(os.path.dirname(__file__), "..", "data", "raw", "mrds.csv")
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "processed")
os.makedirs(OUT, exist_ok=True)

# commodity -> set of exact MRDS commodity tokens
COMMODITY = {
    "copper":     {"copper"},
    "gold":       {"gold"},
    "lithium":    {"lithium"},
    "rare_earth": {"ree", "cerium", "yttrium", "lanthanum", "neodymium", "monazite", "xenotime"},
    "nickel":     {"nickel"},
    "uranium":    {"uranium"},
}
# development status -> evidence weight (real production status drives confidence)
DEVW = {"Producer": 1.0, "Past Producer": 0.85, "Prospect": 0.6,
        "Plant": 0.5, "Occurrence": 0.4, "Unknown": 0.35}

cols = ["site_name", "latitude", "longitude", "country", "commod1", "commod2", "commod3",
        "dep_type", "dev_stat", "prod_size", "hrock_type", "tectonic"]
df = pd.read_csv(RAW, usecols=cols, dtype=str, low_memory=False)
df["lat"] = pd.to_numeric(df["latitude"], errors="coerce")
df["lng"] = pd.to_numeric(df["longitude"], errors="coerce")
df = df.dropna(subset=["lat", "lng"])
df = df[(df.lat.between(-90, 90)) & (df.lng.between(-180, 180)) & ~((df.lat == 0) & (df.lng == 0))]

def tokens(row):
    s = ";".join(str(row[c]) for c in ("commod1", "commod2", "commod3") if pd.notna(row[c]))
    return {t.strip().lower() for part in s.replace(",", ";").split(";") for t in [part]}

# pre-tokenize commodity column once
tok_series = (df["commod1"].fillna("") + ";" + df["commod2"].fillna("") + ";" + df["commod3"].fillna("")) \
    .str.lower().str.replace(",", ";", regex=False)

meta = {}
for c, toks in COMMODITY.items():
    # token match (word-ish): match ;token; boundaries
    pat = "|".join(rf"(?:^|;)\s*{t}\s*(?:;|$)" for t in toks)
    m = tok_series.str.contains(pat, regex=True, na=False)
    sub = df[m].copy()
    sub["w"] = sub["dev_stat"].map(DEVW).fillna(0.35).astype("float32")

    # 1) density field — ALL points, binary float32 [lat,lng,w]
    arr = np.empty((len(sub), 3), dtype="<f4")
    arr[:, 0] = sub["lat"].to_numpy("float32")
    arr[:, 1] = sub["lng"].to_numpy("float32")
    arr[:, 2] = sub["w"].to_numpy("float32")
    arr.tofile(os.path.join(OUT, f"occ_{c}.f32"))

    # 2) significant NAMED subset for markers / nearest evidence
    named = sub[sub["site_name"].notna() & (sub["w"] >= 0.6)].copy()
    named = named.sort_values("w", ascending=False)
    # de-dup near-identical sites (same name within ~5 km)
    named["k"] = named["site_name"].str.strip().str.lower() + "|" + \
        named["lat"].round(1).astype(str) + "|" + named["lng"].round(1).astype(str)
    named = named.drop_duplicates("k").head(2000)
    deposits = [{
        "n": str(r.site_name)[:48], "lat": round(float(r.lat), 4), "lng": round(float(r.lng), 4),
        "w": round(float(r.w), 2), "st": str(r.dev_stat) if pd.notna(r.dev_stat) else "Unknown",
        "dt": (str(r.dep_type)[:40] if pd.notna(r.dep_type) else None),
        "ct": (str(r.country)[:32] if pd.notna(r.country) else None),
        "hr": (str(r.hrock_type)[:40] if pd.notna(r.hrock_type) else None),
    } for r in named.itertuples()]
    with open(os.path.join(OUT, f"deposits_{c}.json"), "w") as f:
        json.dump(deposits, f, separators=(",", ":"))

    meta[c] = {"occurrences": int(len(sub)), "named": len(deposits)}
    print(f"{c:11} occ={len(sub):>6}  named={len(deposits):>5}  f32={len(sub)*12/1e6:.2f}MB")

with open(os.path.join(OUT, "mrds_meta.json"), "w") as f:
    json.dump({"source": "USGS MRDS (mrdata.usgs.gov)", "commodities": meta}, f, indent=2)
print("done →", OUT)
