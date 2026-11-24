// Agent-task track for Browserable. Browserable is an agent framework, not a
// browser, so it is scored on task success instead of the CDP workloads.
//
//   1. Start Browserable (see README.md in this folder) and add an LLM key in its dashboard.
//   2. BROWSERABLE_API_KEY=... node agent-track/run.mjs [--repeats 3]
//
// Each task has a known answer on a public scraping sandbox. A run passes when
// the agent's final output contains one of the expected strings.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const apiKey = process.env.BROWSERABLE_API_KEY;
const baseURL = process.env.BROWSERABLE_BASE_URL ?? 'http://localhost:2003/api/v1';
if (!apiKey) { console.error('Set BROWSERABLE_API_KEY (create one in the Browserable dashboard at http://localhost:2001).'); process.exit(1); }

const repeatsArg = process.argv.indexOf('--repeats');
const repeats = repeatsArg > 0 ? Number(process.argv[repeatsArg + 1]) : 3;
const { Browserable } = await import('browserable-js');
const client = new Browserable({ apiKey, baseURL });
const tasks = JSON.parse(await readFile(join(here, 'tasks.json'), 'utf8'));

const results = [];
for (const t of tasks) {
  for (let i = 0; i < repeats; i++) {
    const t0 = performance.now();
    const row = { id: t.id, attempt: i + 1, ok: false, seconds: 0, output: '', error: undefined };
    try {
      const created = await client.createTask({ task: t.task, agent: 'BROWSER_AGENT' });
      if (!created.success) throw new Error(`createTask failed: ${created.error}`);
      const run = await client.waitForRun(created.data.taskId);
      row.output = JSON.stringify(run.data ?? run).slice(0, 4000);
      const text = row.output.toLowerCase();
      row.ok = t.expect.some((e) => text.includes(e.toLowerCase()));
    } catch (e) {
      row.error = String(e.message ?? e).slice(0, 300);
    }
    row.seconds = (performance.now() - t0) / 1000;
    results.push(row);
    console.log(`${row.ok ? 'PASS' : 'FAIL'} ${t.id} #${i + 1} ${row.seconds.toFixed(0)}s ${row.error ?? ''}`);
  }
}

const out = join(here, '..', 'results', 'agent-track');
await mkdir(out, { recursive: true });
await writeFile(join(out, 'browserable.json'), JSON.stringify({ generatedAt: new Date().toISOString(), repeats, results }, null, 2));
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} runs passed. Wrote ${join(out, 'browserable.json')}`);
