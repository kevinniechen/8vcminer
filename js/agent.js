/* =============================================================================
   agent.js — the LLM agent that plans & performs each level of analysis
   -----------------------------------------------------------------------------
   analyze() is called once per zoom level. It streams a short field-log analysis
   then commits to ONE cell to zoom into.

   Backend:
     • REAL — POSTs to the same-origin server proxy (/api/messages), which calls
       Claude with the key held server-side. Streaming SSE. The browser never
       sees the API key.
     • SIM  — a deterministic scripted agent used when the server has no key
       configured, when running as plain static files, or on any proxy error.
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
    const { mineral, scale, bbox, cells } = ctx;
    const rows = cells.map((c) => {
      const lays = scale.layers.map((n, i) => `${n}=${c.layers[i]}`).join(", ");
      return `  cell ${c.index}: composite=${(c.score * 100) | 0} | ${lays}`;
    }).join("\n");
    return (
      `TARGET COMMODITY: ${mineral.name} (${mineral.symbol})\n` +
      `DEPOSIT MODEL: ${mineral.model}\n` +
      `CURRENT SCALE: ${scale.key} (${scale.km}) — resolving toward a ${scale.sub}.\n` +
      `SEARCH WINDOW: ${bbox.w.toFixed(2)}°,${bbox.s.toFixed(2)}° to ${bbox.e.toFixed(2)}°,${bbox.n.toFixed(2)}°\n\n` +
      `The window is divided into a 4×4 grid. Each cell reports normalized 0–100 ` +
      `readings for this scale's data layers and a composite prospectivity score:\n` +
      rows +
      `\n\nTask: As the 8vcminer agent, write a SHORT field-log analysis (3–5 terse ` +
      `technical lines) interpreting the data for ${mineral.name} using the deposit ` +
      `model. Then pick the single most prospective cell to zoom into.\n` +
      `End your message with EXACTLY one line, nothing after it:\n` +
      `${MARKER} {"cell": <index>, "confidence": <0-100>, "headline": "<≤6 words>"}`
    );
  }

  const SYSTEM =
    "You are the 8vcminer agent, an autonomous mineral-exploration AI. You vector " +
    "toward economic ore deposits by interpreting layered geoscience data. You " +
    "reason like an economic geologist, commodity-specific and scale-aware. Voice: " +
    "terse, technical, mission-control field log. No preamble, no markdown.";

  /* ---- decision parsing ------------------------------------------------- */
  function parseDecision(text, cells) {
    let cell = -1, confidence = 70, headline = "Anomaly locked";
    const i = text.lastIndexOf(MARKER);
    if (i !== -1) {
      const m = text.slice(i + MARKER.length).match(/\{[\s\S]*\}/);
      if (m) try {
        const o = JSON.parse(m[0]);
        if (Number.isInteger(o.cell)) cell = o.cell;
        if (typeof o.confidence === "number") confidence = o.confidence | 0;
        if (typeof o.headline === "string") headline = o.headline;
      } catch (_) {}
    }
    if (cell < 0 || cell >= cells.length)
      cell = cells.reduce((b, c) => (c.score > cells[b].score ? c.index : b), 0);
    return { cell, confidence: Math.max(1, Math.min(100, confidence)), headline };
  }
  const visible = (t) => { const i = t.indexOf(MARKER); return i === -1 ? t : t.slice(0, i); };

  /* ---- REAL: streaming via server proxy --------------------------------- */
  async function callReal(ctx, onToken) {
    const res = await fetch(PROXY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: getModel(), max_tokens: 600, system: SYSTEM,
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
    const { mineral, scale } = ctx;
    const best = ctx.cells.reduce((b, c) => (c.score > ctx.cells[b].score ? c.index : b), 0);
    const bc = ctx.cells[best];
    const top = scale.layers.map((n, i) => ({ n, v: bc.layers[i] })).sort((a, b) => b.v - a.v);
    const seed = mineral.id.length + ctx.level * 3 + best;
    const conf = Math.min(96, 58 + bc.score * 38 + ctx.level * 4);
    const lines = [
      `${pick(["Scanning", "Integrating", "Filtering", "Vectoring on", "Resolving"], seed)} ${scale.layers.length} ${scale.key.toLowerCase()} layers for ${mineral.name}…`,
      `Strongest ${top[0].n.toLowerCase()} response (${top[0].v}) coincident with ${top[1].n.toLowerCase()} (${top[1].v}).`,
      `Signature consistent with the ${mineral.symbol} deposit model — ${mineral.model.split(".")[0].toLowerCase()}.`,
      `Cell ${best} dominates the composite field; flanks decay sharply. Committing zoom.`,
    ];
    for (const l of lines) { await typeLine(l + "\n", onToken); await sleep(110); }
    return {
      cell: best, confidence: conf | 0,
      headline: pick(["Coincident anomaly", "Mineralized corridor", "Prospective intercept", "High-tenor zone"], seed),
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
