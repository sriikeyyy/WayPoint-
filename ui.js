/* ================================================================
   RUNTIME: adapters (LLM, storage) + pipeline orchestration + views
   ================================================================ */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TODAY = D.today();
/* Home country from the device: time zone first (reliable even with en-US browsers in India), then the language region. */
const HOME = (() => {
  const byZone = { "Asia/Kolkata": "IN", "Asia/Calcutta": "IN", "Asia/Tokyo": "JP", "Asia/Singapore": "SG", "Asia/Dubai": "AE", "Asia/Colombo": "LK",
    "Asia/Kathmandu": "NP", "Asia/Thimphu": "BT", "Indian/Maldives": "MV", "Asia/Bangkok": "TH", "Asia/Kuala_Lumpur": "MY", "Asia/Jakarta": "ID",
    "Asia/Ho_Chi_Minh": "VN", "Asia/Seoul": "KR", "Asia/Shanghai": "CN", "Europe/London": "GB", "Europe/Paris": "FR", "Europe/Berlin": "DE",
    "Europe/Rome": "IT", "Europe/Madrid": "ES", "Europe/Amsterdam": "NL", "Europe/Zurich": "CH", "Europe/Istanbul": "TR" };
  const names = { IN: "india", JP: "japan", SG: "singapore", AE: "united arab emirates", LK: "sri lanka", NP: "nepal", BT: "bhutan", MV: "maldives",
    TH: "thailand", MY: "malaysia", ID: "indonesia", VN: "vietnam", KR: "south korea", CN: "china", GB: "united kingdom", FR: "france", DE: "germany",
    IT: "italy", ES: "spain", NL: "netherlands", CH: "switzerland", TR: "turkey", US: "united states", CA: "canada", AU: "australia" };
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    let rc = byZone[tz] || (tz.startsWith("Australia/") ? "AU" : null);
    if (!rc) rc = (navigator.languages || [navigator.language]).map((l) => /-([A-Z]{2})\b/i.exec(l || "")?.[1]?.toUpperCase()).find(Boolean);
    if (!rc) return null;
    return names[rc] || new Intl.DisplayNames(["en"], { type: "region" }).of(rc)?.toLowerCase() || null;
  } catch { return null; }
})();
const uid = () =>"p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------- LLM adapter: Claude (artifact runtime) → OpenAI-compatible → offline rules ---------- */
const LLM = {
  kind: "none", sample: null, cfg: null,
  async init() {
    try {
      if (window.claude?.use) {
        const s = await window.claude.use("sample");
        if (s) { this.sample = s; this.kind = "claude"; return; }
      }
    } catch {}
    try { this.cfg = JSON.parse(localStorage.getItem("wp.llm") || "null"); } catch { this.cfg = null; }
    // key is optional: local servers like Ollama don't use one
    this.kind = this.cfg?.endpoint ? "openai" : "none";
  },
  label() { return { claude: "Claude, on your account", openai: `${isLocal(this.cfg?.endpoint) ? "Local model" : "Your endpoint"} · ${this.cfg?.model || "model"}`, none: "Offline rule parser" }[this.kind]; },
  async json(prompt, signal) {
    if (this.kind === "claude") return this.sample.json(prompt, { signal, modelTier: "default", cache: false });
    if (this.kind === "openai") return openaiJson(this.cfg, prompt, signal);
    throw { code: "no_llm" };
  },
};
const isLocal = (ep) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(ep || "");
/* OpenAI-compatible chat call with real diagnostics (status, provider message, network/CORS). */
async function openaiJson(cfg, prompt, signal, useFormat = true) {
  const url = cfg.endpoint.replace(/\/+$/, "").replace(/\/chat\/completions$/, "") + "/chat/completions";
  const body = { model: cfg.model || "gpt-4o-mini", temperature: 0.2, messages: [{ role: "user", content: prompt }] };
  if (useFormat) body.response_format = { type: "json_object" };
  const headers = { "Content-Type": "application/json" };
  if (cfg.key) headers.Authorization = `Bearer ${cfg.key}`;
  let r;
  try {
    r = await fetch(url, { method: "POST", signal, headers, body: JSON.stringify(body) });
  } catch (e) {
    if (signal?.aborted) throw { code: "cancelled" };
    throw { code: "network", detail: location.protocol === "file:"
      ? "Request blocked. Serve the folder with “python -m http.server 8000” and open http://localhost:8000 instead of double-clicking the file."
      : isLocal(url) ? `Could not reach ${url}. Is the local server running? For Ollama, start the Ollama app (or run “ollama serve”) and check the port.`
      : `Could not reach ${url}. Check the endpoint URL; if it is correct, this provider blocks browser requests (CORS).` };
  }
  let data = null, raw = "";
  try { raw = await r.text(); data = JSON.parse(raw); } catch {}
  if (!r.ok) {
    const pm = data?.error?.message || data?.message || (Array.isArray(data) && data[0]?.error?.message) || raw.slice(0, 200);
    // some providers reject response_format; retry once without it
    if (useFormat && r.status === 400 && /response_format|json_object|not supported/i.test(pm)) return openaiJson(cfg, prompt, signal, false);
    const hint = r.status === 401 ? " The API key is wrong or revoked."
      : r.status === 403 ? (isLocal(url) ? " The local server rejected this page's origin; set OLLAMA_ORIGINS to allow it." : " This key isn't allowed to use that model.")
      : r.status === 404 ? (isLocal(url) ? ` Model not installed? Run “ollama pull ${cfg.model}” (check the name with “ollama list”).` : " Wrong endpoint URL or model name.")
      : r.status === 429 ? (/quota|billing|credit/i.test(pm) ? " The account has no credit left; add billing or use a free provider." : " Rate limited; wait a minute.")
      : "";
    throw { code: "http", detail: `HTTP ${r.status}: ${pm}${hint}` };
  }
  const txt = data?.choices?.[0]?.message?.content;
  if (!txt) throw { code: "invalid_json", detail: "The endpoint answered but returned no message content." };
  return tolerantJson(txt);
}
function tolerantJson(t) {
  try { return JSON.parse(t); } catch {}
  const f = /```(?:json)?\s*([\s\S]*?)```/.exec(t); if (f) try { return JSON.parse(f[1]); } catch {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}"); if (a >= 0 && b > a) try { return JSON.parse(t.slice(a, b + 1)); } catch {}
  throw { code: "invalid_json", message: "Model reply was not JSON" };
}
const ERR = {
  not_granted: "Claude access was declined for this page, so the offline parser was used.",
  rate_limited: "Too many requests right now. Wait a minute and run it again.",
  session_expired: "Your session expired. Sign in again, then rerun.",
  sampling_disabled: "Claude isn't available on this account; used the offline parser.",
  invalid_json: "The model's reply wasn't valid JSON. Run it again.",
  refused: "The model declined this request. Rephrase it and try again.",
  upstream_error: "The model service failed mid-request. Run it again.",
};

/* ---------- Storage adapter: artifact db (per-user, private) → Waypoint server (login) → localStorage ---------- */
const Store = {
  mode: "local", db: null, uid: null, user: null,
  async init() {
    try {
      if (window.claude?.use) {
        const [db, user] = await Promise.all([window.claude.use("db"), window.claude.use("user")]);
        const id = user ? await user.id() : null;
        if (db && id) { this.db = db; this.uid = id; this.mode = "cloud"; return; }
      }
    } catch {}
    // served by server.js? /api/me answers 200 (logged in) or 401 (needs login); anything else means no server
    try {
      const r = await fetch("api/me", { credentials: "same-origin" });
      if (r.status === 200 || r.status === 401) { this.mode = "server"; this.user = r.status === 200 ? (await r.json()).user : null; }
    } catch {}
  },
  async api(method, url, body) {
    // every non-GET goes out as JSON: the server refuses other writes (CSRF guard)
    const write = method !== "GET";
    const r = await fetch(url, { method, credentials: "same-origin", headers: write ? { "Content-Type": "application/json" } : {}, body: write ? JSON.stringify(body ?? {}) : undefined });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && !url.includes("/login")) { this.user = null; showAuth(); }
    if (!r.ok) throw new Error(data.error || `Server error (HTTP ${r.status}).`);
    return data;
  },
  async login(username, password, signup) { this.user = (await this.api("POST", signup ? "api/signup" : "api/login", { username, password })).user; },
  async logout() { try { await this.api("POST", "api/logout", {}); } catch {} this.user = null; },
  col() { return this.db.collection("data/users/" + this.uid); },
  localAll() { try { return JSON.parse(localStorage.getItem("wp.plans") || "{}"); } catch { return {}; } },
  localPut(all) { try { localStorage.setItem("wp.plans", JSON.stringify(all)); return true; } catch { return false; } },
  async list() {
    if (this.mode === "cloud") {
      const snap = await this.col().get();
      return snap.docs.map((d) => d.data()).filter((p) => p && p.id).sort((a, b) => (b.updated || 0) - (a.updated || 0));
    }
    if (this.mode === "server") return this.user ? this.api("GET", "api/plans") : [];
    return Object.values(this.localAll()).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  },
  _q: Promise.resolve(),
  save(plan) {
    const body = JSON.parse(JSON.stringify(plan));
    this._q = this._q.catch(() => {}).then(async () => {
      if (this.mode === "cloud") await this.col().doc(plan.id).set(body);
      else if (this.mode === "server") await this.api("PUT", "api/plans/" + encodeURIComponent(plan.id), body);
      else { const all = this.localAll(); all[plan.id] = body; if (!this.localPut(all)) throw new Error("Browser storage is full or blocked."); }
    });
    return this._q;
  },
  async remove(id) {
    if (this.mode === "cloud") await this.col().doc(id).delete();
    else if (this.mode === "server") await this.api("DELETE", "api/plans/" + encodeURIComponent(id));
    else { const all = this.localAll(); delete all[id]; this.localPut(all); }
  },
  where() { return { cloud: "Saved privately to your account.", server: `Saved to ${this.user}'s account.`, local: "Saved in this browser." }[this.mode]; },
};

/* ---------- Pipeline trace ---------- */
const STEPS = [
  ["interpret", "Interpret request", "neural"],
  ["validate", "Validate & normalize", "symbolic"],
  ["ground", "Apply knowledge rules", "symbolic"],
  ["graph", "Build & schedule task graph", "symbolic"],
  ["itin", "Draft day-by-day plan", "neural"],
  ["verify", "Verify & repair", "loop"],
  ["save", "Save plan", "storage"],
];
const trace = {};
function resetTrace() { STEPS.forEach(([id]) => (trace[id] = { st: "idle", note: "" })); renderTrace(); }
function step(id, st, note = "") { trace[id] = { st, note }; renderTrace(); }
function renderTrace() {
  $("#trace").innerHTML = STEPS.map(([id, label, layer], i) => {
    const t = trace[id] || { st: "idle" };
    return `<li class="st-${t.st}"><span class="dot" aria-hidden="true">${t.st === "run" ? "" : t.st === "ok" ? "✓" : t.st === "warn" ? "!" : t.st === "fail" ? "×" : i + 1}</span>
      <div><div class="tl">${label} <span class="layer l-${layer}">${layer}</span></div>${t.note ? `<div class="tn">${esc(t.note)}</div>` : ""}</div></li>`;
  }).join("");
}

/* ---------- Orchestration ---------- */
let ctl = null, current = null, plans = [], tab = "itin", tripIdx = 0;

async function run(text, refine) {
  ctl?.abort(); ctl = new AbortController(); const signal = ctl.signal;
  setBusy(true); resetTrace(); setNote("");
  const engine = LLM.kind;
  try {
    // 1. INTERPRET (neural, or rule fallback)
    step("interpret", "run", engine === "none" ? "Offline rule parser" : "Asking " + LLM.label());
    let raw, usedLLM = engine !== "none";
    const base = refine && current ? current.raw : null;
    if (usedLLM) {
      try { raw = await LLM.json(interpretPrompt(text, TODAY, base), signal); }
      catch (e) {
        if (e?.code === "cancelled" || signal.aborted) throw e;
        if (["not_granted", "sampling_disabled"].includes(e?.code)) LLM.kind = "none";
        LLM.lastError = e?.detail || ERR[e?.code] || "The model could not be reached.";
        setNote("Language model failed: " + LLM.lastError + " Used the offline parser for this run.");
        usedLLM = false; raw = ruleParse(text, TODAY);
      }
    } else raw = ruleParse(text, TODAY);
    if (!usedLLM && base) setNote("Refining needs a working language model, so your text was planned as a new trip.", true);
    LLM.lastError = usedLLM ? null : LLM.lastError; renderEngine();
    step("interpret", "ok", `${arr(raw?.trips).length} trip(s) identified`);

    // 2. VALIDATE
    step("validate", "run");
    const spec = normalizeSpec(raw, TODAY, { home: HOME });
    if (!spec.trips.length) { step("validate", "fail", spec.issues.map((i) => i.msg).join(" ")); throw { code: "spec", message: spec.issues.map((i) => i.msg).join(" ") || "Nothing to plan." }; }
    const nFix = spec.trips.reduce((a, t) => a + t.fixes.length + t.assumed.length, 0);
    step("validate", spec.issues.some((i) => i.sev === "fail") ? "warn" : "ok", `${spec.trips.length} trip(s) valid · ${nFix} assumption(s)/correction(s)`);

    // 3. GROUND
    step("ground", "run");
    const outTrips = [];
    for (const t of spec.trips) outTrips.push({ ...t, skeleton: daySkeleton(t) });
    // places shortlist: knowledge base first; the model only fills stop × interest pairs the KB doesn't cover
    let fromModel = 0;
    for (const t of outTrips) {
      const gaps = placeGaps(t);
      let suggested = [];
      if (usedLLM && gaps.length) {
        step("ground", "run", `asking the model for places: ${gaps.map((g) => `${g.city} ${g.category}`).join(", ")}`);
        try { suggested = normalizeModelPlaces(await LLM.json(placesPrompt(t, gaps), signal), gaps); fromModel += suggested.length; }
        catch (e) { if (e?.code === "cancelled" || signal.aborted) throw e; }
      }
      t.highlights = placeHighlights(t, suggested);
    }
    const nPlaces = outTrips.reduce((a, t) => a + t.highlights.reduce((b, h) => b + h.places.length, 0), 0);
    step("ground", "ok", `${outTrips.reduce((a, t) => a + t.skeleton.length, 0)} days framed · border: ${outTrips.map((t) => (t.international === null ? "unknown" : t.international ? "international" : "domestic")).join(", ")} · ${nPlaces} places shortlisted${fromModel ? ` (${fromModel} from the model)` : ""}`);

    // 4. GRAPH
    step("graph", "run");
    for (const t of outTrips) t.sched = schedule(buildTasks(t), t.startDate, TODAY);
    const late = outTrips.reduce((a, t) => a + (t.sched.ok ? t.sched.tasks.filter((x) => x.status === "late" || x.status === "infeasible").length : 0), 0);
    step("graph", outTrips.every((t) => t.sched.ok) ? (late ? "warn" : "ok") : "fail", `${outTrips.reduce((a, t) => a + t.sched.tasks.length, 0)} tasks · ${late} behind schedule`);

    // 5 + 6. ITINERARY with verify → repair loop (max 2 LLM repairs, then deterministic fix)
    let anyWarn = false;
    for (let i = 0; i < outTrips.length; i++) {
      const t = outTrips[i];
      const tag = outTrips.length > 1 ? `Trip ${i + 1}/${outTrips.length}: ` : "";
      step("itin", "run", tag + (usedLLM ? "drafting with the model" : "offline template"));
      let itin, log = [];
      if (usedLLM) {
        try { itin = await LLM.json(itineraryPrompt(t, t.skeleton, t.highlights), signal); }
        catch (e) { if (e?.code === "cancelled" || signal.aborted) throw e; log.push(`Draft failed: ${e?.detail || e?.code || "error"}. Used template.`); setNote((e?.detail || ERR[e?.code] || "Itinerary call failed.") + " The day plan is a template."); itin = templateItinerary(t, t.skeleton, t.highlights); }
      } else itin = templateItinerary(t, t.skeleton, t.highlights);
      step("itin", "ok", tag + `${arr(itin?.days).length} day(s) drafted`);

      step("verify", "run", tag + "checking constraints");
      let viol = verifyItinerary(t, itin, t.skeleton);
      log.push(`Attempt 1: ${viol.filter((x) => x.sev === "fail").length} hard violation(s).`);
      for (let k = 0; usedLLM && k < 2 && viol.some((x) => x.sev === "fail"); k++) {
        step("verify", "run", tag + `repair round ${k + 1}: ${viol.filter((x) => x.sev === "fail").length} violation(s)`);
        try { itin = await LLM.json(repairPrompt(itin, viol.filter((x) => x.sev === "fail")), signal); }
        catch (e) { if (e?.code === "cancelled" || signal.aborted) throw e; log.push(`Repair ${k + 1} failed: ${e?.detail || e?.code || "error"}.`); break; }
        viol = verifyItinerary(t, itin, t.skeleton);
        log.push(`Attempt ${k + 2}: ${viol.filter((x) => x.sev === "fail").length} hard violation(s).`);
      }
      const fixed = autoFixItinerary(t, itin, t.skeleton);
      t.itin = fixed.itin; t.itinFixes = fixed.fixes;
      if (fixed.fixes.length) log.push(`Deterministic repair applied ${fixed.fixes.length} change(s).`);
      const finalViol = verifyItinerary(t, t.itin, t.skeleton);
      t.repairLog = log;
      t.budget2 = budgetCheck(t, t.itin);
      t.checks = tripChecks(t, t.sched, [...finalViol, ...fixed.fixes.map((m) => ({ code: "coverage", sev: "warn", msg: `Auto-repaired: ${m}` }))], t.budget2, TODAY);
      t.verdict = worst(t.checks.map((c) => c.sev));
      if (t.verdict !== "pass") anyWarn = true;
    }
    step("itin", "ok", `${outTrips.length} itinerary(ies) drafted`);
    step("verify", outTrips.some((t) => t.verdict === "fail") ? "fail" : anyWarn ? "warn" : "ok", outTrips.map((t) => `${t.checks.filter((c) => c.sev === "pass").length}/${t.checks.length} checks pass`).join(" · "));

    // 7. SAVE
    step("save", "run");
    const now = Date.now();
    const plan = {
      id: refine && current ? current.id : uid(),
      created: refine && current ? current.created : now, updated: now,
      title: outTrips.map((t) => t.title).join(" + ").slice(0, 120),
      inputs: [...(refine && current ? current.inputs : []), { text, at: now, engine: usedLLM ? LLM.kind : "rules" }].slice(-10),
      raw, spec: { assumptions: spec.assumptions, questions: spec.questions, issues: spec.issues },
      trips: outTrips.map(slimTrip), done: refine && current ? current.done || {} : {},
    };
    current = plan; tripIdx = 0;
    renderPlan();
    try { await Store.save(plan); step("save", "ok", Store.mode === "local" ? "Saved in this browser" : "Saved to your account"); await refreshList(); }
    catch (e) { step("save", "fail", e?.code === "quota_exceeded" ? "Storage is full; delete old plans." : "Could not save; the plan is still shown."); }
  } catch (e) {
    if (e?.code === "cancelled" || signal.aborted) { setNote("Stopped."); STEPS.forEach(([id]) => trace[id].st === "run" && step(id, "idle", "stopped")); }
    else if (e?.code === "spec") setNote(e.message);
    else { setNote(e?.detail || ERR[e?.code] || "Something went wrong: " + (e?.message || e?.code || e)); console.error(e); }
  } finally { setBusy(false); }
}
function slimTrip(t) {
  return { title: t.title, origin: t.origin, stops: t.stops, startDate: t.startDate, endDate: t.endDate, nights: t.nights,
    travelers: t.travelers, budget: t.budget, currency: t.currency, pace: t.pace, interests: t.interests, constraints: t.constraints,
    accommodation: t.accommodation, returnBy: t.returnBy, international: t.international, issues: t.issues, fixes: t.fixes, assumed: t.assumed,
    skeleton: t.skeleton, tasks: t.sched.tasks, schedOk: t.sched.ok, itin: t.itin, itinFixes: t.itinFixes, repairLog: t.repairLog,
    budget2: t.budget2, checks: t.checks, verdict: t.verdict, highlights: t.highlights || [] };
}

/* ---------- Views ---------- */
function setBusy(b) { $("#go").disabled = b; $("#stop").hidden = !b; $("#q").readOnly = b; document.body.classList.toggle("busy", b); }
function setNote(m, append) { const n = $("#note"); const t = append && n.textContent && !n.hidden ? n.textContent + " " + m : m; n.textContent = t; n.hidden = !t; }
const VERD = { pass: "Verified", warn: "Verified with warnings", fail: "Needs attention" };

function renderPlan() {
  const el = $("#plan");
  if (!current) { el.innerHTML = `<div class="empty"><h2>No plan open</h2><p>Describe a trip on the left, or open a saved plan.</p></div>`; syncRefine(); return; }
  const t = current.trips[tripIdx] || current.trips[0];
  const route = [t.origin.city || "Home", ...t.stops.map((s) => s.city), t.origin.city || "Home"];
  el.innerHTML = `
    <header class="ph">
      <div class="ph-top">
        <div class="eyebrow">${current.example ? '<span class="tag-ex">Example</span> ' : ""}${current.trips.length > 1 ? `${current.trips.length} trips in this plan` : "Plan"} · updated ${new Date(current.updated).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</div>
        <span class="verdict v-${t.verdict}">${VERD[t.verdict]}</span>
      </div>
      ${current.trips.length > 1 ? `<div class="trips" role="tablist">${current.trips.map((x, i) => `<button role="tab" aria-selected="${i === tripIdx}" data-trip="${i}"><span class="vd v-${x.verdict}"></span>${esc(x.title)}</button>`).join("")}</div>` : ""}
      <h2 class="pt">${esc(t.title)}</h2>
      <div class="board" aria-label="Route">${route.map((c, i) => `<div class="stn"><span class="code">${esc(code(c))}</span><span class="cn">${esc(c)}</span>${i > 0 && i < route.length - 1 ? `<span class="nt">${t.stops[i - 1].nights}N · ${D.fmt(t.stops[i - 1].startDate)}</span>` : `<span class="nt">${D.fmt(i ? t.endDate : t.startDate)}</span>`}</div>${i < route.length - 1 ? `<span class="arr">${esc(modeOf(t, i))}</span>` : ""}`).join("")}</div>
      <dl class="facts">
        <div><dt>Dates</dt><dd>${D.fmtY(t.startDate)} – ${D.fmtY(t.endDate)}</dd></div>
        <div><dt>Nights</dt><dd>${t.nights}</dd></div>
        <div><dt>Travellers</dt><dd>${t.travelers.adults} adult${t.travelers.adults > 1 ? "s" : ""}${t.travelers.children ? `, ${t.travelers.children} child${t.travelers.children > 1 ? "ren" : ""}` : ""}</dd></div>
        <div><dt>Budget</dt><dd>${t.budget ? money(t.budget.amount, t.budget.currency) + (t.budget.scope === "per_person" ? " pp" : "") : "Not set"}</dd></div>
        <div><dt>Pace</dt><dd>${t.pace}</dd></div>
        <div><dt>Border</dt><dd>${t.international === null ? "Unknown" : t.international ? "International" : "Domestic"}</dd></div>
      </dl>
    </header>
    <nav class="tabs" role="tablist">${[["itin", "Itinerary"], ["places", "Places"], ["tasks", "Tasks & graph"], ["verify", "Verification"], ["budget", "Budget"], ["spec", "Spec"]].map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${tab === k}">${l}${k === "verify" ? ` <span class="cnt">${t.checks.filter((c) => c.sev === "pass").length}/${t.checks.length}</span>` : ""}${k === "tasks" ? ` <span class="cnt">${doneCount(t)}/${t.tasks.length}</span>` : ""}</button>`).join("")}</nav>
    <section class="tabpane">${({ itin: viewItin, places: viewPlaces, tasks: viewTasks, verify: viewVerify, budget: viewBudget, spec: viewSpec })[tab](t)}</section>
    <footer class="pf">
      <div class="row"><button class="ghost" id="del">Delete plan</button><button class="ghost" id="dlPdf">Download PDF</button><button class="ghost" id="dlJson">Download JSON</button></div>
      <span class="muted">${current.example ? "Example data, not saved." : Store.where()}</span>
    </footer>`;
  syncRefine();
}
function code(c) { const w = String(c).replace(/[^A-Za-z ]/g, "").trim().split(/\s+/); return (w.length > 1 ? w.map((x) => x[0]).join("") : w[0]).slice(0, 3).toUpperCase() || "—"; }
function modeOf(t, i) { const m = i === t.stops.length ? t.returnBy : t.stops[i].arriveBy; return m || "→"; }
function doneCount(t) { const d = current.done || {}; return t.tasks.filter((x) => d[`${tripIdx}:${x.id}`]).length; }

function viewItin(t) {
  const sk = Object.fromEntries(t.skeleton.map((s) => [s.date, s]));
  return `<div class="days">${t.itin.days.map((d, i) => {
    const s = sk[d.date] || {};
    const cost = d.items.reduce((a, it) => a + (Number(it.cost) || 0), 0);
    return `<article class="day">
      <div class="dh"><div class="dd"><span class="dn">Day ${i + 1}</span><span class="dt">${D.dow(d.date)} ${D.fmt(d.date)}</span></div>
      <div class="dc">${s.travel ? `<span class="trv">${esc(s.travel.from)} → ${esc(s.travel.to)}${s.travel.mode ? ` · ${esc(s.travel.mode)}` : ""}</span>` : `<span>${esc(s.city || "")}</span>`}</div>
      ${cost ? `<div class="dcost">${money(cost, t.currency)}</div>` : ""}</div>
      <ol class="items">${d.items.map((it) => `<li class="ty-${esc(it.type)}"><span class="tm">${esc(it.start)}<i>${esc(it.end)}</i></span><div class="ib"><div class="it">${esc(it.title)}${it.auto ? ' <span class="auto">auto-added</span>' : ""}</div>${it.place ? `<div class="ip">${esc(it.place)}</div>` : ""}</div><span class="chip">${esc(it.type)}</span>${Number(it.cost) > 0 ? `<span class="ic">${money(it.cost, t.currency)}</span>` : '<span class="ic"></span>'}</li>`).join("") || '<li class="none">Open day</li>'}</ol>
    </article>`;
  }).join("")}</div>
  ${t.itin.tips?.length ? `<div class="tips"><h3>Notes from the planner</h3><ul>${t.itin.tips.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}`;
}

const CAT = { nightlife: "Nightlife", beaches: "Beaches", food: "Food", adventure: "Adventure", nature: "Nature", sights: "Sights" };
const SRC = { kb: "Knowledge base", model: "Model suggestion · verify", none: "No data yet" };
const priceRange = (min, max, cur) => (max === 0 ? "Free" : min === max ? money(min, cur) : `${money(min, cur)}–${money(max, cur)}`);
// "visit everything" range for the group, one line per currency
function placesTotal(t) {
  const people = t.travelers.adults + t.travelers.children;
  const tot = Object.entries(highlightsBudget(t, t.highlights));
  if (!tot.length) return "";
  const cap = t.budget ? (t.budget.scope === "per_person" ? t.budget.amount * people : t.budget.amount) : null;
  const same = cap && tot.length === 1 && tot[0][0] === t.budget.currency ? tot[0][1] : null;
  const share = same ? ` That's ${Math.round((same.min / cap) * 100)}–${Math.round((same.max / cap) * 100)}% of your ${money(cap, t.budget.currency)} budget, before travel and stays.` : "";
  return `<p class="pl-total">If you visit all ${tot.reduce((a, [, v]) => a + v.count, 0)} shortlisted places: <b>${tot.map(([cur, v]) => priceRange(v.min, v.max, cur)).join(" + ")}</b> for ${people} ${people > 1 ? "people" : "person"}.${share}</p>`;
}
function viewPlaces(t) {
  const hs = t.highlights || [];
  if (!hs.length) return `<div class="empty sm"><p>No places shortlist for this plan. Plan it again to get one.</p></div>`;
  const people = t.travelers.adults + t.travelers.children;
  return `<p class="cap">The 3 most popular places for each of your interests, with approximate prices per person. Use them to judge the budget before you book. Prices are rough guides, not quotes.</p>
  <div class="pl">${hs.map((h) => `<section class="pl-card">
    <div class="pl-h"><h4>${esc(h.city)} · ${CAT[h.category] || esc(h.category)}</h4><span class="pl-src s-${h.source}">${SRC[h.source]}</span></div>
    ${h.places.length ? `<ol>${h.places.map((p) => `<li><div class="pl-n">${esc(p.name)}${p.area ? ` <span class="muted">· ${esc(p.area)}</span>` : ""}</div>
      <div class="pl-p"><span>${priceRange(p.min, p.max, h.currency)}${p.max ? " pp" : ""}</span>${p.max && people > 1 ? `<span class="muted">${priceRange(p.min * people, p.max * people, h.currency)} for ${people}</span>` : ""}</div>
      ${p.note ? `<div class="pl-note muted">${esc(p.note)}</div>` : ""}</li>`).join("")}</ol>`
      : `<p class="muted sm">Not in the knowledge base yet. Connect a language model and plan again for suggestions.</p>`}
  </section>`).join("")}</div>
  ${placesTotal(t)}`;
}

function viewTasks(t) {
  const d = current.done || {};
  return `${dagSvg(t)}
  <p class="cap">Arrows point from a prerequisite to the task that needs it. Deadlines are computed backwards from departure: each task's own lead time, pulled earlier when a dependent task needs it sooner.</p>
  <table class="tt"><thead><tr><th></th><th>Task</th><th>Start by</th><th>Due</th><th>After</th><th>Rule</th></tr></thead><tbody>
  ${t.tasks.map((x) => `<tr class="s-${x.status}${d[`${tripIdx}:${x.id}`] ? " done" : ""}">
    <td><input type="checkbox" id="tk-${tripIdx}-${x.id}" data-task="${x.id}" ${d[`${tripIdx}:${x.id}`] ? "checked" : ""} aria-label="Mark done"></td>
    <td><label for="tk-${tripIdx}-${x.id}">${esc(x.title)}</label><span class="st">${x.status === "infeasible" ? "cannot finish before departure" : x.status === "late" ? `behind schedule (ideally by ${D.fmt(x.due)}), do now` : x.status === "urgent" ? "start now" : `${x.slack} days slack`}</span></td>
    <td class="num">${actDate(x.startBy)}</td><td class="num">${actDate(x.due)}</td>
    <td class="deps">${x.deps.map((y) => `<code>${y}</code>`).join(" ") || "—"}</td>
    <td><abbr title="${esc(KB.rules[x.rule])}">${x.rule}</abbr></td></tr>`).join("")}
  </tbody></table>`;
}
// a date that has already passed can't be acted on: show "Today" instead
const actDate = (iso) => (iso < TODAY ? "Today" : D.fmt(iso));
function dagSvg(t) {
  const W = 172, H = 46, GX = 44, GY = 14;
  const cols = {};
  t.tasks.forEach((x) => (cols[x.depth] = cols[x.depth] || []).push(x));
  const pos = {};
  const maxRows = Math.max(...Object.values(cols).map((c) => c.length));
  Object.entries(cols).forEach(([dep, list]) => list.forEach((x, r) => (pos[x.id] = { x: 10 + dep * (W + GX), y: 10 + r * (H + GY) + ((maxRows - list.length) * (H + GY)) / 2 })));
  const width = 20 + (Object.keys(cols).length) * (W + GX) - GX, height = 20 + maxRows * (H + GY) - GY;
  const d = current.done || {};
  const edges = t.tasks.flatMap((x) => x.deps.filter((y) => pos[y]).map((y) => {
    const a = pos[y], b = pos[x.id], x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, mx = (x1 + x2) / 2;
    return `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 6},${y2}" class="edge" marker-end="url(#ah)"/>`;
  })).join("");
  const nodes = t.tasks.map((x) => { const p = pos[x.id]; const lbl = x.title.length > 26 ? x.title.slice(0, 25) + "…" : x.title; return `<g class="node n-${x.status}${d[`${tripIdx}:${x.id}`] ? " n-done" : ""}" transform="translate(${p.x},${p.y})"><title>${esc(x.title)}</title><rect width="${W}" height="${H}" rx="6"/><text x="10" y="18" class="nid">${esc(x.id)} · due ${actDate(x.due)}</text><text x="10" y="35" class="nt2">${esc(lbl)}</text></g>`; }).join("");
  return `<div class="dagwrap"><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Task dependency graph"><defs><marker id="ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" class="ahd"/></marker></defs>${edges}${nodes}</svg></div>`;
}

function viewVerify(t) {
  const groups = [["neural", "Neural layer"], ["symbolic", "Symbolic checks"]];
  return `<div class="checks">${groups.map(([g, gl]) => `<h3>${gl}</h3><ul>${t.checks.filter((c) => c.layer === g).map((c) => `<li class="ck c-${c.sev}"><span class="cki" aria-label="${c.sev}">${c.sev === "pass" ? "✓" : c.sev === "warn" ? "!" : "×"}</span><div><div class="ckl">${esc(c.label)}</div><ul class="ckd">${c.detail.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div></li>`).join("")}</ul>`).join("")}</div>
  <div class="cols2">
    <div><h3>Repair log</h3><ol class="log">${(t.repairLog || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ol></div>
    <div><h3>Knowledge rules fired</h3><ul class="rules">${[...new Set(t.tasks.map((x) => x.rule))].map((r) => `<li><code>${r}</code> ${esc(KB.rules[r])}</li>`).join("")}</ul></div>
  </div>
  ${current.spec.questions?.length ? `<div class="qs"><h3>Open questions</h3><ul>${current.spec.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul><p class="muted">Answer them with “Refine this plan” on the left.</p></div>` : ""}
  ${current.spec.issues?.length ? `<div class="qs"><h3>Plan-level issues</h3><ul>${current.spec.issues.map((q) => `<li>${esc(q.msg)}</li>`).join("")}</ul></div>` : ""}`;
}

function viewBudget(t) {
  const c = t.itin.costs, b = t.budget2;
  if (!c) return `<div class="empty sm"><p>${esc(b.msg)}</p>
    ${t.budget ? `<p>Your budget: <b>${money(t.budget.amount, t.budget.currency)}${t.budget.scope === "per_person" ? " per person" : " total"}</b></p>` : ""}
    <p class="muted">Cost estimates come from the language model. This plan was made without one (offline parser, or the model call failed), so there are no figures to compare. Connect a model and plan again.</p>
    ${placesTotal(t)}</div>`;
  const ents = Object.entries(c).filter(([, v]) => v > 0).sort((a, b2) => b2[1] - a[1]);
  const total = ents.reduce((a, [, v]) => a + v, 0);
  const scale = Math.max(total, b.cap || 0);
  const people = t.travelers.adults + t.travelers.children;
  return `<div class="bud">
    <div class="bnum"><div><span class="lbl">Estimated total</span><span class="big">${money(total, t.currency)}</span></div>
      <div><span class="lbl">Budget</span><span class="big">${b.cap ? money(b.cap, t.currency) : "—"}</span></div>
      <div><span class="lbl">Per person</span><span class="big">${money(total / people, t.currency)}</span></div></div>
    <div class="bar" role="img" aria-label="Cost breakdown">${ents.map(([k, v], i) => `<span class="seg s${i % 6}" style="width:${(v / scale) * 100}%" title="${esc(k)}: ${money(v, t.currency)}"></span>`).join("")}${b.cap ? `<span class="capline" style="left:${(b.cap / scale) * 100}%"><i>budget</i></span>` : ""}</div>
    <ul class="legend">${ents.map(([k, v], i) => `<li><span class="sw s${i % 6}"></span><span class="lk">${esc(k)}</span><span class="num">${money(v, t.currency)}</span><span class="num muted">${Math.round((v / total) * 100)}%</span></li>`).join("")}</ul>
    <p class="verdict-line c-${b.sev}">${esc(b.msg)}</p>
    ${placesTotal(t)}
    <p class="muted">Figures are model estimates of typical prices, not quotes. Check live fares before booking.</p></div>`;
}
function viewSpec(t) {
  const { skeleton, tasks, itin, checks, ...rest } = t;
  return `<p class="cap">The normalized trip after validation. This is what the symbolic engine plans from.</p>
  <div class="inputs"><h3>Your inputs</h3><ol>${current.inputs.map((x) => `<li><span class="muted">${new Date(x.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })} · ${esc(x.engine)}</span><br>${esc(x.text)}</li>`).join("")}</ol></div>
  <pre class="json">${esc(JSON.stringify(rest, null, 2))}</pre>`;
}

function renderList() {
  const el = $("#saved");
  if (!plans.length) { el.innerHTML = `<li class="muted sm">No saved plans yet. Plans appear here after you run one.</li>`; return; }
  el.innerHTML = plans.map((p) => `<li><button data-open="${p.id}" class="${current?.id === p.id ? "on" : ""}"><span class="vd v-${worst(p.trips.map((t) => t.verdict))}"></span><span class="sn">${esc(p.title)}</span><span class="sd">${D.fmt(p.trips[0]?.startDate)}${p.trips.length > 1 ? ` · ${p.trips.length} trips` : ""}</span></button></li>`).join("");
}
async function refreshList() { try { plans = await Store.list(); } catch { plans = []; } renderList(); }
function syncRefine() { const r = $("#refineRow"); r.hidden = !current || current.example; if (r.hidden) $("#refine").checked = false; }

/* ---------- Events ---------- */
let saveT = null;
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.tab) { tab = b.dataset.tab; renderPlan(); }
  else if (b.dataset.trip) { tripIdx = +b.dataset.trip; renderPlan(); }
  else if (b.dataset.open) { const p = plans.find((x) => x.id === b.dataset.open); if (p) { current = p; tripIdx = 0; renderPlan(); renderList(); } }
  else if (b.dataset.ex) { $("#q").value = b.dataset.ex; $("#q").focus(); }
  else if (b.id === "del") {
    if (current?.example) { current = null; renderPlan(); return; }
    if (b.dataset.armed) { const id = current.id; current = null; renderPlan(); try { await Store.remove(id); } catch {} await refreshList(); }
    else { b.dataset.armed = "1"; b.textContent = "Click again to delete"; b.classList.add("danger"); setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = "Delete plan"; b.classList.remove("danger"); } }, 4000); }
  }
  else if (b.id === "stop") ctl?.abort();
  else if (b.id === "dlJson" && current) downloadJson(current);
  else if (b.id === "dlPdf" && current) downloadPdf(current);
  else if (b.id === "saveCfg") {
    const cfg = { endpoint: $("#cfgEp").value.trim(), model: $("#cfgModel").value.trim(), key: $("#cfgKey").value.trim() };
    try { localStorage.setItem("wp.llm", JSON.stringify(cfg)); } catch {}
    await LLM.init(); renderEngine();
    const out = $("#cfgOut"); out.hidden = false;
    if (LLM.kind !== "openai") { out.textContent = "Fill in the endpoint (and the key, unless it's a local server like Ollama)."; return; }
    out.textContent = isLocal(cfg.endpoint) ? "Testing the connection… the first call loads the model, which can take a minute." : "Testing the connection…";
    try { const j = await openaiJson(LLM.cfg, 'Reply with only this JSON: {"ok": true}'); out.textContent = j?.ok ? "Connected. The model answered with valid JSON." : "Connected, but the reply wasn't the expected JSON."; }
    catch (e) { out.textContent = "Connection failed. " + (e?.detail || e?.code || ""); }
  }
});
document.addEventListener("change", (e) => {
  const c = e.target.closest("input[data-task]"); if (!c || !current) return;
  current.done = current.done || {};
  const k = `${tripIdx}:${c.dataset.task}`;
  if (c.checked) current.done[k] = true; else delete current.done[k];
  renderPlan();
  if (current.example) return;
  current.updated = Date.now();
  clearTimeout(saveT); const snap = current;
  saveT = setTimeout(() => Store.save(snap).catch(() => setNote("Couldn't save task progress.")), 700);
});
$("#form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#q").value.trim();
  if (text.length < 4) { setNote("Describe where you want to go, for how long, and with whom."); return; }
  const refine = $("#refine").checked; $("#refine").checked = false;
  run(text, refine);
});
$("#q").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#form").requestSubmit(); });

function renderEngine() {
  const bad = LLM.kind === "none" || LLM.lastError;
  $("#engine").innerHTML = `<span class="vd v-${bad ? "warn" : "pass"}"></span>${esc(LLM.label())}${LLM.lastError ? " · last call failed" : ""}`;
  $("#cfg").hidden = LLM.kind === "claude";
  if (LLM.cfg) { $("#cfgEp").value = LLM.cfg.endpoint || ""; $("#cfgModel").value = LLM.cfg.model || ""; $("#cfgKey").value = LLM.cfg.key || ""; }
  else { $("#cfgEp").value = "http://localhost:11434/v1"; $("#cfgModel").value = "qwen2.5:7b"; }
  if (LLM.kind === "none" && location.protocol !== "https:" && !window.claude) $("#cfg").open = true;
}

/* ---------- Example (computed live by the same symbolic engine) ---------- */
function buildExample() {
  const s = D.add(TODAY, 50);
  const raw = { trips: [{ title: "Kerala: hills and backwaters", origin: { city: "Chennai", country: "India" },
    stops: [{ city: "Kochi", country: "India", nights: 2, arriveBy: "flight" }, { city: "Munnar", country: "India", nights: 2, arriveBy: "car" }, { city: "Alleppey", country: "India", nights: 1, arriveBy: "car" }],
    startDate: s, returnBy: "flight", travelers: { adults: 2, children: 0 }, budget: { amount: 60000, currency: "INR", scope: "total" },
    interests: ["tea estates", "backwaters", "Kerala food"], pace: "relaxed" }], assumptions: [], questions: [] };
  const I = (a, b, title, type, place, cost) => ({ start: a, end: b, title, type, place, cost });
  const days = [
    [I("06:10", "07:30", "Flight MAA → COK", "transit", "Chennai → Cochin Intl", 9000), I("09:00", "10:00", "Check in, Fort Kochi homestay", "checkin", "Fort Kochi", 0), I("11:00", "13:00", "Chinese fishing nets and the waterfront", "sight", "Fort Kochi beach", 0), I("13:00", "14:00", "Lunch", "food", "Kashi Art Cafe", 900), I("15:00", "17:00", "Mattancherry Palace and Jew Town", "sight", "Mattancherry", 100), I("19:30", "20:30", "Seafood dinner", "food", "Fort House", 1800)],
    [I("09:30", "11:30", "Kerala Folklore Museum", "sight", "Thevara", 400), I("12:00", "13:00", "Kerala meals lunch", "food", "Dhe Puttu", 700), I("17:00", "19:00", "Kathakali performance", "activity", "Kerala Kathakali Centre", 1000), I("19:30", "20:30", "Dinner", "food", "Fort Kochi", 1200)],
    [I("08:00", "12:30", "Drive Kochi → Munnar via Cheeyappara falls", "transit", "NH 85", 4500), I("13:00", "14:00", "Lunch", "food", "Munnar town", 800), I("14:30", "15:30", "Check in", "checkin", "Chithirapuram", 0), I("16:00", "17:30", "KDHP Tea Museum", "sight", "Nallathanni", 300), I("19:30", "20:30", "Dinner", "food", "Hotel", 1200)],
    [I("08:00", "11:00", "Eravikulam National Park", "sight", "Rajamala", 500), I("13:00", "14:00", "Lunch", "food", "Saravana Bhavan Munnar", 600), I("15:00", "17:00", "Guided tea estate walk", "activity", "Lockhart estate", 1200), I("19:30", "20:30", "Dinner", "food", "Hotel", 1200)],
    [I("08:00", "12:30", "Drive Munnar → Alleppey", "transit", "via Kottayam", 4500), I("12:30", "17:00", "Houseboat cruise on the backwaters, lunch on board", "activity", "Vembanad Lake", 0), I("19:00", "20:00", "Dinner on the houseboat", "food", "Houseboat", 0)],
    [I("09:00", "10:00", "Check out", "checkin", "Finishing Point", 0), I("10:30", "12:00", "Alappuzha beach and pier", "sight", "Alappuzha", 0), I("13:00", "14:00", "Karimeen lunch", "food", "Thaff", 900), I("14:30", "19:30", "Drive to COK, flight COK → MAA", "transit", "Cochin Intl → Chennai", 9000)],
  ];
  const spec = normalizeSpec(raw, TODAY, { home: HOME });
  const t = spec.trips[0];
  t.skeleton = daySkeleton(t);
  t.highlights = placeHighlights(t);
  t.sched = schedule(buildTasks(t), t.startDate, TODAY);
  const itin = { days: t.skeleton.map((sk, i) => ({ date: sk.date, items: days[i] })), costs: { transport: 27000, stay: 25000, food: 9500, activities: 3500, local: 2000, misc: 1500 },
    tips: ["Houseboat price covers the overnight stay plus lunch and dinner on board.", "The estimate runs about 14% over budget. Swapping the houseboat for a day cruise and a homestay saves roughly ₹6,000."] };
  const viol = verifyItinerary(t, itin, t.skeleton);
  const fx = autoFixItinerary(t, itin, t.skeleton);
  t.itin = fx.itin; t.itinFixes = fx.fixes; t.repairLog = [`Attempt 1: ${viol.filter((x) => x.sev === "fail").length} hard violation(s).`];
  t.budget2 = budgetCheck(t, t.itin);
  t.checks = tripChecks(t, t.sched, verifyItinerary(t, t.itin, t.skeleton), t.budget2, TODAY);
  t.verdict = worst(t.checks.map((c) => c.sev));
  return { id: "example", example: true, created: Date.now(), updated: Date.now(), title: t.title,
    inputs: [{ text: "Chennai to Kochi, Munnar and Alleppey, 5 nights, 2 of us, ₹60k, relaxed, tea estates and backwaters", at: Date.now(), engine: "example" }],
    raw, spec: { assumptions: [], questions: [], issues: [] }, trips: [slimTrip(t)], done: {} };
}

/* ---------- Boot ---------- */
(async function boot() {
  resetTrace();
  current = buildExample(); renderPlan();
  $("#saved").innerHTML = `<li class="muted sm">Loading saved plans…</li>`;
  $("#engine").textContent = "Connecting…";
  await Promise.all([LLM.init(), Store.init()]);
  renderEngine();
  if (Store.mode === "server" && !Store.user) { showAuth(); return; }
  await enterApp();
})();
async function enterApp() {
  $("#auth").hidden = true; $("#app").hidden = false;
  $("#who").hidden = Store.mode !== "server";
  $("#whoName").textContent = Store.user || "";
  $("#storeMode").textContent = { cloud: "Private to your account", server: "Your account", local: "This browser only" }[Store.mode];
  await refreshList();
  if (plans.length && current?.example) { current = plans[0]; tripIdx = 0; renderPlan(); renderList(); }
}

/* ---------- Login (only when served by server.js) ---------- */
let signupMode = false;
function showAuth() {
  ctl?.abort();
  current = buildExample(); plans = []; tripIdx = 0; renderPlan(); renderList();
  $("#app").hidden = true; $("#who").hidden = true; $("#auth").hidden = false;
  setAuthMode(false);
  $("#authUser").focus();
}
function setAuthMode(signup) {
  signupMode = signup;
  $("#authTitle").textContent = signup ? "Create your account" : "Log in to Waypoint";
  $("#authGo").textContent = signup ? "Create account" : "Log in";
  $("#authSwitch").textContent = signup ? "I already have an account" : "Create an account";
  $("#authPass").autocomplete = signup ? "new-password" : "current-password";
  $("#authHint").hidden = !signup;
  $("#authErr").hidden = true;
}
$("#authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#authErr"), go = $("#authGo");
  err.hidden = true; go.disabled = true;
  try {
    await Store.login($("#authUser").value.trim(), $("#authPass").value, signupMode);
    $("#authPass").value = "";
    await enterApp();
  } catch (x) { err.textContent = x.message; err.hidden = false; }
  finally { go.disabled = false; }
});
$("#authSwitch").addEventListener("click", () => setAuthMode(!signupMode));
$("#logout").addEventListener("click", async () => { await Store.logout(); showAuth(); });

/* ---------- Downloads ---------- */
const fileBase = (p) => `waypoint-${String(p.title || "plan").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "plan"}`;
function downloadJson(p) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(p, null, 2)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: fileBase(p) + ".json" });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// PDF: render a print-only copy of the whole plan (every trip, every section) and open the print dialog ("Save as PDF")
function downloadPdf(p) {
  const done = p.done || {};
  const trips = p.trips.map((t, ti) => {
    const sk = Object.fromEntries(t.skeleton.map((s) => [s.date, s]));
    const route = [t.origin.city || "Home", ...t.stops.map((s) => `${s.city} (${s.nights}N)`), t.origin.city || "Home"].join(" → ");
    const tot = t.itin.costs ? Object.values(t.itin.costs).reduce((a, v) => a + v, 0) : null;
    return `<section class="pr-trip">
      <h2>${esc(t.title)}</h2>
      <p class="pr-route">${esc(route)}</p>
      <table class="pr-facts"><tr><th>Dates</th><td>${D.fmtY(t.startDate)} – ${D.fmtY(t.endDate)} (${t.nights} nights)</td><th>Travellers</th><td>${t.travelers.adults} adult(s)${t.travelers.children ? `, ${t.travelers.children} child(ren)` : ""}</td></tr>
        <tr><th>Budget</th><td>${t.budget ? money(t.budget.amount, t.budget.currency) + (t.budget.scope === "per_person" ? " per person" : " total") : "Not set"}</td><th>Border</th><td>${t.international === null ? "Unknown" : t.international ? "International" : "Domestic"} · ${t.pace} pace</td></tr></table>
      <h3>Itinerary</h3>
      ${t.itin.days.map((d, i) => { const s = sk[d.date] || {}; return `<div class="pr-day"><h4>Day ${i + 1} · ${D.dow(d.date)} ${D.fmtY(d.date)} · ${esc(s.travel ? `${s.travel.from} → ${s.travel.to}` : s.city || "")}</h4>
        <table>${d.items.map((it) => `<tr><td class="pr-tm">${esc(it.start)}–${esc(it.end)}</td><td>${esc(it.title)}${it.place ? `<br><small>${esc(it.place)}</small>` : ""}</td><td class="pr-ty">${esc(it.type)}</td><td class="pr-num">${Number(it.cost) > 0 ? money(it.cost, t.currency) : ""}</td></tr>`).join("") || `<tr><td colspan="4">Open day</td></tr>`}</table></div>`; }).join("")}
      ${t.itin.tips?.length ? `<h3>Notes</h3><ul>${t.itin.tips.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      ${(t.highlights || []).some((h) => h.places.length) ? `<h3>Places shortlist (approx. per person)</h3>
      <table class="pr-places">${t.highlights.filter((h) => h.places.length).map((h) => h.places.map((pl, k) => `<tr><td>${k ? "" : `${esc(h.city)} · ${CAT[h.category] || esc(h.category)}${h.source === "model" ? " <small>(model, verify)</small>" : ""}`}</td><td>${esc(pl.name)}${pl.area ? `<br><small>${esc(pl.area)}</small>` : ""}</td><td class="pr-num">${priceRange(pl.min, pl.max, h.currency)}</td></tr>`).join("")).join("")}</table>
      <div>${placesTotal(t)}</div>` : ""}
      <h3>Booking tasks</h3>
      <table class="pr-tasks"><tr><th></th><th>Task</th><th>Due</th><th>Status</th></tr>${t.tasks.map((x) => `<tr><td>${done[`${ti}:${x.id}`] ? "☑" : "☐"}</td><td>${esc(x.title)}</td><td>${actDate(x.due)}</td><td>${x.status === "infeasible" ? "cannot finish before departure" : x.status === "late" ? `behind (ideally ${D.fmt(x.due)})` : x.status === "urgent" ? "start now" : `${x.slack} days slack`}</td></tr>`).join("")}</table>
      <h3>Budget</h3>
      ${t.itin.costs ? `<table class="pr-budget">${Object.entries(t.itin.costs).filter(([, v]) => v > 0).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="pr-num">${money(v, t.currency)}</td></tr>`).join("")}<tr class="pr-total"><td>Estimated total</td><td class="pr-num">${money(tot, t.currency)}</td></tr></table>` : ""}
      <p>${esc(t.budget2?.msg || "")}</p>
      <h3>Verification</h3>
      <ul>${t.checks.map((c) => `<li>${c.sev === "pass" ? "✓" : c.sev === "warn" ? "!" : "✗"} ${esc(c.label)}</li>`).join("")}</ul>
    </section>`;
  }).join("");
  $("#print").innerHTML = `<header class="pr-head"><h1>${esc(p.title)}</h1><p>Waypoint trip plan · generated ${new Date().toLocaleDateString([], { dateStyle: "medium" })}${Store.user ? ` · ${esc(Store.user)}` : ""}</p></header>${trips}
    <p class="pr-foot">Costs are model estimates, not quotes. Check live fares before booking.</p>`;
  const prev = document.title; document.title = fileBase(p); // browsers use the title as the PDF file name
  window.print();
  document.title = prev;
}
