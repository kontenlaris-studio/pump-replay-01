// Selective scalp rider for the pump.fun replay (agent-fun/replay/v2).
//
// Strategy summary
// ----------------
// Trade only after demand has been demonstrated, but before price becomes
// excessively extended. The entry gate requires meaningful real reserves,
// strongly buy-dominant recent flow, participation from at least ten distinct
// buyers, a moderate rise over the observation window, and a current price
// close to that window's high. A creator sell permanently disqualifies a mint.
//
// Open positions are managed as short-lived scalps. Profit is taken quickly,
// losses are cut at a fixed threshold, and an armed trailing exit protects a
// successful move. Creator selling, a large sell, deteriorating flow, or the
// maximum holding period can also close a position. Positions are never
// averaged down, and a recently exited mint enters a cooldown.
//
// All arithmetic used for decisions is deterministic bigint math. Decisions
// depend only on the hello, batches, and fills; there is no clock, random
// source, or environment access. Threshold comparisons intentionally use
// cross-multiplication rather than floating-point ratios.

import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';
import { LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;

// Entry configuration.
const MIN_AGE_SLOTS = 100; // Avoid launch-slot sniper noise.
const MAX_AGE_SLOTS = 12_000; // Do not chase stale curves.
const RESERVE_FLOOR = 10n * SOL; // Require at least 10 SOL in real reserves.
const FLOW_WINDOW = 90; // Slots retained for flow and price decisions.
const MIN_FLOW_BUY = 2n * SOL; // Minimum buys inside the window.
const MIN_BUY_SHARE_BPS = 7_500; // Buys must be at least 75% of flow.
const MIN_DISTINCT_BUYERS = 10; // Require breadth across wallets.
const MIN_RISE_BPS = 400; // At least +4% over the window.
const MAX_RISE_BPS = 3_000; // At most +30% over the window.
const MAX_DIP_FROM_HIGH_BPS = 800; // Stay within 8% of the window high.
const SIZE = (SOL * 3n) / 10n; // Intended 0.30 SOL order size.
const MAX_POSITIONS = 3;
const CASH_BUFFER = SOL; // Keep one SOL uncommitted.
const BUY_SLIPPAGE_BPS = 500;
const REENTRY_COOLDOWN = 1_500; // Slots before a mint can be entered again.

// Exit configuration.
const TAKE_PROFIT_BPS = 1_200; // Sell all at +12% by marked value.
const HARD_STOP_BPS = 900; // Sell all at -9% by marked value.
const TRAIL_ARM_BPS = 1_000; // Arm trailing protection at +10%.
const TRAIL_DROP_BPS = 600; // Exit after a 6% fall from peak value.
const MAX_HOLD_SLOTS = 800; // Approximately five minutes at 0.4s slots.
const WHALE_SELL = 2n * SOL; // Treat a single sell of this size as a flush.
const SELL_SLIPPAGE_BPS = 800;

interface FlowTrade {
  slot: number;
  sol: bigint;
  buy: boolean;
  user: string;
  price: bigint; // Curve price immediately after the trade.
}

interface MintWatch {
  creator: string;
  createdSlot: number;
  creatorSold: boolean;
  complete: boolean;
  lastSlot: number;
  lastPrice: bigint; // Virtual quote per token, scaled by PRICE_SCALE.
  window: FlowTrade[]; // Retained recent trades, oldest first.
  windowHigh: bigint; // Highest retained price.
  priceWindowStart: bigint; // Oldest retained price, or zero if unknown.
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
    // All behavior is parameterized above; no hello-dependent seed is needed.
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

  // Fill and position reconciliation.

  private foldFills(state: BotState, batch: Batch): void {
    for (const fill of batch.fills) {
      const mint = fill.mint;
      if (fill.client_id.startsWith('_')) {
        // Harness-generated closes end any locally tracked position.
        this.held.delete(mint);
        continue;
      }
      if (fill.side === 'buy') {
        this.buyPending.delete(mint);
        if (fill.status === 'filled' && !this.held.has(mint)) {
          this.held.set(mint, {
            entrySlot: batch.slot,
            peakValue: 0n,
            sellPending: false,
          });
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

    // The harness account is authoritative: if it no longer reports a
    // position, discard the local holding record.
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
            lastPrice: priceOf(
              BigInt(ev.virtual_quote_reserves),
              BigInt(ev.virtual_token_reserves),
            ),
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

      // Remaining events are TradeEvents.
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
      w.lastPrice = priceOf(
        BigInt(ev.virtual_quote_reserves),
        BigInt(ev.virtual_token_reserves),
      );
      if (ev.user === w.creator && !ev.is_buy) w.creatorSold = true;

      // Retain detailed flow only for mints near the reserve qualification,
      // plus any mint relevant to a current or pending position.
      const realQuote = BigInt(ev.real_quote_reserves);
      if (
        realQuote >= RESERVE_FLOOR / 2n ||
        this.held.has(ev.mint) ||
        this.buyPending.has(ev.mint)
      ) {
        w.window.push({
          slot: ev.slot,
          sol: BigInt(ev.sol_amount),
          buy: ev.is_buy,
          user: ev.user,
          price: w.lastPrice,
        });
        while (
          w.window.length > 0 &&
          ev.slot - w.window[0].slot > FLOW_WINDOW
        ) {
          w.window.shift();
        }
        w.priceWindowStart = w.window.length > 0 ? w.window[0].price : 0n;
        w.windowHigh = 0n;
        for (const t of w.window) {
          if (t.price > w.windowHigh) w.windowHigh = t.price;
        }
      }
    }
  }

  private windowStats(
    w: MintWatch,
    slot: number,
  ): {
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

    // Mark the token balance against the virtual curve reserves.
    return (
      (pos.token_amount * curve.virtual_quote_reserves) /
      curve.virtual_token_reserves
    );
  }

  // Exit planning.

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
      if (w && w.creatorSold) {
        exit = true;
      } else if (
        value > 0n &&
        value * 10_000n >= cost * BigInt(10_000 + TAKE_PROFIT_BPS)
      ) {
        exit = true;
      } else if (
        value > 0n &&
        value * 10_000n <= cost * BigInt(10_000 - HARD_STOP_BPS)
      ) {
        exit = true;
      } else if (
        h.peakValue > 0n &&
        h.peakValue * 10_000n >= cost * BigInt(10_000 + TRAIL_ARM_BPS) &&
        value * 10_000n <= h.peakValue * BigInt(10_000 - TRAIL_DROP_BPS)
      ) {
        exit = true;
      } else if (slot - h.entrySlot >= MAX_HOLD_SLOTS) {
        exit = true;
      } else if (w) {
        const s = this.windowStats(w, slot);
        if (s.whaleSell) {
          exit = true;
        } else if (s.sellSol > s.buySol && s.sellSol >= SOL / 2n) {
          exit = true;
        }
      }

      if (exit) {
        h.sellPending = true;
        orders.push({
          side: 'sell',
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
      }
    }
  }

  // Entry planning.

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

      // Price must have advanced moderately and remain close to its high.
      if (w.priceWindowStart <= 0n || w.lastPrice <= 0n) continue;
      if (
        w.lastPrice * 10_000n <
        w.priceWindowStart * BigInt(10_000 + MIN_RISE_BPS)
      ) {
        continue;
      }
      if (
        w.lastPrice * 10_000n >
        w.priceWindowStart * BigInt(10_000 + MAX_RISE_BPS)
      ) {
        continue;
      }
      if (
        w.windowHigh > 0n &&
        w.lastPrice * 10_000n <
          w.windowHigh * BigInt(10_000 - MAX_DIP_FROM_HIGH_BPS)
      ) {
        continue;
      }

      let size = SIZE;
      const cap = state.maxBuyLamports(mint);
      if (cap <= 0n) continue;
      if (size > cap) size = cap;

      const free = state.freeCashLamports();
      if (free - size < CASH_BUFFER) continue;
      if (size < SOL / 20n) continue; // A smaller trade is not fee-efficient.

      this.buyPending.add(mint);
      committed += 1;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: size,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
    }
  }

  // Memory maintenance.

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
