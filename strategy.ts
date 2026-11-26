// Selective scalp rider for the pump.fun replay (agent-fun/replay/v2).
//
// Why the previous broad momentum rider lost: it round-tripped 168 times at
// an 18% win rate. On this venue a round trip costs about 2.5% in curve
// fees (95 bps protocol + 30 bps creator, each side) plus 0.000105 SOL of
// fixed tx fees, and most coins that have already run hard are at their top.
// Chasing them with a 30% hard stop and a trailing stop that only armed at
// +50% meant the average loser dwarfed the average winner.
//
// This rewrite trades far less and gets out fast:
//
//   Entries — only coins whose demand is proven but whose price is not yet
//   extended: real reserves at or above 10 SOL (so the 1%-of-reserve order
//   cap still allows a meaningful size), a short recent window in which
//   buys are at least 75% of flow from at least 10 distinct wallets, and a
//   price that rose between 4% and 30% across the window and sits within
//   8% of the window high. A creator sell at any point disqualifies the
//   coin forever.
//
//   Exits — fee-aware scalping: take profit at +12% of value over cost,
//   a trailing stop that arms at +10% and fires 6% under the peak, a hard
//   stop at -9%, an instant exit on a creator sell or a whale flush, a
//   flow-fade exit, and a maximum hold of 800 slots (~5 minutes). No
//   position is ever averaged down and no mint is re-entered for 1,500
//   slots after an exit. (An earlier, slower exit set — +16% take profit,
//   -11% stop, 1,500-slot hold — graded lower on the dev tape; faster
//   exits recycle capital into fresh setups instead of riding fades.)
//
//   Sizing — a fixed 0.30 SOL slice, capped by the harness's per-mint
//   reserve cap, at most 3 open positions, and a 1 SOL cash buffer.
//
// Everything is a pure function of the hello, the batch events and the
// fills: integer (bigint) math only, no clock, no environment, no
// randomness, so the two graded executions produce byte-identical logs.

import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';
import { LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;

// ---- entry tuning -----------------------------------------------------------
const MIN_AGE_SLOTS = 100; // skip the sniper noise at launch
const MAX_AGE_SLOTS = 12_000; // stale curves rarely start a second life
const RESERVE_FLOOR = 10n * SOL; // real SOL reserves: the coin survived
const FLOW_WINDOW = 90; // slots of flow history behind every decision
const MIN_FLOW_BUY = 2n * SOL; // SOL of buys inside the window
const MIN_BUY_SHARE_BPS = 7_500; // buys are at least 75% of window flow
const MIN_DISTINCT_BUYERS = 10; // breadth: not one whale carrying the coin
const MIN_RISE_BPS = 400; // price up at least 4% across the window
const MAX_RISE_BPS = 3_000; // but not already extended: no blow-off tops
const MAX_DIP_FROM_HIGH_BPS = 800; // still within 8% of the window high
const SIZE = (SOL * 3n) / 10n; // 0.30 SOL per position (reserve cap applies)
const MAX_POSITIONS = 3;
const CASH_BUFFER = SOL; // never commit the last SOL
const BUY_SLIPPAGE_BPS = 500;
const REENTRY_COOLDOWN = 1_500; // slots to sit out a mint after exiting it

// ---- exit tuning ------------------------------------------------------------
const TAKE_PROFIT_BPS = 1_200; // value 12% over cost: sell everything
const HARD_STOP_BPS = 900; // value 9% under cost: sell everything
const TRAIL_ARM_BPS = 1_000; // trailing arms once value is 10% over cost
const TRAIL_DROP_BPS = 600; // then sell 6% under the peak value
const MAX_HOLD_SLOTS = 800; // ~5 minutes at 0.4 s slots
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
      else if (value > 0n && value * 10_000n >= cost * BigInt(10_000 + TAKE_PROFIT_BPS)) exit = true;
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
        else if (s.sellSol > s.buySol && s.sellSol >= SOL / 2n) exit = true; // flow faded
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

      // Momentum, but not extension: price rose across the window, is not
      // up more than MAX_RISE_BPS, and sits near the window high.
      if (w.priceWindowStart <= 0n || w.lastPrice <= 0n) continue;
      if (w.lastPrice * 10_000n < w.priceWindowStart * BigInt(10_000 + MIN_RISE_BPS)) continue;
      if (w.lastPrice * 10_000n > w.priceWindowStart * BigInt(10_000 + MAX_RISE_BPS)) continue;
      if (w.windowHigh > 0n && w.lastPrice * 10_000n < w.windowHigh * BigInt(10_000 - MAX_DIP_FROM_HIGH_BPS)) continue;

      let size = SIZE;
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
