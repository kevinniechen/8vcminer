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
    return localStorage.getItem("anthropic_model") || "claude-haiku-4-5";
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
  function buildPrompt(ctx) {
    const { mineral, scale, bbox, cells, bias, macro, nearby } = ctx;
    const b = BIAS[bias] || BIAS.balanced;
    const rows = cells.map((c) =>
      `  cell ${c.index}: composite=${(c.composite * 100) | 0} | known=${(c.known * 100) | 0} | signal=${(c.signal * 100) | 0}`
    ).join("\n");
    const macroLine = macro && macro.ok
      ? `HOST GEOLOGY (Macrostrat, window centroid): ${[macro.name, macro.lith, macro.age && "(" + macro.age + ")"].filter(Boolean).join(" ")}`
      : `HOST GEOLOGY (Macrostrat): unavailable for this window`;
    const nearLine = nearby && nearby.length
      ? `KNOWN DEPOSITS IN/NEAR WINDOW: ` +
        nearby.slice(0, 4).map((d) => `${d.n} (${mineral.symbol}, ${d.status}, ${d.src}, ${Math.round(d.distKm)} km)`).join("; ")
      : `KNOWN DEPOSITS IN/NEAR WINDOW: none catalogued`;
    return (
      `TARGET COMMODITY: ${mineral.name} (${mineral.symbol})\n` +
      `DEPOSIT MODEL: ${mineral.model}\n` +
      `CURRENT SCALE: ${scale.key} (${scale.km}) — resolving toward a ${scale.sub}.\n` +
      `SEARCH WINDOW: ${bbox.w.toFixed(2)}°,${bbox.s.toFixed(2)}° to ${bbox.e.toFixed(2)}°,${bbox.n.toFixed(2)}°\n` +
      `DISCOVERY BIAS: ${b.label} — ${b.blurb}.\n` +
      macroLine + `\n` + nearLine + `\n\n` +
      `The window is a 4×4 grid. Each cell reports two SEPARATE 0–100 channels —\n` +
      `KNOWN (proximity to catalogued deposits) and SIGNAL (permissive / look-alike\n` +
      `geology) — plus the bias-weighted COMPOSITE:\n` +
      rows +
      `\n\nApply the discovery bias:\n` +
      `  • Conservative → favour high KNOWN (brownfield, near production).\n` +
      `  • Balanced → favour strong SIGNAL adjacent to KNOWN (permissive ground next to endowment).\n` +
      `  • Frontier → favour high SIGNAL where KNOWN is low (greenfield look-alikes away from mined ground).\n` +
      `Task: As the 8vcminer agent, write a SHORT field-log analysis (3–5 terse\n` +
      `technical lines) — explicitly separating KNOWN EVIDENCE from NOVEL SIGNAL —\n` +
      `then pick the single best cell to zoom into for the ${b.label} mandate.\n` +
      `End with EXACTLY one line, nothing after it:\n` +
      `${MARKER} {"cell": <index>, "confidence": <0-100>, "type": "known|novel", "headline": "<≤6 words>"}`
    );
  }

  const SYSTEM =
    "You are the 8vcminer agent, an autonomous mineral-exploration AI. You vector " +
    "toward economic ore deposits by interpreting layered geoscience data. You keep " +
    "two channels distinct: KNOWN evidence (catalogued deposits) versus NOVEL signal " +
    "(permissive look-alike geology), and you obey the operator's discovery bias. You " +
    "reason like an economic geologist, commodity-specific and scale-aware. Voice: " +
    "terse, technical, mission-control field log. No preamble, no markdown.";

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
        model: getModel(), max_tokens: 700, system: SYSTEM,
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
    const { mineral, scale, bias, macro, nearby } = ctx;
    const b = BIAS[bias] || BIAS.balanced;
    const best = ctx.cells.reduce((acc, c) => (c.composite > ctx.cells[acc].composite ? c.index : acc), 0);
    const bc = ctx.cells[best];
    const type = bc.known >= bc.signal && bias !== "frontier" ? "known" : "novel";
    const seed = mineral.id.length + ctx.level * 3 + best;
    const conf = Math.min(96, 56 + bc.composite * 40 + ctx.level * 4);
    const nearTxt = nearby && nearby[0] ? `${nearby[0].n} (${Math.round(nearby[0].distKm)} km, ${nearby[0].src})` : "none catalogued";
    const macroTxt = macro && macro.ok ? [macro.lith, macro.age && "(" + macro.age + ")"].filter(Boolean).join(" ") : "no map unit returned";
    const lines = [
      `${pick(["Scanning", "Integrating", "Resolving", "Vectoring on"], seed)} ${scale.key.toLowerCase()} window · bias=${b.label.toLowerCase()} for ${mineral.name}.`,
      `KNOWN evidence: nearest catalogued deposit ${nearTxt}; cell ${best} known=${(bc.known * 100) | 0}.`,
      `NOVEL signal: permissive host ${macroTxt}; cell ${best} signal=${(bc.signal * 100) | 0}.`,
      type === "known"
        ? `Brownfield mandate → committing to high-endowment cell ${best}.`
        : `Look-alike ground away from mined zones → committing greenfield cell ${best}.`,
    ];
    for (const l of lines) { await typeLine(l + "\n", onToken); await sleep(110); }
    return {
      cell: best, confidence: conf | 0, type,
      headline: type === "known"
        ? pick(["Brownfield extension", "Known-belt target", "Producing district"], seed)
        : pick(["Greenfield look-alike", "Permissive corridor", "Novel signal zone"], seed),
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
