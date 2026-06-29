/* =============================================================================
   server.js — serves the static site AND proxies Claude calls server-side.
   The Anthropic API key lives only here (env var / .env), never in the browser.
   Zero dependencies (Node 18+ global fetch + built-in http).
   ============================================================================= */
const http = require("http");
const fs = require("fs");
const path = require("path");

// --- load .env (local dev only; Railway injects real env vars) --------------
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch (_) {}

const PORT = process.env.PORT || 3000;
const KEY = (process.env.ANTHROPIC_API_KEY || "").trim();
const ROOT = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png",
  ".map": "application/json", ".webmanifest": "application/manifest+json",
};
const ALLOWED_MODELS = new Set(["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-8"]);

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

// crude per-IP rate limit so a public proxy can't run up the Anthropic bill.
// sliding 60s window; default 40 req/min/IP (~8 full 5-call runs).
const RATE_MAX = +process.env.RATE_LIMIT_PER_MIN || 40;
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear(); // bound memory
  return arr.length > RATE_MAX;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = decodeURIComponent(url.pathname);

  // ---- health: tells the frontend whether real Claude is available ----
  if (p === "/api/health") return json(res, 200, { configured: !!KEY });

  // ---- proxy: forward one Messages request to Anthropic, stream it back ----
  if (p === "/api/messages" && req.method === "POST") {
    if (!KEY) return json(res, 501, { error: "ANTHROPIC_API_KEY not configured on server" });
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
    if (rateLimited(ip)) return json(res, 429, { error: "rate limited — slow down" });
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 200000) req.destroy(); });
    req.on("end", async () => {
      let q; try { q = JSON.parse(body); } catch { return json(res, 400, { error: "bad json" }); }
      const payload = {
        model: ALLOWED_MODELS.has(q.model) ? q.model : "claude-haiku-4-5",
        stream: true,
        max_tokens: Math.min(1024, Math.max(64, q.max_tokens || 600)),
        system: typeof q.system === "string" ? q.system.slice(0, 6000) : undefined,
        messages: Array.isArray(q.messages) ? q.messages.slice(0, 4) : [],
      };
      try {
        const up = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify(payload),
        });
        res.writeHead(up.status, {
          "content-type": up.headers.get("content-type") || "text/event-stream",
          "cache-control": "no-cache",
        });
        const reader = up.body.getReader();
        for (;;) { const { value, done } = await reader.read(); if (done) break; res.write(Buffer.from(value)); }
        res.end();
      } catch (e) { json(res, 502, { error: String(e) }); }
    });
    return;
  }

  // ---- static files (no dotfiles / secrets) ----
  if (p.includes("..") || /(^|\/)\.[^/]/.test(p) || p === "/.env" || p === "/server.js") {
    res.writeHead(404); return res.end("not found");
  }
  const rel = p === "/" ? "/index.html" : p;
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("404 not found"); }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`8vcminer listening on :${PORT} ${KEY ? "(claude live)" : "(no key → local sim)"}`));
