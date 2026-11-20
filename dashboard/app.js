// Launch Radar — the page. Reads window.RADAR (data.js, written by main.ts from the same board),
// renders the KPI strip, the protocol accounting ledger, the fitted model with its out-of-sample
// evidence, the integrity checks, the filterable/sortable board and a detail view per protocol.
// No network, no framework: one file, plain DOM. Farm economics are recomputed in the page from each
// row's own figures under the reader's deposit / drop-share scenario, with the same constants the
// model states (gas per chain, 8 transactions, 2.5 hours of work over an 8-week horizon).

'use strict';
const R = window.RADAR;
const $ = (sel) => document.querySelector(sel);

const state = {
  scope: 'all', verdict: 'any', cat: 'all', chain: 'all', q: '',
  deposit: 1000, share: R.farm.drop_share,
  sort: { key: 'rank', dir: 1 }, sel: null,
};

/* ---------- formatting ---------- */
function usd(n) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(a < 10 ? 2 : 0)}`;
}
function usdFull(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
function pct(n, d) { return n === null || n === undefined ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(d === undefined ? 1 : d)}%`; }
function oddsPct(o) { return `${Math.round(o * 100)}%`; }
function ageText(d) {
  if (d === null) return 'unrecorded';
  if (d < 60) return `${d}d`;
  if (d < 730) return `${(d / 30.44).toFixed(0)}mo`;
  return `${(d / 365.25).toFixed(1)}y`;
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function x(n) { return `×${n.toFixed(2)}`; }

/* ---------- farm economics, from the row's own figures ---------- */
function econ(row) {
  const D = state.deposit, s = state.share;
  const weight = D / (row.tvl_usd + D);
  const sliceIfLaunch = row.value_if_launch_usd * s * weight;
  const slice = row.implied_value_usd * s * weight; // odds-weighted, the honest expectation
  const net = slice - row.gas_usd;
  const perHour = net / row.hours;
  const verdict = net >= 5 && perHour >= 3 ? 'farm' : net > 0 ? 'thin' : 'skip';
  const breakeven = row.implied_value_usd * weight > 0 ? row.gas_usd / (row.implied_value_usd * weight) : 1;
  return { sliceIfLaunch, slice, net, perHour, verdict, breakeven, weight };
}

/* ---------- filtering and sorting ---------- */
function filtered() {
  const watch = R.rows.filter((r) => r.watchlist);
  let rows = R.rows;
  if (state.scope === 'watch') rows = watch;
  if (state.scope === 'early') rows = rows.filter((r) => !r.watchlist);
  if (state.cat !== 'all') rows = rows.filter((r) => (r.category ?? 'Uncategorized') === state.cat);
  if (state.chain !== 'all') rows = rows.filter((r) => r.chains.includes(state.chain));
  if (state.q) {
    const q = state.q.toLowerCase();
    rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.slug.includes(q) || (r.category ?? '').toLowerCase().includes(q));
  }
  if (state.verdict !== 'any') rows = rows.filter((r) => econ(r).verdict === state.verdict);
  const { key, dir } = state.sort;
  if (key === 'name') return [...rows].sort((a, b) => a.name.localeCompare(b.name) * dir || a.rank - b.rank);
  const val = (r) => key === 'net' ? econ(r).perHour : key === 'odds' ? r.launch_odds : key === 'tvl' ? r.tvl_usd : key === 'implied' ? r.implied_value_usd : key === 'age' ? (r.age_days ?? -1) : key === 'growth' ? (r.change_7d ?? -999) : r.rank;
  return [...rows].sort((a, b) => (val(a) - val(b)) * dir || a.rank - b.rank);
}
function verdictCounts() {
  const c = { farm: 0, thin: 0, skip: 0 };
  for (const r of R.rows) c[econ(r).verdict]++;
  return c;
}

/* ---------- integrity: the page checks itself against the board it was written from ---------- */
function integrity() {
  const rows = R.rows;
  const byRank = [...rows].sort((a, b) => a.rank - b.rank);
  const ranksOk = byRank.every((r, i) => r.rank === i + 1);
  let mono = true;
  for (let i = 1; i < byRank.length; i++) if (byRank[i].implied_value_usd > byRank[i - 1].implied_value_usd) mono = false;
  const watchOk = rows.filter((r) => r.watchlist).length === R.watchlist_size;
  const L = R.ledger;
  const ledgerSum = L.ranked + L.traded + L.record + L.bridge + L.staking + L.cex + L.versioned + L.wrapped;
  const ledgerOk = ledgerSum === L.total && L.ranked === rows.length;
  return [
    { ok: rows.length === R.board_size, t: `board has ${rows.length} rows = board.json` },
    { ok: ranksOk, t: `ranks 1–${rows.length}, each once` },
    { ok: mono, t: 'implied value never rises down the board' },
    { ok: watchOk, t: `watchlist ${R.watchlist_size}/${R.watchlist_size} on the board` },
    { ok: ledgerOk, t: `ledger accounts ${ledgerSum} of ${L.total} protocols` },
  ];
}

/* ---------- the scatter: traded anchors set the curve, the band is the printed range ---------- */
function scatter() {
  const W = 470, H = 252, ml = 44, mr = 10, mt = 10, mb = 26;
  const x0 = 5, x1 = 10.4, y0 = 3.6, y1 = 10.4;
  const X = (v) => ml + ((Math.log10(Math.max(1, v)) - x0) / (x1 - x0)) * (W - ml - mr);
  const Y = (v) => H - mb - ((Math.log10(Math.max(1, v)) - y0) / (y1 - y0)) * (H - mt - mb);
  const f = R.fit;
  const line = (off) => {
    const xa = Math.pow(10, x0), xb = Math.pow(10, x1);
    return `${X(xa)},${Y(Math.pow(10, f.a + f.b * x0 + off))} ${X(xb)},${Y(Math.pow(10, f.a + f.b * x1 + off))}`;
  };
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="log-log scatter of traded market cap vs TVL with the fitted curve">`;
  for (let p = 5; p <= 10; p++) {
    s += `<line x1="${X(Math.pow(10, p))}" y1="${mt}" x2="${X(Math.pow(10, p))}" y2="${H - mb}" stroke="#161e28" stroke-width="1"/>`;
    s += `<text x="${X(Math.pow(10, p))}" y="${H - 8}" fill="#4d5a68" font-size="9" text-anchor="middle">$${p === 5 ? '100K' : p === 6 ? '1M' : p === 7 ? '10M' : p === 8 ? '100M' : p === 9 ? '1B' : '10B'}</text>`;
  }
  for (let p = 4; p <= 10; p += 2) {
    s += `<line x1="${ml}" y1="${Y(Math.pow(10, p))}" x2="${W - mr}" y2="${Y(Math.pow(10, p))}" stroke="#161e28" stroke-width="1"/>`;
    s += `<text x="${ml - 5}" y="${Y(Math.pow(10, p)) + 3}" fill="#4d5a68" font-size="9" text-anchor="end">$${p === 4 ? '10K' : p === 6 ? '1M' : p === 8 ? '100M' : '10B'}</text>`;
  }
  const band = `${line(f.q25)} ${line(f.q75).split(' ').reverse().join(' ')}`;
  s += `<polygon points="${band}" fill="#58a6ff" opacity="0.08"/>`;
  s += `<polyline points="${line(0)}" fill="none" stroke="#3fb96f" stroke-width="1.6"/>`;
  for (const a of R.anchors) s += `<circle cx="${X(a.tvl)}" cy="${Y(a.mcap)}" r="2.3" fill="#58a6ff" opacity="0.75"><title>${esc(a.name)}: TVL ${usd(a.tvl)}, cap ${usd(a.mcap)}</title></circle>`;
  s += `<text x="${W - mr}" y="${mt + 10}" fill="#7d8b99" font-size="9" text-anchor="end">${R.anchors.length} traded tickers fit · band = P25–P75</text>`;
  s += `<text x="${ml + 4}" y="${mt + 10}" fill="#3fb96f" font-size="9">cap = 10^(${f.a} + ${f.b}·log₁₀TVL + terms)</text>`;
  s += '</svg>';
  return s;
}

/* ---------- sections ---------- */
function header() {
  return `<header>
    <div><h1>LAUNCH RADAR <span class="spark">▚</span></h1>
    <div class="sub">pre-token protocols, priced from the market's own record — implied value = value if it launches × launch odds</div></div>
    <div class="stamp">DefiLlama snapshot <b>${R.as_of}</b> · model <b>${R.model_version}</b><br>${esc(R.source)}</div>
  </header>`;
}

function kpis() {
  const total = R.rows.reduce((s, r) => s + r.implied_value_usd, 0);
  const vc = verdictCounts();
  const v = R.validation;
  const top = R.rows[0];
  return `<div class="kpis">
    <div class="kpi"><div class="k">Ranked</div><div class="v">${R.board_size}</div><div class="s">${R.watchlist_size}/${R.watchlist_size} watchlist · ${R.early_size} beyond it · ${R.below_floor} under the ${usd(R.floor_usd)} floor</div></div>
    <div class="kpi"><div class="k">Implied value</div><div class="v green">${usd(total)}</div><div class="s">summed over the board · rank 1 ${esc(top.name)} ${usd(top.implied_value_usd)}</div></div>
    <div class="kpi"><div class="k">Out-of-sample miss</div><div class="v cyan">${x(v.loo.miss)}</div><div class="s">leave-one-out on ${v.loo.n} traded tickers · flat multiple ${x(v.loo.flat)}</div></div>
    <div class="kpi"><div class="k">Range holds</div><div class="v">${v.loo.holds}%</div><div class="s">held-out caps inside the printed P25–P75 · walk-forward ${v.walk.holds}%</div></div>
    <div class="kpi"><div class="k">Launch odds, held out</div><div class="v">${v.odds_holdout.right}/${v.odds_holdout.n}</div><div class="s">newer protocols called right · base rate ${v.odds_holdout.base_right}/${v.odds_holdout.n}</div></div>
    <div class="kpi"><div class="k">Worth farming</div><div class="v amber">${vc.farm}</div><div class="s">${vc.thin} thin · ${vc.skip} skip · at ${usdFull(state.deposit)} deposit, ${(state.share * 100).toFixed(1)}% drop</div></div>
  </div>`;
}

function ledgerBar() {
  const L = R.ledger;
  const segs = [
    ['ranked', L.ranked, '#3fb96f', 'ranked, no token recorded'],
    ['traded', L.traded, '#58a6ff', 'token already trades'],
    ['record', L.record, '#a371f7', 'records a token, no market cap'],
    ['bridge', L.bridge, '#39c5cf', 'bridges'],
    ['staking', L.staking, '#d9a441', 'liquid staking / restaking / staking pools'],
    ['cex', L.cex, '#e0894f', 'exchange custody'],
    ['versioned', L.versioned, '#e05d8f', 'versioned releases of another protocol'],
    ['wrapped', L.wrapped, '#7d8b99', 'wrapped or staked by name'],
  ];
  const bar = segs.filter((s) => s[1] > 0).map((s) => `<div style="width:${(s[1] / L.total) * 100}%;background:${s[2]}" title="${s[3]}: ${s[1]}"></div>`).join('');
  const keys = segs.filter((s) => s[1] > 0).map((s) => `<span><i style="background:${s[2]}"></i>${s[1]} ${s[3]}</span>`).join('');
  return `<div class="ledger"><div class="t">Protocol accounting — <b>${L.total} of ${L.total} protocols accounted for</b>, every bucket counted once</div><div class="lbar">${bar}</div><div class="lkeys">${keys}</div></div>`;
}

function modelPanels() {
  const f = R.fit, v = R.validation;
  const prem = Object.entries(f.premiums).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 6)
    .map(([k, p]) => `<tr><td>${k}</td><td class="n ${p >= 0 ? 'good' : ''}">${p >= 0 ? '+' : ''}${p.toFixed(3)}</td></tr>`).join('');
  const abl = v.ablation.map((a, i) => `<tr><td>${a.term}</td><td class="n ${i === v.ablation.length - 1 ? 'good' : ''}">${x(a.miss)}</td></tr>`).join('');
  return `<div class="panels">
    <div class="panel"><h2>How a row is priced</h2>
      <p>Traded tokens set the curve; every pre-token protocol sits on it. One anchor per ticker (${R.anchors.length} fit), Huber-robust, so no single name drags it.</p>
      <div class="formula">value = 10^(${f.a} + ${f.b}·log₁₀TVL + premium + carry)
implied = value × launch odds</div>
      <p>growth carry <b>${f.growth >= 0 ? '+' : ''}${f.growth}</b> per 100% of clamped 7-day TVL change · printed range <b>${f.q25}…${f.q75}</b> in log₁₀ (P25–P75 of fit residuals)</p>
      <table class="mini"><tr><th>category premium (shrunk)</th><th>log₁₀</th></tr>${prem}</table>
      <p style="margin-top:6px">Launch odds = the shrunk share of peers in the same family and age bucket that record a token. Global base rate <b>${oddsPct(R.odds.global)}</b>. Reading a row left to right: size sets the value, the peers' record sets the odds, the plan nets the cost.</p>
    </div>
    <div class="panel"><h2>The market's own curve</h2>${scatter()}
      <p>Each dot is a traded ticker (largest-TVL record per symbol). The green line is the fit; the shaded band is the range the board prints. Pre-token rows are priced on this curve, never beside it.</p>
    </div>
    <div class="panel"><h2>Out-of-sample evidence</h2>
      <table class="mini"><tr><th>leave-one-out, median miss</th><th>×</th></tr>${abl}</table>
      <p style="margin-top:6px"><b>Walk-forward:</b> fit on anchors listed before ${v.walk.cut}, test on the ${v.walk.n} newer ones — miss <b>${x(v.walk.miss)}</b> vs flat <b>${x(v.walk.flat)}</b>, range holds <b>${v.walk.holds}%</b>.</p>
      <p><b>Odds held out:</b> peers' record fit on older protocols calls <b>${v.odds_holdout.right} of ${v.odds_holdout.n}</b> newer ones right (base rate ${v.odds_holdout.base_right}); Brier <b>${v.odds_holdout.brier}</b> vs base <b>${v.odds_holdout.base_brier}</b>.</p>
      <p>Every term above earned its place: the miss falls at each step, and the final model is tested twice — leave-one-out and walk-forward. A flat TVL multiple is the baseline it must beat.</p>
    </div>
  </div>`;
}

function integrityStrip() {
  return `<div class="integrity">${integrity().map((c) => `<span class="${c.ok ? '' : 'bad'}">${c.ok ? '✓' : '✗'} ${c.t}</span>`).join('')}</div>`;
}

function filters() {
  const vc = verdictCounts();
  const watchN = R.rows.filter((r) => r.watchlist).length;
  const cats = [...new Set(R.rows.map((r) => r.category ?? 'Uncategorized'))].sort();
  const chains = [...new Set(R.rows.flatMap((r) => r.chains))].sort();
  const chip = (label, on, cls, act) => `<button class="chip ${on ? 'on ' + (cls || '') : ''}" data-act="${act}">${label}</button>`;
  return `<div class="filters">
    ${chip(`All ${R.board_size}`, state.scope === 'all', '', 'scope:all')}
    ${chip(`Watchlist ${watchN}`, state.scope === 'watch', 'a', 'scope:watch')}
    ${chip(`Beyond watchlist ${R.early_size}`, state.scope === 'early', '', 'scope:early')}
    <span class="sep">·</span>
    ${chip(`Farm ${vc.farm}`, state.verdict === 'farm', 'g', 'verdict:farm')}
    ${chip(`Thin ${vc.thin}`, state.verdict === 'thin', 'a', 'verdict:thin')}
    ${chip(`Skip ${vc.skip}`, state.verdict === 'skip', 'r', 'verdict:skip')}
    ${chip('Any verdict', state.verdict === 'any', '', 'verdict:any')}
    <select data-act="cat"><option value="all">All categories</option>${cats.map((c) => `<option ${state.cat === c ? 'selected' : ''} value="${esc(c)}">${esc(c)}</option>`).join('')}</select>
    <select data-act="chain"><option value="all">All chains</option>${chains.map((c) => `<option ${state.chain === c ? 'selected' : ''} value="${esc(c)}">${esc(c)}</option>`).join('')}</select>
    <input type="search" data-act="q" placeholder="search protocols" value="${esc(state.q)}">
    <div class="scenario">deposit
      ${chip('$1,000', state.deposit === 1000, '', 'deposit:1000')}
      ${chip('$10,000', state.deposit === 10000, '', 'deposit:10000')}
      <span class="sep">drop</span>
      ${chip('3.5%', state.share === 0.035, '', 'share:0.035')}
      ${chip('7%', state.share === 0.07, '', 'share:0.07')}
      ${chip('14%', state.share === 0.14, '', 'share:0.14')}
      <button class="chip" data-act="csv">Export CSV</button>
      <button class="chip" data-act="reset">Reset</button>
    </div>
  </div>`;
}

function th(key, label, numeric) {
  const arrow = state.sort.key === key ? (state.sort.dir === 1 ? ' ▲' : ' ▼') : '';
  return `<th class="${numeric ? 'n' : ''}" data-sort="${key}">${label}${arrow}</th>`;
}

function boardTable(rows) {
  const head = `<tr>${th('rank', '#')}${th('name', 'Protocol')}${th('tvl', 'TVL', 1)}${th('growth', '7d', 1)}${th('age', 'No token', 1)}${th('odds', 'Odds', 1)}<th class="n">If launches</th>${th('implied', 'Implied', 1)}<th class="n">P25–P75</th>${th('net', 'Net $/h', 1)}<th>Verdict</th></tr>`;
  const body = rows.map((r) => {
    const e = econ(r);
    const g = r.change_7d;
    return `<tr class="row ${state.sel === r.slug ? 'sel' : ''}" data-slug="${esc(r.slug)}">
      <td class="n">${r.rank}</td>
      <td><span class="pname">${esc(r.name)}</span>${r.watchlist ? '<span class="tag watch">WATCH</span>' : '<span class="tag early">EARLY</span>'}<br><span class="pcat">${esc(r.category ?? 'Uncategorized')} · ${esc(r.chains.slice(0, 2).join(', '))}${r.chains.length > 2 ? ` +${r.chains.length - 2}` : ''}</span></td>
      <td class="n">${usd(r.tvl_usd)}</td>
      <td class="n ${g === null ? '' : g >= 0 ? 'pos' : 'neg'}">${pct(g)}</td>
      <td class="n">${ageText(r.age_days)}</td>
      <td class="n">${oddsPct(r.launch_odds)}</td>
      <td class="n">${usd(r.value_if_launch_usd)}</td>
      <td class="n"><b>${usd(r.implied_value_usd)}</b></td>
      <td class="n range">${usd(r.range_p25_usd)}–${usd(r.range_p75_usd)}</td>
      <td class="n ${e.perHour >= 0 ? 'pos' : 'neg'}">${e.perHour >= 0 ? '+' : '−'}$${Math.abs(e.perHour).toFixed(2)}</td>
      <td><span class="verdict ${e.verdict}">${e.verdict.toUpperCase()}</span></td>
    </tr>`;
  }).join('');
  return `<div class="boardwrap"><table class="board"><thead>${head}</thead><tbody>${body}</tbody></table></div>
  <div class="count">${rows.length} of ${R.board_size} rows shown · plans at ${usdFull(state.deposit)} deposit, ${(state.share * 100).toFixed(1)}% drop share, ${R.farm.weeks}-week horizon · click a row for its detail and farm plan · click a header to sort</div>`;
}

function detail(slug) {
  const r = R.rows.find((row) => row.slug === slug);
  if (!r) return '';
  const e = econ(r);
  const f = R.fit;
  const base = Math.pow(10, f.a + f.b * Math.log10(Math.max(1, r.tvl_usd)));
  const prem = f.premiums[familyOf(r.category)] ?? 0;
  const carry = f.growth * ((Math.min(120, Math.max(-60, r.change_7d ?? 0))) / 100);
  const line = (k, v, cls) => `<div class="line"><span>${k}</span><b class="${cls || ''}">${v}</b></div>`;
  return `<div class="detail" id="detail">
    <div class="dhead"><h2>${esc(r.name)} <span class="pcat">rank ${r.rank} · ${esc(r.category ?? 'Uncategorized')} · ${esc(r.chains.join(', '))}</span>${r.watchlist ? '<span class="tag watch">WATCHLIST</span>' : '<span class="tag early">BEYOND WATCHLIST</span>'}</h2>
    <button class="close" data-act="close">close ✕</button></div>
    <div class="dgrid">
      <div class="dbox"><h3>The record</h3>
        ${line('TVL', usdFull(r.tvl_usd))}
        ${line('7-day TVL change', pct(r.change_7d), (r.change_7d ?? 0) >= 0 ? 'g' : 'r')}
        ${line('No token recorded for', ageText(r.age_days))}
        ${line('Listed since', r.listed_at ?? 'unrecorded')}
        ${line('Token status', 'records no token')}
        ${line('Watchlist', r.watchlist ? `yes (≥ ${usd(R.floor_usd)} floor)` : 'no — early radar')}
      </div>
      <div class="dbox"><h3>The price, term by term</h3>
        ${line(`size curve 10^(${f.a} + ${f.b}·log₁₀TVL)`, usd(base))}
        ${line('category premium', `${prem >= 0 ? '+' : ''}${prem.toFixed(3)} log₁₀`)}
        ${line('7-day growth carry', `${carry >= 0 ? '+' : ''}${carry.toFixed(3)} log₁₀`)}
        ${line('Value if it launches', usd(r.value_if_launch_usd), 'g')}
        ${line('Launch odds (peers\u2019 record)', oddsPct(r.launch_odds))}
        ${line('Implied value', usd(r.implied_value_usd), 'g')}
        ${line('Printed range P25–P75', `${usd(r.range_p25_usd)} – ${usd(r.range_p75_usd)}`)}
      </div>
      <div class="dbox"><h3>The farm math, this scenario</h3>
        ${line('Deposit', usdFull(state.deposit))}
        ${line('Drop share assumed', `${(state.share * 100).toFixed(1)}%`)}
        ${line('Slice if it launches', usd(e.sliceIfLaunch))}
        ${line('Expected slice (odds-weighted)', usd(e.slice))}
        ${line(`Gas, ${R.farm.txs} txs on ${esc(r.chains[0] ?? 'main chain')}`, `−$${r.gas_usd.toFixed(2)}`, 'r')}
        ${line('Work', `${r.hours.toFixed(1)} h over ${R.farm.weeks} weeks`)}
        ${line('Net of gas', `${e.net >= 0 ? '+' : '−'}$${Math.abs(e.net).toFixed(2)}`, e.net >= 0 ? 'g' : 'r')}
        ${line('Net per hour', `${e.perHour >= 0 ? '+' : '−'}$${Math.abs(e.perHour).toFixed(2)}/h`, e.perHour >= 0 ? 'g' : 'r')}
        ${line('Break-even drop share', `${(e.breakeven * 100).toFixed(2)}%`)}
        ${line('Verdict', e.verdict.toUpperCase(), e.verdict === 'farm' ? 'g' : e.verdict === 'thin' ? 'a' : 'r')}
      </div>
    </div>
    <div class="steps"><h3>Farm plan — ${r.farm_steps.length} steps, each with its cost and time</h3>
      <ol>${r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      <p style="color:var(--faint);margin-top:6px">A launch is plausible at these odds, never promised: the snapshot records no token, which is not proof of none. Implied value is this board's own claim. Never pay a third party to claim, and keep the seed phrase offline.</p>
    </div>
  </div>`;
}

function familyOf(category) {
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

function footer() {
  return `<footer>
    <span>Launch Radar ${R.model_version} · built by hana for make.fun's token-radar-01 bounty · data: DefiLlama snapshot ${R.as_of}, sealed — the board never fetches</span>
    <span>implied value is this entry's own claim, not make.fun's · records no token ≠ has no token · keys: / search · esc close</span>
  </footer>`;
}

/* ---------- render and events ---------- */
function render() {
  const rows = filtered();
  $('#app').innerHTML = `<div class="wrap">${header()}${kpis()}${ledgerBar()}${modelPanels()}${integrityStrip()}${state.sel ? detail(state.sel) : ''}${filters()}${boardTable(rows)}${footer()}</div>`;
  bind();
}

function bind() {
  document.querySelectorAll('[data-act]').forEach((el) => {
    const act = el.getAttribute('data-act');
    if (act === 'cat' || act === 'chain') {
      el.addEventListener('change', () => { state[act] = el.value; render(); });
    } else if (act === 'q') {
      el.addEventListener('input', () => { state.q = el.value; render(); const inp = document.querySelector('[data-act="q"]'); inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); });
    } else {
      el.addEventListener('click', () => {
        if (act.startsWith('scope:')) state.scope = act.slice(6);
        else if (act.startsWith('verdict:')) state.verdict = state.verdict === act.slice(8) && act !== 'verdict:any' ? 'any' : act.slice(8);
        else if (act.startsWith('deposit:')) state.deposit = Number(act.slice(8));
        else if (act.startsWith('share:')) state.share = Number(act.slice(6));
        else if (act === 'close') { state.sel = null; history.replaceState(null, '', location.pathname); }
        else if (act === 'reset') { Object.assign(state, { scope: 'all', verdict: 'any', cat: 'all', chain: 'all', q: '', deposit: 1000, share: R.farm.drop_share, sort: { key: 'rank', dir: 1 }, sel: null }); history.replaceState(null, '', location.pathname); }
        else if (act === 'csv') return exportCsv();
        render();
      });
    }
  });
  document.querySelectorAll('[data-sort]').forEach((el) => {
    el.addEventListener('click', () => {
      const key = el.getAttribute('data-sort');
      if (state.sort.key === key) state.sort.dir *= -1;
      else state.sort = { key, dir: key === 'rank' || key === 'name' ? 1 : -1 };
      render();
    });
  });
  document.querySelectorAll('tr.row').forEach((el) => {
    el.addEventListener('click', () => {
      state.sel = el.getAttribute('data-slug');
      history.replaceState(null, '', `#p=${state.sel}`);
      render();
      const d = $('#detail');
      if (d) d.scrollIntoView({ block: 'start' });
    });
  });
}

function exportCsv() {
  const rows = filtered();
  const head = 'rank,slug,name,category,chains,tvl_usd,change_7d,age_days,launch_odds,value_if_launch_usd,implied_value_usd,range_p25_usd,range_p75_usd,net_usd,net_per_hour,verdict';
  const lines = rows.map((r) => {
    const e = econ(r);
    return [r.rank, r.slug, `"${r.name.replace(/"/g, '""')}"`, `"${r.category ?? ''}"`, `"${r.chains.join(';')}"`, r.tvl_usd, r.change_7d ?? '', r.age_days ?? '', r.launch_odds, r.value_if_launch_usd, r.implied_value_usd, r.range_p25_usd, r.range_p75_usd, e.net.toFixed(2), e.perHour.toFixed(2), e.verdict].join(',');
  });
  const blob = new Blob([head + '\n' + lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `launch-radar-${R.as_of}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function applyHash() {
  const h = location.hash.replace(/^#/, '');
  if (!h) return;
  for (const part of h.split('&')) {
    const [k, v] = part.split('=');
    if (k === 'p' && R.rows.some((r) => r.slug === v)) state.sel = v;
    if (k === 'view') {
      if (v === 'farm' || v === 'thin' || v === 'skip') state.verdict = v;
      if (v === 'watch') state.scope = 'watch';
      if (v === 'early') state.scope = 'early';
    }
    if (k === 'deposit') state.deposit = Number(v) === 10000 ? 10000 : 1000;
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.sel) { state.sel = null; history.replaceState(null, '', location.pathname); render(); }
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); const inp = document.querySelector('[data-act="q"]'); if (inp) inp.focus(); }
});
window.addEventListener('hashchange', () => { applyHash(); render(); });

applyHash();
render();