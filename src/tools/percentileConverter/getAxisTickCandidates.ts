import type { ChartAxis } from "./percentileTypes";

const TARGET_TICK_COUNT = 5;
const NICE_STEP_MULTIPLIERS = [1, 2, 2.5, 5, 10];
const LOG_TICK_MULTIPLIERS = [1, 2, 5];

interface AxisRange {
  axis: ChartAxis;
  minimumValue: number;
  maximumValue: number;
  signedLogLinearWidth: number;
}

/**
 * Round-valued tick candidates, for the caller to thin out by spacing: 1–2–5 steps on a linear axis, 1–2–5 × powers of
 * ten on a log axis, and powers of ten either side of zero (plus zero) on a signed-log one.
 */
export function getAxisTickCandidates({ axis, minimumValue, maximumValue, signedLogLinearWidth }: AxisRange) {
  if (axis === "linear") {
    const step = getNiceStep((maximumValue - minimumValue) / TARGET_TICK_COUNT);
    const firstTick = Math.ceil(minimumValue / step) * step;
    return Array.from({ length: Math.floor((maximumValue - firstTick) / step) + 1 }, (_, index) => firstTick + index * step);
  }
  if (axis === "logarithmic") {
    return getPowersOfTen(minimumValue, maximumValue).flatMap((power) => LOG_TICK_MULTIPLIERS.map((multiplier) => multiplier * power));
  }
  const lowestPower = Math.max(signedLogLinearWidth, 1);
  const positive = maximumValue > 0 ? getPowersOfTen(lowestPower, maximumValue) : [];
  const negative = minimumValue < 0 ? getPowersOfTen(lowestPower, -minimumValue).map((value) => -value).reverse() : [];
  return [...negative, ...(minimumValue < 0 && maximumValue > 0 ? [0] : []), ...positive];
}

function getNiceStep(roughStep: number) {
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const multiplier = NICE_STEP_MULTIPLIERS.find((candidate) => candidate * magnitude >= roughStep) ?? 10;
  return multiplier * magnitude;
}

function getPowersOfTen(lowest: number, highest: number) {
  const values: number[] = [];
  for (let exponent = Math.floor(Math.log10(lowest)); exponent <= Math.ceil(Math.log10(highest)); exponent += 1) {
    values.push(10 ** exponent);
  }
  return values;
}
