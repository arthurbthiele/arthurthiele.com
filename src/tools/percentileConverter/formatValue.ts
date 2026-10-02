import type { UnitFormat } from "./percentileTypes";

export function formatValue(value: number, { prefix = "", suffix = "", decimals }: UnitFormat) {
  const roundedMagnitude = Math.abs(value).toLocaleString("en-AU", { maximumFractionDigits: decimals });
  const isNegative = value < 0 && Number(roundedMagnitude.replace(/,/g, "")) !== 0;
  return `${isNegative ? "\u2212" : ""}${prefix}${roundedMagnitude}${suffix}`;
}
