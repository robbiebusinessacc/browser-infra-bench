// One adapter per browser under test. Each adapter knows how to start its
// container, tell when it is ready, and hand back a connected Playwright session
// the way that project's own docs say to do it.
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { run, rm, waitFor, type ContainerSpec } from './docker.js';

export interface Session {
  browser: Browser;
  context: BrowserContext;
  close(): Promise<void>;
}

export interface Provider {
  id: string;
  label: string;
  /** What kind of thing this is, shown in the report. */
  engine: string;
  license: string;
  container: ContainerSpec;
  /** Resolves once the service accepts sessions. */
  ready(): Promise<void>;
  /** Opens a fresh session (the "cold start" being measured). */
  open(): Promise<Session>;
  /** Opens `c` concurrent client connections for the throughput workload. */
  openMany(c: number): Promise<Session[]>;
  /** What "opening a session" physically does for this provider. */
  sessionSemantics: string;
}

// Local-only token: containers publish to 127.0.0.1 and are torn down after each run.
const TOKEN = 'bench0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

async function viaCdp(endpoint: string, onClose?: () => Promise<void>, headers?: Record<string, string>): Promise<Session> {
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 30_000, headers });
  const context = browser.contexts()[0] ?? (await browser.newContext());
  return {
    browser, context,
    async close() {
      await browser.close().catch(() => {});
      await onClose?.().catch(() => {});
    },
  };
}

const httpOk = (url: string) => async () => (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;

export const providers: Provider[] = [
  {
    id: 'chromium',
    label: 'Headless Chromium (baseline)',
    engine: 'Chromium headless-shell, no wrapper',
    license: 'BSD-3-Clause',
    container: { name: 'bench-chromium', image: 'chromedp/headless-shell:latest', ports: { 9301: 9222 } },
    sessionSemantics: 'Connects to an already-running browser process and uses its default context.',
    ready: () => waitFor(httpOk('http://127.0.0.1:9301/json/version'), 60_000, 'chromium').then(() => {}),
    open: () => viaCdp('http://127.0.0.1:9301'),
    openMany: (c) => Promise.all(Array.from({ length: c }, () => viaCdp('http://127.0.0.1:9301'))),
  },
  {
    id: 'browserless',
    label: 'Browserless',
    engine: 'Chromium behind the Browserless router',
    license: 'SSPL-1.0 or commercial',
    container: {
      name: 'bench-browserless', image: 'ghcr.io/browserless/chromium:latest', ports: { 9302: 3000 },
      env: { TOKEN, CONCURRENT: '20', QUEUED: '20', TIMEOUT: '120000' },
    },
    sessionSemantics: 'Each WebSocket connection launches a new Chromium process, which is killed on disconnect.',
    ready: () => waitFor(httpOk(`http://127.0.0.1:9302/json/version?token=${TOKEN}`), 60_000, 'browserless').then(() => {}),
    open: () => viaCdp(`ws://127.0.0.1:9302?token=${TOKEN}`),
    openMany: (c) => Promise.all(Array.from({ length: c }, () => viaCdp(`ws://127.0.0.1:9302?token=${TOKEN}`))),
  },
  {
    id: 'steel',
    label: 'Steel Browser',
    engine: 'Chromium behind the Steel session API',
    license: 'Apache-2.0',
    container: { name: 'bench-steel', image: 'ghcr.io/steel-dev/steel-browser:latest', ports: { 9303: 3000 } },
    sessionSemantics: 'POST /v1/sessions relaunches Chromium with a clean profile; the client then connects over CDP. One session at a time.',
    ready: () => waitFor(httpOk('http://127.0.0.1:9303/v1/health'), 90_000, 'steel').then(() => {}),
    // Creating a second Steel session relaunches the browser and drops the first,
    // so concurrency means several CDP connections into one session.
    async openMany(c) {
      const first = await this.open();
      const rest = await Promise.all(Array.from({ length: c - 1 }, () => viaCdp('ws://127.0.0.1:9303/')));
      return [...rest, first];
    },
    async open() {
      const r = await fetch('http://127.0.0.1:9303/v1/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!r.ok) throw new Error(`steel session create failed: ${r.status} ${await r.text()}`);
      const { id } = (await r.json()) as { id: string };
      return viaCdp('ws://127.0.0.1:9303/', async () => {
        await fetch(`http://127.0.0.1:9303/v1/sessions/${id}/release`, { method: 'POST' });
      });
    },
  },
  {
    id: 'obscura',
    label: 'Obscura',
    engine: 'Own Rust engine with V8 (not Chromium)',
    license: 'Apache-2.0',
    container: {
      // Obscura rejects requests whose Host port differs from its listen port, so both sides use 9304.
      name: 'bench-obscura', image: 'h4ckf0r0day/obscura:latest', ports: { 9304: 9304 },
      env: { OBSCURA_CDP_TOKEN: TOKEN, OBSCURA_ALLOW_PRIVATE_NETWORK: '1' },
      cmd: ['serve', '--port', '9304', '--host', '0.0.0.0'],
    },
    sessionSemantics: 'Each CDP connection gets its own thread and V8 isolates inside one long-lived server process.',
    ready: () => waitFor(async () => { const s = await openObscura(); await s.close(); return true; }, 60_000, 'obscura').then(() => {}),
    open: () => openObscura(),
    openMany: (c) => Promise.all(Array.from({ length: c }, () => openObscura())),
  },
];

const openObscura = () => viaCdp('ws://127.0.0.1:9304', undefined, { Authorization: `Bearer ${TOKEN}` });

export const byId = (id: string) => {
  const p = providers.find((x) => x.id === id);
  if (!p) throw new Error(`unknown provider ${id}; known: ${providers.map((x) => x.id).join(', ')}`);
  return p;
};

export async function start(p: Provider) {
  const t0 = performance.now();
  await run(p.container);
  await p.ready();
  return performance.now() - t0;
}

export const stop = (p: Provider) => rm(p.container.name);
