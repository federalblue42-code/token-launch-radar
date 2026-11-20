// Hana's launch radar model — one sealed snapshot in, one ranked board out.
//
// The board ranks every pre-token protocol the house rule keeps (the watchlist is the floor, never the
// ceiling), priced from the snapshot's own figures only:
//
//   value_if_launch = 10^(a + b*log10(TVL) + category_premium + growth_carry)
//   implied_value   = value_if_launch * launch_odds
//
// The size curve (a, b) is fitted on the snapshot's TRADED tokens — one anchor per ticker, the largest
// TVL record of each — so the market itself sets the curve. Category premiums are shrunk median
// residuals; the growth carry is fitted on anchor residuals vs 7-day TVL change. Launch odds come from
// the peers' record: the shrunk share of protocols in the same family and age bucket that record a
// token. Every term is tested leave-one-out and walk-forward on the anchors, and the board prints the
// results. No protocol name is ever special-cased: one function scores every row.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
export const MODEL_VERSION = 'radar-h1';
/** Farm horizon in weeks and the opportunity cost of one hour of farm work, in dollars. */
export const FARM_WEEKS = 8;
export const HOUR_USD = 3;
/** Gas dollars per transaction by the protocol's first chain; the plan makes 8 transactions. */
export const GAS_PER_TX: Record<string, number> = {
  Ethereum: 8, Bitcoin: 5, Solana: 0.05, Arbitrum: 0.4, Base: 0.4, Optimism: 0.4,
  Polygon: 0.3, Avalanche: 0.6, Binance: 0.3, Tron: 0.5, Hyperliquid_L1: 0.1,
};
export const FARM_TXS = 8;
export const SETUP_HOURS = 0.5;
export const WEEKLY_HOURS = 0.25;

/** Whole days from listed_at to the snapshot date; null when either date is absent. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
const SET_ASIDE_CATS = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** The ledger bucket every one of the snapshot's protocols falls into, counted once each. */
export type Bucket = 'ranked' | 'traded' | 'record' | 'bridge' | 'staking' | 'cex' | 'versioned' | 'wrapped';

export function recordsToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null;
}

/** Whether the house-style rule keeps a pre-token protocol as a launch subject. */
export function isRankable(p: SnapshotProtocol): boolean {
  if (recordsToken(p)) return false;
  if (p.category !== null && SET_ASIDE_CATS.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/** The ledger bucket, in the order the dashboard's accounting bar states it. */
export function bucketOf(p: SnapshotProtocol): Bucket {
  if (p.mcap_usd !== null && p.mcap_usd > 0) return 'traded';
  if (recordsToken(p)) return 'record';
  if (p.category === 'Bridge' || p.category === 'Canonical Bridge') return 'bridge';
  if (p.category === 'Liquid Staking' || p.category === 'Liquid Restaking' || p.category === 'Restaked BTC' || p.category === 'Staking Pool') return 'staking';
  if (p.category === 'CEX' || EXCHANGE_PREFIX.test(p.name)) return 'cex';
  if (VERSIONED.test(p.name)) return 'versioned';
  if (WRAPPED_WORD.test(p.name)) return 'wrapped';
  return 'ranked';
}

/** Category families: peers for the odds model and premiums for the value model. */
export function familyOf(category: string | null): string {
  const c = (category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'credit';
  if (c.includes('dex') || c.includes('derivative') || c.includes('perpetual') || c.includes('basis') || c.includes('option')) return 'trading';
  if (c.includes('yield') || c.includes('farm') || c.includes('liquidity')) return 'yield';
  if (c.includes('curator') || c.includes('allocator')) return 'curator';
  if (c.includes('rwa')) return 'rwa';
  if (c.includes('stable')) return 'stable';
  if (c.includes('bridge')) return 'bridge';
  if (c.includes('staking') || c.includes('restak')) return 'staking';
  if (c.includes('cex') || c.includes('exchange')) return 'cex';
  if (c.includes('chain')) return 'chain';
  if (c.includes('prediction')) return 'prediction';
  if (c.includes('insurance')) return 'insurance';
  if (c.includes('payment')) return 'payments';
  return 'other';
}

/** Age buckets for the odds peers: a protocol's launch odds follow how long its family has run. */
export function ageBucket(age: number | null): string {
  if (age === null) return 'unknown';
  if (age < 365) return '<1y';
  if (age < 730) return '1-2y';
  if (age < 1095) return '2-3y';
  return '3y+';
}

const finite = (v: unknown, f: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : f);
const log10 = (x: number): number => Math.log(x) / Math.LN10;
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/** One anchor per ticker: the largest-TVL record of each symbol, so Aave V2/V3/V4 count once. */
export interface Anchor {
  slug: string;
  name: string;
  symbol: string;
  family: string;
  tvl: number;
  mcap: number;
  growth: number;
  age: number | null;
  listed_at: string | null;
}

export function buildAnchors(snapshot: Snapshot): Anchor[] {
  const best = new Map<string, Anchor>();
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const sym = (p.symbol ?? p.gecko_id ?? p.slug).toUpperCase();
    const a: Anchor = {
      slug: p.slug, name: p.name, symbol: sym, family: familyOf(p.category),
      tvl: p.tvl_usd, mcap: p.mcap_usd, growth: clamp(finite(p.change_7d, 0), -60, 120),
      age: ageDays(snapshot.as_of, p.listed_at), listed_at: p.listed_at,
    };
    const prev = best.get(sym);
    if (prev === undefined || a.tvl > prev.tvl) best.set(sym, a);
  }
  return [...best.values()].sort((x, y) => (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));
}

/** Ordinary least squares of y on x, returned as [intercept, slope]. */
function ols(xs: number[], ys: number[]): [number, number] {
  const n = xs.length;
  if (n < 2) return [median(ys), 0];
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]!; sy += ys[i]!; }
  const mx = sx / n, my = sy / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i]! - mx) ** 2; sxy += (xs[i]! - mx) * (ys[i]! - my); }
  const b = sxx > 0 ? sxy / sxx : 0;
  return [my - b * mx, b];
}

/** Huber-robust line fit: 12 fixed IRLS passes, so outliers cannot drag the curve. Deterministic. */
function robustFit(xs: number[], ys: number[]): [number, number] {
  let [a, b] = ols(xs, ys);
  for (let pass = 0; pass < 12; pass++) {
    const res = xs.map((x, i) => ys[i]! - (a + b * x));
    const s = Math.max(1e-9, 1.4826 * median(res.map(Math.abs)));
    const w = res.map((r) => { const u = Math.abs(r) / (1.345 * s); return u <= 1 ? 1 : 1 / u; });
    let sw = 0, sx = 0, sy = 0;
    for (let i = 0; i < xs.length; i++) { sw += w[i]!; sx += w[i]! * xs[i]!; sy += w[i]! * ys[i]!; }
    const mx = sx / sw, my = sy / sw;
    let sxx = 0, sxy = 0;
    for (let i = 0; i < xs.length; i++) { sxx += w[i]! * (xs[i]! - mx) ** 2; sxy += w[i]! * (xs[i]! - mx) * (ys[i]! - my); }
    const nb = sxx > 0 ? sxy / sxx : 0;
    a = my - nb * mx; b = nb;
  }
  return [a, b];
}

export interface SizeFit { a: number; b: number; }

/** Category premiums: shrunk median residuals, so a thin category borrows the global curve. */
export function categoryPremiums(anchors: Anchor[], fit: SizeFit): Record<string, number> {
  const byFam = new Map<string, number[]>();
  for (const a of anchors) {
    const r = log10(a.mcap) - (fit.a + fit.b * log10(a.tvl));
    const list = byFam.get(a.family) ?? [];
    list.push(r);
    byFam.set(a.family, list);
  }
  const out: Record<string, number> = {};
  for (const [fam, rs] of byFam) {
    const w = rs.length / (rs.length + 4);
    out[fam] = round4(w * median(rs));
  }
  return out;
}

/** Growth carry: slope of anchor residuals on clamped 7-day growth, in log10 units per 100%. */
export function growthCarry(anchors: Anchor[], fit: SizeFit, premiums: Record<string, number>): number {
  const xs: number[] = [], ys: number[] = [];
  for (const a of anchors) {
    const r = log10(a.mcap) - (fit.a + fit.b * log10(a.tvl)) - (premiums[a.family] ?? 0);
    xs.push(a.growth / 100); ys.push(r);
  }
  const [, g] = ols(xs, ys);
  return round4(clamp(g, -0.6, 0.6));
}

/** The full value fit on one anchor set. */
export interface ValueModel {
  a: number; b: number;
  premiums: Record<string, number>;
  growth: number;
  q25: number; q75: number;
  flat_multiple: number;
}

export function fitValueModel(anchors: Anchor[]): ValueModel {
  const xs = anchors.map((a) => log10(a.tvl));
  const ys = anchors.map((a) => log10(a.mcap));
  const [a, b] = robustFit(xs, ys);
  const fit: SizeFit = { a, b };
  const premiums = categoryPremiums(anchors, fit);
  const growth = growthCarry(anchors, fit, premiums);
  const res = anchors.map((an) => log10(an.mcap) - predictLog(an, { a, b, premiums, growth }));
  return {
    a: round4(a), b: round4(b), premiums, growth,
    q25: round4(quantile(res, 0.25)), q75: round4(quantile(res, 0.75)),
    flat_multiple: median(anchors.map((an) => an.mcap / an.tvl)),
  };
}

function predictLog(an: { tvl: number; family: string; growth: number }, m: { a: number; b: number; premiums: Record<string, number>; growth: number }): number {
  return m.a + m.b * log10(an.tvl) + (m.premiums[an.family] ?? 0) + m.growth * (an.growth / 100);
}

/** Launch odds from the peers' record: shrunk token share of the same family and age bucket. */
export interface OddsModel {
  global: number;
  family: Record<string, number>;
  cells: Record<string, number>;
  cell_n: Record<string, number>;
}

export function fitOdds(snapshot: Snapshot): OddsModel {
  let tokened = 0;
  const famN = new Map<string, { n: number; k: number }>();
  const cellN = new Map<string, { n: number; k: number }>();
  for (const p of snapshot.protocols) {
    const has = recordsToken(p);
    if (has) tokened++;
    const fam = familyOf(p.category);
    const cell = `${fam}|${ageBucket(ageDays(snapshot.as_of, p.listed_at))}`;
    const f = famN.get(fam) ?? { n: 0, k: 0 }; f.n++; if (has) f.k++; famN.set(fam, f);
    const c = cellN.get(cell) ?? { n: 0, k: 0 }; c.n++; if (has) c.k++; cellN.set(cell, c);
  }
  const global = tokened / Math.max(1, snapshot.protocols.length);
  const family: Record<string, number> = {};
  for (const [fam, { n, k }] of famN) family[fam] = round4((k + 8 * global) / (n + 8));
  const cells: Record<string, number> = {};
  const cell_n: Record<string, number> = {};
  for (const [cell, { n, k }] of cellN) {
    const fam = cell.split('|')[0]!;
    const prior = family[fam] ?? global;
    cells[cell] = round4((k + 6 * prior) / (n + 6));
    cell_n[cell] = n;
  }
  return { global: round4(global), family, cells, cell_n };
}

export function oddsFor(p: SnapshotProtocol, asOf: string, odds: OddsModel): number {
  const cell = `${familyOf(p.category)}|${ageBucket(ageDays(asOf, p.listed_at))}`;
  return odds.cells[cell] ?? odds.family[familyOf(p.category)] ?? odds.global;
}

/** Leave-one-out median miss of the size curve, against the flat-multiple baseline. */
export function looMiss(anchors: Anchor[], usePremiums: boolean, useGrowth: boolean): { miss: number; flat: number; holds: number; n: number } {
  const misses: number[] = [], flats: number[] = [];
  let holds = 0;
  for (let i = 0; i < anchors.length; i++) {
    const rest = anchors.filter((_, j) => j !== i);
    const m = fitValueModel(rest);
    const an = anchors[i]!;
    let pred = m.a + m.b * log10(an.tvl);
    if (usePremiums) pred += m.premiums[an.family] ?? 0;
    if (useGrowth) pred += m.growth * (an.growth / 100);
    const ratio = an.mcap / Math.pow(10, pred);
    misses.push(Math.max(ratio, 1 / ratio));
    const flatPred = an.tvl * m.flat_multiple;
    const fr = an.mcap / flatPred;
    flats.push(Math.max(fr, 1 / fr));
    const lo = Math.pow(10, pred + m.q25), hi = Math.pow(10, pred + m.q75);
    if (an.mcap >= lo && an.mcap <= hi) holds++;
  }
  return { miss: round4(median(misses)), flat: round4(median(flats)), holds: anchors.length > 0 ? Math.round((holds / anchors.length) * 100) : 0, n: anchors.length };
}

/** Walk-forward: fit on the older 60% of anchors by listing date, test on the newer 40%. */
export function walkForward(anchors: Anchor[]): { miss: number; flat: number; holds: number; n: number; cut: string } {
  const dated = anchors.filter((a) => a.listed_at !== null).sort((x, y) => (x.listed_at! < y.listed_at! ? -1 : x.listed_at! > y.listed_at! ? 1 : 0));
  const cutAt = Math.floor(dated.length * 0.6);
  const train = dated.slice(0, cutAt), test = dated.slice(cutAt);
  if (train.length < 8 || test.length < 4) return { miss: 0, flat: 0, holds: 0, n: 0, cut: '' };
  const m = fitValueModel(train);
  const misses: number[] = [], flats: number[] = [];
  let holds = 0;
  for (const an of test) {
    const pred = predictLog(an, m);
    const ratio = an.mcap / Math.pow(10, pred);
    misses.push(Math.max(ratio, 1 / ratio));
    const fr = an.mcap / (an.tvl * m.flat_multiple);
    flats.push(Math.max(fr, 1 / fr));
    if (an.mcap >= Math.pow(10, pred + m.q25) && an.mcap <= Math.pow(10, pred + m.q75)) holds++;
  }
  return { miss: round4(median(misses)), flat: round4(median(flats)), holds: Math.round((holds / test.length) * 100), n: test.length, cut: train[train.length - 1]!.listed_at! };
}

/** Odds held out: fit the peers' record on older protocols, call the newer ones' token status. */
export function oddsHoldout(snapshot: Snapshot): { right: number; n: number; base_right: number; brier: number; base_brier: number } {
  const dated = snapshot.protocols
    .map((p) => ({ p, age: ageDays(snapshot.as_of, p.listed_at) }))
    .filter((x) => x.age !== null)
    .sort((x, y) => y.age! - x.age!);
  const cutAt = Math.floor(dated.length * 0.6);
  const train = dated.slice(0, cutAt).map((x) => x.p);
  const test = dated.slice(cutAt).map((x) => x.p);
  if (train.length < 20 || test.length < 10) return { right: 0, n: 0, base_right: 0, brier: 0, base_brier: 0 };
  const trainSnap: Snapshot = { ...snapshot, protocols: train };
  const m = fitOdds(trainSnap);
  let right = 0, baseRight = 0;
  let brier = 0, baseBrier = 0;
  for (const p of test) {
    const has = recordsToken(p) ? 1 : 0;
    const q = oddsFor(p, snapshot.as_of, m);
    if ((q >= 0.5 ? 1 : 0) === has) right++;
    if ((m.global >= 0.5 ? 1 : 0) === has) baseRight++;
    brier += (q - has) ** 2;
    baseBrier += (m.global - has) ** 2;
  }
  return { right, n: test.length, base_right: baseRight, brier: round4(brier / test.length), base_brier: round4(baseBrier / test.length) };
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  launch_odds: number;
  value_if_launch_usd: number;
  implied_value_usd: number;
  range_p25_usd: number;
  range_p75_usd: number;
  model: { a: number; b: number; premium: number; growth_carry: number; odds: number };
  farm_steps: string[];
}

/** The compact row the dashboard renders; economics are computed in the page from these fields. */
export interface RadarRow {
  rank: number; slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; age_days: number | null; listed_at: string | null; watchlist: boolean;
  launch_odds: number; value_if_launch_usd: number; implied_value_usd: number;
  range_p25_usd: number; range_p75_usd: number; gas_usd: number; hours: number;
  farm_steps: string[];
}

export interface Ledger { ranked: number; traded: number; record: number; bridge: number; staking: number; cex: number; versioned: number; wrapped: number; total: number; }

export interface RadarData {
  as_of: string; source: string; floor_usd: number; model_version: string;
  fit: { a: number; b: number; premiums: Record<string, number>; growth: number; q25: number; q75: number; flat_multiple: number };
  odds: { global: number; family: Record<string, number> };
  validation: {
    loo: { miss: number; flat: number; holds: number; n: number };
    walk: { miss: number; flat: number; holds: number; n: number; cut: string };
    ablation: { term: string; miss: number }[];
    odds_holdout: { right: number; n: number; base_right: number; brier: number; base_brier: number };
  };
  ledger: Ledger;
  anchors: { name: string; tvl: number; mcap: number; family: string }[];
  watchlist_size: number; board_size: number; early_size: number; below_floor: number;
  farm: { weeks: number; txs: number; hour_usd: number; setup_hours: number; weekly_hours: number; drop_share: number };
  rows: RadarRow[];
}

/** Gas dollars for a protocol's plan: its first chain's per-tx cost, eight transactions. */
export function gasFor(p: SnapshotProtocol): number {
  const chain = p.chains[0] ?? 'Ethereum';
  const per = GAS_PER_TX[chain] ?? GAS_PER_TX[chain.replace(/\s+/g, '_')] ?? 1.5;
  return Math.round(per * FARM_TXS * 100) / 100;
}

export function hoursFor(): number { return SETUP_HOURS + WEEKLY_HOURS * FARM_WEEKS; }

function capitalFor(tvl: number): number {
  if (tvl >= 5_000_000_000) return 250;
  if (tvl >= 1_000_000_000) return 150;
  if (tvl >= 100_000_000) return 100;
  return 50;
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain}, borrow nothing against it, and keep the supply position open.`;
  if (c.includes('dex') || c.includes('basis') || c.includes('option')) return `Provide $${capital} of liquidity to ${name}'s deepest pool on ${chain} and keep the LP position open.`;
  if (c.includes('derivative') || c.includes('perpetual')) return `Deposit $${capital} of USDC as margin on ${name} on ${chain} and open one small delta-neutral hedge.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the vault shares.`;
  if (c.includes('yield') || c.includes('farm') || c.includes('liquidity')) return `Deposit $${capital} into ${name}'s main strategy on ${chain} and keep the receipt token.`;
  if (c.includes('stable')) return `Mint $${capital} of ${name}'s stable asset on ${chain} and hold it in the same wallet.`;
  if (c.includes('rwa')) return `Mint $${capital} of ${name}'s yield asset on ${chain} and hold it through one full distribution.`;
  if (c.includes('prediction')) return `Fund ${name} with $${capital} on ${chain} and place one small position in a long-dated market.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy to expiry.`;
  if (c.includes('payment')) return `Send one $${capital} payment through ${name} on ${chain} and keep the receipt.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The farm plan: seven concrete steps, each with its cost and its time, from the protocol's record. */
export function farmSteps(p: SnapshotProtocol, age: number | null, odds: number): string[] {
  const chain = p.chains[0] ?? 'its main chain';
  const gas = gasFor(p);
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(age);
  const weeks = FARM_WEEKS;
  const steps = [
    `Prepare a fresh wallet on ${chain} holding only farm funds, keep the seed phrase offline, and fund it with $${capital} plus about $${Math.ceil(gas)} for gas. Cost: under $3 of gas. Time: 5 minutes.`,
    `${actionFor(p, capital, chain)} Cost: $${capital} of capital and about $${Math.max(1, Math.round(gas / 4))} of gas. Time: 15 minutes.`,
    `Make one qualifying action each week for ${weeks} weeks (a deposit, a swap, a vote or a claim), so the wallet is active in every snapshot window. Cost: about $${Math.max(1, Math.round(gas / 8))} of gas a week. Time: 10 minutes a week.`,
    `Hold the position at least ${hold} days before unwinding; protocols this size usually weight age and consistency, and this one has run ${age === null ? 'an unrecorded time' : `${age} days`} with no token recorded. Cost: the $${capital} stays deployed. Time: ${hold} days.`,
    `Watch the protocol's own channels for a points or claim page; at the current peer odds of ${Math.round(odds * 100)}% a launch is plausible, not promised, so never pay a third party to claim. Cost: nothing to check. Time: 10 minutes a week.`,
    `If a token launches, sell only what covers the $${capital} capital plus $${Math.ceil(gas)} gas first, and let the rest ride the vesting schedule. Cost: about $${Math.max(1, Math.round(gas / 4))} of gas per exit. Time: 15 minutes.`,
    `Log the wallet, every transaction hash, the dates and the gas spent in a farm ledger so the position can be repeated or unwound cleanly. Cost: nothing but the log. Time: 5 minutes.`,
  ];
  return steps.map((s) => (s.length > 600 ? `${s.slice(0, 596)}...` : s));
}

/** Build the ranked board: every rankable pre-token protocol, watchlist first-class, priced by the fit. */
export function buildBoard(snapshot: Snapshot, value: ValueModel, odds: OddsModel): BoardRow[] {
  const watch = new Set(snapshot.watchlist);
  const chosen = snapshot.protocols.filter((p) => isRankable(p) || watch.has(p.slug));
  const scored = chosen.map((p) => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const fam = familyOf(p.category);
    const growth = clamp(finite(p.change_7d, 0), -60, 120);
    const o = oddsFor(p, snapshot.as_of, odds);
    const vif = Math.pow(10, value.a + value.b * log10(Math.max(1, p.tvl_usd)) + (value.premiums[fam] ?? 0) + value.growth * (growth / 100));
    const implied = Math.max(1, Math.round(vif * o));
    return { p, age, o, vif, implied, growth, fam };
  });
  scored.sort((x, y) => y.implied - x.implied || (x.p.slug < y.p.slug ? -1 : x.p.slug > y.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug, name: s.p.name, category: s.p.category, chains: s.p.chains,
    tvl_usd: s.p.tvl_usd, change_7d: s.p.change_7d, mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at, gecko_id: s.p.gecko_id, symbol: s.p.symbol,
    token_status: 'pre-token', watchlist: watch.has(s.p.slug), age_days: s.age,
    launch_odds: round4(s.o),
    value_if_launch_usd: Math.max(1, Math.round(s.vif)),
    implied_value_usd: s.implied,
    range_p25_usd: Math.max(1, Math.round(s.vif * s.o * Math.pow(10, value.q25))),
    range_p75_usd: Math.max(1, Math.round(s.vif * s.o * Math.pow(10, value.q75))),
    model: { a: value.a, b: value.b, premium: value.premiums[s.fam] ?? 0, growth_carry: round4(value.growth * (s.growth / 100)), odds: round4(s.o) },
    farm_steps: farmSteps(s.p, s.age, s.o),
  }));
}

export function radarRow(r: BoardRow): RadarRow {
  return {
    rank: r.rank, slug: r.slug, name: r.name, category: r.category, chains: r.chains,
    tvl_usd: r.tvl_usd, change_7d: r.change_7d, age_days: r.age_days, listed_at: r.listed_at, watchlist: r.watchlist,
    launch_odds: r.launch_odds, value_if_launch_usd: r.value_if_launch_usd,
    implied_value_usd: r.implied_value_usd, range_p25_usd: r.range_p25_usd, range_p75_usd: r.range_p75_usd,
    gas_usd: gasFor({ chains: r.chains } as SnapshotProtocol), hours: hoursFor(),
    farm_steps: r.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot and the fits. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const anchors = buildAnchors(snapshot);
  const value = fitValueModel(anchors);
  const odds = fitOdds(snapshot);
  const board = buildBoard(snapshot, value, odds);

  const ledger: Ledger = { ranked: 0, traded: 0, record: 0, bridge: 0, staking: 0, cex: 0, versioned: 0, wrapped: 0, total: snapshot.protocols.length };
  const onBoard = new Set(board.map((r) => r.slug));
  for (const p of snapshot.protocols) {
    if (onBoard.has(p.slug)) ledger.ranked++;
    else ledger[bucketOf(p)]++;
  }

  const looFull = looMiss(anchors, true, true);
  const walk = walkForward(anchors);
  const ablation = [
    { term: 'flat TVL multiple', miss: looMiss(anchors, false, false).flat },
    { term: '+ size curve (TVL^b)', miss: looMiss(anchors, false, false).miss },
    { term: '+ category premium', miss: looMiss(anchors, true, false).miss },
    { term: '+ 7-day growth carry', miss: looFull.miss },
  ];
  const oh = oddsHoldout(snapshot);
  const watch = new Set(snapshot.watchlist);
  const early = board.filter((r) => !watch.has(r.slug)).length;
  const belowFloor = board.filter((r) => r.tvl_usd < snapshot.floor_usd).length;

  const radar: RadarData = {
    as_of: snapshot.as_of, source: snapshot.source, floor_usd: snapshot.floor_usd, model_version: MODEL_VERSION,
    fit: { a: value.a, b: value.b, premiums: value.premiums, growth: value.growth, q25: value.q25, q75: value.q75, flat_multiple: round4(value.flat_multiple) },
    odds: { global: odds.global, family: odds.family },
    validation: { loo: looFull, walk, ablation, odds_holdout: oh },
    ledger,
    anchors: anchors.map((a) => ({ name: a.name, tvl: a.tvl, mcap: a.mcap, family: a.family })),
    watchlist_size: snapshot.watchlist.length, board_size: board.length, early_size: early, below_floor: belowFloor,
    farm: { weeks: FARM_WEEKS, txs: FARM_TXS, hour_usd: HOUR_USD, setup_hours: SETUP_HOURS, weekly_hours: WEEKLY_HOURS, drop_share: 0.07 },
    rows: board.map(radarRow),
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new SnapshotError('snapshot.json is not JSON'); }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug, name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows: the gate takes 100 to 4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'a slug appears twice on the board';
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return 'every row shares one implied value: not a ranking';
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) { const t = s.trim(); if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`; }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}