// Waypoint server: serves index.html and a small accounts + plans API. No dependencies.
// Run: node server.js   (PORT env var overrides 8000). Data lives in data/waypoint.json.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 8000;
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "waypoint.json");
const SESSION_DAYS = 30;
const MAX_BODY = 4 * 1024 * 1024; // plans with long itineraries stay well under this

/* ---------- storage: one JSON file, written atomically ---------- */
let db = { users: {}, sessions: {}, plans: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, "utf8")) }; } catch (e) { if (e.code !== "ENOENT") throw e; }
function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

/* ---------- passwords and sessions ---------- */
const hashPassword = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString("hex");
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
function checkPassword(user, pw) {
  const a = Buffer.from(hashPassword(pw, user.salt), "hex"), b = Buffer.from(user.hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// a fixed dummy record so unknown usernames cost the same time as wrong passwords
const DUMMY = { salt: "0".repeat(32), hash: hashPassword("dummy-password", "0".repeat(32)) };

function newSession(res, username) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.sessions[sha256(token)] = { user: username, exp: Date.now() + SESSION_DAYS * 864e5 };
  persist();
  res.setHeader("Set-Cookie", `wp_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
}
function sessionUser(req) {
  const m = /(?:^|;\s*)wp_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || "");
  if (!m) return null;
  const s = db.sessions[sha256(m[1])];
  if (!s) return null;
  if (s.exp < Date.now()) { delete db.sessions[sha256(m[1])]; persist(); return null; }
  return db.users[s.user] ? s.user : null;
}
function endSession(req, res) {
  const m = /(?:^|;\s*)wp_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || "");
  if (m && db.sessions[sha256(m[1])]) { delete db.sessions[sha256(m[1])]; persist(); }
  res.setHeader("Set-Cookie", "wp_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
}

// brute-force brake: 5 failed logins per username+IP, then a 15-minute lockout
const failures = new Map();
const failKey = (req, u) => `${req.socket.remoteAddress}|${u}`;
function lockedOut(req, u) { const f = failures.get(failKey(req, u)); return f && f.n >= 5 && Date.now() - f.at < 15 * 60e3; }
function noteFailure(req, u) { const k = failKey(req, u), f = failures.get(k); failures.set(k, { n: f && Date.now() - f.at < 15 * 60e3 ? f.n + 1 : 1, at: Date.now() }); }

/* ---------- http helpers ---------- */
function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject({ status: 413, error: "Plan is too large to save." }); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject({ status: 400, error: "Body is not valid JSON." }); } });
    req.on("error", reject);
  });
}
// CSRF guard for state-changing calls: JSON only, and from this same origin
function sameOrigin(req) {
  if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) return false;
  const o = req.headers.origin;
  return !o || o === `http://${req.headers.host}` || o === `https://${req.headers.host}`;
}

/* ---------- API ---------- */
const USER_RE = /^[a-z0-9_.-]{3,32}$/;
const PLAN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  if (req.method !== "GET" && !sameOrigin(req)) return send(res, 403, { error: "Cross-origin or non-JSON request refused." });

  if (route === "GET /api/me") {
    const u = sessionUser(req);
    return u ? send(res, 200, { user: u }) : send(res, 401, { error: "Not logged in." });
  }
  if (route === "POST /api/signup" || route === "POST /api/login") {
    const { username, password } = await readJson(req);
    const u = String(username || "").trim().toLowerCase(), pw = String(password || "");
    if (route === "POST /api/signup") {
      if (!USER_RE.test(u)) return send(res, 400, { error: "Username must be 3–32 characters: letters, numbers, dot, dash or underscore." });
      if (pw.length < 8) return send(res, 400, { error: "Password must be at least 8 characters." });
      if (db.users[u]) return send(res, 409, { error: "That username is taken." });
      const salt = crypto.randomBytes(16).toString("hex");
      db.users[u] = { salt, hash: hashPassword(pw, salt), created: Date.now() };
      db.plans[u] = {};
      newSession(res, u);
      return send(res, 201, { user: u });
    }
    if (lockedOut(req, u)) return send(res, 429, { error: "Too many failed attempts. Try again in 15 minutes." });
    if (!checkPassword(db.users[u] || DUMMY, pw) || !db.users[u]) { noteFailure(req, u); return send(res, 401, { error: "Wrong username or password." }); }
    failures.delete(failKey(req, u));
    newSession(res, u);
    return send(res, 200, { user: u });
  }
  if (route === "POST /api/logout") { endSession(req, res); return send(res, 200, { ok: true }); }

  // everything below needs a logged-in user
  const user = sessionUser(req);
  if (!user) return send(res, 401, { error: "Not logged in." });
  const mine = (db.plans[user] = db.plans[user] || {});

  if (route === "GET /api/plans") return send(res, 200, Object.values(mine).sort((a, b) => (b.updated || 0) - (a.updated || 0)));
  const m = /^\/api\/plans\/([^/]+)$/.exec(url.pathname);
  if (m && PLAN_ID_RE.test(m[1])) {
    const id = m[1];
    if (req.method === "PUT") {
      const plan = await readJson(req);
      if (!plan || typeof plan !== "object" || plan.id !== id || !Array.isArray(plan.trips)) return send(res, 400, { error: "Not a valid plan." });
      mine[id] = plan; persist();
      return send(res, 200, { ok: true });
    }
    if (req.method === "DELETE") { delete mine[id]; persist(); return send(res, 200, { ok: true }); }
  }
  return send(res, 404, { error: "No such API route." });
}

/* ---------- static: only the built page is public (never data/ or source files) ---------- */
const PAGE = path.join(__dirname, "index.html");
function page(res) {
  fs.readFile(PAGE, (err, buf) => {
    if (err) { res.writeHead(500, { "Content-Type": "text/plain" }); return res.end("index.html missing: run `node build.js` first."); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" });
    res.end(buf);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return page(res);
    res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found");
  } catch (e) {
    if (e?.status) return send(res, e.status, { error: e.error });
    console.error(e);
    send(res, 500, { error: "Server error." });
  }
}).listen(PORT, () => console.log(`Waypoint running at http://localhost:${PORT}`));
