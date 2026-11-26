// Static horizontal bar charts as standalone SVG (GitHub READMEs cannot run
// scripts, so there is no hover layer; every value is printed and also appears
// in the tables next to the chart).

export interface Row {
  label: string;
  value?: number;
  lo?: number;
  hi?: number;
  note?: string;
  /** Draw in the neutral reference colour (used for the baseline). */
  muted?: boolean;
  /** Grouped bars: one value per legend entry. Overrides `value`. */
  series?: { value: number; lo?: number; hi?: number }[];
}
export interface Panel { heading?: string; rows: Row[]; fmt(v: number): string; max?: number }

const THEME = {
  light: { surface: '#fcfcfb', text: '#0b0b0b', text2: '#52514e', grid: '#e7e6e1', bar: '#2a78d6', muted: '#a3a29b', whisker: '#0b0b0b', ramp: ['#86b6ef', '#2a78d6', '#104281'] },
  dark: { surface: '#1a1a19', text: '#f0efec', text2: '#c3c2b7', grid: '#2e2e2c', bar: '#3987e5', muted: '#6f6e68', whisker: '#f0efec', ramp: ['#184f95', '#3987e5', '#86b6ef'] },
};
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Rough text width for 12px system sans; good enough to keep labels inside the canvas. */
const textW = (s: string, size = 12) => s.length * size * 0.56;

/** Bar with a square baseline end and a 4px rounded data end. */
function bar(x: number, y: number, w: number, h: number, fill: string) {
  const r = Math.min(4, w, h / 2);
  if (w <= 0) return '';
  return `<path d="M${x},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${-(w - r)}z" fill="${fill}"/>`;
}

export function barPanels(o: { title: string; subtitle: string; panels: Panel[]; mode: 'light' | 'dark'; cols?: number; legend?: string[] }) {
  const t = THEME[o.mode];
  const cols = Math.min(o.cols ?? 1, o.panels.length);
  const W = 860, PAD = 24, GAP = 28;
  const panelW = (W - 2 * PAD - (cols - 1) * GAP) / cols;
  const labelW = Math.max(...o.panels.flatMap((p) => p.rows.map((r) => textW(r.label)))) + 12;
  const nSeries = o.legend?.length ?? 1;
  const barH = nSeries > 1 ? 12 : 16;
  const rowH = nSeries > 1 ? nSeries * (barH + 2) + 14 : 30;
  const headH = 22;
  const top = 64 + (o.legend ? 26 : 0);
  const rowsPer = Math.max(...o.panels.map((p) => p.rows.length));
  const anyHeading = o.panels.some((p) => p.heading);
  const panelH = (anyHeading ? headH : 4) + rowsPer * rowH + (anyHeading ? 10 : 0);
  const nRows = Math.ceil(o.panels.length / cols);
  const H = top + nRows * panelH + (nRows - 1) * 12 + PAD - 8;

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${FONT}" role="img" aria-label="${esc(o.title)}">`);
  out.push(`<title>${esc(o.title)}</title><desc>${esc(o.subtitle)}</desc>`);
  out.push(`<rect width="${W}" height="${H}" rx="8" fill="${t.surface}"/>`);
  out.push(`<text x="${PAD}" y="32" font-size="16" font-weight="600" fill="${t.text}">${esc(o.title)}</text>`);
  out.push(`<text x="${PAD}" y="52" font-size="12" fill="${t.text2}">${esc(o.subtitle)}</text>`);
  if (o.legend) {
    let lx = PAD;
    o.legend.forEach((name, i) => {
      out.push(`<rect x="${lx}" y="${66}" width="12" height="12" rx="2" fill="${o.legend!.length === 2 ? [t.ramp[0], t.ramp[2]][i] : t.ramp[i]}"/><text x="${lx + 18}" y="${76}" font-size="12" fill="${t.text2}">${esc(name)}</text>`);
      lx += 18 + textW(name) + 22;
    });
  }

  o.panels.forEach((p, pi) => {
    const px = PAD + (pi % cols) * (panelW + GAP);
    const py = top + Math.floor(pi / cols) * (panelH + 12);
    if (p.heading) out.push(`<text x="${px}" y="${py + 12}" font-size="12" font-weight="600" fill="${t.text}">${esc(p.heading)}</text>`);
    const all = p.rows.flatMap((r) => (r.series ?? [{ value: r.value!, lo: r.lo, hi: r.hi }]));
    const valueLabels = all.map((s) => (Number.isFinite(s.value) ? p.fmt(s.value) : 'n/a'));
    const noteW = Math.max(0, ...p.rows.map((r) => (r.note ? textW(`  ${r.note}`, 11) : 0)));
    const labelRoom = Math.max(...valueLabels.map((v) => textW(v))) + 10 + noteW;
    const x0 = px + labelW;
    const plotW = panelW - labelW - labelRoom;
    const finite = all.flatMap((s) => [s.value, s.hi ?? s.value]).filter((v) => Number.isFinite(v)) as number[];
    const max = p.max ?? (Math.max(...finite, 0) || 1);
    const sx = (v: number) => (Math.max(0, v) / max) * plotW;
    const y0 = py + (p.heading ? headH : 4);
    out.push(`<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 + p.rows.length * rowH - 6}" stroke="${t.grid}" stroke-width="1"/>`);

    p.rows.forEach((r, ri) => {
      const ry = y0 + ri * rowH;
      const series = r.series ?? [{ value: r.value!, lo: r.lo, hi: r.hi }];
      const blockH = series.length * (barH + 2) - 2;
      out.push(`<text x="${x0 - 10}" y="${ry + blockH / 2 + 4}" font-size="12" text-anchor="end" fill="${t.text}">${esc(r.label)}</text>`);
      series.forEach((s, si) => {
        const by = ry + si * (barH + 2);
        const fill = r.series ? (r.series.length === 2 ? [t.ramp[0], t.ramp[2]][si] : t.ramp[si]) : r.muted ? t.muted : t.bar;
        if (!Number.isFinite(s.value)) {
          out.push(`<text x="${x0 + 6}" y="${by + barH / 2 + 4}" font-size="12" fill="${t.text2}">n/a</text>`);
          return;
        }
        const w = Math.max(sx(s.value), 1.5);
        out.push(bar(x0, by, w, barH, fill));
        let end = x0 + w;
        if (Number.isFinite(s.lo) && Number.isFinite(s.hi) && s.hi! > s.lo!) {
          const a = x0 + sx(s.lo!), b = x0 + sx(s.hi!), cy = by + barH / 2;
          out.push(`<path d="M${a},${cy}H${b}M${a},${cy - 3}v6M${b},${cy - 3}v6" stroke="${t.whisker}" stroke-width="1" fill="none" opacity="0.75"/>`);
          end = Math.max(end, b);
        }
        const note = !r.series && r.note ? `<tspan font-size="11" fill="${t.text2}">  ${esc(r.note)}</tspan>` : '';
        out.push(`<text x="${end + 6}" y="${by + barH / 2 + 4}" font-size="12" fill="${t.text}" style="font-variant-numeric: tabular-nums">${esc(p.fmt(s.value))}${note}</text>`);
      });
    });
  });
  out.push('</svg>');
  return out.join('\n');
}
