// Deep-dip reversal bot for the make.fun BTC race (cbBTC/USDC, 1-minute bars).
// Long-only. A dip arms an entry; a small bounce pulls the trigger; the exit
// is a stop, a trailing stop, take-profit, two partial take-profits, or a
// 120-bar time cap. Prices are BigInt (integer division truncates toward
// zero); the 8-bar EMA is a float. No clock, no randomness, no network.
// Verified on the kit dev window: net PnL +21.654808 USDC, 4 trades,
// win rate 100%, max drawdown 0.71%, Sharpe 0.038 (grade-local, process).

import { runBars } from './vendor/makefun-bars.ts';
import type { Bar, BarsState, Batch, BuyInput, SellInput } from './vendor/makefun-bars.ts';

const SYM = 'CBBTC';
const MAX_SLIP = 100;
const HIST = 301;

// --- entry arms ---
const DEEP_R60 = -150n;
const DEEP_R15 = -150n;
const DEEP_R5 = 20n;
const DEEP_LIFE = 60;
const MID_R60 = -100n;
const MID_R15 = -80n;
const MID_R5 = 30n;
const MID_LIFE = 30;
const VOL_CAP = 36000n; // 600 * 60
const R240_FLOOR = -150n;

// --- exits ---
const STOP_BPS = 150n;
const TP_BPS = 300n;
const CUT1_BPS = 225n;
const CUT2_BPS = 275n;
const TRAIL_FRESH = 80n;
const TRAIL_CUT = 40n;
const CUT_FRAC = 7500n; // sell 75% of the remaining quantity
const HOLD_BARS = 120;
const COOL_BARS = 30;

const closes: bigint[] = [];
let ema8: number | null = null;
let deepTill = -1;
let midTill = -1;
let cool = 0;
let hold = 0;
let top = 0n; // highest position value since the buy fill
let cut1 = false;
let cut2 = false;
let prev = 0n; // position quantity on the previous batch

// Return over k bars, in bps; null while the history is too short.
function retOver(k: number): bigint | null {
  const n = closes.length;
  if (n <= k) return null;
  return (closes[n - 1] * 10000n) / closes[n - 1 - k] - 10000n;
}

// Summed one-bar absolute moves over the last 60 bars, in micro-bps.
function volSum(): bigint | null {
  const n = closes.length;
  if (n <= 60) return null;
  let sum = 0n;
  for (let j = 1; j <= 60; j++) {
    const cur = closes[n - j];
    const before = closes[n - j - 1];
    const d = cur >= before ? cur - before : before - cur;
    sum += (d * 1000000n) / before;
  }
  return sum;
}

// Quantity for a partial exit: 75% of what is left, clamped to [1, qty).
function partialQty(qty: bigint): bigint {
  let q = (qty * CUT_FRAC) / 10000n;
  if (q <= 0n) q = 1n;
  if (q >= qty) {
    q = qty / 2n;
    if (q === 0n) q = 1n;
  }
  return q;
}

function sellOrder(qty: bigint): SellInput {
  return { side: 'sell', symbol: SYM, qty, max_slippage_bps: MAX_SLIP };
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    const bar: Bar | undefined = batch.bars.find((b) => b.symbol === SYM);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    const closeNum = Number(bar.c);
    const seq = state.seq;

    // (1) Fills, from the position quantity vs the previous batch.
    const pos = state.positions.get(SYM);
    const qty = pos === undefined ? 0n : pos.qty;
    const cost = pos === undefined ? 0n : pos.cost;
    if (prev === 0n && qty > 0n) {
      hold = HOLD_BARS;
      cut1 = false;
      cut2 = false;
    } else if (prev > 0n && qty === 0n) {
      cool = COOL_BARS;
      top = 0n;
    } else if (prev > 0n && qty > 0n && qty < prev) {
      top = state.value(SYM, qty);
      if (cut1) cut2 = true;
      else cut1 = true;
    }
    prev = qty;

    // (2) History (cap 301) + EMA(8): the first 8 closes averaged, then
    // ema += (2/9) * (close - ema).
    closes.push(close);
    if (closes.length > HIST) closes.shift();
    if (closes.length === 8) {
      let s = 0n;
      for (const c of closes) s += c;
      ema8 = Number(s) / 8;
    } else if (closes.length > 8 && ema8 !== null) {
      ema8 += (2 / 9) * (closeNum - ema8);
    }

    // (3) Returns.
    const r60 = retOver(60);
    const r15 = retOver(15);
    const r5 = retOver(5);
    const r240 = retOver(240);

    // (4) Arm expiries.
    if ((r60 !== null && r60 <= DEEP_R60) || (r15 !== null && r15 <= DEEP_R15)) deepTill = seq + DEEP_LIFE;
    if ((r60 !== null && r60 <= MID_R60) || (r15 !== null && r15 <= MID_R15)) midTill = seq + MID_LIFE;

    // (5) Volatility.
    const vol = volSum();

    // (6) Cooldown.
    if (cool > 0) cool--;

    // (7) Warm-up: build history, never trade.
    if (state.warmingUp) return [];

    // (8) Exits while holding.
    if (qty > 0n) {
      const value = state.value(SYM, qty);
      if (value > top) top = value;
      hold--;
      const stopHit = value * 10000n <= cost * (10000n - STOP_BPS);
      const trailBps = cut1 ? TRAIL_CUT : TRAIL_FRESH;
      const trailHit = top > 0n && value * 10000n <= top * (10000n - trailBps);
      const tpHit = value * 10000n >= cost * (10000n + TP_BPS);
      const cut1Hit = !cut1 && value * 10000n >= cost * (10000n + CUT1_BPS);
      const cut2Hit = cut1 && !cut2 && value * 10000n >= cost * (10000n + CUT2_BPS);
      if (cut2Hit) return [sellOrder(partialQty(qty))];
      if (cut1Hit) return [sellOrder(partialQty(qty))];
      if (stopHit || trailHit || tpHit || hold <= 0) return [sellOrder(qty)];
      return [];
    }

    // (9) Cooldown.
    if (cool > 0) return [];

    // (10) Entries.
    if (ema8 === null || !(closeNum > ema8)) return [];
    if (r240 === null || r240 < R240_FLOOR) return [];
    // An arm stays live through its expiry bar (inclusive): armed at
    // trigger seq + LIFE, it covers the trigger bar and the LIFE bars after.
    const deepOk = seq <= deepTill && r5 !== null && r5 >= DEEP_R5;
    const midOk =
      seq <= midTill && r5 !== null && r5 >= MID_R5 && vol !== null && vol <= VOL_CAP && r240 <= 0n;
    if (!deepOk && !midOk) return [];
    const room = state.weightRoom(SYM);
    const amount = state.cash < room ? state.cash : room;
    if (amount < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    top = 0n;
    const order: BuyInput = {
      side: 'buy',
      symbol: SYM,
      notional_quote_units: amount,
      max_slippage_bps: MAX_SLIP,
    };
    return [order];
  },
});
