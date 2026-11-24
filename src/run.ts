// Benchmark runner.
//   npx tsx src/run.ts                      full run, all providers, 3 rounds
//   npx tsx src/run.ts --quick              smoke run (1 round, few trials)
//   npx tsx src/run.ts --providers steel,obscura --rounds 2 --only compat,fingerprint
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { docker, imageInfo, LIMITS, sleep, startFixtures, startProbe, stopProbe, rm, FIXTURES_NAME } from './docker.js';
import { byId, providers, start, stop, type Provider } from './providers.js';
import { rng, shuffle } from './stats.js';
import * as w from './workloads.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, def: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };

const quick = flag('quick');
const rounds = Number(opt('rounds', quick ? '1' : '5'));
const N = {
  sessions: Number(opt('sessions', quick ? '3' : '15')),
  pageLoads: Number(opt('page-loads', quick ? '3' : '15')),
  commands: Number(opt('commands', quick ? '30' : '200')),
  throughputPages: Number(opt('throughput-pages', quick ? '40' : '400')),
  concurrency: opt('concurrency', quick ? '1,4' : '1,4,8').split(',').map(Number),
  realWorld: Number(opt('real-world', quick ? '1' : '2')),
};
const selected: Provider[] = opt('providers', providers.map((p) => p.id).join(',')).split(',').map(byId);
const only = opt('only', 'session,pageload,latency,memory,compat,fingerprint,realworld,throughput').split(',');
const seed = Number(opt('seed', '20261124'));
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const outDir = join(ROOT, opt('out', quick ? 'results/quick' : 'results/raw'));

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | { failed: string }> {
  if (!only.includes(name)) return { failed: 'skipped' };
  const t0 = performance.now();
  try {
    const r = await fn();
    log(`    ${name} done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    return r;
  } catch (e) {
    log(`    ${name} FAILED: ${(e as Error).message.split('\n')[0]}`);
    return { failed: String((e as Error).message).split('\n')[0] };
  }
}

async function runProvider(p: Provider, round: number) {
  log(`  ${p.id}: starting container`);
  const startupMs = await start(p);
  await sleep(2000);
  const result: Record<string, unknown> = { provider: p.id, round, startupMs, startedAt: new Date().toISOString() };
  try {
    const v = await p.open();
    result.browserVersion = v.browser.version();
    await v.close();
    result.memory = await step('memory', () => w.memory(p));
    result.session = await step('session', () => w.sessionStart(p, N.sessions));
    if (only.includes('pageload') || only.includes('latency')) {
      const s = await p.open();
      try {
        result.pageload = await step('pageload', () => w.pageLoad(s, N.pageLoads));
        result.latency = await step('latency', () => w.commandLatency(s, N.commands));
      } finally { await s.close(); }
    }
    result.compat = await step('compat', () => w.compat(p));
    result.fingerprint = await step('fingerprint', () => w.fingerprint(p));
    result.realworld = await step('realworld', () => w.realWorld(p, N.realWorld));
    if (only.includes('throughput')) {
      // Fresh container per concurrency level so peak memory and CPU time belong to that level alone.
      const tp = [];
      for (const c of N.concurrency) {
        await stop(p); await start(p); await sleep(2000);
        const r = await step('throughput', () => w.throughput(p, c, N.throughputPages));
        tp.push('failed' in (r as object) ? { concurrency: c, ...(r as object) } : r);
      }
      result.throughput = tp;
    }
  } finally {
    result.logsTail = (await docker('logs', '--tail', '5', p.container.name).catch(() => '')).slice(-1500);
    await stop(p);
  }
  return result;
}

async function main() {
  await mkdir(outDir, { recursive: true });
  log(`providers: ${selected.map((p) => p.id).join(', ')} | rounds: ${rounds} | limits: ${LIMITS.cpus} CPU, ${LIMITS.memoryGb} GB`);
  await startFixtures();
  await startProbe();

  const require = createRequire(import.meta.url);
  const meta = {
    generatedAt: new Date().toISOString(),
    seed, rounds, trials: N, limits: LIMITS, only,
    host: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, memGb: Math.round(os.totalmem() / 2 ** 30), platform: `${os.platform()} ${os.release()}`, arch: os.arch() },
    docker: await docker('version', '--format', '{{.Server.Version}} ({{.Server.Os}}/{{.Server.Arch}})'),
    node: process.version,
    playwright: require('playwright-core/package.json').version,
    providers: await Promise.all(selected.map(async (p) => ({
      id: p.id, label: p.label, engine: p.engine, license: p.license, sessionSemantics: p.sessionSemantics, ...(await imageInfo(p.container.image)),
    }))),
    pageKinds: w.pageKinds.map(({ id, describe }) => ({ id, describe })),
    fingerprintSignals: w.fingerprintSignals,
    sites: w.sites.map(({ id, url }) => ({ id, url })),
  };
  await writeFile(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));

  const random = rng(seed);
  for (let round = 1; round <= rounds; round++) {
    const order = shuffle(selected, random);
    log(`round ${round}/${rounds}: ${order.map((p) => p.id).join(' -> ')}`);
    for (const p of order) {
      const r = await runProvider(p, round).catch((e) => ({ provider: p.id, round, fatal: String(e.message).split('\n')[0] }));
      if ('fatal' in r) { log(`  ${p.id} FATAL: ${r.fatal}`); await stop(p); }
      await writeFile(join(outDir, `${p.id}.round${round}.json`), JSON.stringify(r, null, 2));
      await sleep(2000);
    }
  }
  await rm(FIXTURES_NAME);
  await stopProbe();
  log(`done -> ${outDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
