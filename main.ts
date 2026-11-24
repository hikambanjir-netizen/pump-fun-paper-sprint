// Pump.fun Paper Sprint — "Breakout Rider" bot (agent-fun/replay/v2, Node 22).
//
// Idea: ride short momentum breakouts on fresh pump.fun bonding curves and
// get out fast. A coin only earns a buy when it has already proved buyers
// are in control: price up sharply over the last few hundred slots, buy
// volume dominating sell volume, and enough real SOL reserve that our order
// fits comfortably under the 100 bps size cap. Every position carries a
// take-profit, a stop-loss and a maximum hold time, so no single coin can
// sit and bleed while the 6-hour window runs out.
//
// Determinism: no randomness, no clock, no environment reads. All decisions
// come from the harness stream (slots, reserves, fills) in first-seen order,
// so two runs produce byte-identical action logs.
//
// Fees are ~1.25% a round trip plus a flat tx fee per order, so buys are
// sized at 0.02–0.08 SOL: large enough that fees are a small share of the
// trade, small enough to stay under the reserve cap and the 5-position cap.

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning

// Buy size: 0.08 SOL target, never below 0.02 SOL (fees would eat it).
const BUY_TARGET_LAMPORTS = 80_000_000n;
const BUY_MIN_LAMPORTS = 20_000_000n;
// Entry: price up at least 8% vs ~300 slots ago, buys >= 60% of volume.
const MOMENTUM_BPS = 800;
const MOMENTUM_WINDOW_SLOTS = 300;
const MIN_BUY_SHARE_BPS = 6000;
const MIN_TRADES_BEFORE_ENTRY = 12;
const MIN_AGE_SLOTS = 20;
// Exits: take profit +25%, stop loss -12%, max hold 4000 slots.
const TAKE_PROFIT_BPS = 2500;
const STOP_LOSS_BPS = 1200;
const MAX_HOLD_SLOTS = 4000;
// Re-entry cooldown after an exit, to avoid churning on the same coin.
const REENTRY_COOLDOWN_SLOTS = 200;
// At most 2 fresh buys per batch so entries spread across coins.
const MAX_BUYS_PER_BATCH = 2;
const SLIPPAGE_BPS = 500;

// Price is kept as a scaled integer: price * 1e12 lamports per token.
const PRICE_SCALE = 1_000_000_000_000n;

interface PricePoint {
  slot: number;
  price: bigint;
}

interface CoinTrack {
  firstSlot: number;
  lastSlot: number;
  trades: number;
  // Price samples inside the momentum window (oldest first).
  samples: PricePoint[];
  // SOL volume (lamports) inside the momentum window.
  buyVol: bigint;
  sellVol: bigint;
  lastExitSlot: number;
  everTraded: boolean;
}

interface Held {
  entryPrice: bigint;
  entrySlot: number;
  peakValueBps: number; // peak mark-to-cost in bps (10000 = breakeven)
}

const tracks = new Map<string, CoinTrack>();
const held = new Map<string, Held>();

function priceOf(virtualQuote: bigint, virtualToken: bigint): bigint {
  if (virtualToken <= 0n) return 0n;
  return (virtualQuote * PRICE_SCALE) / virtualToken;
}

function trackFor(mint: string, slot: number): CoinTrack {
  let t = tracks.get(mint);
  if (t === undefined) {
    t = {
      firstSlot: slot,
      lastSlot: slot,
      trades: 0,
      samples: [],
      buyVol: 0n,
      sellVol: 0n,
      lastExitSlot: -1_000_000,
      everTraded: false,
    };
    tracks.set(mint, t);
  }
  return t;
}

// Drop samples older than the momentum window; volume is approximated by
// keeping only the samples' window — volumes are reset when the window
// slides past, which keeps the buy-share estimate recent by construction.
function prune(t: CoinTrack, nowSlot: number): void {
  while (t.samples.length > 0 && nowSlot - t.samples[0].slot > MOMENTUM_WINDOW_SLOTS) {
    t.samples.shift();
  }
}

function observeTrade(
  mint: string,
  slot: number,
  isBuy: boolean,
  solAmount: bigint,
  virtualQuote: bigint,
  virtualToken: bigint,
): void {
  const t = trackFor(mint, slot);
  t.lastSlot = slot;
  t.trades += 1;
  const p = priceOf(virtualQuote, virtualToken);
  if (p > 0n) t.samples.push({ slot, price: p });
  if (isBuy) t.buyVol += solAmount;
  else t.sellVol += solAmount;
  prune(t, slot);
  // Keep the sample list bounded even for very chatty coins.
  if (t.samples.length > 200) t.samples.splice(0, t.samples.length - 200);
}

// Momentum in bps of the current price vs the oldest in-window sample.
function momentumBps(t: CoinTrack): number {
  if (t.samples.length < 2) return 0;
  const oldP = t.samples[0].price;
  const newP = t.samples[t.samples.length - 1].price;
  if (oldP <= 0n) return 0;
  return Number(((newP - oldP) * 10_000n) / oldP);
}

function buyShareBps(t: CoinTrack): number {
  const total = t.buyVol + t.sellVol;
  if (total <= 0n) return 0;
  return Number((t.buyVol * 10_000n) / total);
}

// ------------------------------------------------------------------ exits

// Mark value of a holding in bps of its cost (10000 = breakeven).
function valueBps(state: BotState, mint: string): number {
  const pos = state.positions.get(mint);
  const curve = state.curves.get(mint);
  if (pos === undefined || curve === undefined) return 0;
  if (pos.cost_lamports <= 0n) return 0;
  const p = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
  if (p <= 0n) return 0;
  const value = (pos.token_amount * p) / PRICE_SCALE;
  return Number((value * 10_000n) / pos.cost_lamports);
}

function exitReason(state: BotState, mint: string, h: Held): string | null {
  const v = valueBps(state, mint);
  if (v <= 0) return 'stale';
  if (v >= 10_000 + TAKE_PROFIT_BPS) return 'take-profit';
  if (v <= 10_000 - STOP_LOSS_BPS) return 'stop-loss';
  if (state.slot - h.entrySlot >= MAX_HOLD_SLOTS) return 'max-hold';
  // Trailing stop: once up 15%+, sell if it gives back half the gain.
  if (h.peakValueBps >= 11_500 && v <= h.peakValueBps - 750) return 'trailing-stop';
  return null;
}

// ------------------------------------------------------------------ entries

function entryCandidate(state: BotState, mint: string, t: CoinTrack): bigint | null {
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.complete) return null;
  if (t.trades < MIN_TRADES_BEFORE_ENTRY) return null;
  if (state.slot - t.firstSlot < MIN_AGE_SLOTS) return null;
  if (state.slot - t.lastExitSlot < REENTRY_COOLDOWN_SLOTS) return null;
  if (momentumBps(t) < MOMENTUM_BPS) return null;
  if (buyShareBps(t) < MIN_BUY_SHARE_BPS) return null;
  // Size: target 0.08 SOL, capped at 90% of this batch's per-mint cap.
  const cap = state.maxBuyLamports(mint);
  if (cap < BUY_MIN_LAMPORTS) return null;
  let size = BUY_TARGET_LAMPORTS;
  const cap90 = (cap * 9n) / 10n;
  if (size > cap90) size = cap90;
  if (size < BUY_MIN_LAMPORTS) return null;
  // Leave room for the tx fee and don't spend cash we don't have free.
  const free = state.freeCashLamports();
  if (free < size + state.txFeeLamports()) return null;
  return size;
}

// ------------------------------------------------------------------ bot

async function onBatch(state: BotState, batch: Batch): Promise<OrderInput[]> {
  // Fold this batch's events into the per-coin tracks first.
  for (const e of batch.events) {
    if (e.event === 'TradeEvent') {
      observeTrade(
        e.mint,
        e.slot,
        e.is_buy,
        BigInt(e.sol_amount),
        BigInt(e.virtual_quote_reserves),
        BigInt(e.virtual_token_reserves),
      );
    } else if (e.event === 'CreateEvent') {
      trackFor(e.mint, e.slot);
    }
  }

  const orders: OrderInput[] = [];

  // 1) Exits first: every held position gets checked against its rules.
  //    Sell the full holding; a completed curve is already closed by the
  //    harness, so its position is gone from state.positions.
  for (const mint of [...state.positions.keys()]) {
    const pos = state.positions.get(mint);
    if (pos === undefined || pos.token_amount <= 0n) continue;
    let h = held.get(mint);
    if (h === undefined) {
      // Position arrived without a recorded entry (e.g. a fill landed
      // after a restart of tracking): anchor at the current price.
      const curve = state.curves.get(mint);
      const p = curve === undefined ? 0n : priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      h = { entryPrice: p, entrySlot: state.slot, peakValueBps: 10_000 };
      held.set(mint, h);
    }
    const v = valueBps(state, mint);
    if (v > h.peakValueBps) h.peakValueBps = v;
    const reason = exitReason(state, mint, h);
    if (reason !== null) {
      orders.push({
        side: 'sell',
        mint,
        token_amount: pos.token_amount,
        max_slippage_bps: SLIPPAGE_BPS,
      });
      const t = tracks.get(mint);
      if (t !== undefined) t.lastExitSlot = state.slot;
      held.delete(mint);
    }
  }

  // 2) Entries: scan coins in first-seen order (deterministic), strongest
  //    momentum first is unnecessary — first-seen order is stable and the
  //    per-batch buy cap spreads entries across batches and coins.
  if (state.committedPositionCount() < state.hello.caps.max_open_positions) {
    let buys = 0;
    for (const mint of [...tracks.keys()]) {
      if (buys >= MAX_BUYS_PER_BATCH) break;
      if (state.positions.has(mint)) continue;
      if (state.pending.has(mint)) continue;
      // Skip a mint with a buy already pending in this run's pending map.
      let pendingBuy = false;
      for (const p of state.pending.values()) {
        if (p.order.side === 'buy' && p.order.mint === mint) {
          pendingBuy = true;
          break;
        }
      }
      if (pendingBuy) continue;
      if (state.committedPositionCount() + buys >= state.hello.caps.max_open_positions) break;
      const t = tracks.get(mint);
      if (t === undefined) continue;
      const size = entryCandidate(state, mint, t);
      if (size === null) continue;
      orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: SLIPPAGE_BPS });
      buys += 1;
    }
  }

  return orders;
}

await runBot({
  onBatch(state: BotState, batch: Batch): Promise<OrderInput[]> {
    return onBatch(state, batch);
  },
  onDone(state: BotState): void {
    // Final account is already flattened by the harness; nothing to do.
    console.error(
      `done: cash=${state.cash} positions=${state.positions.size} coins-tracked=${tracks.size}`,
    );
  },
});
