// Broad-flow momentum rider for the pump.fun replay (agent-fun/replay/v2).
//
// Market shape: every coin is a bonding curve. Price is virtual SOL reserves
// over virtual token reserves; a coin graduates when its real SOL reserves
// fill the curve, and the overwhelming majority of coins die within minutes
// of launch. Chasing every new coin bleeds fees (about 1% of curve fees on
// each side, plus a fixed tx fee per order, plus a share of failed txs), so
// this bot only rides coins whose demand is already proven and broad:
//
//   - the curve survived its first minute and holds a real-reserve floor;
//   - over the last FLOW_WINDOW slots the flow is one-sided: most SOL is
//     buying, from many distinct wallets, with net inflow positive;
//   - the price is rising over the window and still near its window high;
//   - the coin's creator has not sold a single token (a creator sell is the
//     most reliable death signal on this venue).
//
// Exits are rule-based and fee-aware: a hard stop, a trailing stop that arms
// once a run is real, a flow-fade exit when the crowd turns, an instant exit
// on a creator sell or a whale flush, and a maximum hold. Position size is a
// fixed slice of the starting capital, scaled up only for the broadest flow,
// and never past the harness's per-mint reserve cap.
//
// Everything is a pure function of the hello, the batch events and the fills:
// integer (bigint) math only, no clock, no environment, no randomness, so the
// two graded executions produce byte-identical action logs.

import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';
import { LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;

// ---- entry tuning -----------------------------------------------------------
const MIN_AGE_SLOTS = 150; // ~1 minute: skip the sniper noise at launch
const MAX_AGE_SLOTS = 30_000; // stale curves rarely start a second life
const RESERVE_FLOOR = 6n * SOL; // real SOL reserves: the coin survived
const FLOW_WINDOW = 120; // slots of flow history behind every decision
const MIN_FLOW_BUY = 3n * SOL; // SOL of buys inside the window
const MIN_BUY_SHARE_BPS = 6_500; // buys are at least 65% of window flow
const MIN_DISTINCT_BUYERS = 8; // breadth: not one whale carrying the coin
const MIN_RISE_BPS = 1_000; // price up at least 10% across the window
const MAX_DIP_FROM_HIGH_BPS = 1_500; // still within 15% of the window high
const BASE_SIZE = (SOL * 3n) / 10n; // 0.30 SOL per position
const STRONG_SIZE = SOL / 2n; // 0.50 SOL when the flow is exceptional
const STRONG_BUY_SHARE_BPS = 8_000;
const STRONG_DISTINCT_BUYERS = 15;
const MAX_POSITIONS = 5;
const CASH_BUFFER = SOL; // never commit the last SOL
const BUY_SLIPPAGE_BPS = 500;
const REENTRY_COOLDOWN = 600; // slots to sit out a mint after exiting it

// ---- exit tuning ------------------------------------------------------------
const HARD_STOP_BPS = 3_000; // value 30% under cost: sell everything
const TRAIL_ARM_BPS = 5_000; // trailing arms once value is 50% over cost
const TRAIL_DROP_BPS = 2_800; // then sell 28% under the peak value
const MAX_HOLD_SLOTS = 7_200; // ~48 minutes at 0.4 s slots
const WHALE_SELL = 2n * SOL; // one sell this big is a flush signal
const SELL_SLIPPAGE_BPS = 800;

interface FlowTrade {
  slot: number;
  sol: bigint;
  buy: boolean;
  user: string;
  price: bigint; // curve price right after this trade
}

interface MintWatch {
  creator: string;
  createdSlot: number;
  creatorSold: boolean;
  complete: boolean;
  lastSlot: number;
  lastPrice: bigint; // virtual quote per token, scaled by PRICE_SCALE
  window: FlowTrade[]; // recent trades, oldest first (watched mints only)
  windowHigh: bigint; // highest price inside the window
  priceWindowStart: bigint; // price at the start of the window (0 = unknown)
}

interface Held {
  entrySlot: number;
  peakValue: bigint;
  sellPending: boolean;
}

const PRICE_SCALE = 1_000_000_000n; // price = vQuote * SCALE / vToken

function priceOf(vQuote: bigint, vToken: bigint): bigint {
  if (vToken <= 0n) return 0n;
  return (vQuote * PRICE_SCALE) / vToken;
}

export class MomentumRider {
  private watch = new Map<string, MintWatch>();
  private held = new Map<string, Held>();
  private cooldownUntil = new Map<string, number>();
  private buyPending = new Set<string>();
  private lastPrune = 0;

  onHello(_state: BotState): void {
    // Nothing to seed: every parameter is fixed above so the run is a pure
    // function of the batches.
  }

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    this.foldFills(state, batch);
    this.foldEvents(batch);

    const orders: OrderInput[] = [];
    this.planExits(state, batch, orders);
    this.planEntries(state, batch, orders);

    if (slot - this.lastPrune >= 1_000) {
      this.lastPrune = slot;
      this.prune(slot);
    }
    return orders;
  }

  // ---- bookkeeping ----------------------------------------------------------

  private foldFills(state: BotState, batch: Batch): void {
    for (const fill of batch.fills) {
      const mint = fill.mint;
      if (fill.client_id.startsWith('_')) {
        // Harness closes (_complete_, _flatten_, _writeoff_) end a position.
        this.held.delete(mint);
        continue;
      }
      if (fill.side === 'buy') {
        this.buyPending.delete(mint);
        if (fill.status === 'filled' && !this.held.has(mint)) {
          this.held.set(mint, { entrySlot: batch.slot, peakValue: 0n, sellPending: false });
        }
      } else {
        const h = this.held.get(mint);
        if (h) h.sellPending = false;
        if (fill.status === 'filled') {
          this.held.delete(mint);
          this.cooldownUntil.set(mint, batch.slot + REENTRY_COOLDOWN);
        }
      }
    }
    // Reconcile with the account the harness reports: a position that is no
    // longer there is gone, whatever the fills said.
    for (const mint of [...this.held.keys()]) {
      if (!state.positions.has(mint)) this.held.delete(mint);
    }
  }

  private foldEvents(batch: Batch): void {
    for (const ev of batch.events) {
      if (ev.event === 'CreateEvent') {
        if (!this.watch.has(ev.mint)) {
          this.watch.set(ev.mint, {
            creator: ev.creator,
            createdSlot: ev.slot,
            creatorSold: false,
            complete: false,
            lastSlot: ev.slot,
            lastPrice: priceOf(BigInt(ev.virtual_quote_reserves), BigInt(ev.virtual_token_reserves)),
            window: [],
            windowHigh: 0n,
            priceWindowStart: 0n,
          });
        }
        continue;
      }
      if (ev.event === 'CompleteEvent') {
        const w = this.watch.get(ev.mint);
        if (w) w.complete = true;
        continue;
      }
      // TradeEvent
      let w = this.watch.get(ev.mint);
      if (!w) {
        w = {
          creator: ev.creator,
          createdSlot: ev.slot,
          creatorSold: false,
          complete: false,
          lastSlot: ev.slot,
          lastPrice: 0n,
          window: [],
          windowHigh: 0n,
          priceWindowStart: 0n,
        };
        this.watch.set(ev.mint, w);
      }
      w.lastSlot = ev.slot;
      w.lastPrice = priceOf(BigInt(ev.virtual_quote_reserves), BigInt(ev.virtual_token_reserves));
      if (ev.user === w.creator && !ev.is_buy) w.creatorSold = true;

      // Keep a rolling window only for mints that are anywhere near the
      // reserve floor; the rest cost two counters and nothing else.
      const realQuote = BigInt(ev.real_quote_reserves);
      if (realQuote >= RESERVE_FLOOR / 2n || this.held.has(ev.mint) || this.buyPending.has(ev.mint)) {
        w.window.push({ slot: ev.slot, sol: BigInt(ev.sol_amount), buy: ev.is_buy, user: ev.user, price: w.lastPrice });
        while (w.window.length > 0 && ev.slot - w.window[0].slot > FLOW_WINDOW) w.window.shift();
        // Recompute the window anchors from what is actually in the window.
        w.priceWindowStart = w.window.length > 0 ? w.window[0].price : 0n;
        w.windowHigh = 0n;
        for (const t of w.window) if (t.price > w.windowHigh) w.windowHigh = t.price;
      }
    }
  }

  private windowStats(w: MintWatch, slot: number): {
    buySol: bigint;
    sellSol: bigint;
    buyers: Set<string>;
    whaleSell: boolean;
  } {
    let buySol = 0n;
    let sellSol = 0n;
    let whaleSell = false;
    const buyers = new Set<string>();
    for (const t of w.window) {
      if (slot - t.slot > FLOW_WINDOW) continue;
      if (t.buy) {
        buySol += t.sol;
        buyers.add(t.user);
      } else {
        sellSol += t.sol;
        if (t.sol >= WHALE_SELL) whaleSell = true;
      }
    }
    return { buySol, sellSol, buyers, whaleSell };
  }

  private positionValue(state: BotState, mint: string): bigint {
    const pos = state.positions.get(mint);
    const curve = state.curves.get(mint);
    if (!pos || !curve || curve.virtual_token_reserves <= 0n) return 0n;
    // Mark at the curve: tokens * virtual quote / virtual token reserves.
    return (pos.token_amount * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
  }

  // ---- exits ----------------------------------------------------------------

  private planExits(state: BotState, batch: Batch, orders: OrderInput[]): void {
    const slot = batch.slot;
    for (const [mint, h] of this.held) {
      const pos = state.positions.get(mint);
      if (!pos || h.sellPending) continue;
      const value = this.positionValue(state, mint);
      if (value > h.peakValue) h.peakValue = value;
      const cost = pos.cost_lamports;
      const w = this.watch.get(mint);

      let exit = false;
      if (w && w.creatorSold) exit = true; // creator bailed: leave now
      else if (value > 0n && value * 10_000n <= cost * BigInt(10_000 - HARD_STOP_BPS)) exit = true;
      else if (
        h.peakValue > 0n &&
        h.peakValue * 10_000n >= cost * BigInt(10_000 + TRAIL_ARM_BPS) &&
        value * 10_000n <= h.peakValue * BigInt(10_000 - TRAIL_DROP_BPS)
      ) {
        exit = true; // trailing stop on an armed run
      } else if (slot - h.entrySlot >= MAX_HOLD_SLOTS) exit = true;
      else if (w) {
        const s = this.windowStats(w, slot);
        if (s.whaleSell) exit = true;
        else if (s.sellSol > s.buySol && s.sellSol >= SOL) exit = true; // flow faded
      }

      if (exit) {
        h.sellPending = true;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
      }
    }
  }

  // ---- entries --------------------------------------------------------------

  private planEntries(state: BotState, batch: Batch, orders: OrderInput[]): void {
    const slot = batch.slot;
    const maxPos = Math.min(MAX_POSITIONS, state.hello.caps.max_open_positions);
    let committed = state.committedPositionCount();
    if (committed >= maxPos) return;

    for (const [mint, w] of this.watch) {
      if (committed >= maxPos) break;
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (this.held.has(mint) || this.buyPending.has(mint)) continue;
      if (w.complete || w.creatorSold) continue;
      const age = slot - w.createdSlot;
      if (age < MIN_AGE_SLOTS || age > MAX_AGE_SLOTS) continue;
      if ((this.cooldownUntil.get(mint) ?? -1) > slot) continue;

      const curve = state.curves.get(mint);
      if (!curve || curve.complete) continue;
      if (curve.real_quote_reserves < RESERVE_FLOOR) continue;

      const s = this.windowStats(w, slot);
      const flow = s.buySol + s.sellSol;
      if (s.buySol < MIN_FLOW_BUY || flow <= 0n) continue;
      if (s.buySol * 10_000n < flow * BigInt(MIN_BUY_SHARE_BPS)) continue;
      if (s.buyers.size < MIN_DISTINCT_BUYERS) continue;

      // Momentum: price now vs the price at the window's start, and the dip
      // from the window high.
      if (w.priceWindowStart <= 0n || w.lastPrice <= 0n) continue;
      if (w.lastPrice * 10_000n < w.priceWindowStart * BigInt(10_000 + MIN_RISE_BPS)) continue;
      if (w.windowHigh > 0n && w.lastPrice * 10_000n < w.windowHigh * BigInt(10_000 - MAX_DIP_FROM_HIGH_BPS)) continue;

      const strong =
        s.buySol * 10_000n >= flow * BigInt(STRONG_BUY_SHARE_BPS) && s.buyers.size >= STRONG_DISTINCT_BUYERS;
      let size = strong ? STRONG_SIZE : BASE_SIZE;
      const cap = state.maxBuyLamports(mint);
      if (cap <= 0n) continue;
      if (size > cap) size = cap;
      const free = state.freeCashLamports();
      if (free - size < CASH_BUFFER) continue;
      if (size < SOL / 20n) continue; // under 0.05 SOL the fees eat the trade

      this.buyPending.add(mint);
      committed += 1;
      orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
    }
  }

  // ---- memory ---------------------------------------------------------------

  private prune(slot: number): void {
    for (const [mint, w] of this.watch) {
      if (this.held.has(mint) || this.buyPending.has(mint)) continue;
      if (slot - w.lastSlot > 3_000) this.watch.delete(mint);
    }
    for (const [mint, until] of this.cooldownUntil) {
      if (until <= slot) this.cooldownUntil.delete(mint);
    }
  }
}
