/* =============================================================================
   data.js — mineral metadata (commodity, deposit model, typical analogue ranges)
   -----------------------------------------------------------------------------
   No synthetic prospectivity field lives here anymore. Scoring is driven by REAL
   inputs (see deposits.js):
     • KNOWN  — proximity to catalogued deposits (USGS USMIN + global districts)
     • SIGNAL — host-rock favourability from live Macrostrat geology
   The grade/tonnage figures below are TYPICAL ANALOGUE RANGES for each deposit
   type (used to characterise a target by analogy), not measured assays.
   ============================================================================= */

const MINERALS = {
  copper: {
    id: "copper", name: "Copper", symbol: "Cu", color: "#d68a3a",
    model:
      "Porphyry & sediment-hosted Cu. Favoured by magmatic arcs above subduction zones, " +
      "intermediate intrusions, large fault corridors, and potassic/phyllic alteration haloes.",
    grade: { lo: 0.3, hi: 1.6, unit: "% Cu" },
    tonnage: { lo: 80, hi: 1800, unit: "Mt" },
  },
  gold: {
    id: "gold", name: "Gold", symbol: "Au", color: "#c9a227",
    model:
      "Orogenic & epithermal Au. Vectors: crustal-scale shear zones, greenstone belts, " +
      "epithermal quartz veins in volcanic arcs, and arsenic/antimony geochem anomalies.",
    grade: { lo: 0.8, hi: 9.5, unit: "g/t Au" },
    tonnage: { lo: 5, hi: 220, unit: "Mt ore" },
  },
  lithium: {
    id: "lithium", name: "Lithium", symbol: "Li", color: "#5b9bd5",
    model:
      "Brine salars in closed high-altitude basins + LCT pegmatites + volcano-sedimentary " +
      "clays. Vectors: evaporitic playa geochem, fractionated granites, arid endorheic drainage.",
    grade: { lo: 0.4, hi: 2.1, unit: "% Li2O" },
    tonnage: { lo: 10, hi: 320, unit: "Mt" },
  },
  rare_earth: {
    id: "rare_earth", name: "Rare Earths", symbol: "REE", color: "#9a7bc0",
    model:
      "REE in carbonatites & alkaline complexes. Vectors: ring-shaped intrusive bodies, " +
      "radiometric Th/U highs, and ionic-adsorption laterite caps.",
    grade: { lo: 0.8, hi: 7.0, unit: "% TREO" },
    tonnage: { lo: 8, hi: 250, unit: "Mt" },
  },
  nickel: {
    id: "nickel", name: "Nickel", symbol: "Ni", color: "#6fae7f",
    model:
      "Magmatic Ni-sulphide & laterite. Vectors: mafic/ultramafic intrusions, komatiite " +
      "belts, and tropical weathering profiles over ophiolites.",
    grade: { lo: 0.5, hi: 2.6, unit: "% Ni" },
    tonnage: { lo: 20, hi: 400, unit: "Mt" },
  },
  uranium: {
    id: "uranium", name: "Uranium", symbol: "U", color: "#5fae9e",
    model:
      "Unconformity, sandstone-hosted & IOCG U. Vectors: Proterozoic basin margins, " +
      "reactivated basement faults, and radiometric uranium-channel anomalies.",
    grade: { lo: 0.05, hi: 14.0, unit: "% U3O8" },
    tonnage: { lo: 2, hi: 120, unit: "Mt ore" },
  },
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));
