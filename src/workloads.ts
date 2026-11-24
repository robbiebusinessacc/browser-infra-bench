// The measured workloads. Each returns plain JSON samples; no aggregation here.
import type { Page } from 'playwright-core';
import { createHash } from 'node:crypto';
import { checks } from './compat.js';
import { sampler, sleep, stats, FIXTURES_URL as BASE } from './docker.js';
import type { Provider, Session } from './providers.js';

export interface Trial { ok: boolean; ms: number; error?: string }

const token = (i: number) => createHash('sha1').update(`item-${i}`).digest('hex').slice(0, 12);
const errText = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0].slice(0, 300);

export async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms); });
  try { return await Promise.race([p, timeout]); } finally { clearTimeout(t!); }
}

async function timed(fn: () => Promise<void>, limitMs = 30_000): Promise<Trial> {
  const t0 = performance.now();
  try {
    await withTimeout(fn(), limitMs, 'trial');
    return { ok: true, ms: performance.now() - t0 };
  } catch (e) {
    return { ok: false, ms: performance.now() - t0, error: errText(e) };
  }
}

async function freshPage(s: Session): Promise<Page> {
  const page = await withTimeout(s.context.newPage(), 15_000, 'newPage');
  page.setDefaultTimeout(15_000);
  return page;
}

// ---------------------------------------------------------------------------
// 1. Session start: how long from "I want a browser" to "first page loaded".
// ---------------------------------------------------------------------------
export async function sessionStart(p: Provider, n: number) {
  const connect: Trial[] = [];
  const firstPage: Trial[] = [];
  for (let i = 0; i < n; i++) {
    let s: Session | undefined;
    const t0 = performance.now();
    try {
      s = await withTimeout(p.open(), 45_000, 'open');
      connect.push({ ok: true, ms: performance.now() - t0 });
      const page = await freshPage(s);
      await page.goto(`${BASE}/static`);
      if ((await page.title()) !== 'Static page') throw new Error('wrong title');
      firstPage.push({ ok: true, ms: performance.now() - t0 });
    } catch (e) {
      const t = { ok: false, ms: performance.now() - t0, error: errText(e) };
      if (connect.length <= i) connect.push(t);
      firstPage.push(t);
    } finally {
      await s?.close();
    }
  }
  return { connect, firstPage };
}

// ---------------------------------------------------------------------------
// 2. Page load: navigate to a fixture and wait until its content is verifiably there.
// ---------------------------------------------------------------------------
interface PageKind { id: string; describe: string; url: string; ready(page: Page): Promise<void> }

export const pageKinds: PageKind[] = [
  { id: 'static', describe: 'Server-rendered HTML, 40 paragraphs', url: '/static',
    async ready(page) { if ((await page.locator('p').count()) !== 40) throw new Error('bad paragraph count'); } },
  { id: 'spa', describe: 'Client-rendered: fetch JSON, build 200 rows', url: '/spa',
    async ready(page) { await page.waitForSelector('#done'); if ((await page.locator('li.row').count()) !== 200) throw new Error('bad row count'); } },
  { id: 'dom', describe: '5,000-row table (15,000 cells)', url: '/dom?n=5000',
    async ready(page) {
      const r = await page.evaluate(() => [document.querySelectorAll('tr').length, document.querySelectorAll('td.t')[4999]?.textContent]);
      if (r[0] !== 5000 || r[1] !== token(4999)) throw new Error(`bad dom ${r}`);
    } },
  { id: 'assets', describe: '30 images, 5 scripts, 3 stylesheets', url: '/assets',
    async ready(page) {
      const r = await page.evaluate(() => [Array.from(document.images).filter((i) => i.complete && i.naturalWidth === 16).length, (window as any).__s]);
      if (r[0] !== 30 || r[1] !== 5) throw new Error(`assets not loaded ${r}`);
    } },
  { id: 'compute', describe: 'Inline script: 300k-iteration loop and sort', url: '/compute',
    async ready(page) { if (!/^\d+$/.test((await page.textContent('#result')) ?? '')) throw new Error('no compute result'); } },
];

export async function pageLoad(s: Session, n: number) {
  const out: Record<string, Trial[]> = {};
  for (const kind of pageKinds) out[kind.id] = [];
  // Interleave kinds so drift over time hits all of them equally.
  for (let i = 0; i < n; i++) {
    for (const kind of pageKinds) {
      let page: Page | undefined;
      try {
        page = await freshPage(s);
        const pg = page;
        out[kind.id].push(await timed(async () => { await pg.goto(`${BASE}${kind.url}`, { waitUntil: 'load' }); await kind.ready(pg); }));
      } catch (e) {
        out[kind.id].push({ ok: false, ms: 0, error: errText(e) });
      } finally {
        await page?.close().catch(() => {});
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Command latency: round trip of a trivial CDP command on an open page.
// ---------------------------------------------------------------------------
export async function commandLatency(s: Session, n: number) {
  const page = await freshPage(s);
  const evaluate: Trial[] = [];
  const query: Trial[] = [];
  try {
    await page.goto(`${BASE}/static`);
    for (let i = 0; i < 20; i++) await page.evaluate('1+1'); // warm-up, discarded
    for (let i = 0; i < n; i++) {
      evaluate.push(await timed(async () => { if ((await page.evaluate('1+1')) !== 2) throw new Error('bad result'); }, 10_000));
      query.push(await timed(async () => { if ((await page.locator('p').count()) !== 40) throw new Error('bad count'); }, 10_000));
    }
  } catch (e) {
    evaluate.push({ ok: false, ms: 0, error: errText(e) });
  } finally {
    await page.close().catch(() => {});
  }
  return { evaluate, query };
}

// ---------------------------------------------------------------------------
// 4. Throughput: scrape `total` distinct pages with `c` concurrent connections,
//    one fresh tab per URL, verifying a per-page token so wrong data counts as failure.
// ---------------------------------------------------------------------------
export async function throughput(p: Provider, c: number, total: number) {
  const sessions = await withTimeout(p.openMany(c), 90_000, 'openMany');
  // Warm each connection once so the measurement is steady-state scraping, not session start.
  await Promise.all(sessions.map(async (s) => { const pg = await freshPage(s); await pg.goto(`${BASE}/static`).catch(() => {}); await pg.close().catch(() => {}); }));
  const samp = sampler(p.container.name);
  let next = 0, okCount = 0;
  const errors: string[] = [];
  const perPage: number[] = [];
  const t0 = performance.now();
  await Promise.all(sessions.map(async (s) => {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      const t = await timed(async () => {
        const page = await freshPage(s);
        try {
          await page.goto(`${BASE}/page?i=${i}`, { waitUntil: 'load' });
          const d = await page.evaluate(() => ({
            title: document.querySelector('.title')?.textContent, price: document.querySelector('.price')?.textContent,
            tok: document.getElementById('tok')?.textContent, next: (document.querySelector('a.next') as HTMLAnchorElement | null)?.href,
          }));
          if (d.title !== `Item ${i}` || d.tok !== token(i) || d.price !== `$${(i * 1.5 + 9.99).toFixed(2)}` || !d.next?.endsWith(`/page?i=${i + 1}`))
            throw new Error(`wrong data for page ${i}: ${JSON.stringify(d)}`);
        } finally { await page.close().catch(() => {}); }
      }, 20_000);
      if (t.ok) { okCount++; perPage.push(t.ms); } else if (errors.length < 5) errors.push(t.error!);
    }
  }));
  const wallMs = performance.now() - t0;
  const usage = await samp.stop();
  await Promise.all(sessions.map((s) => s.close()));
  return {
    concurrency: c, total, ok: okCount, wallMs, pagesPerSec: okCount / (wallMs / 1000), perPageMs: perPage, errors,
    ...usage, cpuMsPerPage: okCount ? (usage.cpuSec * 1000) / okCount : NaN,
  };
}

// ---------------------------------------------------------------------------
// 5. Memory: container memory idle, with one session, and with 10 tabs open.
// ---------------------------------------------------------------------------
export async function memory(p: Provider) {
  await sleep(3000);
  const idle = await stats(p.container.name);
  const s = await p.open();
  const pages: Page[] = [];
  try {
    pages.push(await freshPage(s));
    await pages[0].goto(`${BASE}/static`);
    await sleep(1500);
    const onePage = await stats(p.container.name);
    let opened = 1;
    try {
      for (let i = 1; i < 10; i++) {
        const pg = await freshPage(s);
        pages.push(pg);
        await pg.goto(`${BASE}/dom?n=2000`);
        opened++;
      }
    } catch { /* report how many tabs actually opened */ }
    await sleep(1500);
    const tenPages = await stats(p.container.name);
    return { idle, onePage, tenPages, tabsOpened: opened };
  } finally {
    for (const pg of pages) await pg.close().catch(() => {});
    await s.close();
  }
}

// ---------------------------------------------------------------------------
// 6. Compatibility: the checks in compat.ts, one fresh tab each.
// ---------------------------------------------------------------------------
export async function compat(p: Provider) {
  const results: { id: string; group: string; ok: boolean; ms: number; error?: string }[] = [];
  let s = await p.open();
  for (const check of checks) {
    let page: Page | undefined;
    const t0 = performance.now();
    try {
      if (!s.browser.isConnected()) { await s.close(); s = await p.open(); }
      page = await freshPage(s);
      page.setDefaultTimeout(8000);
      await withTimeout(check.run({ page, context: s.context, base: BASE }), 20_000, check.id);
      results.push({ id: check.id, group: check.group, ok: true, ms: performance.now() - t0 });
    } catch (e) {
      results.push({ id: check.id, group: check.group, ok: false, ms: performance.now() - t0, error: errText(e) });
    } finally {
      await page?.close().catch(() => {});
      await s.context.clearCookies().catch(() => {});
    }
  }
  await s.close();
  return results;
}

// ---------------------------------------------------------------------------
// 7. Automation fingerprint: which well-known "this is an automated/headless
//    browser" signals does the default configuration expose to a page?
//    Self-inspection on our own fixture; nothing here touches a third-party site.
// ---------------------------------------------------------------------------
export const fingerprintSignals: { id: string; describe: string }[] = [
  { id: 'webdriver-flag', describe: 'navigator.webdriver is true' },
  { id: 'headless-ua', describe: 'User-Agent contains "Headless"' },
  { id: 'ua-header-mismatch', describe: 'HTTP User-Agent differs from navigator.userAgent' },
  { id: 'no-accept-language', describe: 'No Accept-Language request header' },
  { id: 'no-languages', describe: 'navigator.languages is empty' },
  { id: 'no-plugins', describe: 'navigator.plugins is empty' },
  { id: 'no-chrome-object', describe: 'UA claims Chrome but window.chrome is missing' },
  { id: 'zero-outer-size', describe: 'window.outerWidth/outerHeight is 0' },
  { id: 'software-webgl', describe: 'WebGL missing or reports a software renderer' },
  { id: 'permissions-inconsistent', describe: 'Notification.permission contradicts permissions.query' },
  { id: 'platform-mismatch', describe: 'UA operating system contradicts navigator.platform' },
  { id: 'ua-data-mismatch', describe: 'UA claims Chrome but navigator.userAgentData is missing or inconsistent' },
  { id: 'cdp-runtime-leak', describe: 'Page can observe the CDP Runtime domain serialising console arguments' },
  { id: 'no-media-codecs', describe: 'No H.264 or AAC playback support (Chrome builds have it)' },
];

export async function fingerprint(p: Provider) {
  const s = await p.open();
  try {
    const page = await freshPage(s);
    await page.goto(`${BASE}/api/echo`);
    const headers = JSON.parse(await page.evaluate(() => document.body.innerText)).headers as Record<string, string>;
    await page.goto(`${BASE}/static`);
    const js = await page.evaluate(async () => {
      const nav = navigator as any;
      const ua = navigator.userAgent;
      let webgl = '';
      try {
        const gl = document.createElement('canvas').getContext('webgl') as WebGLRenderingContext | null;
        const ext = gl?.getExtension('WEBGL_debug_renderer_info');
        webgl = gl ? String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : '';
      } catch { webgl = ''; }
      let permState = 'unsupported';
      try { permState = (await navigator.permissions.query({ name: 'notifications' as PermissionName })).state; } catch { /* keep */ }
      // Known CDP tell: with the Runtime domain enabled, console arguments are serialised eagerly,
      // which invokes a getter the page planted.
      let cdpLeak = false;
      const e = new Error('probe');
      Object.defineProperty(e, 'stack', { get() { cdpLeak = true; return ''; } });
      console.debug(e);
      const v = document.createElement('video');
      const brands = (nav.userAgentData?.brands ?? []).map((b: any) => b.brand).join(',');
      return {
        ua, webdriver: nav.webdriver, languages: navigator.languages?.length ?? 0, plugins: navigator.plugins?.length ?? 0,
        hasChrome: typeof (window as any).chrome === 'object', outer: [window.outerWidth, window.outerHeight], webgl,
        notification: typeof Notification === 'undefined' ? 'undefined' : Notification.permission, permState,
        platform: navigator.platform, brands, uaDataPlatform: nav.userAgentData?.platform ?? '', cdpLeak,
        h264: v.canPlayType('video/mp4; codecs="avc1.42E01E"'), aac: v.canPlayType('audio/mp4; codecs="mp4a.40.2"'),
        hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: nav.deviceMemory ?? null,
      };
    });
    const claimsChrome = /Chrome\//.test(js.ua);
    const uaOs = /Windows/.test(js.ua) ? 'Win' : /Mac OS X/.test(js.ua) ? 'Mac' : /Linux|X11/.test(js.ua) ? 'Linux' : '?';
    const exposed: Record<string, boolean> = {
      'webdriver-flag': js.webdriver === true,
      'headless-ua': /headless/i.test(js.ua) || /headless/i.test(headers['user-agent']),
      'ua-header-mismatch': headers['user-agent'] !== js.ua,
      'no-accept-language': !headers['accept-language'],
      'no-languages': js.languages === 0,
      'no-plugins': js.plugins === 0,
      'no-chrome-object': claimsChrome && !js.hasChrome,
      'zero-outer-size': js.outer[0] === 0 || js.outer[1] === 0,
      'software-webgl': !js.webgl || /swiftshader|llvmpipe|software/i.test(js.webgl),
      'permissions-inconsistent': js.notification === 'denied' && js.permState === 'prompt',
      'platform-mismatch': uaOs !== '?' && !String(js.platform).startsWith(uaOs),
      'ua-data-mismatch': claimsChrome && (!/Chrom/.test(js.brands) || /Headless/i.test(js.brands)),
      'cdp-runtime-leak': js.cdpLeak,
      'no-media-codecs': claimsChrome && !js.h264 && !js.aac,
    };
    return { exposed, raw: { ...js, headerUa: headers['user-agent'], acceptLanguage: headers['accept-language'] } };
  } finally {
    await s.close();
  }
}

// ---------------------------------------------------------------------------
// 8. Real sites: a small set of public pages with a content assertion each.
//    Two are scraping sandboxes built for this purpose; volume is a handful of
//    requests per run. Timing here includes the public internet, so it is
//    reported for context only; the result that matters is correctness.
// ---------------------------------------------------------------------------
interface Site { id: string; url: string; check(page: Page): Promise<void> }

export const sites: Site[] = [
  { id: 'example.com', url: 'https://example.com/',
    async check(page) {
      const text = await page.locator('p').first().innerText();
      if ((await page.title()) !== 'Example Domain' || !text.includes('documentation examples')) throw new Error(`unexpected content: "${text.slice(0, 60)}"`);
    } },
  { id: 'books.toscrape.com (static catalogue)', url: 'https://books.toscrape.com/',
    async check(page) {
      const titles = await page.$$eval('article.product_pod h3 a', (as) => as.map((a) => a.getAttribute('title')));
      if (titles.length !== 20 || titles[0] !== 'A Light in the Attic') throw new Error(`got ${titles.length} books, first "${titles[0]}"`);
    } },
  { id: 'quotes.toscrape.com/js (client-rendered)', url: 'https://quotes.toscrape.com/js/',
    async check(page) {
      await page.waitForSelector('.quote');
      const n = await page.locator('.quote .text').count();
      const author = await page.locator('.quote .author').first().innerText();
      if (n !== 10 || author !== 'Albert Einstein') throw new Error(`got ${n} quotes, first author "${author}"`);
    } },
  { id: 'quotes.toscrape.com/scroll (infinite scroll, XHR)', url: 'https://quotes.toscrape.com/scroll',
    async check(page) {
      await page.waitForSelector('.quote');
      const before = await page.locator('.quote').count();
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForFunction((b) => document.querySelectorAll('.quote').length > b, before);
    } },
  { id: 'scrapethissite.com (AJAX table)', url: 'https://www.scrapethissite.com/pages/ajax-javascript/#2015',
    async check(page) {
      await page.waitForSelector('tr.film');
      const first = (await page.locator('tr.film .film-title').first().innerText()).trim();
      if (first !== 'Spotlight') throw new Error(`first film "${first}"`);
    } },
  { id: 'en.wikipedia.org (large article)', url: 'https://en.wikipedia.org/wiki/Web_scraping',
    async check(page) {
      const h = (await page.locator('#firstHeading').innerText()).trim();
      const refs = await page.locator('ol.references li').count();
      if (h !== 'Web scraping' || refs < 20) throw new Error(`heading "${h}", ${refs} references`);
    } },
  { id: 'news.ycombinator.com', url: 'https://news.ycombinator.com/',
    async check(page) { const n = await page.locator('tr.athing').count(); if (n !== 30) throw new Error(`${n} stories`); } },
];

export async function realWorld(p: Provider, n: number) {
  const out: Record<string, Trial[]> = {};
  const s = await p.open();
  try {
    for (const site of sites) {
      out[site.id] = [];
      for (let i = 0; i < n; i++) {
        let page: Page | undefined;
        try {
          page = await freshPage(s);
          const pg = page;
          out[site.id].push(await timed(async () => { await pg.goto(site.url, { waitUntil: 'load', timeout: 30_000 }); await site.check(pg); }, 45_000));
        } catch (e) {
          out[site.id].push({ ok: false, ms: 0, error: errText(e) });
        } finally { await page?.close().catch(() => {}); }
        await sleep(500);
      }
    }
  } finally { await s.close(); }
  return out;
}
