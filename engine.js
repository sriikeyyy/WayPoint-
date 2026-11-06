/* ================================================================
   WAYPOINT ENGINE — pure, deterministic, testable (no DOM, no network)
   Layers:
     D        date algebra on ISO strings (UTC-noon free, integer days)
     KB       knowledge base: lead times, pace caps, rule catalogue
     normalizeSpec   schema validation + repair of LLM interpretation
     daySkeleton     fixed day/city/travel frame the LLM must fill
     buildTasks      rule instantiation -> task DAG
     schedule        Kahn topo sort + backward CPM deadline pass
     verifyItinerary constraint checks on LLM itinerary
     autoFixItinerary deterministic last-resort repair
     tripChecks      verdict table
     ruleParse / templateItinerary   offline fallback (no LLM)
   ================================================================ */

const D = {
  parse(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const [y, m, d] = s.split("-").map(Number);
    const t = Date.UTC(y, m - 1, d);
    const x = new Date(t);
    if (x.getUTCFullYear() !== y || x.getUTCMonth() !== m - 1 || x.getUTCDate() !== d) return null;
    return t;
  },
  iso(t) { return new Date(t).toISOString().slice(0, 10); },
  add(s, n) { return D.iso(D.parse(s) + n * 864e5); },
  diff(a, b) { return Math.round((D.parse(b) - D.parse(a)) / 864e5); }, // b - a in days
  today() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  },
  MON: ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],
  DOW: ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"],
  fmt(s) { const t = D.parse(s); if (t == null) return s || "—"; const x = new Date(t); return `${x.getUTCDate()} ${D.MON[x.getUTCMonth()]}`; },
  fmtY(s) { const t = D.parse(s); if (t == null) return s || "—"; const x = new Date(t); return `${x.getUTCDate()} ${D.MON[x.getUTCMonth()]} ${x.getUTCFullYear()}`; },
  dow(s) { const t = D.parse(s); return t == null ? "" : D.DOW[new Date(t).getUTCDay()]; },
};

const KB = {
  paceCap: { relaxed: 7, moderate: 9, packed: 11 }, // active hours/day, excl. transit & rest
  lead: { scope: 45, passport: 60, entry: 50, visa: 30, legIntl: 30, legDom: 21, stay: 21,
          insurance: 14, forex: 5, activities: 10, docs: 2, pack: 1,
          scopeDom: 21, stayDom: 14 }, // domestic trips need less runway

  effort: { visa: 15 },
  modes: ["flight", "train", "bus", "car", "ferry"],
  aliases: { usa: "united states", us: "united states", "u.s.": "united states", america: "united states",
             uk: "united kingdom", england: "united kingdom", scotland: "united kingdom", britain: "united kingdom",
             uae: "united arab emirates", dubai: "united arab emirates", bharat: "india", holland: "netherlands" },
  currency: { india: "INR", "united states": "USD", "united kingdom": "GBP", "united arab emirates": "AED",
              japan: "JPY", singapore: "SGD", thailand: "THB", malaysia: "MYR", indonesia: "IDR",
              "sri lanka": "LKR", nepal: "NPR", australia: "AUD", canada: "CAD", switzerland: "CHF",
              france: "EUR", germany: "EUR", italy: "EUR", spain: "EUR", netherlands: "EUR",
              portugal: "EUR", greece: "EUR", austria: "EUR", vietnam: "VND", maldives: "MVR",
              "south korea": "KRW", china: "CNY", turkey: "TRY", bhutan: "BTN" },
  cityCountry: Object.fromEntries([
    ...["chennai","bengaluru","bangalore","mumbai","delhi","new delhi","kolkata","hyderabad","pune","ahmedabad","jaipur","udaipur","jodhpur","jaisalmer","agra","varanasi","rishikesh","haridwar","goa","panaji","kochi","cochin","munnar","alleppey","alappuzha","thekkady","wayanad","kovalam","trivandrum","thiruvananthapuram","ooty","kodaikanal","coonoor","pondicherry","puducherry","madurai","mysuru","mysore","coorg","madikeri","hampi","gokarna","shimla","manali","leh","srinagar","gulmarg","darjeeling","gangtok","shillong","amritsar","chandigarh","dharamshala","nainital","mussoorie","andaman","port blair","vellore","mahabalipuram","rameswaram","kanyakumari","tirupati","visakhapatnam","lucknow","bhopal","indore","khajuraho","ranthambore","pushkar","mount abu","lonavala","mahabaleshwar","katpadi","coimbatore","trichy","thanjavur"].map((c) => [c, "india"]),
    ["tokyo","japan"],["kyoto","japan"],["osaka","japan"],["paris","france"],["nice","france"],["london","united kingdom"],["edinburgh","united kingdom"],["dubai","united arab emirates"],["abu dhabi","united arab emirates"],["singapore","singapore"],["bangkok","thailand"],["phuket","thailand"],["bali","indonesia"],["kuala lumpur","malaysia"],["colombo","sri lanka"],["kathmandu","nepal"],["male","maldives"],["rome","italy"],["venice","italy"],["florence","italy"],["barcelona","spain"],["madrid","spain"],["amsterdam","netherlands"],["berlin","germany"],["munich","germany"],["zurich","switzerland"],["interlaken","switzerland"],["new york","united states"],["san francisco","united states"],["sydney","australia"],["melbourne","australia"],["seoul","south korea"],["istanbul","turkey"],["hanoi","vietnam"],["thimphu","bhutan"],
  ]),
  rules: {
    R1: "Every trip starts from a confirmed scope: dates, travellers and budget.",
    R2: "Crossing a border needs a passport valid 6+ months past the return date.",
    R3: "Entry rules must be known before any booking is committed.",
    R4: "Each transport leg is booked once scope (and entry rules) are settled; international legs need a longer lead.",
    R5: "A stay is booked after the leg that arrives there, so check-in matches arrival.",
    R6: "Visa applications usually need booked itineraries as proof and take ~15 days to process.",
    R7: "Travel insurance is bought once the outbound journey is fixed.",
    R8: "Different home and destination currencies require arranging forex or a travel card.",
    R9: "Timed-entry attractions are pre-booked once stays are fixed.",
    R10: "Tickets, confirmations and offline maps are gathered after all bookings.",
    R11: "Packing comes last and depends on finalized documents.",
  },
};

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const toInt = (v) => { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; };
const titleCase = (s) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase());
function normCountry(c) { const s = str(c); if (!s) return null; const k = s.toLowerCase(); return KB.aliases[k] || k; }
function normMode(m) { const s = str(m); if (!s) return null; const k = s.toLowerCase(); if (/fl(y|ight)|air|plane/.test(k)) return "flight"; if (/train|rail/.test(k)) return "train"; if (/bus|coach/.test(k)) return "bus"; if (/car|cab|taxi|drive|road/.test(k)) return "car"; if (/ferry|boat|ship/.test(k)) return "ferry"; return null; }

/* ---------------- Places knowledge: top 3 per interest, approx. price per person in local currency ---------------- */
// interest words → category (first match wins); trips with no matching interest get sights + food
KB.categories = {
  nightlife: /nightlife|night life|party|parties|club|bar|pub/i,
  beaches: /beach|\bsea\b|coast/i,
  food: /food|cuisine|eat|cafe|seafood|dining|restaurant/i,
  adventure: /adventure|rafting|bungee|trek|hiking|scuba|diving|water ?sport|paraglid/i,
  nature: /nature|hill|waterfall|tea|wildlife|backwater|lake|garden|scenery|national park/i,
  sights: /sight|temple|heritage|histor|culture|museum|fort|palace|architect|shrine/i,
};
KB.defaultCategories = ["sights", "food"];
// [name, area, min, max, note]. Prices are rough guides for planning, not quotes; Indian sites list the Indian-national rate first.
KB.places = {
  goa: {
    nightlife: [["Tito's Lane (Tito's, Mambo's)", "Baga", 1000, 2500, "Cover charge, usually redeemable against drinks"],
                ["Club Cubana", "Arpora hilltop", 1500, 3000, "Entry often includes drinks; busiest on weekends"],
                ["LPK Waterfront", "Nerul riverside", 1000, 2500, "Cover charge on party nights"]],
    beaches: [["Baga & Calangute beach", "North Goa", 0, 2500, "Beach is free; water sports about ₹500–2,500 per ride"],
              ["Palolem Beach", "South Goa", 0, 1500, "Free; kayaking or dolphin boat trips about ₹500–1,500"],
              ["Anjuna & Vagator beaches", "North Goa", 0, 1000, "Free; Anjuna flea market on Wednesdays"]],
    food: [["Britto's", "Baga", 800, 1800, "Goan seafood on the beach"],
           ["Fisherman's Wharf", "Cavelossim / Panjim", 1000, 2000, "Goan and coastal food"],
           ["Thalassa", "Siolim", 1500, 3000, "Greek food, sunset views; book ahead"]],
    sights: [["Basilica of Bom Jesus", "Old Goa", 0, 0, "Free; modest dress"],
             ["Fort Aguada", "Candolim", 0, 50, "Lighthouse and sea views"],
             ["Dudhsagar Falls jeep safari", "Mollem", 500, 1500, "Usually closed in the monsoon (Jun–Sep)"]],
    adventure: [["Scuba diving", "Grande Island", 3000, 6000, "Boat trip with a beginner dive"],
                ["Parasailing & water sports", "Calangute / Baga", 500, 2500, "Per activity"],
                ["Kayaking", "Nerul / Sal backwaters", 800, 1500, "Guided, 2–3 hours"]],
  },
  jaipur: {
    sights: [["Amber (Amer) Fort", "Amer", 100, 500, "₹100 Indians, ₹500 foreign nationals"],
             ["City Palace", "Old City", 200, 1000, "Higher rate for foreign nationals"],
             ["Hawa Mahal", "Badi Choupad", 50, 200, "₹50 Indians, ₹200 foreign nationals"]],
    food: [["Laxmi Mishthan Bhandar (LMB)", "Johari Bazaar", 300, 700, "Rajasthani thali and sweets"],
           ["Rawat Mishthan Bhandar", "Station Road", 50, 200, "Famous pyaaz kachori"],
           ["Chokhi Dhani", "Tonk Road", 900, 1500, "Village-themed evening with dinner"]],
  },
  udaipur: {
    sights: [["City Palace", "Lake Pichola", 300, 1000, "Museum ticket; camera extra"],
             ["Lake Pichola boat ride", "City Palace jetty", 400, 1000, "Sunset rides cost more"],
             ["Sajjangarh (Monsoon Palace)", "Sajjangarh hill", 100, 400, "Entry plus vehicle up the hill"]],
    food: [["Ambrai", "Hanuman Ghat", 1000, 2500, "Lakeside dinner; book ahead"],
           ["Upre by 1559 AD", "Lake Pichola", 1500, 3000, "Rooftop with palace views"],
           ["Natraj Dining Hall", "Bapu Bazaar", 300, 500, "Unlimited Rajasthani thali"]],
  },
  kochi: {
    sights: [["Chinese fishing nets", "Fort Kochi beach", 0, 0, "Free; best at sunset"],
             ["Mattancherry Palace", "Mattancherry", 5, 100, "Murals; closed Fridays"],
             ["Kathakali show", "Kerala Kathakali Centre", 300, 600, "Arrive early to watch the make-up"]],
    food: [["Kashi Art Cafe", "Fort Kochi", 400, 800, "Breakfast and coffee"],
           ["Dhe Puttu", "Edappally", 300, 600, "Kerala puttu varieties"],
           ["Fort House", "Fort Kochi waterfront", 800, 1500, "Kerala seafood"]],
  },
  munnar: {
    nature: [["Eravikulam National Park", "Rajamala", 200, 500, "Nilgiri tahr; closed in calving season (Feb–Mar)"],
             ["KDHP Tea Museum", "Nallathanni", 125, 200, "Tea processing demo"],
             ["Top Station viewpoint", "Top Station", 0, 100, "Go early, before the mist"]],
  },
  alleppey: {
    nature: [["Houseboat overnight cruise", "Vembanad Lake", 4000, 10000, "Per person, sharing; includes meals"],
             ["Shikara canal ride", "Alappuzha canals", 400, 800, "Per person per hour, sharing"],
             ["Alappuzha Beach", "Alappuzha", 0, 0, "Free; old pier at sunset"]],
  },
  rishikesh: {
    adventure: [["River rafting (Shivpuri, 16 km)", "Shivpuri", 500, 1500, "Season roughly Sep–Jun"],
                ["Bungee jumping", "Jumpin Heights, Mohan Chatti", 3500, 5000, "Age and weight limits apply"],
                ["Giant swing / flying fox", "Mohan Chatti", 1500, 3000, "Per activity"]],
    sights: [["Ganga Aarti", "Triveni Ghat", 0, 0, "Free; evenings at sunset"],
             ["Parmarth Niketan aarti", "Swarg Ashram", 0, 0, "Free; arrive 30 min early"],
             ["Beatles Ashram (Chaurasi Kutia)", "Swarg Ashram", 150, 600, "₹150 Indians, ₹600 foreign nationals"]],
  },
  ooty: {
    nature: [["Government Botanical Garden", "Ooty", 50, 100, "Camera extra"],
             ["Ooty Lake boating", "Ooty", 200, 600, "Pedal or row boats"],
             ["Nilgiri Mountain Railway (toy train)", "Ooty–Coonoor", 50, 600, "Book early; first class costs more"]],
  },
  tokyo: {
    sights: [["Senso-ji", "Asakusa", 0, 0, "Free; go early"],
             ["Meiji Jingu", "Harajuku", 0, 0, "Free"],
             ["teamLab Planets", "Toyosu", 3600, 4200, "Timed tickets; book ahead"]],
    food: [["Tsukiji Outer Market", "Tsukiji", 1500, 4000, "Street food and sushi; mornings"],
           ["Ichiran Ramen", "Shibuya / Shinjuku", 1000, 1500, "Solo ramen booths"],
           ["Omoide Yokocho", "Shinjuku", 2000, 4000, "Yakitori alley"]],
    nightlife: [["Golden Gai", "Shinjuku", 1500, 4000, "Tiny bars; many charge a seat fee"],
                ["Shibuya Center Gai bars", "Shibuya", 2000, 5000, "Drinks and izakaya"],
                ["Roppongi clubs", "Roppongi", 2000, 4000, "Entry; ID required"]],
  },
  kyoto: {
    sights: [["Fushimi Inari Taisha", "Fushimi", 0, 0, "Free; open 24 hours"],
             ["Kinkaku-ji (Golden Pavilion)", "Kita", 500, 500, "Fixed entry"],
             ["Kiyomizu-dera", "Higashiyama", 400, 500, "Entry"]],
    food: [["Nishiki Market", "Downtown", 1000, 3000, "Street food tasting"],
           ["Pontocho alley dinner", "Pontocho", 3000, 8000, "Riverside kaiseki and izakaya"],
           ["Gion tea house sweets", "Gion", 800, 2000, "Matcha and wagashi"]],
  },
};

function interestCategories(interests) {
  const cats = [];
  for (const i of interests || []) for (const [c, re] of Object.entries(KB.categories)) if (re.test(i) && !cats.includes(c)) { cats.push(c); break; }
  return cats.length ? cats : KB.defaultCategories;
}
// one entry per stop × category: knowledge base first, then validated model suggestions, else an empty slot
function placeHighlights(trip, modelPlaces = []) {
  const cats = interestCategories(trip.interests);
  const out = [];
  for (const s of trip.stops) {
    const cur = KB.currency[s.country] || trip.currency;
    for (const category of cats) {
      const kb = KB.places[s.city.toLowerCase()]?.[category];
      if (kb) { out.push({ city: s.city, category, currency: cur, source: "kb", places: kb.map(([name, area, min, max, note]) => ({ name, area, min, max, note })) }); continue; }
      const m = modelPlaces.filter((p) => p.city.toLowerCase() === s.city.toLowerCase() && p.category === category).slice(0, 3);
      out.push({ city: s.city, category, currency: m[0]?.currency || cur, source: m.length ? "model" : "none", places: m.map(({ name, area, min, max, note }) => ({ name, area, min, max, note })) });
    }
  }
  return out;
}
// gaps the model should fill: stop × category pairs the knowledge base doesn't cover
const placeGaps = (trip) => placeHighlights(trip).filter((h) => h.source === "none").map(({ city, category, currency }) => ({ city, category, currency }));
function normalizeModelPlaces(raw, gaps) {
  const want = new Set(gaps.map((g) => `${g.city.toLowerCase()}|${g.category}`));
  const out = [];
  for (const p of arr(raw?.places)) {
    const city = str(p?.city), category = str(p?.category)?.toLowerCase(), name = str(p?.name);
    if (!city || !name || !want.has(`${city.toLowerCase()}|${category}`)) continue;
    let min = costNum(p.min), max = costNum(p.max);
    if (min == null && max == null) continue;
    if (min == null) min = max; if (max == null) max = min; if (min > max) [min, max] = [max, min];
    const gap = gaps.find((g) => g.city.toLowerCase() === city.toLowerCase());
    out.push({ city: gap.city, category, name: name.slice(0, 80), area: str(p.area)?.slice(0, 60) || "", min, max, note: str(p.note)?.slice(0, 120) || "", currency: gap.currency });
  }
  return out;
}
// "visit everything on the shortlist" range for the whole group, per currency
function highlightsBudget(trip, highlights) {
  const people = trip.travelers.adults + trip.travelers.children;
  const tot = {};
  for (const h of highlights || []) for (const p of h.places) {
    const t = (tot[h.currency] = tot[h.currency] || { min: 0, max: 0, count: 0 });
    t.min += p.min * people; t.max += p.max * people; t.count++;
  }
  return tot;
}

/* ---------------- 1. Validate + normalize interpreter output ---------------- */
// opts.home: the user's home country as detected by the runtime (used when the origin is unknown)
function normalizeSpec(raw, today, opts = {}) {
  const out = { trips: [], assumptions: [], questions: [], issues: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    out.issues.push({ sev: "fail", msg: "The interpreter did not return a JSON object." });
    return out;
  }
  out.assumptions = arr(raw.assumptions).map(String).filter(Boolean).slice(0, 12);
  out.questions = arr(raw.questions).map(String).filter(Boolean).slice(0, 8);
  const trips = arr(raw.trips);
  if (!trips.length) out.issues.push({ sev: "fail", msg: "No trip with a destination was found in the request." });
  trips.forEach((t, i) => {
    const r = normalizeTrip(t, today, i, normCountry(opts.home));
    if (r.error) out.issues.push({ sev: "fail", msg: r.error });
    else out.trips.push(r);
  });
  // cross-trip overlap
  const sorted = [...out.trips].sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startDate < sorted[i - 1].endDate)
      out.issues.push({ sev: "warn", msg: `“${sorted[i - 1].title}” and “${sorted[i].title}” overlap (${D.fmt(sorted[i].startDate)} is before ${D.fmt(sorted[i - 1].endDate)}).` });
  }
  return out;
}

function normalizeTrip(t, today, i, home) {
  if (!t || typeof t !== "object") return { error: `Trip ${i + 1} is not an object.` };
  const issues = [], fixes = [], assumed = [];
  const stopsRaw = [];
  for (const s of arr(t.stops).filter((s) => s && str(s.city))) {
    const prev = stopsRaw[stopsRaw.length - 1];
    // back-to-back stops in the same city are one stay (models sometimes split them)
    if (prev && str(prev.city).toLowerCase() === str(s.city).toLowerCase()) {
      const a = toInt(prev.nights), b = toInt(s.nights);
      stopsRaw[stopsRaw.length - 1] = { ...prev, nights: a > 0 && b > 0 ? a + b : null, endDate: s.endDate ?? null };
      fixes.push(`Merged back-to-back ${titleCase(str(s.city))} stops into one stay.`);
    } else stopsRaw.push(s);
  }
  if (!stopsRaw.length) return { error: `Trip ${i + 1} has no destination city.` };

  const guessC = (city, given) => normCountry(given) || (city ? KB.cityCountry[city.toLowerCase()] || null : null);
  const origin = { city: str(t.origin?.city) ? titleCase(str(t.origin.city)) : null, country: null };
  origin.country = guessC(origin.city, t.origin?.country);
  if (!origin.city) assumed.push("Starting city not stated; outbound/return legs use “home”.");

  const adultsIn = toInt(t.travelers?.adults);
  const adults = Math.max(1, adultsIn ?? 1);
  if (adultsIn == null) assumed.push("1 adult traveller (not stated).");
  const children = Math.max(0, toInt(t.travelers?.children) ?? 0);

  // start date
  let start = D.parse(t.startDate) != null ? t.startDate : D.parse(stopsRaw[0].startDate) != null ? stopsRaw[0].startDate : null;
  if (!start) { start = D.add(today, 30); assumed.push(`Start date not given; assumed ${D.fmtY(start)} (30 days out).`); }
  let statedEnd = D.parse(t.endDate) != null ? t.endDate : D.parse(stopsRaw[stopsRaw.length - 1].endDate) != null ? stopsRaw[stopsRaw.length - 1].endDate : null;
  if (statedEnd && D.diff(start, statedEnd) < 1) { issues.push({ sev: "warn", msg: `End date ${D.fmtY(statedEnd)} is not after start ${D.fmtY(start)}; ignored it.` }); statedEnd = null; }

  // nights per stop
  const nights = stopsRaw.map((s) => {
    const a = D.parse(s.startDate), b = D.parse(s.endDate);
    if (a != null && b != null && b > a) return Math.round((b - a) / 864e5);
    const n = toInt(s.nights);
    return n && n > 0 ? n : null;
  });
  const known = nights.filter((n) => n != null).reduce((a, b) => a + b, 0);
  const unknown = nights.map((n, j) => (n == null ? j : -1)).filter((j) => j >= 0);
  if (unknown.length) {
    const names = unknown.map((j) => titleCase(str(stopsRaw[j].city))).join(", ");
    if (statedEnd) {
      let rem = D.diff(start, statedEnd) - known;
      if (rem < unknown.length) { issues.push({ sev: "warn", msg: `Stated dates leave too few nights for ${names}; gave each 1 night.` }); rem = unknown.length; }
      const base = Math.floor(rem / unknown.length), extra = rem % unknown.length;
      unknown.forEach((j, k) => (nights[j] = base + (k < extra ? 1 : 0)));
      fixes.push(`Split the remaining ${rem} night(s) across ${names}.`);
    } else {
      unknown.forEach((j) => (nights[j] = 2));
      assumed.push(`Length of stay not given for ${names}; assumed 2 nights each.`);
    }
  }
  if (nights.some((n) => n > 30)) issues.push({ sev: "warn", msg: "A single stop longer than 30 nights; check the duration." });

  // chain stops back-to-back (departure day = next arrival day)
  let cur = start;
  const stops = stopsRaw.map((s, j) => {
    const city = titleCase(str(s.city));
    if (D.parse(s.startDate) != null && s.startDate !== cur) fixes.push(`${city}: arrival moved ${D.fmt(s.startDate)} → ${D.fmt(cur)} so stops run back-to-back without gaps or overlaps.`);
    const st = { city, country: guessC(city, s.country), nights: nights[j], arriveBy: normMode(s.arriveBy), startDate: cur, endDate: D.add(cur, nights[j]) };
    cur = st.endDate;
    return st;
  });
  const end = cur;
  if (statedEnd && statedEnd !== end) issues.push({ sev: "warn", msg: `Stated end ${D.fmt(statedEnd)} differs from the sum of stop lengths (${D.fmt(end)}); used the stop lengths.` });
  if (start < today) issues.push({ sev: "fail", msg: `Trip starts ${D.fmtY(start)}, which is already in the past.` });
  else if (D.diff(today, start) > 540) issues.push({ sev: "warn", msg: `Trip starts ${D.fmtY(start)}, more than 18 months away; prices and schedules are speculative.` });

  // origin country unknown: fall back to the home country the runtime detected
  if (!origin.country && home) {
    origin.country = home;
    assumed.push(origin.city
      ? `Couldn't place ${origin.city}; assumed it is in ${titleCase(home)} (detected from this device).`
      : `Assumed you start from ${titleCase(home)} (detected from this device).`);
  }

  // international?
  const cs = [origin.country, ...stops.map((s) => s.country)];
  const knownCs = cs.filter(Boolean);
  let international;
  if (new Set(knownCs).size > 1) international = true;
  else if (knownCs.length === cs.length) international = false;
  else international = null;
  if (international === null) assumed.push("Could not confirm whether the trip crosses a border; border tasks are marked conditional.");

  // budget
  const amount = Number(t.budget?.amount);
  let currency = str(t.budget?.currency)?.toUpperCase() || null;
  if (currency && !/^[A-Z]{3}$/.test(currency)) currency = null;
  if (!currency) {
    currency = KB.currency[origin.country] || KB.currency[stops[0].country] || "INR";
    if (amount > 0) assumed.push(`Budget currency not stated; assumed ${currency}.`);
  }
  const budget = amount > 0 ? { amount, currency, scope: t.budget?.scope === "per_person" ? "per_person" : "total" } : null;

  const pace = ["relaxed", "moderate", "packed"].includes(t.pace) ? t.pace : "moderate";
  const title = str(t.title) || [origin.city, ...stops.map((s) => s.city)].filter(Boolean).join(" → ");

  return {
    title, origin, stops, startDate: start, endDate: end, nights: D.diff(start, end),
    travelers: { adults, children }, budget, currency, pace,
    interests: arr(t.interests).map(String).filter(Boolean).slice(0, 10),
    constraints: arr(t.constraints).map(String).filter(Boolean).slice(0, 10),
    accommodation: str(t.accommodation),
    returnBy: normMode(t.returnBy),
    international, issues, fixes, assumed,
  };
}

/* ---------------- 2. Day skeleton (symbolic frame for the LLM) ---------------- */
function daySkeleton(trip) {
  const days = [], home = trip.origin.city || "home";
  for (let d = trip.startDate; d <= trip.endDate; d = D.add(d, 1)) {
    let travel = null;
    if (d === trip.startDate) travel = { from: home, to: trip.stops[0].city, mode: trip.stops[0].arriveBy };
    const leaving = trip.stops.findIndex((s) => s.endDate === d);
    if (leaving >= 0) {
      const nx = trip.stops[leaving + 1];
      travel = nx ? { from: trip.stops[leaving].city, to: nx.city, mode: nx.arriveBy } : { from: trip.stops[leaving].city, to: home, mode: trip.returnBy };
    }
    const idx = trip.stops.findIndex((s) => d >= s.startDate && d < s.endDate);
    days.push({ date: d, city: idx >= 0 ? trip.stops[idx].city : trip.stops[trip.stops.length - 1].city, travel });
  }
  return days;
}

/* ---------------- 3. Rule instantiation -> task graph ---------------- */
function buildTasks(trip) {
  const T = [], L = KB.lead;
  const intl = trip.international; // true | false | null
  const cond = intl === null ? " (if crossing a border)" : "";
  const add = (id, title, lead, deps, rule, cat, effort = 1) => T.push({ id, title, lead, deps, rule, cat, effort, cond: intl === null && ["R2", "R3", "R6", "R7"].includes(rule) });
  const home = { city: trip.origin.city || "home", country: trip.origin.country };

  add("scope", "Confirm dates, travellers and budget", intl === false ? L.scopeDom : L.scope, [], "R1", "plan");
  const countries = [...new Set(trip.stops.map((s) => s.country).filter((c) => c && c !== trip.origin.country))].map(titleCase);
  if (intl !== false) {
    add("passport", `Check passport validity (6+ months past ${D.fmtY(trip.endDate)})${cond}`, L.passport, ["scope"], "R2", "docs");
    add("entry", `Check visa and entry rules for ${countries.join(", ") || "destination"}${cond}`, L.entry, ["passport"], "R3", "docs");
  }
  const pre = intl !== false ? ["entry"] : ["scope"];

  const nodes = [home, ...trip.stops, home];
  const legIds = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i], b = nodes[i + 1];
    const id = i === 0 ? "legOut" : i === nodes.length - 2 ? "legRet" : `leg${i}`;
    const date = i === 0 ? trip.startDate : trip.stops[i - 1].endDate;
    const mode = i === nodes.length - 2 ? trip.returnBy : trip.stops[i].arriveBy;
    const legIntl = a.country && b.country ? a.country !== b.country : intl === true;
    add(id, `Book ${mode || "transport"}: ${a.city} → ${b.city} (${D.fmt(date)})`, legIntl ? L.legIntl : L.legDom, pre, "R4", "book");
    legIds.push(id);
  }
  const stayIds = trip.stops.map((s, i) => {
    const id = `stay${i + 1}`;
    add(id, `Book stay in ${s.city}: ${s.nights} night${s.nights > 1 ? "s" : ""} from ${D.fmt(s.startDate)}`, intl === false ? L.stayDom : L.stay, [legIds[i]], "R5", "book");
    return id;
  });
  const bookings = [...legIds, ...stayIds];
  if (intl !== false) add("visa", `Apply for visa if required${cond}`, L.visa, ["entry", ...bookings], "R6", "docs", KB.effort.visa);
  if (intl !== false) add("insurance", "Buy travel insurance", L.insurance, ["legOut"], "R7", "docs");
  const destCur = [...new Set(trip.stops.map((s) => KB.currency[s.country]).filter(Boolean))];
  const homeCur = KB.currency[trip.origin.country];
  if (homeCur && destCur.some((c) => c !== homeCur)) add("forex", `Arrange forex / travel card (${destCur.filter((c) => c !== homeCur).join(", ")})`, L.forex, ["scope"], "R8", "money");
  add("activities", "Pre-book timed-entry attractions", L.activities, stayIds, "R9", "book");
  const docDeps = [...bookings, "activities", ...(intl !== false ? ["visa", "insurance"] : [])];
  add("docs", "Download tickets, confirmations and offline maps", L.docs, docDeps, "R10", "docs");
  add("pack", "Pack using the day plan and weather", L.pack, ["docs", ...(T.some((t) => t.id === "forex") ? ["forex"] : [])], "R11", "plan");
  return T;
}

/* ---------------- 4. Topological sort + backward deadline pass ---------------- */
function schedule(tasks, tripStart, today) {
  const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
  const badRefs = [];
  tasks.forEach((t) => t.deps.forEach((d) => { if (!byId[d]) badRefs.push(`${t.id} → ${d}`); }));
  const dependents = Object.fromEntries(tasks.map((t) => [t.id, []]));
  const indeg = Object.fromEntries(tasks.map((t) => [t.id, 0]));
  tasks.forEach((t) => t.deps.forEach((d) => { if (byId[d]) { dependents[d].push(t.id); indeg[t.id]++; } }));
  const q = tasks.filter((t) => indeg[t.id] === 0).map((t) => t.id);
  const order = [];
  while (q.length) {
    const id = q.shift(); order.push(id);
    for (const n of dependents[id]) if (--indeg[n] === 0) q.push(n);
  }
  if (order.length < tasks.length) {
    return { ok: false, cycle: tasks.filter((t) => !order.includes(t.id)).map((t) => t.id), badRefs, tasks };
  }
  const out = tasks.map((t) => ({ ...t, due: D.add(tripStart, -t.lead), tightenedBy: null }));
  const m = Object.fromEntries(out.map((t) => [t.id, t]));
  for (const id of [...order].reverse()) {
    const t = m[id];
    for (const b of dependents[id]) {
      const lim = D.add(m[b].due, -m[b].effort); // finish before b must start
      if (lim < t.due) { t.due = lim; t.tightenedBy = b; }
    }
  }
  const depth = {};
  for (const id of order) depth[id] = Math.max(0, ...m[id].deps.filter((d) => m[d]).map((d) => depth[d] + 1));
  out.forEach((t) => {
    t.startBy = D.add(t.due, -(t.effort - 1));
    t.depth = depth[t.id];
    // infeasible: even starting today it cannot finish before departure; late: past the recommended lead time
    t.status = D.add(today, t.effort - 1) >= tripStart ? "infeasible" : t.due < today ? "late" : t.startBy <= D.add(today, 2) ? "urgent" : "ok";
    t.slack = D.diff(today, t.startBy);
  });
  // sanity: every edge respects ordering
  const edgeViol = [];
  out.forEach((t) => t.deps.forEach((d) => { if (m[d] && m[d].due > D.add(t.startBy, -1)) edgeViol.push(`${d} → ${t.id}`); }));
  return { ok: true, order, badRefs, edgeViol, tasks: out.sort((a, b) => (a.startBy < b.startBy ? -1 : a.startBy > b.startBy ? 1 : a.depth - b.depth)) };
}

/* ---------------- 5. Itinerary verification ---------------- */
const tm = (s) => { if (typeof s !== "string") return null; const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim()); if (!m) return null; const h = +m[1], mi = +m[2]; if (h > 23 || mi > 59) return null; return h * 60 + mi; };
const ITEM_TYPES = ["transit", "sight", "food", "activity", "rest", "checkin"];

function verifyItinerary(trip, itin, skel) {
  const v = [];
  if (!itin || typeof itin !== "object" || !Array.isArray(itin.days)) return [{ code: "coverage", sev: "fail", msg: "Itinerary has no “days” array." }];
  const map = new Map();
  itin.days.forEach((d, k) => {
    if (!d || D.parse(d.date) == null) v.push({ code: "coverage", sev: "fail", msg: `Day #${k + 1} has an invalid date “${d?.date}”.` });
    else if (map.has(d.date)) v.push({ code: "coverage", sev: "fail", msg: `${d.date} appears twice.` });
    else map.set(d.date, d);
  });
  const skelSet = new Set(skel.map((s) => s.date));
  for (const d of map.keys()) if (!skelSet.has(d)) v.push({ code: "coverage", sev: "fail", msg: `${d} is outside the trip (${trip.startDate} to ${trip.endDate}).` });
  const cap = KB.paceCap[trip.pace] * 60;
  for (const s of skel) {
    const day = map.get(s.date);
    if (!day) { v.push({ code: "coverage", sev: "fail", msg: `No plan for ${s.date} (${s.city}).` }); continue; }
    const items = arr(day.items);
    if (!items.length) v.push({ code: "coverage", sev: "warn", msg: `${s.date} has no activities.` });
    const parsed = [];
    items.forEach((it) => {
      const a = tm(it?.start), b = tm(it?.end);
      if (a == null || b == null) v.push({ code: "time", sev: "fail", msg: `${s.date}: “${it?.title}” has an invalid time (${it?.start}–${it?.end}).` });
      else if (b <= a) v.push({ code: "time", sev: "fail", msg: `${s.date}: “${it.title}” ends before it starts (${it.start}–${it.end}).` });
      else parsed.push({ a, b, it });
      if (it && it.cost != null && !(Number(it.cost) >= 0)) v.push({ code: "cost", sev: "warn", msg: `${s.date}: “${it.title}” has an invalid cost.` });
    });
    parsed.sort((x, y) => x.a - y.a);
    for (let i = 1; i < parsed.length; i++)
      if (parsed[i].a < parsed[i - 1].b) v.push({ code: "overlap", sev: "fail", msg: `${s.date}: “${parsed[i - 1].it.title}” (${parsed[i - 1].it.start}–${parsed[i - 1].it.end}) overlaps “${parsed[i].it.title}” (${parsed[i].it.start}–${parsed[i].it.end}).` });
    const load = parsed.filter((p) => p.it.type !== "transit" && p.it.type !== "rest").reduce((s2, p) => s2 + (p.b - p.a), 0);
    if (load > cap) v.push({ code: "load", sev: "fail", msg: `${s.date}: ${(load / 60).toFixed(1)} h of activities exceeds the ${trip.pace} limit of ${cap / 60} h.` });
    if (s.travel && !parsed.some((p) => p.it.type === "transit")) v.push({ code: "transit", sev: "fail", msg: `${s.date} is a travel day (${s.travel.from} → ${s.travel.to}) but has no transit item.` });
  }
  const c = itin.costs;
  if (!c || typeof c !== "object") v.push({ code: "cost", sev: "warn", msg: "No cost breakdown returned." });
  else for (const [k, val] of Object.entries(c)) if (!(Number(val) >= 0)) v.push({ code: "cost", sev: "warn", msg: `Cost “${k}” is not a valid amount.` });
  return v;
}

function autoFixItinerary(trip, itin, skel) {
  const fixes = [];
  const src = new Map(arr(itin?.days).filter((d) => d && D.parse(d.date) != null).map((d) => [d.date, d]));
  const cap = KB.paceCap[trip.pace] * 60;
  const pad = (n) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
  const days = skel.map((s) => {
    const day = src.get(s.date);
    if (!day) fixes.push(`Added an open day for ${s.date} (${s.city}).`);
    let items = arr(day?.items).map((it) => ({ ...it, a: tm(it?.start), b: tm(it?.end) }))
      .filter((it) => { const ok = it.a != null && it.b != null && it.b > it.a; if (!ok && it) fixes.push(`${s.date}: dropped “${it.title}” (invalid time).`); return ok; })
      .sort((x, y) => x.a - y.a);
    const kept = [];
    for (const it of items) {
      const prev = kept[kept.length - 1];
      if (prev && it.a < prev.b) {
        const len = it.b - it.a, na = prev.b, nb = prev.b + len;
        if (nb <= 23 * 60 + 30) { fixes.push(`${s.date}: moved “${it.title}” to ${pad(na)} to clear an overlap.`); it.a = na; it.b = nb; }
        else { fixes.push(`${s.date}: dropped “${it.title}” (no room after overlap).`); continue; }
      }
      kept.push(it);
    }
    let load = kept.filter((p) => p.type !== "transit" && p.type !== "rest").reduce((t, p) => t + (p.b - p.a), 0);
    while (load > cap) {
      const idx = [...kept].reverse().findIndex((p) => p.type === "sight" || p.type === "activity");
      if (idx < 0) break;
      const real = kept.length - 1 - idx, rm = kept.splice(real, 1)[0];
      load -= rm.b - rm.a;
      fixes.push(`${s.date}: removed “${rm.title}” to respect the ${trip.pace} pace.`);
    }
    if (s.travel && !kept.some((p) => p.type === "transit")) {
      const first = kept.length ? kept[0].a : 12 * 60;
      const b = Math.max(60, Math.min(first, 12 * 60)), a = Math.max(0, b - 180);
      kept.unshift({ a, b, title: `Travel ${s.travel.from} → ${s.travel.to}`, type: "transit", place: "", cost: null, auto: true });
      fixes.push(`${s.date}: inserted a transit block (${s.travel.from} → ${s.travel.to}); set exact times when booked.`);
    }
    return { date: s.date, items: kept.map(({ a, b, ...it }) => ({ ...it, start: pad(a), end: pad(b), type: ITEM_TYPES.includes(it.type) ? it.type : "activity" })) };
  });
  const costs = {};
  if (itin?.costs && typeof itin.costs === "object") for (const [k, val] of Object.entries(itin.costs)) { const n = costNum(val); if (n != null) costs[k] = n; }
  return { itin: { days, costs: Object.values(costs).some((v) => v > 0) ? costs : null, tips: arr(itin?.tips).map(String).slice(0, 8) }, fixes };
}

// models often send "₹6,000" or {amount: 6000} instead of a plain number
function costNum(v) {
  if (v && typeof v === "object") v = v.amount ?? v.total ?? v.value;
  if (typeof v === "string") v = v.replace(/,/g, "").match(/\d+(\.\d+)?/)?.[0];
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function budgetCheck(trip, itin) {
  const c = itin?.costs;
  if (!c) return { sev: "warn", msg: "No cost estimate available, so the budget could not be checked.", total: null };
  const total = Object.values(c).reduce((a, b) => a + Number(b || 0), 0);
  if (!trip.budget) return { sev: "warn", msg: `No budget set. Estimated total ${money(total, trip.currency)}.`, total };
  const people = trip.travelers.adults + trip.travelers.children;
  const cap = trip.budget.scope === "per_person" ? trip.budget.amount * people : trip.budget.amount;
  if (total <= cap) return { sev: "pass", msg: `Estimated ${money(total, trip.currency)} of ${money(cap, trip.currency)} (${Math.round((total / cap) * 100)}%).`, total, cap };
  return { sev: "warn", msg: `Estimated ${money(total, trip.currency)} is ${Math.round(((total - cap) / cap) * 100)}% over the ${money(cap, trip.currency)} budget.`, total, cap };
}

function money(n, cur) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  try { return new Intl.NumberFormat(cur === "INR" ? "en-IN" : "en", { style: "currency", currency: cur || "INR", maximumFractionDigits: 0 }).format(n); }
  catch { return `${cur || ""} ${Math.round(n).toLocaleString()}`; }
}

/* ---------------- 6. Verdict table ---------------- */
function worst(list) { return list.includes("fail") ? "fail" : list.includes("warn") ? "warn" : "pass"; }
function tripChecks(trip, sched, finalViol, budget, today) {
  const C = [];
  const byCode = (code) => finalViol.filter((x) => x.code === code);
  const push = (id, label, layer, items, passMsg) => {
    const sev = items.length ? worst(items.map((x) => x.sev)) : "pass";
    C.push({ id, label, layer, sev, detail: items.length ? items.map((x) => x.msg) : [passMsg] });
  };
  push("parse", "Request understood", "neural", trip.assumed.map((m) => ({ sev: "warn", msg: `Assumed: ${m}` })), "All required fields came from your request.");
  push("dates", "Dates resolve and are in the future", "symbolic", trip.issues, `${D.fmtY(trip.startDate)} → ${D.fmtY(trip.endDate)}, ${trip.nights} night(s).`);
  push("seq", "Stops run back-to-back", "symbolic", trip.fixes.map((m) => ({ sev: "warn", msg: `Corrected: ${m}` })), `${trip.stops.length} stop(s), no gaps or overlaps.`);
  push("dag", "Task graph is acyclic and ordered", "symbolic", sched.ok ? (sched.edgeViol || []).map((e) => ({ sev: "fail", msg: `Deadline order broken on edge ${e}` })) : [{ sev: "fail", msg: `Cycle among: ${sched.cycle.join(", ")}` }], `${sched.tasks.length} tasks; every prerequisite is due before its dependent starts.`);
  push("refs", "Every dependency exists", "symbolic", sched.badRefs.map((r) => ({ sev: "fail", msg: `Missing dependency ${r}` })), "All edges resolve.");
  if (sched.ok) {
    const inf = sched.tasks.filter((t) => t.status === "infeasible").map((t) => ({ sev: t.cond ? "warn" : "fail", msg: `“${t.title}” takes ~${t.effort} day(s) and cannot finish before departure on ${D.fmtY(trip.startDate)}.` }));
    const late = sched.tasks.filter((t) => t.status === "late").map((t) => ({ sev: "warn", msg: `“${t.title}” is behind the recommended lead time (ideally done by ${D.fmtY(t.due)}${t.tightenedBy ? `, set by ${t.tightenedBy}` : ""}); do it now.` }));
    const urgent = sched.tasks.filter((t) => t.status === "urgent").map((t) => ({ sev: "warn", msg: `“${t.title}” should start by ${D.fmtY(t.startBy)}.` }));
    push("deadlines", "Deadlines reachable from today", "symbolic", [...inf, ...late, ...urgent], `Earliest task starts ${D.fmtY(sched.tasks[0]?.startBy)}; nothing is late.`);
  }
  push("coverage", "Itinerary covers every day", "symbolic", byCode("coverage"), `${trip.nights + 1} day(s) planned.`);
  push("time", "No time conflicts", "symbolic", [...byCode("time"), ...byCode("overlap")], "All items have valid, non-overlapping times.");
  push("load", "Daily load fits the pace", "symbolic", byCode("load"), `≤ ${KB.paceCap[trip.pace]} active hours/day (${trip.pace}).`);
  push("transit", "Travel days include transit", "symbolic", byCode("transit"), "Every city change has a transit block.");
  C.push({ id: "budget", label: "Budget", layer: "symbolic", sev: budget.sev, detail: [budget.msg, ...byCode("cost").map((x) => x.msg)] });
  return C;
}

/* ---------------- 7. Offline fallback: rule parser + template ---------------- */
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function ruleParse(text, today) {
  const parts = text.split(/\n+|;|\balso\b|\bseparately\b/i).map((s) => s.replace(/^[\s,.:-]+/, "").trim())
    .filter((s) => /\bto\b|\bvisit/i.test(s) || /\d+\s*(nights?|days?)/i.test(s));
  const trips = (parts.length ? parts : [text]).map((p) => parseOne(p, today)).filter(Boolean);
  return { trips, assumptions: ["Parsed by the offline rule engine (no language model connected); review the fields."], questions: [] };
}
function parseOne(s, today) {
  const origin = /\bfrom\s+([A-Za-z][A-Za-z .'-]+?)(?=\s+(?:to|on|in|for|with|and)\b|[,.:]|$)/i.exec(s)?.[1]
    || /(?:^|[:,]\s*)([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?)\s+to\s+[A-Z]/.exec(s.replace(/^(?:two|three|\d+)\s+trips?\s*:?\s*/i, ""))?.[1];
  const destM = /\b(?:to|visit(?:ing)?)\s+([A-Za-z][A-Za-z ,.'-]+?)(?=\s+(?:for|on|from|in|with|under|budget|starting|next|this|around)\b|\s+\d|[.;]|$)/i.exec(s)
    || /^(?:a\s+trip\s+to\s+|trip\s+to\s+)?([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?)\b/.exec(s.replace(/^(?:two|three|\d+)\s+trips?\s*:?\s*/i, ""));
  if (!destM) return null;
  const cities = destM[1].split(/,|\band\b|\bthen\b/i).map((c) => c.trim()).filter((c) => c && c.length < 40);
  const dur = /(\d+)\s*(nights?|days?)/i.exec(s);
  let totalNights = dur ? (/night/i.test(dur[2]) ? +dur[1] : Math.max(1, +dur[1] - 1)) : null;
  let startDate = null;
  const ty = +today.slice(0, 4);
  const m1 = /(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:,?\s+(\d{4}))?/i.exec(s)
          || (() => { const m = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i.exec(s); return m ? [m[0], m[2], m[1], m[3]] : null; })();
  const rel = /\b(next|this)\s+(week|weekend|month)\b|\b(tomorrow|day after tomorrow)\b/i.exec(s);
  if (!m1 && rel) {
    const t0 = new Date(D.parse(today)), dow = t0.getUTCDay();
    if (/day after/i.test(rel[0])) startDate = D.add(today, 2);
    else if (/tomorrow/i.test(rel[0])) startDate = D.add(today, 1);
    else if (/weekend/i.test(rel[2] || "")) startDate = D.add(today, ((5 - dow + 7) % 7 || 7) + (/next/i.test(rel[1]) ? 7 : 0)); // Friday
    else if (/week/i.test(rel[2] || "")) startDate = D.add(today, ((1 - dow + 7) % 7 || 7)); // next Monday
    else if (/month/i.test(rel[2] || "")) { const y = t0.getUTCFullYear(), mo = t0.getUTCMonth() + (/next/i.test(rel[1]) ? 1 : 0); startDate = D.iso(Date.UTC(y, mo, /next/i.test(rel[1]) ? 1 : t0.getUTCDate() + 7)); }
  }
  if (!totalNights && /long weekend/i.test(s)) totalNights = 3;
  else if (!totalNights && /\bweekend\b/i.test(s)) totalNights = 2;
  if (!totalNights && /\ba week\b/i.test(s)) totalNights = 7;
  if (m1) {
    const mon = MONTHS[m1[2].slice(0, 3).toLowerCase()], day = +m1[1];
    let y = m1[3] ? +m1[3] : ty;
    let iso = `${y}-${String(mon + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (!m1[3] && D.parse(iso) != null && iso < today) iso = `${y + 1}${iso.slice(4)}`;
    if (D.parse(iso) != null) startDate = iso;
  } else {
    const iso = /(\d{4}-\d{2}-\d{2})/.exec(s)?.[1];
    const mo = /\b(mid|early|late|end of)?[\s-]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b(?:\s+(\d{4}))?/i.exec(s);
    if (D.parse(iso) != null) startDate = iso;
    else if (mo) {
      const mon = MONTHS[mo[2].slice(0, 3).toLowerCase()];
      const day = /mid/i.test(mo[1] || "") ? 15 : /late|end/i.test(mo[1] || "") ? 22 : 1;
      let y = mo[3] ? +mo[3] : ty;
      let cand = `${y}-${String(mon + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (!mo[3] && cand < today) cand = `${y + 1}${cand.slice(4)}`;
      if (D.parse(cand) != null) startDate = cand;
    }
  }
  const b = /(₹|rs\.?|inr|\$|usd|€|eur|£|gbp)\s*([\d,.]+)\s*(k|lakhs?|l\b)?/i.exec(s) || (() => { const m = /([\d,.]+)\s*(k|lakhs?)?\s*(inr|rupees|usd|dollars|eur|euros|gbp)/i.exec(s); return m ? [m[0], m[3], m[1], m[2]] : null; })();
  let budget = null;
  if (b) {
    let amt = parseFloat(b[2].replace(/,/g, ""));
    if (/^k/i.test(b[3] || "")) amt *= 1e3; if (/^l/i.test(b[3] || "")) amt *= 1e5;
    const sym = b[1].toLowerCase();
    const cur = /₹|rs|inr|rupee/.test(sym) ? "INR" : /\$|usd|dollar/.test(sym) ? "USD" : /€|eur/.test(sym) ? "EUR" : "GBP";
    budget = { amount: amt, currency: cur, scope: /per\s*(person|head)|each/i.test(s) ? "per_person" : "total" };
  }
  const ppl = /(\d+)\s*(?:people|adults|persons|of us|friends|pax)/i.exec(s);
  const kids = /(\d+)\s*(?:kids|children|child)/i.exec(s);
  const interestWords = ["beach", "food", "history", "museum", "nature", "hiking", "trek", "temple", "nightlife", "party", "club", "pub", "shopping", "art", "wildlife", "tea", "backwater", "photography", "architecture", "adventure", "rafting", "scuba", "diving", "heritage", "culture", "sightseeing"];
  const interests = interestWords.filter((w) => new RegExp(`\\b${w}`, "i").test(s));
  const per = totalNights ? Math.max(1, Math.floor(totalNights / cities.length)) : null;
  return {
    title: null,
    origin: { city: origin || null, country: null },
    stops: cities.map((c, i) => ({ city: c, country: null, nights: per ? (i === cities.length - 1 ? Math.max(1, totalNights - per * (cities.length - 1)) : per) : null, arriveBy: null })),
    startDate, endDate: null,
    travelers: { adults: ppl ? +ppl[1] : null, children: kids ? +kids[1] : 0 },
    budget, interests,
    pace: /relax|slow|chill/i.test(s) ? "relaxed" : /pack|fast|max/i.test(s) ? "packed" : "moderate",
    returnBy: null, constraints: [],
  };
}

function templateItinerary(trip, skel, highlights = []) {
  const people = trip.travelers.adults + trip.travelers.children;
  // per city: queues of shortlisted places by slot; each place is used once, in shortlist order
  const q = {};
  for (const h of highlights) {
    const c = (q[h.city.toLowerCase()] = q[h.city.toLowerCase()] || { day: [], food: [], night: [] });
    const slot = h.category === "food" ? "food" : h.category === "nightlife" ? "night" : "day";
    c[slot].push(...h.places.map((p) => ({ ...p, cost: h.currency === trip.currency ? Math.round(((p.min + p.max) / 2) * people) : null })));
  }
  const take = (city, slot) => q[city.toLowerCase()]?.[slot].shift();
  const item = (start, end, p, fallback, type) => p
    ? { start, end, title: p.name, type, place: p.area, cost: p.cost }
    : { start, end, title: fallback, type, place: "", cost: null };
  const days = skel.map((s) => {
    const items = [];
    const topic = (k) => trip.interests[k % Math.max(1, trip.interests.length)] || "main sights";
    if (s.travel) {
      items.push({ start: "08:00", end: "12:00", title: `Travel ${s.travel.from} → ${s.travel.to}`, type: "transit", place: "", cost: null });
      if (s.travel.to !== (trip.origin.city || "home")) {
        items.push({ start: "13:00", end: "14:00", title: `Check in, ${s.travel.to}`, type: "checkin", place: "", cost: null });
        items.push(item("17:00", "19:00", take(s.travel.to, "day"), `Walk around ${s.travel.to}`, "sight"));
      }
    } else {
      const night = take(s.city, "night");
      items.push(item("09:00", "12:00", take(s.city, "day"), `${s.city}: ${topic(0)}`, "sight"));
      items.push(item("12:30", "13:30", take(s.city, "food"), "Lunch", "food"));
      // a night out replaces the afternoon block so the day stays inside the pace cap
      if (!night) items.push(item("15:00", { relaxed: "17:00", moderate: "17:30", packed: "18:00" }[trip.pace] || "17:30", take(s.city, "day"), `${s.city}: ${topic(1)}`, "activity"));
      items.push(item("19:30", "20:30", take(s.city, "food"), "Dinner", "food"));
      if (night) items.push(item("21:30", "23:30", night, "Night out", "activity"));
    }
    return { date: s.date, items };
  });
  return { days, costs: null, tips: [highlights.some((h) => h.places.length)
    ? "Offline template: shortlisted places are scheduled with approximate costs; connect a language model for transport and stay estimates."
    : "Offline template: connect a language model for real places and cost estimates."] };
}

/* ---------------- 8. Prompts (neural layer contracts) ---------------- */
function interpretPrompt(text, today, base) {
  return `You are the INTERPRETATION layer of a neuro-symbolic travel planner. A deterministic engine will validate your JSON, so follow the schema exactly and output JSON only.

Today is ${D.dow(today)} ${today}. Resolve relative dates ("next Friday", "this Diwali", "in December") to ISO YYYY-MM-DD. A month without a year means its next future occurrence. If no date is implied, use null — never invent one.

If the text describes SEVERAL SEPARATE trips, return one entry per trip. A multi-city journey is ONE trip with several ordered stops.

Schema:
{"trips":[{
  "title": string|null,
  "origin": {"city": string|null, "country": string|null},
  "stops": [{"city": string, "country": string, "nights": integer|null, "startDate": "YYYY-MM-DD"|null, "endDate": "YYYY-MM-DD"|null, "arriveBy": "flight"|"train"|"bus"|"car"|"ferry"|null}],
  "startDate": "YYYY-MM-DD"|null, "endDate": "YYYY-MM-DD"|null,
  "returnBy": "flight"|"train"|"bus"|"car"|"ferry"|null,
  "travelers": {"adults": integer|null, "children": integer},
  "budget": {"amount": number|null, "currency": "ISO 4217 code"|null, "scope": "total"|"per_person"},
  "interests": [string], "pace": "relaxed"|"moderate"|"packed",
  "accommodation": string|null, "constraints": [string]
}],
"assumptions": [string], "questions": [string]}

Rules:
- country: full English country name for every city you can identify (e.g. "India", "Japan").
- nights: "5 days" means 4 nights; "a week" means 7 nights. If a total is given for a multi-city trip without a split, split it sensibly and list that in assumptions.
- budget.amount is a plain number: "50k" = 50000, "1.5 lakh" = 150000, "2L" = 200000.
- arriveBy: the mode used to reach that stop; pick the realistic mode if the user didn't say and note it in assumptions.
- Put anything you inferred in "assumptions" and anything that blocks a good plan in "questions". Keep both short.
${base ? `
The user is REFINING an existing plan. Current interpreted spec:
${JSON.stringify(base)}
Apply the user's change and return the COMPLETE updated spec. Keep every field they did not ask to change.` : ""}
USER REQUEST:
"""${text.slice(0, 6000)}"""`;
}

function placesPrompt(trip, gaps) {
  return `You are the PLACES layer of a neuro-symbolic travel planner. For each city and category below, list the 3 MOST POPULAR, well-established, currently operating places a visitor would go to. Output JSON only.

${gaps.map((g) => `- ${g.city}: ${g.category} (prices in ${g.currency})`).join("\n")}

Return:
{"places":[{"city":string,"category":string,"name":string,"area":string,"min":number,"max":number,"note":string}]}

Rules:
1. Exactly 3 places per city+category, using the city and category names exactly as given.
2. min and max: approximate price range PER PERSON for a typical visit (entry, cover charge, meal or activity), in the currency given, as plain numbers. Use 0 for free places.
3. note: one short practical line (what the price covers, best time, booking). No marketing.
4. Only real places you are confident exist. Fewer than 3 is better than inventing one.`;
}

function itineraryPrompt(trip, skel, highlights = []) {
  const people = trip.travelers.adults + trip.travelers.children;
  const cap = trip.budget ? (trip.budget.scope === "per_person" ? trip.budget.amount * people : trip.budget.amount) : null;
  const brief = { title: trip.title, origin: trip.origin.city, stops: trip.stops.map((s) => ({ city: s.city, country: s.country, nights: s.nights })), travelers: trip.travelers, interests: trip.interests, pace: trip.pace, accommodation: trip.accommodation, constraints: trip.constraints };
  const known = highlights.filter((h) => h.places.length).map((h) => `${h.city} ${h.category}: ${h.places.map((p) => `${p.name} (${p.area}; ${p.min}–${p.max} ${h.currency} pp)`).join("; ")}`);
  return `You are the ITINERARY layer of a neuro-symbolic travel planner. A symbolic engine has FIXED the day skeleton below; fill it, do not change it. A verifier will reject violations. Output JSON only.

Trip: ${JSON.stringify(brief)}
Day skeleton (return exactly these dates, in this order):
${JSON.stringify(skel)}
${known.length ? `
Shortlisted places with per-person price ranges (schedule these first, at sensible times of day; for each, item "cost" = midpoint of the range × ${people} people, converted to ${trip.currency} if needed):
${known.join("\n")}
` : ""}
Return:
{"days":[{"date":"YYYY-MM-DD","items":[{"start":"HH:MM","end":"HH:MM","title":string,"type":"transit"|"sight"|"food"|"activity"|"rest"|"checkin","place":string,"cost":number}]}],
 "costs":{"transport":number,"stay":number,"food":number,"activities":number,"local":number,"misc":number},
 "tips":[string]}

Hard constraints:
1. Exactly the skeleton dates. 24-hour HH:MM times, end after start, no overlapping items in a day, nothing after 23:30.
2. Any day with "travel" must contain a "transit" item for that journey (use the given mode, or the realistic one).
3. Active hours per day (all types except transit and rest) must be ≤ ${KB.paceCap[trip.pace]} (pace: ${trip.pace}).
4. All money in ${trip.currency}, for the whole group of ${people}. Item "cost" is the group cost of that item; "costs" is the full trip breakdown including transport and stays. Use realistic current prices.
5. ${cap ? `Stay within a total of ${cap} ${trip.currency} if at all possible; if not possible, still plan sensibly and explain the gap in tips.` : "No budget given: plan mid-range."}
6. Use real, specific, currently operating places in each city that match the interests. Respect opening hours. 3–6 items per full day.`;
}

function repairPrompt(prevJson, violations) {
  return `Your itinerary JSON was rejected by the symbolic verifier. Fix ONLY these violations and return the complete corrected JSON in the same schema, nothing else.

Violations:
${violations.map((v) => `- ${v.msg}`).join("\n")}

Previous JSON:
${JSON.stringify(prevJson).slice(0, 60000)}`;
}

if (typeof module !== "undefined") module.exports = { D, KB, normalizeSpec, daySkeleton, buildTasks, schedule, verifyItinerary, autoFixItinerary, costNum, budgetCheck, tripChecks, ruleParse, templateItinerary, interpretPrompt, itineraryPrompt, repairPrompt, placesPrompt, interestCategories, placeHighlights, placeGaps, normalizeModelPlaces, highlightsBudget, money, worst };
