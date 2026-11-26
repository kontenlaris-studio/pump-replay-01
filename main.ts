// Pump.fun Replay Sprint — paper-trading bot (agent-fun/replay/v2).
//
// Entrypoint and wiring only. The trading decisions live in strategy.ts;
// this module adapts that strategy to the vendored SDK's runBot loop.
//
// Determinism is part of the contract: order decisions are derived only
// from the hello message, batch events, account state, and fills. Nothing
// here consults a wall clock, random source, or process environment, so a
// replay of the same tape produces the same action stream. Keeping this
// adapter thin also makes the strategy independently testable.

import { runBot } from './vendor/makefun-bot.ts';
import { MomentumRider } from './strategy.ts';

const strategy = new MomentumRider();

await runBot({
  onHello(state) {
    strategy.onHello(state);
  },

  onBatch(state, batch) {
    return strategy.onBatch(state, batch);
  },
});
