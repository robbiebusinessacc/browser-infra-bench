// Small, dependency-free statistics helpers.

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export const sortNum = (xs: number[]) => [...xs].sort((a, b) => a - b);
export const median = (xs: number[]) => quantile(sortNum(xs), 0.5);
export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** Deterministic PRNG (mulberry32) so bootstrap intervals are reproducible from the raw data. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 95% percentile-bootstrap confidence interval for the median. */
export function medianCI(xs: number[], iters = 2000, seed = 1): [number, number] {
  if (xs.length < 2) return [NaN, NaN];
  const r = rng(seed);
  const meds: number[] = [];
  const n = xs.length;
  const buf = new Array<number>(n);
  for (let i = 0; i < iters; i++) {
    for (let j = 0; j < n; j++) buf[j] = xs[Math.floor(r() * n)];
    meds.push(median(buf));
  }
  const s = sortNum(meds);
  return [quantile(s, 0.025), quantile(s, 0.975)];
}

export interface Summary {
  n: number;
  median: number;
  ci95: [number, number];
  p95: number;
  min: number;
  max: number;
  mean: number;
}

export function summarize(xs: number[]): Summary {
  const s = sortNum(xs);
  return {
    n: xs.length,
    median: quantile(s, 0.5),
    ci95: medianCI(xs),
    p95: quantile(s, 0.95),
    min: s[0] ?? NaN,
    max: s[s.length - 1] ?? NaN,
    mean: mean(xs),
  };
}

export function shuffle<T>(xs: T[], r: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
