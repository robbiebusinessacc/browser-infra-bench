// Deterministic fixture site used by every workload.
// Zero dependencies so it can run in a bare node:alpine container.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'site');
const PORT = Number(process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/** Stable token for page i; lets the harness verify an extraction was really correct. */
export const token = (i) => createHash('sha1').update(`item-${i}`).digest('hex').slice(0, 12);

const html = (title, body, head = '') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

const send = (res, status, type, body, headers = {}) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
  res.end(body);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1x1 PNGs are too trivial; this is a valid 16x16 solid PNG generated once per colour.
import { deflateSync, crc32 } from 'node:zlib';
function png(r, g, b, size = 16) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0).map((_, i) => [r, g, b][i % 3])]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const routes = {
  '/health': (req, res) => send(res, 200, 'text/plain', 'ok'),

  // --- page-load workloads -------------------------------------------------
  '/static': (req, res) =>
    send(res, 200, MIME['.html'], html('Static page',
      `<h1 id="h">Static page</h1>` + Array.from({ length: 40 }, (_, i) => `<p>Paragraph ${i} of plain server-rendered text.</p>`).join(''))),

  // Client-rendered: fetches JSON then renders 200 rows; sets #done when finished.
  '/spa': (req, res) =>
    send(res, 200, MIME['.html'], html('SPA page', `<div id="app">loading</div>
<script>
(async () => {
  const r = await fetch('/api/items?n=200');
  const items = await r.json();
  const ul = document.createElement('ul');
  for (const it of items) { const li = document.createElement('li'); li.className = 'row'; li.dataset.token = it.token; li.textContent = it.name; ul.appendChild(li); }
  const app = document.getElementById('app'); app.textContent = ''; app.appendChild(ul);
  const d = document.createElement('div'); d.id = 'done'; d.textContent = String(items.length); document.body.appendChild(d);
})();
</script>`)),

  // Large server-rendered DOM (n nodes).
  '/dom': (req, res, url) => {
    const n = Math.min(Number(url.searchParams.get('n') || 5000), 50000);
    let rows = '';
    for (let i = 0; i < n; i++) rows += `<tr><td>${i}</td><td class="t">${token(i)}</td><td>row ${i}</td></tr>`;
    send(res, 200, MIME['.html'], html('Large DOM', `<table id="t"><tbody>${rows}</tbody></table>`,
      '<style>td{padding:2px 6px;border-bottom:1px solid #ddd;font:12px sans-serif}</style>'));
  },

  // Sub-resource heavy: 30 images + 5 scripts + 3 stylesheets.
  '/assets': (req, res) => {
    const imgs = Array.from({ length: 30 }, (_, i) => `<img src="/img/${i}.png" width="16" height="16" alt="">`).join('');
    const js = Array.from({ length: 5 }, (_, i) => `<script src="/gen/s${i}.js"></script>`).join('');
    const css = Array.from({ length: 3 }, (_, i) => `<link rel="stylesheet" href="/gen/c${i}.css">`).join('');
    send(res, 200, MIME['.html'], html('Asset heavy', `<h1>Assets</h1>${imgs}${js}<script>window.__loaded = (window.__s||0);</script>`, css));
  },

  // CPU-bound script work in the page (sort + hash-ish loop), result in #result.
  '/compute': (req, res) =>
    send(res, 200, MIME['.html'], html('Compute', `<div id="result"></div><script>
let x = 0; const a = [];
for (let i = 0; i < 300000; i++) { x = (x * 31 + i) >>> 0; a.push(x); }
a.sort((p, q) => p - q);
document.getElementById('result').textContent = String(a[150000]);
</script>`)),

  // --- throughput workload -------------------------------------------------
  '/page': (req, res, url) => {
    const i = Number(url.searchParams.get('i') || 0);
    send(res, 200, MIME['.html'], html(`Item ${i}`,
      `<article><h1 class="title">Item ${i}</h1><span class="price">$${(i * 1.5 + 9.99).toFixed(2)}</span>
<div id="tok"></div><a class="next" href="/page?i=${i + 1}">next</a>
<script>document.getElementById('tok').textContent = ${JSON.stringify(token(i))};</script></article>`));
  },

  // --- APIs ----------------------------------------------------------------
  '/api/items': (req, res, url) => {
    const n = Math.min(Number(url.searchParams.get('n') || 10), 5000);
    send(res, 200, MIME['.json'], JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: i, name: `Item ${i}`, token: token(i) }))));
  },
  '/api/echo': async (req, res, url) => {
    let body = '';
    for await (const c of req) body += c;
    send(res, 200, MIME['.json'], JSON.stringify({
      method: req.method, body, query: Object.fromEntries(url.searchParams),
      headers: { 'user-agent': req.headers['user-agent'] || '', 'x-bench': req.headers['x-bench'] || '', cookie: req.headers.cookie || '', 'accept-language': req.headers['accept-language'] || '' },
    }));
  },
  '/api/slow': async (req, res, url) => {
    await sleep(Math.min(Number(url.searchParams.get('ms') || 200), 5000));
    send(res, 200, MIME['.json'], JSON.stringify({ ok: true }));
  },
  '/set-cookie': (req, res) =>
    send(res, 200, MIME['.html'], html('Cookie', '<p id="c">set</p>'), { 'set-cookie': 'server_cookie=abc123; Path=/' }),
  '/redirect': (req, res) => { res.writeHead(302, { location: '/static' }); res.end(); },
  '/login': async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'POST only');
    let body = '';
    for await (const c of req) body += c;
    const p = new URLSearchParams(body);
    if (p.get('user') === 'bench' && p.get('pass') === 'secret') {
      res.writeHead(302, { location: '/account', 'set-cookie': 'session=ok; Path=/' });
      return res.end();
    }
    send(res, 401, MIME['.html'], html('Denied', '<p id="status">denied</p>'));
  },
  '/account': (req, res) => {
    const ok = /session=ok/.test(req.headers.cookie || '');
    send(res, ok ? 200 : 401, MIME['.html'], html('Account', `<p id="status">${ok ? 'welcome bench' : 'denied'}</p>`));
  },
  '/download': (req, res) =>
    send(res, 200, 'text/csv', 'a,b\n1,2\n', { 'content-disposition': 'attachment; filename="data.csv"' }),
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (routes[p]) return await routes[p](req, res, url);

    let m;
    if ((m = p.match(/^\/img\/(\d+)\.png$/))) {
      const i = Number(m[1]);
      return send(res, 200, MIME['.png'], png((i * 37) % 256, (i * 91) % 256, (i * 53) % 256));
    }
    if ((m = p.match(/^\/gen\/s(\d+)\.js$/))) return send(res, 200, MIME['.js'], `window.__s = (window.__s||0) + 1; // script ${m[1]}\n` + '/* pad */\n'.repeat(500));
    if ((m = p.match(/^\/gen\/c(\d+)\.css$/))) return send(res, 200, MIME['.css'], `.c${m[1]}{color:rgb(${m[1]},0,0)}\n` + '/* pad */\n'.repeat(500));

    // static files under site/
    const file = normalize(join(ROOT, p === '/' ? 'index.html' : p));
    if (!file.startsWith(ROOT)) return send(res, 403, 'text/plain', 'forbidden');
    const data = await readFile(file);
    send(res, 200, MIME[extname(file)] || 'application/octet-stream', data);
  } catch (e) {
    send(res, e.code === 'ENOENT' ? 404 : 500, 'text/plain', e.code === 'ENOENT' ? 'not found' : String(e));
  }
});

// Minimal WebSocket echo (RFC 6455, unfragmented text frames < 126 bytes) for the compat suite.
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on('data', (buf) => {
    const op = buf[0] & 0x0f;
    if (op === 8) return socket.end();
    const len = buf[1] & 0x7f;
    if (op !== 1 || len > 125) return;
    const mask = buf.subarray(2, 6);
    const payload = Buffer.from(buf.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4]));
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  });
  socket.on('error', () => {});
});

server.listen(PORT, '0.0.0.0', () => console.log(`fixtures listening on :${PORT}`));
