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

// ---------------------------------------------------------------------------
// Scoreboard table as SVG. Markdown tables on GitHub cannot colour cells, so the
// ranking is drawn: in each column the best three contenders are shaded, darkest = best.
// ---------------------------------------------------------------------------
export interface TableCell { text: string; /** 1 = best, 2, 3; 0 = not highlighted */ place: number }
export interface TableRow { rank: string; label: string; muted?: boolean; cells: TableCell[] }

export function tableSvg(o: { title: string; subtitle: string; columns: string[][]; rows: TableRow[]; footnote: string; mode: 'light' | 'dark' }) {
  const t = THEME[o.mode];
  const fills = o.mode === 'light' ? ['', '#2a78d6', '#86b6ef', '#cde2fb'] : ['', '#3987e5', '#1c5cab', '#0d366b'];
  const onFill = o.mode === 'light' ? ['', '#ffffff', '#0b0b0b', '#0b0b0b'] : ['', '#ffffff', '#f0efec', '#f0efec'];
  const W = 980, PAD = 24, rankW = 28, labelW = 232, rowH = 34, headH = 44, top = 70;
  const colW = (W - 2 * PAD - rankW - labelW) / o.columns.length;
  const H = top + headH + o.rows.length * rowH + 44;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${FONT}" role="img" aria-label="${esc(o.title)}">`);
  out.push(`<title>${esc(o.title)}</title><desc>${esc(o.subtitle)}</desc><rect width="${W}" height="${H}" rx="8" fill="${t.surface}"/>`);
  out.push(`<text x="${PAD}" y="32" font-size="16" font-weight="600" fill="${t.text}">${esc(o.title)}</text>`);
  out.push(`<text x="${PAD}" y="52" font-size="12" fill="${t.text2}">${esc(o.subtitle)}</text>`);
  // legend
  let lx = W - PAD - 300;
  ['Best', '2nd', '3rd'].forEach((name, i) => {
    out.push(`<rect x="${lx}" y="22" width="14" height="14" rx="3" fill="${fills[i + 1]}"/><text x="${lx + 20}" y="33" font-size="12" fill="${t.text2}">${name}</text>`);
    lx += 20 + textW(name) + 20;
  });
  out.push(`<text x="${lx}" y="33" font-size="12" fill="${t.text2}">in each column</text>`);
  const x0 = PAD + rankW + labelW;
  o.columns.forEach((lines, ci) => {
    const cx = x0 + ci * colW + colW / 2;
    lines.forEach((line, li) => out.push(`<text x="${cx}" y="${top + 16 + li * 14 + (lines.length === 1 ? 7 : 0)}" font-size="11.5" font-weight="600" text-anchor="middle" fill="${t.text2}">${esc(line)}</text>`));
  });
  out.push(`<line x1="${PAD}" y1="${top + headH - 4}" x2="${W - PAD}" y2="${top + headH - 4}" stroke="${t.grid}" stroke-width="1"/>`);
  o.rows.forEach((r, ri) => {
    const y = top + headH + ri * rowH;
    if (ri > 0) out.push(`<line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="${t.grid}" stroke-width="1"/>`);
    const ink = r.muted ? t.text2 : t.text;
    out.push(`<text x="${PAD + 4}" y="${y + rowH / 2 + 4}" font-size="13" font-weight="600" fill="${t.text2}">${esc(r.rank)}</text>`);
    out.push(`<text x="${PAD + rankW}" y="${y + rowH / 2 + 4}" font-size="13" ${r.muted ? 'font-style="italic"' : 'font-weight="600"'} fill="${ink}">${esc(r.label)}</text>`);
    r.cells.forEach((c, ci) => {
      const cx = x0 + ci * colW;
      if (c.place) out.push(`<rect x="${cx + 5}" y="${y + 4}" width="${colW - 10}" height="${rowH - 8}" rx="5" fill="${fills[c.place]}"/>`);
      out.push(`<text x="${cx + colW / 2}" y="${y + rowH / 2 + 4.5}" font-size="13" text-anchor="middle" ${c.place === 1 ? 'font-weight="700"' : ''} fill="${c.place ? onFill[c.place] : ink}" style="font-variant-numeric: tabular-nums">${esc(c.text)}</text>`);
    });
  });
  out.push(`<text x="${PAD}" y="${H - 16}" font-size="11.5" fill="${t.text2}">${esc(o.footnote)}</text>`);
  out.push('</svg>');
  return out.join('\n');
}
