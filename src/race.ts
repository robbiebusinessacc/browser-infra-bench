// Renders results/charts/race.gif: a real-time replay of the measured median
// throughput at 8 connections, one quadrant per browser, racing to 400 pages.
// It replays numbers from results/summary.json; it is not a screen recording.
//   npx tsx src/race.ts      (needs ffmpeg on PATH and `npx playwright-core install chromium-headless-shell`)
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const { meta, summary } = JSON.parse(await readFile(join(ROOT, 'results/summary.json'), 'utf8'));
const CONN = 8, PAGES = meta.trials.throughputPages as number;
const FPS = 15, RACE_S = 10, HOLD_S = 2.5;

const lanes = (meta.providers as any[]).map((p) => {
  const pps = summary[p.id].throughput.find((t: any) => t.concurrency === CONN).pagesPerSec as number;
  return { name: p.label.replace(' (baseline)', '').replace('Headless Chromium', 'Plain Chromium'), pps, muted: p.id === 'chromium' };
}).sort((a, b) => b.pps - a.pps);

const cols = 25, rowsN = Math.ceil(PAGES / cols);
const html = `<!doctype html><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; width: 880px; height: 600px; background: #1a1a19; color: #f0efec; font: 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; padding: 22px 24px; }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 4px; }
  .sub { color: #c3c2b7; font-size: 13px; display: flex; justify-content: space-between; }
  .clock { font-variant-numeric: tabular-nums; color: #f0efec; font-weight: 600; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px 28px; margin-top: 16px; }
  .lane .head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
  .lane .name { font-weight: 600; font-size: 15px; }
  .lane .rate { color: #c3c2b7; font-size: 12px; }
  .tiles { display: grid; grid-template-columns: repeat(${cols}, 1fr); gap: 2px; }
  .tiles i { height: 9px; border-radius: 2px; background: #2e2e2c; }
  .tiles i.on { background: #3987e5; }
  .muted .tiles i.on { background: #8a8982; }
  .foot { margin-top: 8px; font-size: 13px; font-variant-numeric: tabular-nums; display: flex; justify-content: space-between; color: #c3c2b7; }
  .foot b { color: #f0efec; font-weight: 600; }
</style>
<h1>Scraping ${PAGES} pages: real-time replay of measured throughput</h1>
<div class="sub"><span>Median verified pages per second at ${CONN} connections, 5 rounds. Each square is one page.</span><span class="clock" id="clock"></span></div>
<div class="grid">${lanes.map((l, i) => `<div class="lane${l.muted ? ' muted' : ''}"><div class="head"><span class="name">${l.name}</span><span class="rate">${l.pps < 100 ? l.pps.toFixed(1) : Math.round(l.pps)} pages/s</span></div>
<div class="tiles" id="t${i}">${'<i></i>'.repeat(PAGES)}</div><div class="foot"><span id="c${i}"></span><span id="d${i}"></span></div></div>`).join('')}</div>
<script>
  const lanes = ${JSON.stringify(lanes)}, PAGES = ${PAGES};
  window.setTime = (t) => {
    document.getElementById('clock').textContent = t.toFixed(1) + ' s';
    lanes.forEach((l, i) => {
      const n = Math.min(PAGES, Math.floor(l.pps * t));
      const tiles = document.getElementById('t' + i).children;
      for (let k = 0; k < PAGES; k++) tiles[k].className = k < n ? 'on' : '';
      document.getElementById('c' + i).innerHTML = '<b>' + n + '</b> / ' + PAGES + ' pages';
      const finish = PAGES / l.pps;
      document.getElementById('d' + i).innerHTML = n >= PAGES ? 'done in <b>' + finish.toFixed(finish < 10 ? 2 : 1) + ' s</b>' : (t >= ${RACE_S} ? 'would finish at ' + finish.toFixed(1) + ' s' : '');
    });
  };
</script>`;

const dir = await mkdtemp(join(tmpdir(), 'race-'));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 880, height: 600 } });
await page.setContent(html);
const frames = Math.round((RACE_S + HOLD_S) * FPS);
for (let f = 0; f < frames; f++) {
  await page.evaluate((t) => (window as any).setTime(t), Math.min(RACE_S, f / FPS));
  await page.screenshot({ path: join(dir, `f${String(f).padStart(4, '0')}.png`) });
}
await browser.close();

const out = join(ROOT, 'results/charts/race.gif');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(dir, 'f%04d.png'),
  '-filter_complex', '[0:v]split[a][b];[a]palettegen=max_colors=64:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle', out]);
await rm(dir, { recursive: true, force: true });
console.log(`wrote ${out} (${lanes.map((l) => `${l.name} ${l.pps.toFixed(1)}/s`).join(', ')})`);
