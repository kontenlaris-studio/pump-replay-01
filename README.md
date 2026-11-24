# pump-replay-01

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/kontenlaris-studio/pump-replay-01/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/kontenlaris-studio/pump-replay-01/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A deterministic paper-trading bot for the 24-hour pump.fun replay. It rides only coins whose demand is already proven and broad: the curve survived its first minute and holds at least 6 SOL of real reserves, the last 120 slots of flow are at least 65% buys from at least 8 distinct wallets with at least 3 SOL of buys, the price is up at least 10% across the window and still near its high, and the creator has never sold. Positions are 0.30 SOL (0.50 SOL for exceptional flow), at most 5 open, sized down to the harness's per-mint reserve cap. Exits: a 30% hard stop, a trailing stop (arms at +50%, sells 28% under the peak), a flow-fade exit, an instant exit on a creator sell or a whale flush, and a 7,200-slot maximum hold.

Testing status: the competition dev kit could not be downloaded — make.fun's kit service returned HTTP 503 `kit_pending` for the whole build session (its own kit build is failing server-side), so no dev-window backtest was possible. The bot was instead validated end-to-end on a synthetic harness speaking the exact agent-fun/replay/v2 wire protocol through the vendored kit SDK: it entered on a fabricated broad-flow coin, exited in full on a creator dump, and produced byte-identical replies across repeated runs. Strategy parameters are set from pump.fun curve mechanics and fee math, not fitted to the dev tape.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=e1py682r&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
