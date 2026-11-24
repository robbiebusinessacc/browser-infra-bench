// Thin wrappers around the docker CLI. Every browser under test runs in its own
// container on the same bridge network with identical CPU and memory limits.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const exec = promisify(execFile);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const NETWORK = 'bench-net';
export const FIXTURES_NAME = 'bench-fixtures';
/** URL browsers inside the docker network use to reach the fixture site. */
export const FIXTURES_URL = `http://${FIXTURES_NAME}:8080`;
export const LIMITS = { cpus: Number(process.env.BENCH_CPUS || 4), memoryGb: Number(process.env.BENCH_MEMORY_GB || 4) };

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

export async function docker(...args: string[]): Promise<string> {
  const { stdout } = await exec('docker', args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export async function rm(name: string) {
  ids.delete(name);
  await docker('rm', '-f', name).catch(() => {});
}

export async function ensureNetwork() {
  await docker('network', 'inspect', NETWORK).catch(() => docker('network', 'create', NETWORK));
}

export async function startFixtures() {
  await ensureNetwork();
  await rm(FIXTURES_NAME);
  await docker('run', '-d', '--name', FIXTURES_NAME, '--network', NETWORK, '-p', '127.0.0.1:8080:8080',
    '-v', `${join(ROOT, 'fixtures')}:/app:ro`, '-w', '/app', 'node:22-alpine', 'node', 'server.mjs');
  await waitFor(async () => (await fetch('http://127.0.0.1:8080/health')).ok, 30_000, 'fixture server');
}

export async function waitFor(fn: () => Promise<boolean>, timeoutMs: number, what: string) {
  const t0 = Date.now();
  let last: unknown;
  while (Date.now() - t0 < timeoutMs) {
    try { if (await fn()) return Date.now() - t0; } catch (e) { last = e; }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}: ${last}`);
}

export interface ContainerSpec {
  name: string;
  image: string;
  /** host port -> container port */
  ports: Record<number, number>;
  env?: Record<string, string>;
  cmd?: string[];
  extraArgs?: string[];
}

export async function run(spec: ContainerSpec) {
  await ensureNetwork();
  await rm(spec.name);
  const args = ['run', '-d', '--name', spec.name, '--network', NETWORK,
    '--cpus', String(LIMITS.cpus), '--memory', `${LIMITS.memoryGb}g`, '--shm-size', '1g'];
  for (const [h, c] of Object.entries(spec.ports)) args.push('-p', `127.0.0.1:${h}:${c}`);
  for (const [k, v] of Object.entries(spec.env ?? {})) args.push('-e', `${k}=${v}`);
  args.push(...(spec.extraArgs ?? []), spec.image, ...(spec.cmd ?? []));
  await docker(...args);
}

// ---------------------------------------------------------------------------
// Resource accounting. A sidecar container mounts the VM's cgroup tree read-only,
// so we can read exact kernel counters for any container (including distroless
// ones with no shell) in about 30 ms, instead of the 1-2 s `docker stats` takes.
// ---------------------------------------------------------------------------
const PROBE = 'bench-probe';
const ids = new Map<string, string>();

export async function startProbe() {
  await rm(PROBE);
  await docker('run', '-d', '--name', PROBE, '-v', '/sys/fs/cgroup:/cg:ro', 'alpine', 'sleep', '86400');
}
export const stopProbe = () => rm(PROBE);

async function cgroupDir(name: string) {
  let id = ids.get(name);
  if (!id) { id = await docker('inspect', name, '--format', '{{.Id}}'); ids.set(name, id); }
  return `/cg/docker/${id}`;
}

export interface Stats {
  /** Working set: memory.current minus inactive page cache (the same definition `docker stats` uses). */
  memMb: number;
  /** Anonymous memory only (heap/stack; excludes all page cache). */
  anonMb: number;
  pids: number;
  /** Cumulative CPU time consumed by the container, in seconds. */
  cpuSec: number;
}

export async function stats(name: string): Promise<Stats> {
  const d = await cgroupDir(name);
  const out = await docker('exec', PROBE, 'cat', `${d}/memory.current`, `${d}/pids.current`, `${d}/memory.stat`, `${d}/cpu.stat`);
  const lines = out.split('\n');
  const kv = new Map(lines.slice(2).map((l) => l.split(' ') as [string, string]));
  const MB = 1024 * 1024;
  return {
    memMb: (Number(lines[0]) - Number(kv.get('inactive_file') ?? 0)) / MB,
    anonMb: Number(kv.get('anon') ?? NaN) / MB,
    pids: Number(lines[1]),
    cpuSec: Number(kv.get('usage_usec') ?? NaN) / 1e6,
  };
}

/** Samples the container ~20x/s until stop(); returns peak working set and exact CPU time used. */
export function sampler(name: string) {
  let running = true;
  let peak = 0, peakPids = 0, n = 0;
  let first: Stats | undefined, last: Stats | undefined;
  const loop = (async () => {
    while (running) {
      try {
        const st = await stats(name);
        first ??= st; last = st; n++;
        peak = Math.max(peak, st.memMb); peakPids = Math.max(peakPids, st.pids);
      } catch { /* container may be going away */ }
      await sleep(20);
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      try { last = await stats(name); peak = Math.max(peak, last.memMb); } catch { /* keep previous */ }
      return { samples: n, peakMemMb: n ? peak : NaN, peakPids, cpuSec: first && last ? last.cpuSec - first.cpuSec : NaN };
    },
  };
}

export async function imageInfo(image: string) {
  const out = await docker('image', 'inspect', image, '--format', '{{json .}}');
  const j = JSON.parse(out);
  return {
    image,
    digest: (j.RepoDigests?.[0] as string | undefined) ?? j.Id,
    created: j.Created as string,
    arch: j.Architecture as string,
    sizeMb: Math.round(j.Size / 1024 / 1024),
  };
}
