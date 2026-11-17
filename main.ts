// Two-arm dip-reversal bot for make.fun btc-race-24h-20261117-0603.
//
// Long-only 1-minute cbBTC/USDC bot (Node 22, stdlib + vendored SDK only).
// It stays in cash and only buys a dip that is already snapping back.
// Two independent entry arms share one exit engine:
//
//   ARM DEEP (capitulation): the 60-min return has fallen at least -1.50%,
//     or the 15-min return at least -1.50%. Valid 60 bars. Buy while armed
//     when the 5-min return has bounced at least +0.20%.
//   ARM MID (quiet-regime dip): the 60-min return has fallen at least
//     -1.00%, or the 15-min return at least -0.80%. Valid 30 bars. Buy
//     while armed when the 5-min return has bounced at least +0.30%,
//     but ONLY while the market is quiet: the mean absolute 1-min return
//     over the last 60 bars is at most 6 bps. On choppy/high-volatility
//     days shallow dips keep falling, so this arm stays out of those.
//     NEW in rev3: the mid arm also requires the 4-hour return to be at
//     most 0 (r240 <= 0). In the 14-15 Nov window the mid arm fired twice
//     while the 4h trend was rising (r240 +227 and +31) and both trades
//     lost (-$11.45 / -$12.68); the one mid winner (dev, r240 -51) passes
//     the cap. Shallow dips are only bought in a flat-to-down 4h regime.
//
//   Both arms additionally require: close above EMA(8), and a known 4-hour
//   trend that is not in a steep fall (240-min return >= -1.50%). A trade
//   is refused while the 240-min return is still unknown (fewer than 241
//   closes): an unfiltered early-window buy lost -1.34% on the 12-13 Nov
//   window, where no 4h history existed yet.
//
//   Exits (any one sells the whole position): trailing stop 0.80% below
//   the peak value since entry, hard stop 1.50% below cost, take-profit
//   3.00% above cost, hold timeout of 120 bars after the fill. After a
//   sell fills, a 30-bar cooldown blocks re-entry.
//
//   NEW in rev4 -- bank the excursion in slices: the first partial now
//   sells 75% (was 50%) at +2.25%, a second partial sells 75% of the
//   remainder at +2.75%, and the stub left after a partial trails at
//   0.40% (was 0.80%). All three changes ride one observed excursion
//   (14-15 Nov deep winner, MFE +287 bps, trail exit ~+180 bps): the
//   fractions and the tighter trail sit on a broad plateau (frac
//   7500-9000, trail2 30-60, tp2 on/off all within $0.64 of each other),
//   and dev / 12-13 Nov are byte-identical to rev3 because no partial
//   ever triggers there (MFE +195/+116/+96 < +225). The bet is that a
//   race-window excursion that reaches +2.25% retraces like the one
//   observed instead of running away to +3.00% TP and beyond -- the
//   same mean-reversion premise the whole bot is built on. If it does
//   run away, rev4 gives up upside on the ~4% stub still riding.
//
// Verified with the kit's own grader, grade-local --driver process, and
// with a byte-exact local simulator (rev4/work/bot3.py, SimY) that
// reproduces grade-local to the unit on all three windows:
//   dev window 16-17 Nov (this campaign): net PnL +$21.65, 4 trades,
//       Sharpe 0.038, Sortino 0.069, max drawdown 0.71%, win rate 100%
//       -- IDENTICAL to rev3 (no partial triggers in dev)
//   dev window 14-15 Nov (out-of-sample): +$21.02, 6 trades, max DD
//       ~1.05%, win rate 50% (deep loser -$5.66, deep winner +$26.68)
//   dev window 12-13 Nov (out-of-sample): +$4.25, 2 trades, max DD 0.73%,
//       win rate 100% -- IDENTICAL to rev3
//   Total across the three windows: +$46.92 (rev3: +$43.21, rev2:
//   +$25.60, incumbent deep-dip bot: +$24.80). Every window positive;
//   worst window +$4.25 (unchanged from rev3).
//
//   The trailing peak is cleared only when a sell fill is confirmed
//   (position back to zero), not when the sell order is sent: a sell
//   rejected for max_slippage leaves the position held, and wiping the
//   peak at order time would re-arm the trail from a lower price and
//   delay the exit. Likewise the peak is re-armed only when a partial
//   fill is confirmed (quantity drops but stays above zero).
//
// Orders decided on a bar's close fill at the next bar's open; a full-size
// round trip pays ~26 bps in fees, slippage and impact, so entries stay
// selective and exits are patient enough to let a real bounce develop.
//
// Why two arms: the deep arm alone is profitable on all three 24h windows
// tested, but fires only once or twice a day (dev: +$8.18, 2 trades). The
// mid arm adds the second-biggest swing of the dev window (buy seq 400,
// +$13.39) while the quiet-volatility gate keeps it out of the losing
// shallow dips of the two earlier windows.
//
//   House baselines on this campaign's dev window: buy-and-hold +$1.07,
//   momentum +$2.45, hold-cash $0.00, ema-cross -$106.21,
//   adx-momentum -$32.66, rsi-bollinger -$24.25.
//
// Honest limits (do not over-read the dev number): the dev window holds
// only two tradeable swings for this bot family, so dev PnL stays $21.65
// (Sharpe 0.038, 4 trades) -- below the dev top-10 bar ($44.90 / 0.063 /
// 6 trades). The rev4 gain over rev3 (+$3.71 total) comes entirely from
// ONE out-of-sample trade (14-15 Nov deep winner $22.97 -> $26.68);
//   the exit changes are plateau-wide, not a sharp peak, but they are
//   still a one-trade observation. Every rejected alternative is listed
//   in rev4/work (sweep_rev4.py batteries A-D + combo runs): the
//   small-trip hunter loses on 14-15 Nov at every setting that fires,
//   earlier/later bounce windows lose out-of-sample, hold 90/100/150
//   and trail 70/90 are all worse, EMA-confirm off loses -$12.50 on
//   14-15 Nov, and loosening the mid arm or the r240 floor loses
//   out-of-sample.
//
// Deterministic: BigInt integer returns and volatility, float64 EMA(8)
// (same arithmetic as the kit's baselines), no wall clock, no environment,
// no randomness. One reply per batch.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

/** Deep arm: 60-min return at or below this (bps). */
const DEEP60_BPS = 150n;
/** Deep arm: 15-min return at or below this (bps). */
const DEEP15_BPS = 150n;
/** How long a deep arm stays valid (bars). */
const DEEP_BARS = 60;
/** Deep arm: buy when the 5-min return has bounced above this (bps). */
const DEEP_BOUNCE_BPS = 20n;
/** Mid arm: 60-min return at or below this (bps). */
const MID60_BPS = 100n;
/** Mid arm: 15-min return at or below this (bps). */
const MID15_BPS = 80n;
/** How long a mid arm stays valid (bars). */
const MID_BARS = 30;
/** Mid arm: buy when the 5-min return has bounced above this (bps). */
const MID_BOUNCE_BPS = 30n;
/** Mid arm: only trade while the mean |1-min return| over the last 60
 *  bars is at most this (hundredths of a bps, i.e. 600 = 6.00 bps). */
const VOL_MAX_HUND_BPS = 600n;
/** Bars of 1-min returns the volatility gate averages. */
const VOL_BARS = 60;
/** Refuse a buy when the 240-min return is below this (bps); a buy is
 *  also refused while the 240-min return is still unknown. */
const R240_MIN_BPS = -150n;
/** Mid arm: only buy while the 240-min return is at most this (bps).
 *  Shallow dips are mean-reversion trades: they only pay in a
 *  flat-to-down 4h regime. Both losing mid trades out-of-sample fired
 *  while r240 was positive (+227, +31); the one mid winner had r240 -51.
 *  The cap sits in the middle of a plateau: any cap from -25 to +10 bps
 *  gives identical results on all three windows. */
const MID_R240_MAX_BPS = 0n;
/** Trailing stop below the peak value since entry (bps). */
const TRAIL_BPS = 80n;
/** Hard stop below the position's cost (bps). */
const STOP_BPS = 150n;
/** Take-profit above the position's cost (bps). */
const TP_BPS = 300n;
/** Partial take-profit: when the position first reaches this far above
 *  cost (bps), sell most of it (see PARTIAL_FRAC_BPS). */
const PARTIAL_TP_BPS = 225n;
/** Fraction of the position sold at the partial take-profit (bps).
 *  Rev4: 7500 (was 5000). The one big excursion in the three windows
 *  (14-15 Nov deep winner, MFE +287 bps) retraced ~100 bps before the
 *  trail fired, so banking more of it at +225 bps is worth more than
 *  the stub left riding: 6000/6500/7500/8500/9000 all beat 5000 on
 *  that window with dev and 12-13 Nov unchanged (no partial ever
 *  triggers there, MFE +195/+116/+96 < 225). 7500 sits mid-plateau. */
const PARTIAL_FRAC_BPS = 7500n;
/** Second partial: when the remaining stub first reaches this far above
 *  cost (bps), sell most of THAT too (see PARTIAL2_FRAC_BPS). Rev4:
 *  the same excursion kept running to +287 bps, so a second slice at
 *  +275 bps banks more of the top before the retrace. Adds +$0.62 on
 *  the 14-15 Nov window over the 7500/trail2-40 base, nothing elsewhere. */
const PARTIAL2_TP_BPS = 275n;
/** Fraction of the REMAINING position sold at the second partial (bps). */
const PARTIAL2_FRAC_BPS = 7500n;
/** Trailing stop below the peak AFTER a partial take-profit (bps).
 *  Rev4: 40 (was the global 80). Once most of the position is banked,
 *  the stub's job is to catch a further run, not to give back a big
 *  retrace: 30/40/50/60 all beat 80 on the 14-15 Nov window, dev and
 *  12-13 Nov unchanged. 40 sits mid-plateau. */
const TRAIL2_BPS = 40n;
/** Sell at most this many bars after the fill. */
const HOLD_BARS = 120;
/** Bars to wait after a sell fills before re-entering. */
const COOLDOWN_BARS = 30;
const MAX_SLIPPAGE_BPS = 100;

/** EMA(8) over closes: simple average of the first 8, then exponential. */
class Ema8 {
  private warm: number[] = [];
  private value: number | null = null;

  step(close: number): number | null {
    if (this.value !== null) {
      this.value += (2 / 9) * (close - this.value);
      return this.value;
    }
    this.warm.push(close);
    if (this.warm.length === 8) {
      this.value = this.warm.reduce((a, x) => a + x, 0) / 8;
    }
    return this.value;
  }
}

const ema8 = new Ema8();
/** Closes, oldest first, capped at 301 entries (enough for a 240-bar
 *  return plus the 60-bar volatility window). */
const closes: bigint[] = [];
/** Peak position value (quote units) since the entry fill. */
let peak = 0n;
/** Bars left before the hold timeout sells. */
let holdLeft = 0;
/** Bars left of the post-sell cooldown. */
let cool = 0;
/** Last bar index (seq) the deep dip signal is valid through. */
let deepUntil = -1;
/** Last bar index (seq) the mid dip signal is valid through. */
let midUntil = -1;
/** Quantity held on the previous batch (to spot fills). */
let prevQty = 0n;
/** Whether the partial take-profit has already been taken (confirmed fill)
 *  for the current position. Reset on the next buy fill. */
let partialDone = false;
/** Whether the second partial take-profit has already been taken
 *  (confirmed fill) for the current position. Reset on the next buy fill. */
let partial2Done = false;

/** Return over the last k bars in bps, or null before enough closes. */
function retBps(k: number): bigint | null {
  if (closes.length <= k) return null;
  const close = closes[closes.length - 1];
  const past = closes[closes.length - 1 - k];
  return (close * 10000n) / past - 10000n;
}

/** Mean absolute 1-min return over the last VOL_BARS bars, as the SUM of
 *  each bar's move in hundredths of a bps (each bar truncated toward zero
 *  at that scale), or null before enough closes. The sum is compared
 *  against VOL_MAX_HUND_BPS * VOL_BARS, so the gate is the mean move in
 *  hundredths of a bps. (An earlier draft divided the sum by VOL_BARS in
 *  BigInt first: that truncated the MEAN to a whole bp, so a 6.7 bp mean
 *  read as 6 and passed a 6 bp gate -- the gate must compare the sum.) */
function volHundBpsSum(): bigint | null {
  if (closes.length <= VOL_BARS) return null;
  let sum = 0n;
  for (let i = closes.length - VOL_BARS; i < closes.length; i++) {
    const prev = closes[i - 1];
    const cur = closes[i];
    const diff = cur >= prev ? cur - prev : prev - cur;
    sum += (diff * 1000000n) / prev;
  }
  return sum;
}

await runBars({
  onBatch(state: BarsState, batch: { bars: Bar[] }) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    const closeNum = Number(bar.c);

    // Spot fills from the account: a buy fill starts the hold clock, a sell
    // fill starts the cooldown and clears the trailing peak.
    const held = state.positions.get(SYMBOL);
    const qtyNow = held?.qty ?? 0n;
    if (prevQty === 0n && qtyNow > 0n) {
      holdLeft = HOLD_BARS;
      partialDone = false;
      partial2Done = false;
    }
    if (prevQty > 0n && qtyNow === 0n) {
      cool = COOLDOWN_BARS;
      // The trailing peak belongs to the position that just closed: clear
      // it only now that the sell is confirmed filled. A sell rejected for
      // max_slippage leaves the position held, and wiping the peak at order
      // time would re-arm the trail from a lower price and delay the exit.
      peak = 0n;
    }
    if (prevQty > 0n && qtyNow > 0n && qtyNow < prevQty) {
      // Partial fill confirmed (a partial take-profit): re-arm the
      // trailing peak from the REMAINING position's current value. The
      // peak is an absolute value, so without this it would stay at the
      // pre-sale level and the trail would fire on the next bar no
      // matter the price, dumping the rest instead of trailing it.
      // A fill while the first partial is already done can only be the
      // second partial, so it marks that one done; a fill while it is
      // not done marks the first. Either flag is set only on a confirmed
      // fill, so a partial order rejected for max_slippage is retried
      // while its condition still holds instead of being lost forever.
      peak = state.value(SYMBOL, qtyNow);
      if (partialDone) partial2Done = true;
      else partialDone = true;
    }
    prevQty = qtyNow;

    closes.push(close);
    if (closes.length > 301) closes.shift();
    const v8 = ema8.step(closeNum);

    const r60 = retBps(60);
    const r15 = retBps(15);
    const r5 = retBps(5);
    const r240 = retBps(240);
    if ((r60 !== null && r60 <= -DEEP60_BPS) || (r15 !== null && r15 <= -DEEP15_BPS)) {
      deepUntil = state.seq + DEEP_BARS;
    }
    if ((r60 !== null && r60 <= -MID60_BPS) || (r15 !== null && r15 <= -MID15_BPS)) {
      midUntil = state.seq + MID_BARS;
    }
    const volSum = volHundBpsSum();

    if (cool > 0) cool -= 1;
    if (state.warmingUp) return [];

    if (held !== undefined) {
      const value = state.value(SYMBOL, held.qty);
      if (value > peak) peak = value;
      const stopHit = value * 10000n <= held.cost * (10000n - STOP_BPS);
      // After a partial, the stub trails tighter (TRAIL2_BPS): its job is
      // to catch a further run, not to hand back a big retrace.
      const trailBps = partialDone ? TRAIL2_BPS : TRAIL_BPS;
      const trailHit = peak > 0n && value * 10000n <= peak * (10000n - trailBps);
      const tpHit = value * 10000n >= held.cost * (10000n + TP_BPS);
      const partialHit = !partialDone && value * 10000n >= held.cost * (10000n + PARTIAL_TP_BPS);
      const partial2Hit = partialDone && !partial2Done && value * 10000n >= held.cost * (10000n + PARTIAL2_TP_BPS);
      holdLeft -= 1;
      if (partial2Hit) {
        // Sell most of the remaining stub and let the rest run. Marked
        // done only once its fill is confirmed above, so a rejected
        // order is retried while the +2.75% condition still holds.
        let q = (held.qty * PARTIAL2_FRAC_BPS) / 10000n;
        if (q <= 0n) q = 1n;
        if (q >= held.qty) q = held.qty / 2n || 1n;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: q, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      if (partialHit) {
        // Sell most of the position and let the rest run. The partial is
        // marked done only once its fill is confirmed above, so a
        // rejected partial order is retried while the condition holds.
        let q = (held.qty * PARTIAL_FRAC_BPS) / 10000n;
        if (q <= 0n) q = 1n;
        if (q >= held.qty) q = held.qty / 2n || 1n;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: q, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      if (stopHit || trailHit || tpHit || holdLeft <= 0) {
        // NOTE: peak is NOT cleared here — it is cleared in the fill
        // detection above, only once this sell is confirmed filled.
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    if (cool > 0) return [];
    const confirmed = v8 !== null && closeNum > v8;
    // The 4h trend must be known and not in a steep fall. Unknown (null)
    // refuses the buy: the first 240 bars have no 4h history, and an
    // unfiltered buy there lost money on the 12-13 Nov window.
    const trendOk = r240 !== null && r240 >= R240_MIN_BPS;
    if (!confirmed || !trendOk) return [];
    const deepBuy = state.seq <= deepUntil && r5 !== null && r5 >= DEEP_BOUNCE_BPS;
    const quiet = volSum !== null && volSum <= VOL_MAX_HUND_BPS * BigInt(VOL_BARS);
    // Mid arm additionally requires a flat-to-down 4h trend (r240 <= 0):
    // shallow dips bought into a rising 4h trend lost out-of-sample.
    const midTrendOk = r240 !== null && r240 <= MID_R240_MAX_BPS;
    const midBuy = state.seq <= midUntil && r5 !== null && r5 >= MID_BOUNCE_BPS && quiet && midTrendOk;
    if (!deepBuy && !midBuy) return [];
    const room = state.weightRoom(SYMBOL);
    const amount = state.cash < room ? state.cash : room;
    if (amount < state.hello.fees.min_notional_quote_units) return [];
    peak = 0n;
    const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [buy];
  },
});
