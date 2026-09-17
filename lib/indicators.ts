/** Pure technical indicators from close-price series (no stubs). */

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function emaSeries(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0]!;
  out.push(prev);
  for (let i = 1; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** Wilder RSI */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export type MacdResult = {
  macd: number;
  signal: number;
  histogram: number;
};

export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): MacdResult | null {
  if (closes.length < slow + signalPeriod) return null;
  const fastEma = emaSeries(closes, fast);
  const slowEma = emaSeries(closes, slow);
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    macdLine.push(fastEma[i]! - slowEma[i]!);
  }
  // Signal EMA over the MACD line (use full series; first slow bars are warm-up)
  const signalLine = emaSeries(macdLine.slice(slow - 1), signalPeriod);
  const macdVal = macdLine[macdLine.length - 1]!;
  const signalVal = signalLine[signalLine.length - 1]!;
  return {
    macd: macdVal,
    signal: signalVal,
    histogram: macdVal - signalVal,
  };
}

export type BollingerResult = {
  upper: number;
  middle: number;
  lower: number;
  stdev: number;
};

export function bollinger(
  closes: number[],
  period = 20,
  mult = 2,
): BollingerResult | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance =
    slice.reduce((acc, v) => acc + (v - middle) ** 2, 0) / period;
  const stdev = Math.sqrt(variance);
  return {
    upper: middle + mult * stdev,
    middle,
    lower: middle - mult * stdev,
    stdev,
  };
}

export type MomentumLabel = "bullish" | "bearish" | "neutral";
export type SentimentLabel = "risk-on" | "risk-off" | "neutral";
export type SignalLabel = "buy" | "sell" | "hold";

export function momentumFromChange(change24hPct: number | null): MomentumLabel {
  if (change24hPct == null) return "neutral";
  if (change24hPct >= 2) return "bullish";
  if (change24hPct <= -2) return "bearish";
  return "neutral";
}

export function aggregatePulse(changes: Array<number | null>): {
  momentum: MomentumLabel;
  sentiment: SentimentLabel;
  signal: SignalLabel;
  avgChange24hPct: number | null;
} {
  const nums = changes.filter((c): c is number => c != null);
  if (nums.length === 0) {
    return {
      momentum: "neutral",
      sentiment: "neutral",
      signal: "hold",
      avgChange24hPct: null,
    };
  }
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
  let momentum: MomentumLabel = "neutral";
  if (avg >= 1.5) momentum = "bullish";
  else if (avg <= -1.5) momentum = "bearish";

  let sentiment: SentimentLabel = "neutral";
  if (avg >= 1) sentiment = "risk-on";
  else if (avg <= -1) sentiment = "risk-off";

  let signal: SignalLabel = "hold";
  if (avg >= 2.5) signal = "buy";
  else if (avg <= -2.5) signal = "sell";

  return { momentum, sentiment, signal, avgChange24hPct: avg };
}
