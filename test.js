const E = require("./engine.js");
const today = "2026-10-29";
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:", m); };

// 1. multi-trip, multi-city, partially specified, with conflicting LLM dates
const raw = {
  trips: [
    { origin: { city: "chennai", country: "India" },
      stops: [{ city: "Kochi", country: "India", nights: 2, arriveBy: "flight" },
              { city: "Munnar", country: "India", startDate: "2026-12-21", nights: null, arriveBy: "car" }, // wrong date
              { city: "Alleppey", country: "India", nights: 1, arriveBy: "car" }],
      startDate: "2026-12-18", endDate: "2026-12-23", travelers: { adults: 2, children: 0 },
      budget: { amount: 60000, currency: "INR", scope: "total" }, pace: "relaxed", returnBy: "flight" },
    { origin: { city: "Chennai", country: "India" }, stops: [{ city: "Tokyo", country: "Japan", nights: 4 }, { city: "Kyoto", country: "Japan", nights: 3, arriveBy: "train" }],
      startDate: "2027-03-28", travelers: { adults: 1 }, budget: { amount: 2.5e5 }, pace: "packed" },
    { origin: {}, stops: [{ city: "Goa" }], startDate: "2026-11-05", travelers: {} },
    { stops: [] },
  ],
};
const spec = E.normalizeSpec(raw, today);
ok(spec.trips.length === 3, "3 valid trips, 1 rejected");
ok(spec.issues.some((i) => /no destination/.test(i.msg)), "empty trip reported");
const k = spec.trips[0];
ok(k.stops[1].nights === 2 && k.stops[1].startDate === "2026-12-20" && k.endDate === "2026-12-23", "Munnar nights derived from end date and re-chained");
ok(k.fixes.length >= 1, "fix recorded for Munnar arrival");
ok(k.international === false, "domestic detected");
const j = spec.trips[1];
ok(j.international === true && j.currency === "INR", "Japan international, currency from origin");
ok(spec.trips[2].international === null && spec.trips[2].travelers.adults === 1, "Goa: unknown border, default 1 adult");

// skeleton
const sk = E.daySkeleton(k);
ok(sk.length === 6, "6 days for 5 nights");
ok(sk[0].travel.to === "Kochi" && sk[2].travel.from === "Kochi" && sk[5].travel.to === "Chennai", "travel days placed");
ok(sk[3].travel === null && sk[3].city === "Munnar", "full day in Munnar");

// tasks + schedule
for (const t of spec.trips) {
  const tasks = E.buildTasks(t);
  const s = E.schedule(tasks, t.startDate, today);
  ok(s.ok && s.badRefs.length === 0 && s.edgeViol.length === 0, `${t.title}: DAG ok (${tasks.length} tasks)`);
  if (t === j) {
    const visa = s.tasks.find((x) => x.id === "visa"), out = s.tasks.find((x) => x.id === "legOut");
    ok(out.due < visa.startBy, "Japan: flights due before visa starts (" + out.due + " < " + visa.startBy + ")");
    ok(s.tasks.some((x) => x.id === "forex"), "forex task fired INR→JPY");
  }
  if (t === spec.trips[2]) ok(s.tasks.some((x) => x.status === "late") && s.tasks.some((x) => x.status === "infeasible" && x.id === "visa"), "Goa in 7 days: tasks late, visa infeasible");
}
// cycle detection
const cyc = E.schedule([{ id: "a", deps: ["b"], lead: 1, effort: 1 }, { id: "b", deps: ["a"], lead: 1, effort: 1 }], "2026-12-01", today);
ok(!cyc.ok && cyc.cycle.length === 2, "cycle detected");

// itinerary verification: broken LLM output
const bad = { days: [
  { date: "2026-12-18", items: [{ start: "10:00", end: "12:00", title: "Fort Kochi", type: "sight" }, { start: "11:00", end: "13:00", title: "Lunch", type: "food" }] },
  { date: "2026-12-19", items: [{ start: "25:00", end: "26:00", title: "bad", type: "sight" }, { start: "08:00", end: "18:00", title: "long", type: "sight" }] },
  { date: "2026-12-30", items: [] },
], costs: { transport: 20000, stay: "x" } };
const v = E.verifyItinerary(k, bad, sk);
const codes = new Set(v.map((x) => x.code));
ok(["coverage", "overlap", "time", "load", "transit", "cost"].every((c) => codes.has(c)), "verifier catches coverage/overlap/time/load/transit/cost: " + [...codes]);
{
  // origin not stated: the runtime's detected home country decides the border, no user input needed
  const trips = [
    { stops: [{ city: "Rishikesh", nights: 3 }], startDate: "2027-02-06" },
    { stops: [{ city: "Tokyo", nights: 4 }], startDate: "2027-02-06" },
    { origin: { city: "Tirunelveli" }, stops: [{ city: "Goa", nights: 2 }], startDate: "2027-02-06" }, // origin city not in the KB
  ];
  const [dom, intl, unplaced] = E.normalizeSpec({ trips }, today, { home: "India" }).trips;
  ok(dom.international === false && dom.origin.country === "india" && dom.assumed.some((m) => /start from India \(detected/.test(m)), "home India + Rishikesh: domestic, assumption shown");
  ok(!E.buildTasks(dom).some((t) => t.id === "passport"), "domestic trip has no passport task");
  ok(intl.international === true && E.buildTasks(intl).some((t) => t.id === "passport" && !t.cond), "home India + Tokyo only: international, passport required");
  ok(unplaced.international === false && unplaced.assumed.some((m) => /Couldn't place Tirunelveli/.test(m)), "unknown origin city placed in home country");
  const [noHome] = E.normalizeSpec({ trips: [trips[0]] }, today).trips;
  ok(noHome.international === null && E.buildTasks(noHome).some((t) => t.id === "passport" && t.cond), "no home detected: passport task stays conditional");
  ok(E.normalizeSpec({ trips: [trips[0]] }, today, { home: "USA" }).trips[0].international === true, "home USA + Rishikesh: international");
}
{
  // the Goa → Goa case from a local model: split stay merged, no self-leg, domestic lead times
  const g = E.normalizeSpec({ trips: [{ origin: { city: "Chennai", country: "India" }, stops: [{ city: "Goa", nights: 4 }, { city: "goa", nights: 1 }], startDate: "2026-11-05" }] }, today).trips[0];
  ok(g.stops.length === 1 && g.stops[0].nights === 5 && g.endDate === "2026-11-10" && g.fixes.some((f) => /Merged back-to-back Goa/.test(f)), "consecutive same-city stops merged (4N + 1N = 5N)");
  const gt = E.buildTasks(g);
  ok(!gt.some((x) => / Goa → Goa/.test(x.title)) && gt.filter((x) => x.id.startsWith("stay")).length === 1, "no Goa → Goa leg, one stay booking");
  ok(gt.find((x) => x.id === "scope").lead === E.KB.lead.scopeDom && gt.find((x) => x.id === "stay1").lead === E.KB.lead.stayDom, "domestic trip uses domestic lead times");
  const v = E.normalizeSpec({ trips: [{ origin: { city: "Chennai", country: "India" }, stops: [{ city: "Goa", nights: 2 }, { city: "Kochi", nights: 2 }, { city: "Goa", nights: 1 }], startDate: "2026-12-05" }] }, today).trips[0];
  ok(v.stops.length === 3, "non-adjacent repeat visits are kept");
}
{
  // places shortlist: interests → categories → top 3 from the KB, model fills gaps, budget range
  ok(JSON.stringify(E.interestCategories(["beaches", "nightlife"])) === '["beaches","nightlife"]', "interests map to categories");
  ok(E.interestCategories(["seafood"])[0] === "food" && E.interestCategories(["temples", "rafting"]).join() === "sights,adventure", "seafood is food, not beaches; temples/rafting map");
  ok(E.interestCategories([]).join() === "sights,food", "no interests: sights + food by default");
  const goa = E.normalizeSpec({ trips: [{ origin: { city: "Chennai", country: "India" }, stops: [{ city: "Goa", nights: 3 }, { city: "Hampi", nights: 2 }], startDate: "2026-12-05", travelers: { adults: 4 }, interests: ["beaches", "nightlife"] }] }, today).trips[0];
  const hl = E.placeHighlights(goa);
  const night = hl.find((h) => h.city === "Goa" && h.category === "nightlife");
  ok(night.source === "kb" && night.places.length === 3 && /Tito's/.test(night.places[0].name) && night.currency === "INR", "Goa nightlife: top 3 from the knowledge base, in INR");
  const gaps = E.placeGaps(goa);
  ok(gaps.length === 2 && gaps.every((g) => g.city === "Hampi"), "Hampi isn't in the KB: 2 gaps for the model");
  const model = E.normalizeModelPlaces({ places: [
    { city: "hampi", category: "beaches", name: "A", min: "₹500", max: 200 },        // min > max: swapped
    { city: "Hampi", category: "beaches", name: "B", min: 0, max: 0 },
    { city: "Hampi", category: "beaches", name: "C", min: 100, max: 300 },
    { city: "Hampi", category: "beaches", name: "D", min: 100, max: 300 },           // 4th: dropped later
    { city: "Hampi", category: "nightlife", name: "", min: 1, max: 2 },              // no name: dropped
    { city: "Goa", category: "nightlife", name: "Invented bar", min: 1, max: 2 },    // KB already covers it: ignored
    { city: "Hampi", category: "nightlife", name: "No price" },                      // no price: dropped
  ] }, gaps);
  ok(model.length === 4 && model[0].min === 200 && model[0].max === 500 && model[0].city === "Hampi", "model places validated: bad rows dropped, min/max fixed, KB-covered pairs ignored");
  const hl2 = E.placeHighlights(goa, model);
  ok(hl2.find((h) => h.city === "Hampi" && h.category === "beaches").places.length === 3 && hl2.find((h) => h.city === "Hampi" && h.category === "beaches").source === "model", "model fills the gap, capped at 3, marked as model");
  ok(hl2.find((h) => h.city === "Hampi" && h.category === "nightlife").source === "none", "unfilled gap stays visible as 'none'");
  const tot = E.highlightsBudget(goa, hl);
  ok(tot.INR.count === 6 && tot.INR.min === (1000 + 1500 + 1000 + 0 + 0 + 0) * 4 && tot.INR.max === (2500 + 3000 + 2500 + 2500 + 1500 + 1000) * 4, "visit-all range = sum of per-person ranges × 4 people");
  goa.skeleton = E.daySkeleton(goa);
  const ti = E.templateItinerary(goa, goa.skeleton, hl);
  const all = ti.days.flatMap((d) => d.items);
  const tito = all.find((i) => /Tito's/.test(i.title));
  ok(tito && tito.start === "21:30" && tito.cost === 7000, "offline template schedules Tito's at night, cost = midpoint × 4");
  ok(E.verifyItinerary(goa, ti, goa.skeleton).filter((v) => v.sev === "fail").length === 0, "template with places passes the verifier");
  ok(/Tito's Lane/.test(E.itineraryPrompt(goa, goa.skeleton, hl)), "itinerary prompt carries the shortlist");
}
ok(E.costNum("₹6,000") === 6000 && E.costNum({ amount: 2400 }) === 2400 && E.costNum("about 1,500.5 INR") === 1500.5, "costNum parses formatted and nested costs");
ok(E.costNum(null) === null && E.costNum("n/a") === null && E.costNum(-5) === null && E.costNum(0) === 0, "costNum rejects junk");
const fx = E.autoFixItinerary(k, bad, sk);
const v2 = E.verifyItinerary(k, fx.itin, sk).filter((x) => x.sev === "fail");
ok(v2.length === 0, "autofix leaves no hard failures (" + v2.map((x) => x.msg).join("; ") + ")");
console.log(fx.fixes.slice(0, 6));

// fallback parser
const rp = E.ruleParse("Trip from Chennai to Kochi and Munnar for 5 days starting 18 Dec with 2 adults, budget ₹60k, love nature and food; also visit Delhi for 3 nights on Jan 10", today);
ok(rp.trips.length === 2, "rule parser: 2 trips");
const rs = E.normalizeSpec(rp, today);
console.log(JSON.stringify(rs.trips.map((t) => [t.title, t.startDate, t.endDate, t.budget, t.travelers]), null, 0));
ok(rs.trips[0].nights === 4 && rs.trips[0].budget.amount === 60000 && rs.trips[1].startDate === "2027-01-10", "rule parser fields");
const tsk = E.templateItinerary(rs.trips[0], E.daySkeleton(rs.trips[0]));
ok(E.verifyItinerary(rs.trips[0], tsk, E.daySkeleton(rs.trips[0])).filter((x) => x.sev === "fail").length === 0, "template itinerary passes");
console.log(E.money(68000, "INR"), E.money(1200, "USD"));
console.log("FAILS:", fails);
