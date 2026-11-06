# Waypoint: project context for Claude Code

Neuro-symbolic travel planner (student ECE project). Single-page web app, no framework, no build tooling beyond `build.sh`.

## Architecture
- Neural layer (LLM): interprets free text into a typed trip spec (`interpretPrompt`), and fills a fixed day skeleton (`itineraryPrompt`). The LLM is never trusted directly.
- Symbolic layer (`engine.js`, pure functions, no DOM):
  - `normalizeSpec` validates/repairs LLM output (dates, stop chaining, border + currency inference, assumptions)
  - `KB` knowledge base: lead times, pace caps, city→country map, rules R1–R11
  - `buildTasks` + `schedule`: rules → task DAG → Kahn topo sort (cycle detection) → backward critical-path deadlines → status ok/urgent/late/infeasible
  - `verifyItinerary` → LLM repair (max 2 rounds via `repairPrompt`) → `autoFixItinerary` guarantees zero hard violations
  - `ruleParse` + `templateItinerary`: offline fallback when no LLM (the template schedules shortlisted places by name)
  - Places shortlist: `KB.categories` maps interests → nightlife/beaches/food/adventure/nature/sights; `KB.places` holds the curated top 3 per city × category with an approx. per-person price range in local currency. `placeHighlights` uses the KB first; only uncovered pairs (`placeGaps`) go to the LLM via `placesPrompt`, validated by `normalizeModelPlaces` and labelled "model, verify". `highlightsBudget` gives the visit-all range. Add destinations by extending `KB.places`.
- Runtime (`ui.js`): LLM adapter (Claude artifact runtime → OpenAI-compatible endpoint → offline), storage adapter (artifact db → Waypoint server account → localStorage), login page, PDF (print) / JSON downloads, pipeline orchestration, views.
- Server (`server.js`, Node built-ins only): serves index.html only (never data/ or sources) plus `/api/signup|login|logout|me` and `/api/plans/:id`. scrypt password hashes, HttpOnly SameSite=Strict session cookie (token stored as SHA-256), writes must be same-origin JSON, 5-failure login lockout. Data in `data/waypoint.json` (user accounts: don't commit or share). The frontend detects the server via `/api/me` answering 200/401; anything else falls back to browser storage, so artifact.html is unaffected.
- `shell.html`: markup + CSS (theme tokens on :root, dark mode via prefers-color-scheme).

## Workflow
- Edit `engine.js`, `ui.js`, `shell.html` only. Never hand-edit `index.html` or `artifact.html`.
- After any edit: `node build.js` (or `sh build.sh`; identical output). Regenerates index.html for local use, artifact.html for claude.ai.
- Tests: `node test.js` must end with `FAILS: 0`. UI test: `npm i jsdom@24 && node domtest.js`.
- Run locally: `node server.js`, open http://localhost:8000 (login page). `python -m http.server 8000` still works but skips login and saves to the browser only.
- Keep engine.js free of DOM/network code so it stays unit-testable in Node.

## Known state / next steps
- LLM endpoint is now local Ollama via its OpenAI-compatible API: http://localhost:11434/v1, model qwen2.5:7b, no key (the key is optional in `LLM.init`; no Authorization header is sent without one). These are the pre-filled defaults.
- Dev machine has no usable GPU (Intel iGPU), so Ollama runs on CPU: a full plan takes minutes. llama3.2:3b is the faster fallback.
- Gemini (gemini-3.8-flash) still works as a hosted alternative but returned 503 "high demand" when tested on 2026-10-29.
- Hosted-provider keys live in browser localStorage: fine for a local demo only. A public deployment needs a small backend proxy holding the key.
