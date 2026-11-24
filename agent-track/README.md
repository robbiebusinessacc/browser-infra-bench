# Agent track: Browserable

**Status: not run yet.** It needs an LLM API key, and none was available when the browser benchmark ran. The runner in this folder has not been executed against a live Browserable instance, so treat it as a draft.

## Why a separate track

Browserable is an agent framework. You give it a task in English, an LLM decides what to click, and a browser underneath does it. It has no CDP endpoint of its own to benchmark, so the workloads in the main README do not apply. The fair measure for it is task success.

## What is here

- `tasks.json`: 10 tasks on public scraping sandboxes (books.toscrape.com, quotes.toscrape.com, scrapethissite.com). Each has a known answer, checked by hand on 2026-11-24.
- `run.mjs`: creates each task through the `browserable-js` SDK, waits for the run, and passes it if the output contains an expected answer. Default is 3 attempts per task.

## How to run it

1. Start Browserable: `npx browserable`, or clone https://github.com/browserable/browserable and run `docker-compose -f deployment/docker-compose.dev.yml up`. It starts nine services (API, UI, MongoDB, Redis, MinIO, Postgres and others).
2. Open http://localhost:2001/dash/@admin/settings and add one LLM key (OpenAI, Claude or Gemini). Its compose file points at a local browser service by default, so no hosted browser key should be needed.
3. Create a Browserable API key in the dashboard.
4. `npm i browserable-js && BROWSERABLE_API_KEY=... node agent-track/run.mjs`

Results land in `results/agent-track/browserable.json`.

## Caveats to keep in mind when reading results

- The score depends heavily on which LLM you plug in. Record the model with the result.
- Ten tasks is a smoke test, not a WebVoyager replacement. Browserable's own README reports 90.4% on WebVoyager; this track does not try to reproduce that.
- The repository's last commit was on 2025-08-27.
