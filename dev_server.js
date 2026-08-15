#!/usr/bin/env node
/**
 * SpankBang Grayjay plugin — local dev harness
 * ============================================
 *
 * Purpose
 * -------
 *   The Cloudflare Managed Challenge on spankbang.com blocks EVERY plain HTTP
 *   client (curl, node fetch, python requests, etc.) with a 403. The only way
 *   to reach the site programmatically is to reuse a `cf_clearance` cookie
 *   obtained by a real browser that solved the Turnstile challenge, together
 *   with the exact User-Agent that solved it.
 *
 *   This harness lets you paste that cookie + UA into a small web UI, run the
 *   same requests the Grayjay plugin makes, and see the raw response — so you
 *   can prove the fix works end-to-end BEFORE side-loading the patched script
 *   into Grayjay.
 *
 * How to use
 * ----------
 *   1. Requires only Node.js >= 18 (uses built-in fetch). No `npm install`.
 *   2. Run:      node dev_server.js
 *   3. Open:     http://localhost:5555
 *   4. In Chrome/Firefox, visit https://spankbang.com, solve the Turnstile
 *      challenge, then open DevTools -> Application -> Cookies -> spankbang.com
 *      Copy the `cf_clearance` value (and `__cf_bm` if present).
 *   5. Also copy the exact User-Agent your browser is sending
 *      (chrome://version -> "User agent").
 *   6. Paste all three into the harness and click "Test Home". You should see
 *      HTTP 200 and real HTML. That proves the cookie+UA reuse pattern works
 *      on your IP.
 *   7. Buttons for Home / Channel / Video / Search let you validate every code
 *      path the Grayjay plugin uses.
 *
 * IMPORTANT: cf_clearance is IP-bound. You must run this harness on the SAME
 * network / IP address that solved the challenge in your browser. If you
 * paste a cookie from a phone and run this on desktop wifi, it will 403.
 */

const http = require("http");
const url = require("url");

const PORT = 5555;

// ---- HTML UI ---------------------------------------------------------------
const HTML = `<!doctype html><html><head><meta charset="utf-8">
<title>SpankBang Plugin Dev Harness</title>
<style>
  :root { color-scheme: dark; --bg:#0d1117; --fg:#e6edf3; --mut:#7d8590; --br:#30363d; --acc:#2f81f7; --ok:#3fb950; --err:#f85149; }
  * { box-sizing: border-box; }
  body { background:var(--bg); color:var(--fg); font-family: ui-sans-serif, system-ui, sans-serif; margin:0; padding:24px; }
  h1 { margin:0 0 4px; font-size:20px; }
  .sub { color:var(--mut); font-size:13px; margin-bottom:24px; }
  .grid { display:grid; grid-template-columns: 380px 1fr; gap:20px; }
  .card { background:#161b22; border:1px solid var(--br); border-radius:8px; padding:16px; }
  label { display:block; font-size:12px; color:var(--mut); margin:12px 0 4px; text-transform:uppercase; letter-spacing:.5px; }
  textarea, input, select { width:100%; background:#0d1117; color:var(--fg); border:1px solid var(--br); border-radius:6px; padding:8px 10px; font-family:ui-monospace,Menlo,monospace; font-size:12px; }
  textarea { min-height:60px; resize:vertical; }
  button { background:var(--acc); color:#fff; border:0; border-radius:6px; padding:8px 14px; margin:6px 6px 0 0; cursor:pointer; font-weight:600; font-size:13px; }
  button.sec { background:#21262d; color:var(--fg); border:1px solid var(--br); }
  button:hover { filter: brightness(1.1); }
  .status { display:inline-block; padding:2px 8px; border-radius:12px; font-weight:600; font-size:12px; margin-right:8px; }
  .status.ok { background:rgba(63,185,80,.2); color:var(--ok); }
  .status.err { background:rgba(248,81,73,.2); color:var(--err); }
  pre { background:#0d1117; border:1px solid var(--br); border-radius:6px; padding:12px; overflow:auto; max-height:280px; font-size:11px; line-height:1.5; }
  .hdr-line { color:var(--mut); }
  .hint { font-size:12px; color:var(--mut); line-height:1.5; margin-top:8px; }
  a { color:var(--acc); }
  .row { display:flex; gap:8px; align-items:center; margin-top:10px; flex-wrap:wrap; }
  .row input { flex:1; }
  code { background:#21262d; padding:1px 6px; border-radius:4px; font-size:12px; }
</style></head>
<body>
<h1>SpankBang Grayjay plugin — dev harness</h1>
<div class="sub">Paste a browser-solved <code>cf_clearance</code> cookie + matching UA, then trigger the same requests the plugin makes.</div>
<div class="grid">
  <div class="card">
    <label for="ua">User-Agent (must match the browser that solved Turnstile)</label>
    <textarea id="ua" placeholder="Mozilla/5.0 ...">Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36</textarea>

    <label for="cf">cf_clearance cookie value</label>
    <textarea id="cf" placeholder="paste the raw cf_clearance value (no name=, no quotes)"></textarea>

    <label for="cfbm">__cf_bm cookie value (optional)</label>
    <textarea id="cfbm" placeholder="paste the __cf_bm value if you have one"></textarea>

    <label for="extra">Extra cookies (e.g. sb_session=..., raw cookie header format)</label>
    <textarea id="extra" placeholder="sb_session=abc; auth=xyz"></textarea>

    <label for="path">Custom path to fetch (starts with /)</label>
    <div class="row">
      <input id="path" value="/" />
      <button id="btn-custom">Fetch path</button>
    </div>

    <label>Preset endpoints (identical to what the plugin calls)</label>
    <div class="row">
      <button class="sec" data-path="/">Home</button>
      <button class="sec" data-path="/new-videos/">/new-videos/</button>
      <button class="sec" data-path="/api/videos/trending/">/api/videos/trending/</button>
      <button class="sec" data-path="/s/amateur/">/s/amateur/</button>
      <button class="sec" data-path="/pornstars/">/pornstars/</button>
    </div>

    <div class="hint">
      Tip: open Chrome, visit <code>https://spankbang.com</code>, wait for the
      "Just a moment…" page to disappear (Turnstile solved). Open DevTools →
      Application → Cookies → <code>spankbang.com</code>, copy <code>cf_clearance</code>
      and <code>__cf_bm</code>. Then copy the User-Agent from <code>chrome://version</code>.
      This harness proves the cookie-reuse pattern is what the plugin needs to do.
    </div>
  </div>

  <div class="card">
    <div id="out"><em style="color:var(--mut)">Response will appear here. Click any button on the left to fire a request.</em></div>
  </div>
</div>

<script>
async function fire(path){
  const ua = document.getElementById('ua').value.trim();
  const cf = document.getElementById('cf').value.trim();
  const cfbm = document.getElementById('cfbm').value.trim();
  const extra = document.getElementById('extra').value.trim();

  const out = document.getElementById('out');
  out.innerHTML = '<em style="color:var(--mut)">Firing '+path+' ...</em>';

  const body = { path, ua, cf, cfbm, extra };
  const res = await fetch('/api/fetch', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  const j = await res.json();

  const ok = j.status >= 200 && j.status < 400;
  const cfMit = j.headers && j.headers['cf-mitigated'];
  const setC = j.headers && j.headers['set-cookie'];
  out.innerHTML = ''
    + '<div><span class="status '+(ok?'ok':'err')+'">HTTP '+j.status+'</span>'
    + '<b>'+path+'</b> — '+j.ms+' ms — server: '+(j.headers?.server||'?')
    + (cfMit ? ' — <span class="status err">cf-mitigated: '+cfMit+'</span>' : '')
    + '</div>'
    + '<label>Response headers</label>'
    + '<pre>'+ Object.entries(j.headers||{}).map(([k,v])=>'<span class="hdr-line">'+k+':</span> '+v).join('\\n') +'</pre>'
    + (setC ? '<label>Set-Cookie</label><pre>'+ (Array.isArray(setC)?setC.join('\\n'):setC) +'</pre>' : '')
    + '<label>Body snippet (first 4000 chars)</label>'
    + '<pre>'+ (j.body||'').substring(0,4000).replace(/</g,'&lt;') +'</pre>';
}
document.querySelectorAll('[data-path]').forEach(b=>b.addEventListener('click',()=>fire(b.dataset.path)));
document.getElementById('btn-custom').addEventListener('click',()=>fire(document.getElementById('path').value.trim()||'/'));
</script>
</body></html>`;

// ---- Server ---------------------------------------------------------------
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function proxyFetch({ path, ua, cf, cfbm, extra }) {
  const targetPath = path && path.startsWith("/") ? path : "/" + (path || "");
  const target = "https://spankbang.com" + targetPath;

  const cookieParts = [];
  if (cf) cookieParts.push("cf_clearance=" + cf);
  if (cfbm) cookieParts.push("__cf_bm=" + cfbm);
  if (extra) cookieParts.push(extra);
  const cookieHeader = cookieParts.join("; ");

  const headers = {
    "User-Agent":
      ua ||
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "sec-ch-ua":
      '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    "sec-ch-ua-mobile": "?1",
    "sec-ch-ua-platform": '"Android"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "upgrade-insecure-requests": "1",
    Referer: "https://spankbang.com/",
  };
  if (cookieHeader) headers.Cookie = cookieHeader;

  const t0 = Date.now();
  const res = await fetch(target, { method: "GET", headers, redirect: "manual" });
  const bodyText = await res.text().catch(() => "");
  const ms = Date.now() - t0;

  const hobj = {};
  res.headers.forEach((v, k) => {
    // Node fetch already lowercases; keep as-is
    hobj[k] = hobj[k] ? hobj[k] + " || " + v : v;
  });

  return { status: res.status, headers: hobj, body: bodyText, ms };
}

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  try {
    if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(HTML);
      return;
    }
    if (req.method === "POST" && u.pathname === "/api/fetch") {
      const body = await readJson(req);
      const result = await proxyFetch(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e && e.message, stack: e && e.stack }));
  }
});

server.listen(PORT, () => {
  console.log("");
  console.log("SpankBang plugin dev harness ready:");
  console.log("  http://localhost:" + PORT);
  console.log("");
  console.log("Paste cf_clearance + User-Agent from a browser that solved Turnstile,");
  console.log("then click any endpoint button to verify the cookie-reuse pattern works.");
  console.log("");
});
