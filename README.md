# Waypoint: neuro-symbolic travel planner

## Run locally
1. In this folder:  node build.js   then   node server.js
2. Open http://localhost:8000 and create an account (or log in). Plans save to your account; each user only sees their own.
   Accounts and plans are stored in data/waypoint.json. Delete that file to reset everything.
3. Open "Connect a language model", fill in endpoint + model (+ key for hosted providers), click "Save and test connection".
   It must say "Connected". If not, it shows the provider's exact error.

Endpoints (OpenAI-compatible):
  Ollama   http://localhost:11434/v1                                  qwen2.5:7b / llama3.2:3b  (default; no key, leave it blank)
  Gemini   https://generativelanguage.googleapis.com/v1beta/openai    gemini-3.8-flash  (key: aistudio.google.com; 2.5-flash is closed to new users)
  OpenAI   https://api.openai.com/v1                                  gpt-4o-mini       (needs billing credit)

Ollama setup (Windows):
  winget install Ollama.Ollama          (or the installer from ollama.com); it runs in the tray and serves on port 11434
  ollama pull qwen2.5:7b                ~4.7 GB; use llama3.2:3b if planning is too slow on CPU
  Optional, recommended: set OLLAMA_CONTEXT_LENGTH=8192 (System > Environment Variables), then restart Ollama,
  so long itinerary prompts aren't cut off. Browser calls from http://localhost:8000 are allowed by default;
  only set OLLAMA_ORIGINS if you serve the page from another host.

If the engine label shows "last call failed", the plan came from the offline parser, not the model.

Downloads (buttons under every plan):
  Download PDF   opens the print dialog with a clean copy of all trips; choose "Save as PDF"
  Download JSON  the full plan data (spec, tasks, itinerary, checks)

Without login: python -m http.server 8000 still works; plans are then saved in the browser only.

## Files
engine.js  pure logic: validation, knowledge rules, task DAG + scheduling, verifier, offline parser, prompts
ui.js      LLM + storage adapters, login, downloads, pipeline, views
shell.html markup + styles
server.js  login + per-user plan storage (Node, no dependencies); serves index.html
build.js   rebuilds index.html (local) and artifact.html (claude.ai); build.sh does the same

## Tests
node test.js                         engine logic (ends with FAILS: 0)
npm i jsdom@24 && node domtest.js    full page with fake LLMs: repair loop, API errors
