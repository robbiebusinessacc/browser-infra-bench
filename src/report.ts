// Turns results/raw/*.json into results/summary.json, SVG charts and the
// generated tables in RESULTS.md. Everything in the README comes from here.
//   npx tsx src/report.ts [rawDir]
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { median, sortNum, summarize, type Summary } from './stats.js';
import { barPanels, type Panel } from './svg.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const rawDir = join(ROOT, process.argv[2] ?? 'results/raw');
const outDir = join(rawDir, '..');
const chartDir = join(outDir, 'charts');

interface Trial { ok: boolean; ms: number; error?: string }
type Round = Record<string, any>;

const meta = JSON.parse(await readFile(join(rawDir, 'meta.json'), 'utf8'));
const order: string[] = meta.providers.map((p: any) => p.id);
const label = (id: string) => meta.providers.find((p: any) => p.id === id).label as string;
const short = (id: string) => label(id).replace(' (baseline)', '').replace('Headless Chromium', 'Plain Chromium');

const rounds: Record<string, Round[]> = Object.fromEntries(order.map((id) => [id, []]));
for (const f of (await readdir(rawDir)).filter((f) => /\.round\d+\.json$/.test(f)).sort()) {
  const r = JSON.parse(await readFile(join(rawDir, f), 'utf8'));
  if (!r.fatal) rounds[r.provider]?.push(r);
}

const good = (x: any) => x && !x.failed;
const pool = (id: string, pick: (r: Round) => Trial[] | undefined): Trial[] => rounds[id].flatMap((r) => pick(r) ?? []);
interface Timing extends Summary { ok: number; total: number; firstError?: string }
const timing = (ts: Trial[]): Timing => {
  const ok = ts.filter((t) => t.ok);
  return { ...summarize(ok.map((t) => t.ms)), ok: ok.length, total: ts.length, firstError: ts.find((t) => !t.ok)?.error };
};
const med = (xs: number[]) => median(xs.filter(Number.isFinite));
const range = (xs: number[]): [number, number] => { const s = sortNum(xs.filter(Number.isFinite)); return [s[0], s[s.length - 1]]; };

// ---- aggregate --------------------------------------------------------------
const summary: Record<string, any> = {};
for (const id of order) {
  const rs = rounds[id];
  const s: any = { rounds: rs.length, browserVersion: rs[0]?.browserVersion, startupMs: med(rs.map((r) => r.startupMs)) };
  s.session = {
    connect: timing(pool(id, (r) => good(r.session) && r.session.connect)),
    firstPage: timing(pool(id, (r) => good(r.session) && r.session.firstPage)),
  };
  s.pageload = Object.fromEntries(meta.pageKinds.map((k: any) => [k.id, timing(pool(id, (r) => good(r.pageload) && r.pageload[k.id]))]));
  s.latency = {
    evaluate: timing(pool(id, (r) => good(r.latency) && r.latency.evaluate)),
    query: timing(pool(id, (r) => good(r.latency) && r.latency.query)),
  };
  const mem = rs.map((r) => r.memory).filter(good);
  s.memory = Object.fromEntries(['idle', 'onePage', 'tenPages'].map((k) => [k, {
    memMb: med(mem.map((m) => m[k].memMb)), range: range(mem.map((m) => m[k].memMb)), pids: med(mem.map((m) => m[k].pids)),
  }]));
  s.memory.tabsOpened = Math.min(...mem.map((m) => m.tabsOpened));
  s.throughput = meta.trials.concurrency.map((c: number) => {
    const t = rs.map((r) => (r.throughput ?? []).find((x: any) => x.concurrency === c)).filter((x) => x && !x.failed);
    return {
      concurrency: c, runs: t.length,
      pagesPerSec: med(t.map((x) => x.pagesPerSec)), range: range(t.map((x) => x.pagesPerSec)),
      ok: t.reduce((a, x) => a + x.ok, 0), total: t.reduce((a, x) => a + x.total, 0),
      peakMemMb: med(t.map((x) => x.peakMemMb)), cpuMsPerPage: med(t.map((x) => x.cpuMsPerPage)),
      firstError: t.flatMap((x) => x.errors)[0],
    };
  });
  const compatRuns = rs.map((r) => r.compat).filter(Array.isArray);
  s.compat = (compatRuns[0] ?? []).map((c: any) => {
    const all = compatRuns.map((run) => run.find((x: any) => x.id === c.id));
    const passes = all.filter((x) => x?.ok).length;
    return { id: c.id, group: c.group, passes, runs: all.length, status: passes === all.length ? 'pass' : passes === 0 ? 'fail' : 'flaky', error: all.find((x) => x && !x.ok)?.error };
  });
  s.compatTotals = { pass: 0, flaky: 0, fail: 0, total: s.compat.length };
  for (const c of s.compat) s.compatTotals[c.status]++;
  const fps = rs.map((r) => r.fingerprint).filter(good);
  s.fingerprint = Object.fromEntries(meta.fingerprintSignals.map((sig: any) => [sig.id, fps.filter((f) => f.exposed[sig.id]).length]));
  s.fingerprintRuns = fps.length;
  s.fingerprintExposed = Object.values(s.fingerprint).filter((n) => (n as number) > 0).length;
  s.fingerprintRaw = fps[0]?.raw;
  s.realworld = Object.fromEntries((meta.sites ?? []).map((site: any) => [site.id, timing(pool(id, (r) => good(r.realworld) && r.realworld[site.id]))]));
  summary[id] = s;
}
await mkdir(chartDir, { recursive: true });
await writeFile(join(outDir, 'summary.json'), JSON.stringify({ meta, summary }, null, 2));

// ---- charts -----------------------------------------------------------------
const fmtMs = (v: number) => (!Number.isFinite(v) ? 'n/a' : v < 10 ? v.toFixed(1) : v < 100 ? v.toFixed(0) : Math.round(v).toLocaleString('en-US'));
const fmtN = (v: number) => (!Number.isFinite(v) ? 'n/a' : v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString('en-US'));
const rowsOf = (get: (id: string) => { value: number; lo?: number; hi?: number; note?: string }) =>
  order.map((id) => ({ label: short(id), muted: id === 'chromium', ...get(id) }));
const t2row = (t: Timing) => ({ value: t.median, lo: t.ci95[0], hi: t.ci95[1], note: t.ok < t.total ? `${t.ok}/${t.total} ok` : undefined });

async function chart(name: string, title: string, subtitle: string, panels: Panel[], opts: { cols?: number; legend?: string[] } = {}) {
  for (const mode of ['light', 'dark'] as const)
    await writeFile(join(chartDir, `${name}-${mode}.svg`), barPanels({ title, subtitle, panels, mode, ...opts }));
}

await chart('session-start', 'Time to first page', 'Open a new session and load one page. Median ms, lower is better. Whiskers: 95% CI of the median.',
  [{ rows: rowsOf((id) => t2row(summary[id].session.firstPage)), fmt: fmtMs }]);
await chart('page-load', 'Page load by page type', 'Navigate and verify the content is there. Median ms, lower is better. Each panel has its own scale.',
  meta.pageKinds.map((k: any) => ({ heading: k.describe, rows: rowsOf((id) => t2row(summary[id].pageload[k.id])), fmt: fmtMs })), { cols: 2 });
await chart('throughput', 'Scraping throughput', 'Verified pages per second at 1, 4 and 8 concurrent connections. Median of rounds, higher is better.',
  [{ rows: order.map((id) => ({ label: short(id), series: summary[id].throughput.map((t: any) => ({ value: t.pagesPerSec, lo: t.range[0], hi: t.range[1] })) })), fmt: fmtN }],
  { legend: meta.trials.concurrency.map((c: number) => `${c} connection${c > 1 ? 's' : ''}`) });
await chart('memory', 'Container memory', 'Working set in MB, lower is better. Median of rounds; whiskers show min and max.',
  [['idle', 'Idle, no session'], ['onePage', 'One tab open'], ['tenPages', 'Ten tabs open']].map(([k, heading]) => ({
    heading, fmt: fmtN, rows: rowsOf((id) => ({ value: summary[id].memory[k].memMb, lo: summary[id].memory[k].range[0], hi: summary[id].memory[k].range[1] })),
  })), { cols: 3 });
await chart('cpu-per-page', 'CPU cost per scraped page', 'Container CPU milliseconds per verified page at 4 connections. Lower is better.',
  [{ rows: rowsOf((id) => ({ value: summary[id].throughput.find((t: any) => t.concurrency === 4)?.cpuMsPerPage })), fmt: fmtMs }]);
await chart('compat', 'Playwright compatibility', `Checks passed in every round, out of ${summary[order[0]].compatTotals.total}. Higher is better.`,
  [{ rows: rowsOf((id) => ({ value: summary[id].compatTotals.pass, note: summary[id].compatTotals.flaky ? `${summary[id].compatTotals.flaky} flaky` : undefined })), fmt: (v) => String(v), max: summary[order[0]].compatTotals.total }]);
await chart('fingerprint', 'Automation signals exposed by default', `Of ${meta.fingerprintSignals.length} well-known headless or automation tells. Lower is better.`,
  [{ rows: rowsOf((id) => ({ value: summary[id].fingerprintExposed })), fmt: (v) => String(v), max: meta.fingerprintSignals.length }]);

// ---- markdown ---------------------------------------------------------------
const L: string[] = [];
const table = (head: string[], rows: (string | number)[][], textual = false) => {
  L.push(`| ${head.join(' | ')} |`, `| ${head.map((_, i) => (i && !textual ? '---:' : '---')).join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`), '');
};
const cell = (t: Timing) => (t.total === 0 ? 'not run' : t.ok === 0 ? `failed (0/${t.total})` : `${fmtMs(t.median)}${t.ok < t.total ? ` (${t.ok}/${t.total} ok)` : ''}`);
const cellCi = (t: Timing) => (t.ok === 0 ? cell(t) : `${fmtMs(t.median)} [${fmtMs(t.ci95[0])}, ${fmtMs(t.ci95[1])}]`);
const best = (vals: number[], lower = true) => { const f = vals.filter(Number.isFinite); return lower ? Math.min(...f) : Math.max(...f); };
const bold = (text: string, isBest: boolean) => (isBest ? `**${text}**` : text);
const heads = ['', ...order.map(short)];

L.push('<!-- Generated by src/report.ts. Do not edit by hand. -->', '# Full results', '',
  `Run finished ${meta.generatedAt.slice(0, 10)}. ${meta.rounds} rounds, provider order shuffled each round (seed ${meta.seed}).`,
  `Every container was limited to ${meta.limits.cpus} CPUs and ${meta.limits.memoryGb} GB. Host: ${meta.host.cpu}, ${meta.host.cores} cores, ${meta.host.memGb} GB, Docker ${meta.docker}.`,
  `Client: Playwright ${meta.playwright} on Node ${meta.node}, connecting with \`connectOverCDP\`.`, '',
  'Times are medians in milliseconds. Square brackets are the 95% bootstrap confidence interval of the median. Bold marks the best value in a row.', '');

L.push('## What was tested', '');
table(['Browser', 'Engine', 'Reports itself as', 'Image', 'Image size', 'License'], meta.providers.map((p: any) =>
  [p.label, p.engine, summary[p.id].browserVersion ?? '?', `\`${p.image}\`<br>\`${String(p.digest).split('@')[1]?.slice(0, 19) ?? ''}\``, `${p.sizeMb.toLocaleString('en-US')} MB`, p.license]), true);
L.push('What "opening a session" means for each:', '', ...meta.providers.map((p: any) => `- **${p.label}:** ${p.sessionSemantics}`), '');

L.push('## Session start', '');
{
  const rowsDef: [string, (id: string) => Timing][] = [['WebSocket connected', (id) => summary[id].session.connect], ['First page loaded', (id) => summary[id].session.firstPage]];
  table(heads, [
    ['Container start to ready', ...order.map((id) => fmtMs(summary[id].startupMs))],
    ...rowsDef.map(([name, get]) => { const b = best(order.map((id) => get(id).median)); return [name, ...order.map((id) => bold(cellCi(get(id)), get(id).median === b))]; }),
    ['p95, first page loaded', ...order.map((id) => fmtMs(summary[id].session.firstPage.p95))],
  ]);
}

L.push('## Page load', '');
table(heads, meta.pageKinds.map((k: any) => {
  const b = best(order.map((id) => summary[id].pageload[k.id].median));
  return [k.describe, ...order.map((id) => bold(cellCi(summary[id].pageload[k.id]), summary[id].pageload[k.id].median === b))];
}));

L.push('## Command round trip', '', 'One CDP command on an already-open page, 20 warm-up calls discarded.', '');
table(heads, [['`page.evaluate("1+1")`', 'evaluate'], ['`locator("p").count()`', 'query']].map(([name, k]) => {
  const b = best(order.map((id) => summary[id].latency[k].median));
  return [name, ...order.map((id) => bold(`${summary[id].latency[k].median.toFixed(2)} (p95 ${summary[id].latency[k].p95.toFixed(2)})`, summary[id].latency[k].median === b))];
}));

L.push('## Throughput', '', `${meta.trials.throughputPages} distinct pages per run, one fresh tab per page, every extraction verified against a per-page token. A fresh container is started for each concurrency level.`, '');
for (const [title, get, lower] of [
  ['Verified pages per second (min to max across rounds)', (t: any) => `${fmtN(t.pagesPerSec)} (${fmtN(t.range[0])} to ${fmtN(t.range[1])})`, false],
  ['Peak container memory during the run, MB', (t: any) => fmtN(t.peakMemMb), true],
  ['Container CPU milliseconds per page', (t: any) => fmtMs(t.cpuMsPerPage), true],
  ['Pages that returned correct data', (t: any) => `${t.ok}/${t.total}`, null],
] as [string, (t: any) => string, boolean | null][]) {
  L.push(`**${title}**`, '');
  table(['Connections', ...order.map(short)], meta.trials.concurrency.map((c: number, i: number) => {
    const key = title.startsWith('Verified') ? 'pagesPerSec' : title.startsWith('Peak') ? 'peakMemMb' : 'cpuMsPerPage';
    const b = lower === null ? NaN : best(order.map((id) => summary[id].throughput[i][key]), lower);
    return [c, ...order.map((id) => bold(get(summary[id].throughput[i]), summary[id].throughput[i][key] === b))];
  }));
}

L.push('## Memory', '', 'Container working set (memory in use minus inactive page cache), read from the kernel\'s cgroup counters. Median of rounds, with min to max.', '');
table(heads, [['idle', 'Idle, no session'], ['onePage', 'One tab open'], ['tenPages', 'Ten tabs open (2,000-row tables)']].map(([k, name]) => {
  const b = best(order.map((id) => summary[id].memory[k].memMb));
  return [name, ...order.map((id) => bold(`${fmtN(summary[id].memory[k].memMb)} MB (${fmtN(summary[id].memory[k].range[0])} to ${fmtN(summary[id].memory[k].range[1])})`, summary[id].memory[k].memMb === b))];
}).concat([['Processes and threads, ten tabs', ...order.map((id) => String(summary[id].memory.tenPages.pids))]]));

L.push('## Compatibility', '', `${summary[order[0]].compatTotals.total} checks driven through stock Playwright, each with a fixed expected result, repeated every round. A check counts as passed only if it passed in every round; "flaky" means it passed in some rounds.`, '');
table(heads, [
  ['Passed every round', ...order.map((id) => `${summary[id].compatTotals.pass}/${summary[id].compatTotals.total}`)],
  ['Flaky', ...order.map((id) => summary[id].compatTotals.flaky)],
  ['Failed every round', ...order.map((id) => summary[id].compatTotals.fail)],
]);
const groups = [...new Set(summary[order[0]].compat.map((c: any) => c.group))] as string[];
table(['Passed every round, by area', ...order.map(short)], groups.map((g) => [g, ...order.map((id) => {
  const cs = summary[id].compat.filter((c: any) => c.group === g);
  return `${cs.filter((c: any) => c.status === 'pass').length}/${cs.length}`;
})]));
L.push('Every check that did not pass everywhere:', '');
const mark = (c: any) => (c.status === 'pass' ? 'pass' : c.status === 'fail' ? '**fail**' : `flaky (${c.passes}/${c.runs})`);
table(['Check', ...order.map(short)], summary[order[0]].compat
  .filter((c: any) => order.some((id) => summary[id].compat.find((x: any) => x.id === c.id)?.status !== 'pass'))
  .map((c: any) => [`\`${c.id}\``, ...order.map((id) => mark(summary[id].compat.find((x: any) => x.id === c.id)))]));
L.push('<details><summary>Error message for each failure</summary>', '');
for (const id of order) {
  const bad = summary[id].compat.filter((c: any) => c.status !== 'pass');
  if (!bad.length) continue;
  L.push(`**${label(id)}**`, '', ...bad.map((c: any) => `- \`${c.id}\`: ${String(c.error).replace(/\|/g, '\\|')}`), '');
}
L.push('</details>', '');

L.push('## Automation signals', '', 'Which well-known "this browser is automated or headless" signals each default configuration shows to a page. Measured on the local fixture site only. This is a fingerprint self-check, not a test against any anti-bot product.', '');
table(['Signal', ...order.map(short)], [
  ...meta.fingerprintSignals.map((sig: any) => [sig.describe, ...order.map((id) => (summary[id].fingerprint[sig.id] > 0 ? 'exposed' : '-'))]),
  ['**Total exposed**', ...order.map((id) => `**${summary[id].fingerprintExposed}/${meta.fingerprintSignals.length}**`)],
]);
table(['Reported value', ...order.map(short)], [['User-Agent', 'ua'], ['WebGL renderer', 'webgl'], ['navigator.platform', 'platform'], ['UA client-hint brands', 'brands']].map(([name, k]) =>
  [name, ...order.map((id) => `\`${String(summary[id].fingerprintRaw?.[k] || '(none)').slice(0, 120)}\``)]), true);

if (meta.sites?.length) {
  L.push('## Real sites', '', 'A content assertion on each of seven public pages. Timings include the public internet from one location, so read them as context, not as a ranking. The result that matters is whether the assertion held.', '');
  table(['Site', ...order.map(short)], meta.sites.map((s: any) => [s.id, ...order.map((id) => {
    const t: Timing = summary[id].realworld[s.id];
    return t.total === 0 ? 'not run' : `${t.ok}/${t.total} ok${t.ok ? `, ${fmtMs(t.median)} ms` : ''}`;
  })]));
  const fails = order.flatMap((id) => meta.sites.filter((s: any) => summary[id].realworld[s.id].firstError).map((s: any) => `- ${short(id)}, ${s.id}: ${summary[id].realworld[s.id].firstError}`));
  if (fails.length) L.push('Failures:', '', ...fails, '');
}

await writeFile(join(outDir, 'RESULTS.md'), L.join('\n'));
console.log(`wrote ${join(outDir, 'summary.json')}, RESULTS.md and ${chartDir}/*.svg`);
