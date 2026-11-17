/**
 * Adaptive Macro-Trend Momentum Strategy for 24-Hour BTC Race.
 *
 * Designed for low turnover, minimal fee drag, and strict tail-risk control.
 * Strictly adheres to agent-fun/bars-replay/v1 protocol specs.
 */

import { BPS, runBars, type BuyInput, type SellInput } from "./vendor/makefun-bars.ts";

const STRATEGY_VERSION = "1.0.1";
const MAX_SLIPPAGE_BPS = 100;
const EMA_PERIOD = 60;
const TRAILING_DRAWDOWN_LIMIT = 0.035; // 3.5% trailing stop from peak
const HARD_STOP_LIMIT = 0.05; // 5.0% absolute stop from entry

let entered = false;
let exited = false;
let entryPrice: number | null = null;
let peakPrice: number | null = null;

let emaValue: number | null = null;
const emaHistory: number[] = [];

function updateEma(close: number): number {
  if (emaValue === null) {
    emaHistory.push(close);
    if (emaHistory.length === EMA_PERIOD) {
      emaValue = emaHistory.reduce((acc, val) => acc + val, 0) / EMA_PERIOD;
    }
    return close;
  }
  const alpha = 2.0 / (EMA_PERIOD + 1);
  emaValue = alpha * close + (1.0 - alpha) * emaValue;
  return emaValue;
}

await runBars({
  onBatch(state, batch) {
    if (state.warmingUp) {
      return [];
    }

    const { caps, fees } = state.hello;
    const targetSymbol = "CBBTC";

    // Update market state
    for (const bar of batch.bars) {
      if (bar.symbol === targetSymbol) {
        const c = Number(bar.c);
        const currentEma = updateEma(c);

        if (entered && !exited) {
          if (peakPrice === null || c > peakPrice) {
            peakPrice = c;
          }

          // Check exit signals
          if (entryPrice !== null && peakPrice !== null) {
            const drawdownFromPeak = (peakPrice - c) / peakPrice;
            const lossFromEntry = (entryPrice - c) / entryPrice;
            const trendBroken = currentEma > 0 && c < currentEma * 0.985;

            if (drawdownFromPeak >= TRAILING_DRAWDOWN_LIMIT && trendBroken) {
              exited = true;
            } else if (lossFromEntry >= HARD_STOP_LIMIT) {
              exited = true;
            }
          }
        }
      }
    }

    const held = state.positions.get(targetSymbol);

    // 1. Process Exit Orders
    if (exited && held !== undefined && held.qty > 0n) {
      return [
        {
          side: "sell",
          symbol: targetSymbol,
          qty: held.qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        } as SellInput,
      ];
    }

    // 2. Process Entry Orders
    if (!entered && !exited && state.cash > 0n) {
      const currentClose = state.close(targetSymbol);
      if (currentClose !== null && currentClose > 0n) {
        const slots = Math.min(state.hello.symbols.length, caps.max_open_positions);
        const maxNotionalByWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
        let notional = state.cash < maxNotionalByWeight ? state.cash : maxNotionalByWeight;

        if (notional >= BigInt(fees.min_notional_quote_units)) {
          entered = true;
          entryPrice = Number(currentClose);
          peakPrice = entryPrice;

          return [
            {
              side: "buy",
              symbol: targetSymbol,
              notional_quote_units: notional,
              max_slippage_bps: MAX_SLIPPAGE_BPS,
            } as BuyInput,
          ];
        }
      }
    }

    return [];
  },
});
