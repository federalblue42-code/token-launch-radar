# token-launch-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/federalblue42-code/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/federalblue42-code/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar for the 758 protocols in make.fun's sealed DefiLlama snapshot (2026-11-14). It prices every protocol that records no token against the market's own record — a log-log size curve fitted on the 127 traded anchor tickers, category premiums, and a 7-day growth carry — then multiplies by launch odds estimated from peer protocols' records. Implied value = value if it launches × launch odds. Every value is the model's own claim, derived only from the snapshot's figures; nothing is hardcoded per name.

The board ranks 198 pre-token protocols (all 40 watchlist protocols covered, 158 beyond the watchlist), accounts for all 758 protocols in a full ledger, and gives each row a costed farm plan: deposit/drop-share/horizon scenario toggles → net $, net $/hour, break-even → FARM / THIN / SKIP verdicts. The model is validated on the board itself: leave-one-out miss ×3.37 vs ×4.88 flat baseline, walk-forward ×3.84 on 38 newer anchors, launch-odds hit rate 140/258 vs 83/258 base rate, with an ablation table and a green integrity strip.

Node 22+, standard library only, no network. Two runs write identical bytes.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input/snapshot.json
```

Writes `out/board.json`, `out/data.js`, copies `dashboard/` and `screenshots/`, and writes `out/dossier.json` with the vendored make.fun library. Open `out/dashboard/index.html` (with `out/data.js` beside it) in a browser — sortable/filterable board, per-protocol detail view, CSV export.

---

<sub>Entered on [make.fun](https://make.fun/?ref=2bxfv32e&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
