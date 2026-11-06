const { JSDOM } = require("jsdom");
const fs = require("fs");
const html = fs.readFileSync(__dirname + "/index.html", "utf8");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function session(name, fakeClaude) {
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "https://example.test/",
    beforeParse(w) {
      w.HTMLFormElement.prototype.requestSubmit = function () { this.dispatchEvent(new w.Event("submit", { cancelable: true })); };
      w.addEventListener("error", (e) => console.log(name, "PAGE ERROR", e.message));
      if (fakeClaude) w.claude = fakeClaude;
    } });
  const w = dom.window, $ = (s) => w.document.querySelector(s);
  await wait(300);
  return { w, $ };
}

(async () => {
  // A) no LLM, local storage
  let { w, $ } = await session("A");
  console.log("A example verdict:", $(".verdict")?.textContent, "| engine:", $("#engine").textContent);
  console.log("A example checks:", [...w.document.querySelectorAll(".tabs button")].map((b) => b.textContent.trim()).join(" | "));
  $("#q").value = "Two trips: from Delhi to Jaipur and Udaipur for 5 days on 14 Dec with 3 adults, relaxed; also Rishikesh for 3 nights on Feb 6 for rafting, 2 adults, ₹25k";
  $("#form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await wait(500);
  console.log("A trace:", [...w.document.querySelectorAll("#trace li")].map((l) => l.className + ":" + (l.querySelector(".tn")?.textContent || "")).join("\n   "));
  console.log("A trips tabs:", [...w.document.querySelectorAll(".trips button")].map((b) => b.textContent).join(" / "));
  console.log("A saved:", $("#saved").textContent.trim().slice(0, 120));
  for (const t of ["tasks", "verify", "budget", "spec"]) { $(`[data-tab="${t}"]`).click(); if (!$(".tabpane").innerHTML.length) console.log("EMPTY TAB", t); }
  $('[data-tab="tasks"]').click();
  const cb = $("input[data-task]"); cb.checked = true; cb.dispatchEvent(new w.Event("change", { bubbles: true }));
  await wait(900);
  console.log("A done saved:", JSON.stringify(Object.values(JSON.parse(w.localStorage.getItem("wp.plans")))[0].done));

  // B) fake Claude with a sloppy model: wrong dates + overlaps first, fixes on repair
  let calls = 0;
  const fake = {
    use: async (n) => {
      if (n === "sample") {
        const s = async () => ({ text: "" });
        s.json = async (prompt) => {
          calls++;
          if (prompt.includes("INTERPRETATION")) return { trips: [{ origin: { city: "Bengaluru", country: "India" }, stops: [{ city: "Tokyo", country: "Japan", nights: 4, arriveBy: "flight" }, { city: "Kyoto", country: "Japan", nights: 3, arriveBy: "train", startDate: "2027-03-30" }], startDate: "2027-03-28", returnBy: "flight", travelers: { adults: 1, children: 0 }, budget: { amount: 250000, currency: "INR", scope: "total" }, interests: ["food"], pace: "packed" }], assumptions: ["Return from Osaka KIX assumed via Kyoto"], questions: [] };
          const skel = JSON.parse(prompt.match(/\[\{"date"[\s\S]*?\}\]\n/)?.[0] || "[]");
          if (prompt.includes("ITINERARY")) return { days: skel.slice(0, -1).map((d) => ({ date: d.date, items: [{ start: "09:00", end: "11:00", title: "A", type: "sight" }, { start: "10:00", end: "12:00", title: "B", type: "food" }] })), costs: { transport: 90000, stay: 80000, food: 30000 } };
          if (prompt.includes("rejected")) { const prev = JSON.parse(prompt.split("Previous JSON:\n")[1]); return { ...prev, days: prev.days.map((d) => ({ ...d, items: [{ start: "07:00", end: "10:00", title: "Train/flight", type: "transit" }, { start: "11:00", end: "13:00", title: "Sight", type: "sight" }] })) }; }
        };
        return s;
      }
      return null;
    },
  };
  ({ w, $ } = await session("B", fake));
  console.log("B engine:", $("#engine").textContent);
  $("#q").value = "Tokyo and Kyoto";
  $("#form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await wait(600);
  console.log("B calls:", calls, "verdict:", $(".verdict")?.textContent);
  console.log("B trace:", [...w.document.querySelectorAll("#trace li")].map((l) => l.className + ":" + (l.querySelector(".tn")?.textContent || "")).join("\n   "));
  $('[data-tab="verify"]').click();
  console.log("B checks:", [...w.document.querySelectorAll(".ck")].map((c) => c.className.split(" ")[1] + " " + c.querySelector(".ckl").textContent).join(" | "));
  console.log("B log:", $(".log").textContent);
  $('[data-tab="itin"]').click();
  console.log("B days:", w.document.querySelectorAll(".day").length, "board:", $(".board").textContent.replace(/\s+/g, " "));
  // C) OpenAI-compatible endpoint returning 429 quota, then a working one
  const mk = (status, body) => async () => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
  ({ w, $ } = await session("C", null));
  w.localStorage.setItem("wp.llm", JSON.stringify({ endpoint: "https://api.openai.com/v1", model: "gpt-4o-mini", key: "sk-x" }));
  w.fetch = mk(429, { error: { message: "You exceeded your current quota, please check your plan and billing details." } });
  $("#cfgEp").value = "https://api.openai.com/v1"; $("#cfgKey").value = "sk-x"; $("#cfgModel").value = "gpt-4o-mini";
  $("#saveCfg").click(); await wait(300);
  console.log("C test:", $("#cfgOut").textContent);
  $("#q").value = "Chennai to Ooty for 3 nights in Dec, 2 adults, ₹5,000 total";
  $("#form").dispatchEvent(new w.Event("submit", { cancelable: true })); await wait(400);
  console.log("C note:", $("#note").textContent);
  console.log("C board:", $(".board").textContent.replace(/\s+/g, " "), "| budget:", [...w.document.querySelectorAll(".facts dd")].map((d) => d.textContent).join(", "));
  w.fetch = async (u, o) => { const p = JSON.parse(o.body).messages[0].content; const c = p.includes('{"ok": true}') ? { ok: true } : p.includes("INTERPRETATION") ? { trips: [{ origin: { city: "Chennai", country: "India" }, stops: [{ city: "Ooty", country: "India", nights: 3, arriveBy: "bus" }], startDate: "2026-12-05", travelers: { adults: 2 }, budget: { amount: 5000, currency: "INR" }, pace: "relaxed" }] } : { days: [], costs: { transport: 2400, stay: 6000, food: 3000 } };
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(c) } }] }) }; };
  $("#saveCfg").click(); await wait(300); console.log("C test2:", $("#cfgOut").textContent);
  $("#form").dispatchEvent(new w.Event("submit", { cancelable: true })); await wait(500);
  $('[data-tab="verify"]').click();
  console.log("C2 verdict:", $(".verdict").textContent, "|", [...w.document.querySelectorAll(".ck")].filter((c) => !c.classList.contains("c-pass")).map((c) => c.querySelector(".ckl").textContent).join(", "));
  process.exit(0);
})();
