/* =============================================================================
   agent.js — the LLM agent that plans & performs each level of analysis
   -----------------------------------------------------------------------------
   analyze() is called once per zoom level. It streams a short field-log analysis
   then commits to ONE cell to zoom into.

   The agent now reasons over TWO separate evidence channels per cell:
     • KNOWN  — proximity to catalogued deposits (USMIN + global districts)
     • SIGNAL — permissive / look-alike geology (the "novel" channel)
   plus a Macrostrat host-rock summary for the window, plus the active
   DISCOVERY BIAS (conservative / balanced / frontier) which governs how those
   channels should be traded off.

   Backend:
     • REAL — POSTs to the same-origin server proxy (/api/messages).
     • SIM  — deterministic fallback (no key / static files / proxy error).
   ============================================================================= */

const Agent = (() => {
  const PROXY = "/api/messages";
  const MARKER = "##TARGET##";

  let _configured = null; // cache of /api/health

  function getModel() {
    return localStorage.getItem("anthropic_model") || "claude-sonnet-5";
  }
  async function configured() {
    if (_configured !== null) return _configured;
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      _configured = r.ok ? !!(await r.json()).configured : false;
    } catch { _configured = false; }
    return _configured;
  }
  async function backend() {
    return (await configured()) ? "claude " + getModel() : "local deterministic agent";
  }

  /* ---- prompt ----------------------------------------------------------- */
  function lithOf(f) {
    return f && f.macro && f.macro.ok ? (f.macro.lith || f.macro.name || "?") : "no map";
  }
  function buildPrompt(ctx) {
    const { mineral, scale, bbox, cells, bias, level, nLevels } = ctx;
    const b = BIAS[bias] || BIAS.balanced;
    const note = (typeof MS !== "undefined" && MS[mineral.id]) ? MS[mineral.id].note : mineral.model;
    const rows = cells.map((c) => {
      const f = c.f || {};
      const seg = [
        `comp=${(c.composite * 100) | 0}`, `known=${(c.known * 100) | 0}`, `signal=${(c.signal * 100) | 0}`,
      ];
      if (f.dSub != null) seg.push(`arc=${Math.round(f.dSub)}km`);
      if (f.dFault != null) seg.push(`fault=${Math.round(f.dFault)}km`);
      if (f.gravGrad != null) seg.push(`gravGrad=${Math.round(f.gravGrad)}`);
      if (f.magGrad != null) seg.push(`magGrad=${Math.round(f.magGrad)}`);
      seg.push(`MRDS=${f.occCount || 0}`);
      seg.push(`host=${String(lithOf(f)).slice(0, 22)}`);
      return `  cell ${c.index}: ${seg.join(" | ")}`;
    }).join("\n");
    const coarse = level <= 1;
    const guide = coarse
      ? "COARSE scale: weight first-order tectonic setting (subduction arc / crustal faults) and province endowment (MRDS occurrence clustering)."
      : "FINER scale: weight host lithology, nearest-occurrence proximity, and structural intersections.";
    return (
      `TARGET: ${mineral.name} (${mineral.symbol})\n` +
      `MINERAL SYSTEM: ${note}\n` +
      `SCALE: ${scale.key} (${scale.km}) → resolving a ${scale.sub}. ${guide}\n` +
      `DISCOVERY BIAS: ${b.label} — ${b.blurb}.\n` +
      `WINDOW: ${bbox.w.toFixed(2)},${bbox.s.toFixed(2)} → ${bbox.e.toFixed(2)},${bbox.n.toFixed(2)}\n\n` +
      `4×4 grid. Per cell, REAL data:\n` +
      `  comp=bias composite · known=USGS MRDS occurrence endowment · signal=mineral-systems favourability\n` +
      `  arc=km to nearest subduction zone (Bird PB2002) · fault=km to nearest GEM active fault\n` +
      `  gravGrad=gravity gradient (mGal/°, crustal edges) · magGrad=magnetic gradient (nT/°, magnetite intrusions/IOCG/BIF)\n` +
      `  MRDS=USGS MRDS ${mineral.symbol} occurrences in cell radius · host=Macrostrat bedrock lithology\n` +
      rows +
      `\n\nApply the bias: Conservative→high KNOWN (brownfield); Balanced→strong SIGNAL next to KNOWN; ` +
      `Frontier→high SIGNAL where KNOWN is low (favourable geology, no catalogued deposit = greenfield).\n` +
      `Read the FULL ${cells.length}-cell scan above and write a detailed field log (6–10 lines):\n` +
      `  1) SCAN: how many cells carry MRDS occurrences vs favourable geology, and the overall pattern.\n` +
      `  2) KNOWN ENDOWMENT: the top brownfield cells by MRDS count, citing arc/fault km and host rock.\n` +
      `  3) NOVEL SIGNAL: the strongest mineral-systems cells with LOW known (favourable geophysics/geology, ` +
      `few/no occurrences) — cite gravity/magnetic edges, arc/fault distances.\n` +
      `  4) DECISION: which cell you commit to under the ${b.label} bias, and why.\n` +
      `Cite specific cells by index (C##) with their REAL numbers throughout, like an exploration geologist.\n` +
      `End with EXACTLY one line: ${MARKER} {"cell":<index>,"confidence":<0-100>,"type":"known|novel","headline":"<≤6 words>"}`
    );
  }

  const SYSTEM =
    "You are the 8vcminer agent, an autonomous mineral-exploration geologist. You vector toward " +
    "undiscovered ore deposits using REAL data layers: USGS MRDS occurrences, subduction-zone & " +
    "plate-boundary geometry (Bird PB2002), GEM active faults, and live Macrostrat bedrock geology. " +
    "You apply mineral-systems criteria specific to the commodity and the exploration scale (coarse → " +
    "tectonic setting & province endowment; fine → host lithology & structure). You keep KNOWN " +
    "endowment distinct from NOVEL mineral-systems signal, obey the operator's discovery bias, and " +
    "always cite the real numbers. Voice: terse, technical, mission-control field log. No markdown.";

  /* ---- decision parsing ------------------------------------------------- */
  function parseDecision(text, cells) {
    let cell = -1, confidence = 70, headline = "Anomaly locked", type = "novel";
    const i = text.lastIndexOf(MARKER);
    if (i !== -1) {
      const m = text.slice(i + MARKER.length).match(/\{[\s\S]*\}/);
      if (m) try {
        const o = JSON.parse(m[0]);
        if (Number.isInteger(o.cell)) cell = o.cell;
        if (typeof o.confidence === "number") confidence = o.confidence | 0;
        if (typeof o.headline === "string") headline = o.headline;
        if (o.type === "known" || o.type === "novel") type = o.type;
      } catch (_) {}
    }
    if (cell < 0 || cell >= cells.length)
      cell = cells.reduce((b, c) => (c.composite > cells[b].composite ? c.index : b), 0);
    return { cell, confidence: Math.max(1, Math.min(100, confidence)), headline, type };
  }
  const visible = (t) => { const i = t.indexOf(MARKER); return i === -1 ? t : t.slice(0, i); };

  /* ---- REAL: streaming via server proxy --------------------------------- */
  async function callReal(ctx, onToken) {
    const res = await fetch(PROXY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: getModel(), max_tokens: 1400, system: SYSTEM,
        messages: [{ role: "user", content: buildPrompt(ctx) }],
      }),
    });
    if (!res.ok || !res.body) throw new Error(`proxy ${res.status}`);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", full = "", shown = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n"); buf = parts.pop();
      for (const line of parts) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") continue;
        let ev; try { ev = JSON.parse(payload); } catch { continue; }
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          full += ev.delta.text;
          const vis = visible(full);
          if (vis.length > shown) { onToken(vis.slice(shown)); shown = vis.length; }
        }
      }
    }
    return parseDecision(full, ctx.cells);
  }

  /* ---- SIM: deterministic fallback -------------------------------------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pick = (a, s) => a[Math.abs(s) % a.length];
  async function typeLine(line, onToken) {
    for (let i = 0; i < line.length; i += 3) { onToken(line.slice(i, i + 3)); await sleep(12); }
  }
  async function callSim(ctx, onToken) {
    const { mineral, scale, bias } = ctx;
    const b = BIAS[bias] || BIAS.balanced;
    const best = ctx.cells.reduce((acc, c) => (c.composite > ctx.cells[acc].composite ? c.index : acc), 0);
    const bc = ctx.cells[best];
    const f = bc.f || {};
    const type = bc.known >= bc.signal && bias !== "frontier" ? "known" : "novel";
    const seed = mineral.id.length + ctx.level * 3 + best;
    const conf = Math.min(96, 56 + bc.composite * 40 + ctx.level * 4);
    const nearTxt = f.nearest ? `${f.nearest.n} (${Math.round(f.nearest.distKm)} km, ${f.nearest.st})` : "none catalogued";
    const host = f.macro && f.macro.ok ? (f.macro.lith || f.macro.name || "mapped unit") : "no map unit";
    const tect = f.dSub != null ? `subduction arc ${Math.round(f.dSub)} km, fault ${Math.round(f.dFault)} km` : "intraplate setting";
    const lines = [
      `${pick(["Scanning", "Integrating", "Resolving", "Vectoring on"], seed)} ${scale.key.toLowerCase()} window · ${b.label.toLowerCase()} mandate · ${mineral.name}.`,
      `KNOWN: ${f.occCount || 0} USGS MRDS occurrences in cell ${best}; nearest ${nearTxt}; endowment ${(bc.known * 100) | 0}.`,
      `SIGNAL: ${tect}; host ${host}; mineral-systems favourability ${(bc.signal * 100) | 0}.`,
      type === "known"
        ? `Brownfield mandate → high-endowment cell ${best}, committing.`
        : `Favourable geology, low catalogued density → greenfield cell ${best}, committing.`,
    ];
    for (const l of lines) { await typeLine(l + "\n", onToken); await sleep(110); }
    return {
      cell: best, confidence: conf | 0, type,
      headline: type === "known"
        ? pick(["Brownfield extension", "Known-belt target", "Producing district"], seed)
        : pick(["Greenfield look-alike", "Permissive arc corridor", "Novel signal zone"], seed),
    };
  }

  /* ---- public ----------------------------------------------------------- */
  async function analyze(ctx, onToken) {
    if (await configured()) {
      try { return await callReal(ctx, onToken); }
      catch (e) {
        onToken(`\n[uplink degraded: ${e.message}] — switching to onboard inference\n`);
        return await callSim(ctx, onToken);
      }
    }
    return await callSim(ctx, onToken);
  }

  return { analyze, backend, configured, getModel };
})();
