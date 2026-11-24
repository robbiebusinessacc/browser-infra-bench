// Compatibility suite: does the browser behind the CDP endpoint actually behave
// like a browser when driven by stock Playwright? Every check has a deterministic
// expected result served by the fixture site.
import type { BrowserContext, Page } from 'playwright-core';
import { decodePng } from './png.js';

export interface CheckEnv {
  page: Page;
  context: BrowserContext;
  base: string;
}

export interface Check {
  id: string;
  group: 'navigation' | 'web-platform' | 'interaction' | 'capture' | 'network' | 'automation';
  run(env: CheckEnv): Promise<void>;
}

function eq<T>(actual: T, expected: T, what = 'value') {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a?.slice(0, 200)}`);
}
function ok(cond: unknown, what: string) {
  if (!cond) throw new Error(what);
}
const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;

/** Runs `fn` in the page on /compat.html and returns its result. */
const inPage = (id: string, group: Check['group'], fn: (() => unknown) | string, expected: unknown): Check => ({
  id, group,
  async run({ page, base }) {
    await page.goto(`${base}/compat.html`);
    eq(await page.evaluate(fn), expected, id);
  },
});

export const checks: Check[] = [
  // ---- navigation ---------------------------------------------------------
  { id: 'goto-title', group: 'navigation', async run({ page, base }) {
    const r = await page.goto(`${base}/static`);
    eq(r?.status(), 200, 'status'); eq(await page.title(), 'Static page', 'title');
  } },
  { id: 'redirect-followed', group: 'navigation', async run({ page, base }) {
    await page.goto(`${base}/redirect`);
    eq(new URL(page.url()).pathname, '/static', 'final url');
  } },
  { id: 'http-404-status', group: 'navigation', async run({ page, base }) {
    const r = await page.goto(`${base}/nope`);
    eq(r?.status(), 404, 'status');
  } },
  { id: 'page-content', group: 'navigation', async run({ page, base }) {
    await page.goto(`${base}/static`);
    ok((await page.content()).includes('Paragraph 39'), 'content() missing text');
  } },
  { id: 'go-back', group: 'navigation', async run({ page, base }) {
    await page.goto(`${base}/static`); await page.goto(`${base}/red.html`);
    await page.goBack();
    eq(await page.title(), 'Static page', 'title after back');
  } },
  { id: 'link-click-navigates', group: 'navigation', async run({ page, base }) {
    await page.goto(`${base}/compat.html`);
    await Promise.all([page.waitForURL('**/static'), page.click('#nav')]);
    eq(await page.title(), 'Static page', 'title');
  } },
  { id: 'wait-for-selector-spa', group: 'navigation', async run({ page, base }) {
    await page.goto(`${base}/spa`);
    await page.waitForSelector('#done');
    eq(await page.locator('li.row').count(), 200, 'rows');
  } },
  { id: 'wait-for-function', group: 'navigation', async run({ page, base }) {
    await page.goto(`${base}/compat.html`);
    await page.evaluate(() => { setTimeout(() => { (window as any).ready = 42; }, 150); });
    const h = await page.waitForFunction(() => (window as any).ready);
    eq(await h.jsonValue(), 42, 'value');
  } },
  { id: 'iframe-access', group: 'navigation', async run({ page, base }) {
    await page.goto(`${base}/compat.html`);
    eq(await page.frameLocator('#fr').locator('#inframe').innerText(), 'inside frame', 'frame text');
  } },
  { id: 'multiple-pages', group: 'navigation', async run({ page, context, base }) {
    const p2 = await context.newPage();
    try {
      await Promise.all([page.goto(`${base}/static`), p2.goto(`${base}/page?i=7`)]);
      eq([await page.title(), await p2.title()], ['Static page', 'Item 7'], 'titles');
    } finally { await p2.close().catch(() => {}); }
  } },

  // ---- web platform -------------------------------------------------------
  inPage('eval-roundtrip', 'web-platform', () => ({ a: [1, 2, { b: 'x' }], n: null, t: true }), { a: [1, 2, { b: 'x' }], n: null, t: true }),
  // Passed as source text: the TypeScript loader rewrites class bodies with a helper the page does not have.
  inPage('modern-js-syntax', 'web-platform', `(() => {
    class A { #x = 2; get x() { return this.#x; } static s = 3; }
    const o = { p: { q: 5 } };
    return [new A().x, A.s, o?.p?.q ?? 0, o.z?.y ?? 'd', [1, 2, 3].at(-1), [1, 2, 3].findLast((v) => v < 3), String(2n ** 64n),
      Object.fromEntries([['k', 1]]).k, 'a-b'.replaceAll('-', '+'), structuredClone({ d: [1] }).d[0]];
  })()`, [2, 3, 5, 'd', 3, 2, '18446744073709551616', 1, 'a+b', 1]),
  inPage('promise-timer-ordering', 'web-platform', async () => {
    const order: string[] = [];
    await new Promise<void>((res) => {
      setTimeout(() => { order.push('timeout'); res(); }, 0);
      Promise.resolve().then(() => order.push('micro'));
      queueMicrotask(() => order.push('micro2'));
      order.push('sync');
    });
    return order;
  }, ['sync', 'micro', 'micro2', 'timeout']),
  inPage('fetch-json', 'web-platform', async () => (await (await fetch('/api/items?n=3')).json()).map((i: any) => i.id), [0, 1, 2]),
  inPage('fetch-post-body', 'web-platform', async () => {
    const r = await (await fetch('/api/echo?x=1', { method: 'POST', body: 'payload' })).json();
    return [r.method, r.body, r.query.x];
  }, ['POST', 'payload', '1']),
  inPage('xhr', 'web-platform', () => new Promise((res) => {
    const x = new XMLHttpRequest(); x.open('GET', '/api/items?n=2');
    x.onload = () => res([x.status, JSON.parse(x.responseText).length]); x.onerror = () => res('error'); x.send();
  }), [200, 2]),
  inPage('abort-controller', 'web-platform', async () => {
    const c = new AbortController(); const p = fetch('/api/slow?ms=2000', { signal: c.signal });
    c.abort(); try { await p; return 'resolved'; } catch (e: any) { return e.name; }
  }, 'AbortError'),
  inPage('local-storage', 'web-platform', () => { localStorage.setItem('k', 'v1'); const v = localStorage.getItem('k'); localStorage.removeItem('k'); return [v, localStorage.getItem('k')]; }, ['v1', null]),
  inPage('session-storage', 'web-platform', () => { sessionStorage.setItem('k', 'v2'); return sessionStorage.getItem('k'); }, 'v2'),
  inPage('document-cookie', 'web-platform', () => { document.cookie = 'js_cookie=1; path=/'; return /js_cookie=1/.test(document.cookie); }, true),
  inPage('indexeddb', 'web-platform', () => new Promise((res) => {
    const req = indexedDB.open('bench-' + Math.random(), 1);
    req.onupgradeneeded = () => req.result.createObjectStore('s');
    req.onerror = () => res('error');
    req.onsuccess = () => {
      const tx = req.result.transaction('s', 'readwrite'); tx.objectStore('s').put('val', 'key');
      tx.oncomplete = () => { const g = req.result.transaction('s').objectStore('s').get('key'); g.onsuccess = () => res(g.result); };
    };
  }), 'val'),
  inPage('mutation-observer', 'web-platform', () => new Promise((res) => {
    const el = document.createElement('div'); document.body.appendChild(el);
    new MutationObserver((m) => res(m[0].type)).observe(el, { attributes: true }); el.setAttribute('data-x', '1');
  }), 'attributes'),
  inPage('intersection-observer', 'web-platform', () => new Promise((res) => {
    new IntersectionObserver((e) => res(e[0].isIntersecting)).observe(document.getElementById('h')!);
  }), true),
  inPage('resize-observer', 'web-platform', () => new Promise((res) => {
    new ResizeObserver((e) => res(Math.round(e[0].contentRect.width))).observe(document.getElementById('box')!);
  }), 200),
  inPage('request-animation-frame', 'web-platform', () => new Promise((res) => requestAnimationFrame((t) => res(typeof t))), 'number'),
  inPage('shadow-dom', 'web-platform', () => {
    const host = document.createElement('div'); document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' }); root.innerHTML = '<span id="s">shadow</span>';
    return [root.querySelector('#s')!.textContent, document.querySelector('#s')];
  }, ['shadow', null]),
  inPage('custom-elements', 'web-platform', `(() => {
    class X extends HTMLElement { connectedCallback() { this.textContent = 'upgraded'; } }
    customElements.define('x-bench', X); const el = document.createElement('x-bench'); document.body.appendChild(el);
    return el.textContent;
  })()`, 'upgraded'),
  inPage('layout-bounding-rect', 'web-platform', () => {
    const r = document.getElementById('box')!.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  }, [10, 400, 200, 100]),
  inPage('layout-flexbox', 'web-platform', () => ['fa', 'fb', 'fc'].map((i) => { const r = document.getElementById(i)!.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width)]; }),
    [[0, 100], [100, 100], [200, 100]]),
  inPage('computed-style', 'web-platform', () => getComputedStyle(document.getElementById('styled')!).color, 'rgb(0, 128, 0)'),
  inPage('element-from-point', 'web-platform', () => document.elementFromPoint(50, 450)?.id, 'box'),
  inPage('canvas-2d-pixels', 'web-platform', () => {
    const c = document.createElement('canvas'); c.width = 4; c.height = 4; const g = c.getContext('2d')!;
    g.fillStyle = 'rgb(10, 20, 30)'; g.fillRect(0, 0, 4, 4); return Array.from(g.getImageData(1, 1, 1, 1).data);
  }, [10, 20, 30, 255]),
  inPage('canvas-to-data-url', 'web-platform', () => {
    const c = document.createElement('canvas'); c.width = 2; c.height = 2; c.getContext('2d')!.fillRect(0, 0, 2, 2);
    return c.toDataURL().startsWith('data:image/png;base64,iVBOR');
  }, true),
  inPage('web-worker', 'web-platform', () => new Promise((res) => {
    const w = new Worker('/worker.js'); w.onmessage = (e) => res(e.data); w.onerror = () => res('error'); w.postMessage(21);
  }), 42),
  inPage('webassembly', 'web-platform', async () => {
    // (module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add))
    const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127, 3, 2, 1, 0, 7, 7, 1, 3, 97, 100, 100, 0, 0, 10, 9, 1, 7, 0, 32, 0, 32, 1, 106, 11]);
    const { instance } = await WebAssembly.instantiate(bytes); return (instance.exports as any).add(40, 2);
  }, 42),
  inPage('websocket-echo', 'web-platform', () => new Promise((res) => {
    const ws = new WebSocket(location.origin.replace('http', 'ws') + '/ws');
    ws.onopen = () => ws.send('ping-bench'); ws.onmessage = (e) => { res(e.data); ws.close(); }; ws.onerror = () => res('error');
  }), 'ping-bench'),
  // Secure-context-only crypto (subtle, randomUUID) is not tested: the fixture origin is plain http.
  inPage('crypto-get-random-values', 'web-platform', () => { const a = crypto.getRandomValues(new Uint8Array(16)); return [a.length, a.some((v) => v !== 0)]; }, [16, true]),
  inPage('history-push-state', 'web-platform', () => new Promise((res) => {
    history.pushState({ n: 1 }, '', '/compat.html?step=1'); history.pushState({ n: 2 }, '', '/compat.html?step=2');
    addEventListener('popstate', (e) => res([location.search, (e.state as any)?.n])); history.back();
  }), ['?step=1', 1]),
  inPage('intl-formatting', 'web-platform', () => [new Intl.NumberFormat('en-US').format(1234567.891), new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', dateStyle: 'medium' }).format(new Date(0))],
    ['1,234,567.891', 'Jan 1, 1970']),
  inPage('url-and-encoding-apis', 'web-platform', () => {
    const u = new URL('https://a.test/p?x=1&y=2#h');
    return [u.searchParams.get('y'), u.hash, new TextDecoder().decode(new TextEncoder().encode('héllo')), btoa('hi'), atob('aGk=')];
  }, ['2', '#h', 'héllo', 'aGk=', 'hi']),
  inPage('dom-parser-and-serializer', 'web-platform', () => {
    const d = new DOMParser().parseFromString('<ul><li>a</li><li>b</li></ul>', 'text/html');
    return [d.querySelectorAll('li').length, new XMLSerializer().serializeToString(d.querySelector('li')!).includes('<li')];
  }, [2, true]),
  inPage('css-selectors-advanced', 'web-platform', () => [document.querySelectorAll('form:has(#q)').length, document.querySelectorAll('option:nth-child(2)')[0]?.textContent, document.querySelector('button:not(#btn)')?.id, document.getElementById('h')!.matches(':is(h1, h2)')],
    [1, 'B', 'save', true]),
  inPage('match-media', 'web-platform', () => [matchMedia('(min-width: 100px)').matches, matchMedia('(max-width: 10px)').matches], [true, false]),
  inPage('performance-timing', 'web-platform', () => {
    const nav = performance.getEntriesByType('navigation')[0] as any;
    return [typeof performance.now(), !!nav && nav.responseEnd > 0];
  }, ['number', true]),
  inPage('dynamic-script-and-module', 'web-platform', async () => {
    await new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/gen/s1.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    const spec = 'data:text/javascript,export default 7';
    const m = await import(spec);
    return [(window as any).__s, m.default];
  }, [1, 7]),
  inPage('inner-text-vs-text-content', 'web-platform', () => {
    const d = document.createElement('div'); d.innerHTML = '<span>a</span><span style="display:none">hidden</span><p>b</p>'; document.body.appendChild(d);
    return [d.textContent, d.innerText.replace(/\s+/g, ' ').trim()];
  }, ['ahiddenb', 'a b']),

  // ---- interaction --------------------------------------------------------
  { id: 'click', group: 'interaction', async run({ page, base }) {
    await page.goto(`${base}/compat.html`); await page.click('#btn');
    eq(await page.textContent('#out'), 'clicked', 'out');
  } },
  { id: 'fill-fires-input', group: 'interaction', async run({ page, base }) {
    await page.goto(`${base}/compat.html`); await page.fill('#name', 'Ada Lovelace');
    eq(await page.inputValue('#name'), 'Ada Lovelace', 'value');
    ok(Number(await page.textContent('#inputs')) >= 1, 'input event did not fire');
  } },
  { id: 'keyboard-type-per-key', group: 'interaction', async run({ page, base }) {
    await page.goto(`${base}/compat.html`); await page.focus('#name'); await page.keyboard.type('abc');
    eq([await page.inputValue('#name'), await page.textContent('#inputs')], ['abc', '3'], 'typed');
  } },
  { id: 'press-enter-submits-form', group: 'interaction', async run({ page, base }) {
    await page.goto(`${base}/compat.html`); await page.fill('#q', 'hello'); await page.press('#q', 'Enter');
    eq(await page.textContent('#out'), 'submitted:hello', 'out');
  } },
  { id: 'select-option', group: 'interaction', async run({ page, base }) {
    await page.goto(`${base}/compat.html`); await page.selectOption('#sel', 'b');
    eq(await page.inputValue('#sel'), 'b', 'select');
  } },
  { id: 'check-checkbox', group: 'interaction', async run({ page, base }) {
    await page.goto(`${base}/compat.html`); await page.check('#cb');
    eq(await page.isChecked('#cb'), true, 'checked');
  } },
  { id: 'hover', group: 'interaction', async run({ page, base }) {
    await page.goto(`${base}/compat.html`); await page.hover('#hover');
    eq(await page.getAttribute('#hover', 'data-hovered'), '1', 'hovered');
  } },
  { id: 'get-by-role', group: 'interaction', async run({ page, base }) {
    await page.goto(`${base}/compat.html`); await page.getByRole('button', { name: 'Save changes' }).click();
    eq(await page.textContent('#out'), 'saved', 'out');
  } },
  { id: 'get-by-label-and-text', group: 'interaction', async run({ page, base }) {
    await page.goto(`${base}/compat.html`); await page.getByLabel('Full name').fill('x');
    eq([await page.inputValue('#name'), await page.getByText('go static').getAttribute('id')], ['x', 'nav'], 'label/text');
  } },
  { id: 'form-login-post-redirect', group: 'interaction', async run({ page, base }) {
    await page.goto(`${base}/compat.html`); await page.fill('#user', 'bench'); await page.fill('#pass', 'secret');
    await Promise.all([page.waitForURL('**/account'), page.click('#signin')]);
    eq(await page.textContent('#status'), 'welcome bench', 'status');
  } },
  { id: 'file-upload', group: 'interaction', async run({ page, base }) {
    await page.goto(`${base}/compat.html`);
    await page.setInputFiles('#file', { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('hello file') });
    eq(await page.evaluate(async () => { const f = (document.getElementById('file') as HTMLInputElement).files![0]; return [f.name, await f.text()]; }), ['note.txt', 'hello file'], 'file');
  } },
  { id: 'dialog-alert', group: 'interaction', async run({ page, base }) {
    await page.goto(`${base}/compat.html`);
    let msg = ''; page.once('dialog', (d) => { msg = d.message(); d.accept().catch(() => {}); });
    await page.click('#alert');
    eq([msg, await page.textContent('#out')], ['hello dialog', 'alerted'], 'dialog');
  } },
  { id: 'scroll-into-view', group: 'interaction', async run({ page, base }) {
    await page.goto(`${base}/compat.html`); await page.locator('#tall').scrollIntoViewIfNeeded();
    ok((await page.evaluate(() => window.scrollY)) > 1000, 'did not scroll');
  } },

  // ---- capture ------------------------------------------------------------
  { id: 'screenshot-pixels', group: 'capture', async run({ page, base }) {
    await page.goto(`${base}/red.html`); await page.setViewportSize({ width: 800, height: 600 });
    const img = decodePng(await page.screenshot({ type: 'png' }));
    eq([img.width, img.height], [800, 600], 'size');
    eq([img.pixel(400, 300), img.pixel(50, 25)], [[255, 0, 0], [0, 0, 255]], 'pixels');
  } },
  { id: 'screenshot-full-page', group: 'capture', async run({ page, base }) {
    await page.goto(`${base}/compat.html`); await page.setViewportSize({ width: 800, height: 600 });
    const img = decodePng(await page.screenshot({ fullPage: true }));
    // Width may be up to a scrollbar narrower than the viewport.
    ok(img.width >= 780 && img.width <= 800 && img.height >= 3000, `full page size ${img.width}x${img.height}`);
  } },
  { id: 'screenshot-element', group: 'capture', async run({ page, base }) {
    await page.goto(`${base}/compat.html`); await page.setViewportSize({ width: 800, height: 600 });
    const img = decodePng(await page.locator('#box').screenshot());
    eq([img.width, img.height, img.pixel(100, 50)], [200, 100, [255, 0, 0]], 'element shot');
  } },
  { id: 'screenshot-text-rendered', group: 'capture', async run({ page, base }) {
    // A page with text must not be a single flat colour: proves glyphs are painted.
    await page.goto(`${base}/static`); await page.setViewportSize({ width: 800, height: 600 });
    const img = decodePng(await page.screenshot());
    const seen = new Set<string>();
    for (let y = 0; y < 120; y += 1) for (let x = 0; x < 300; x += 1) seen.add(img.pixel(x, y).join(','));
    ok(seen.size >= 2, 'screenshot is a flat colour');
  } },
  { id: 'pdf', group: 'capture', async run({ page, base }) {
    await page.goto(`${base}/static`);
    const pdf = await page.pdf({ format: 'A4' });
    ok(pdf.subarray(0, 5).toString() === '%PDF-' && pdf.length > 1000, 'not a PDF');
  } },
  { id: 'viewport-resize', group: 'capture', async run({ page, base }) {
    await page.goto(`${base}/compat.html`); await page.setViewportSize({ width: 1024, height: 700 });
    eq(await page.evaluate(() => [innerWidth, innerHeight]), [1024, 700], 'viewport');
  } },
  { id: 'viewport-survives-first-navigation', group: 'capture', async run({ page, base }) {
    // Set on a brand-new tab, before any navigation.
    await page.setViewportSize({ width: 1024, height: 700 }); await page.goto(`${base}/static`);
    eq(await page.evaluate(() => [innerWidth, innerHeight]), [1024, 700], 'viewport');
  } },
  { id: 'emulate-dark-mode', group: 'capture', async run({ page, base }) {
    await page.emulateMedia({ colorScheme: 'dark' }); await page.goto(`${base}/compat.html`);
    eq(await page.evaluate(() => [matchMedia('(prefers-color-scheme: dark)').matches, getComputedStyle(document.getElementById('styled')!).color]), [true, 'rgb(1, 2, 3)'], 'dark');
    await page.emulateMedia({ colorScheme: null });
  } },

  // ---- network ------------------------------------------------------------
  { id: 'response-events', group: 'network', async run({ page, base }) {
    const seen: string[] = []; page.on('response', (r) => seen.push(new URL(r.url()).pathname + ':' + r.status()));
    await page.goto(`${base}/spa`); await page.waitForSelector('#done');
    ok(seen.includes('/spa:200') && seen.includes('/api/items:200'), `responses seen: ${seen.join(' ')}`);
  } },
  { id: 'response-body', group: 'network', async run({ page, base }) {
    const [resp] = await Promise.all([page.waitForResponse('**/api/items*'), page.goto(`${base}/spa`)]);
    eq((await resp.json()).length, 200, 'body length');
  } },
  { id: 'route-fulfill-mock', group: 'network', async run({ page, base }) {
    await page.route('**/api/items*', (r) => r.fulfill({ json: [{ id: 0, name: 'mocked', token: 't' }] }));
    await page.goto(`${base}/spa`); await page.waitForSelector('#done');
    eq(await page.locator('li.row').allInnerTexts(), ['mocked'], 'rows');
  } },
  { id: 'route-abort-images', group: 'network', async run({ page, base }) {
    await page.route('**/*.png', (r) => r.abort());
    await page.goto(`${base}/assets`);
    eq(await page.evaluate(() => Array.from(document.images).filter((i) => i.naturalWidth > 0).length), 0, 'loaded images');
  } },
  { id: 'images-load', group: 'network', async run({ page, base }) {
    await page.goto(`${base}/assets`);
    eq(await page.evaluate(() => [Array.from(document.images).filter((i) => i.complete && i.naturalWidth === 16).length, (window as any).__s]), [30, 5], 'assets');
  } },
  { id: 'extra-http-headers', group: 'network', async run({ page, base }) {
    await page.setExtraHTTPHeaders({ 'x-bench': 'hdr-1' }); await page.goto(`${base}/api/echo`);
    eq(JSON.parse(await page.evaluate(() => document.body.innerText)).headers['x-bench'], 'hdr-1', 'header');
  } },
  { id: 'context-add-cookies', group: 'network', async run({ page, context, base }) {
    await context.addCookies([{ name: 'ctx_cookie', value: 'c1', url: base }]);
    await page.goto(`${base}/api/echo`);
    ok(/ctx_cookie=c1/.test(JSON.parse(await page.evaluate(() => document.body.innerText)).headers.cookie), 'cookie not sent');
  } },
  { id: 'context-read-server-cookie', group: 'network', async run({ page, context, base }) {
    await page.goto(`${base}/set-cookie`);
    eq((await context.cookies(base)).find((c) => c.name === 'server_cookie')?.value, 'abc123', 'cookie');
  } },
  { id: 'download-event', group: 'network', async run({ page, base }) {
    await page.goto(`${base}/compat.html`);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dl')]);
    eq(dl.suggestedFilename(), 'data.csv', 'filename');
  } },

  // ---- automation ---------------------------------------------------------
  { id: 'add-init-script', group: 'automation', async run({ page, base }) {
    await page.addInitScript(() => { (window as any).__init = 'early'; });
    await page.goto(`${base}/compat.html`);
    eq(await page.evaluate(() => [(window as any).__init, (window as any).__inlineRan]), ['early', true], 'init script');
  } },
  { id: 'expose-function', group: 'automation', async run({ page, base }) {
    await page.exposeFunction('benchAdd', (a: number, b: number) => a + b);
    await page.goto(`${base}/compat.html`);
    eq(await page.evaluate(() => (window as any).benchAdd(2, 3)), 5, 'exposed');
  } },
  { id: 'console-event', group: 'automation', async run({ page, base }) {
    await page.goto(`${base}/compat.html`);
    const [msg] = await Promise.all([page.waitForEvent('console'), page.click('#log')]);
    eq(msg.text(), 'bench-console-message', 'console');
  } },
  { id: 'page-error-event', group: 'automation', async run({ page, base }) {
    await page.goto(`${base}/compat.html`);
    const [err] = await Promise.all([page.waitForEvent('pageerror'), page.evaluate(() => { setTimeout(() => { throw new Error('bench-boom'); }, 0); })]);
    ok(err.message.includes('bench-boom'), 'pageerror message');
  } },
  { id: 'element-handles', group: 'automation', async run({ page, base }) {
    await page.goto(`${base}/static`);
    const hs = await page.$$('p');
    eq([hs.length, await hs[3].evaluate((e) => e.textContent)], [40, 'Paragraph 3 of plain server-rendered text.'], 'handles');
  } },
  { id: 'raw-cdp-session', group: 'automation', async run({ page, context, base }) {
    await page.goto(`${base}/static`);
    const cdp = await context.newCDPSession(page);
    const r = await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
    eq(r.result.value, 'Static page', 'cdp evaluate');
    const tree = await cdp.send('DOM.getDocument', { depth: 1 });
    ok(tree.root.nodeId > 0, 'DOM.getDocument');
    await cdp.detach();
  } },
  { id: 'accessibility-snapshot', group: 'automation', async run({ page, base }) {
    await page.goto(`${base}/compat.html`);
    const snap = await page.locator('body').ariaSnapshot();
    ok(snap.includes('Save changes') && snap.includes('heading "Compat"'), 'aria snapshot missing nodes');
  } },
  { id: 'set-content', group: 'automation', async run({ page }) {
    await page.setContent('<h1 id="x">set</h1><script>document.getElementById("x").dataset.ran = "1"</script>');
    eq(await page.getAttribute('#x', 'data-ran'), '1', 'setContent script');
  } },
];
