import type { UnitFormat } from "./percentileTypes";

export function formatValue(value: number, { prefix = "", suffix = "", decimals }: UnitFormat) {
  const roundedValue = value.toLocaleString("en-AU", { maximumFractionDigits: decimals });
  return `${prefix}${roundedValue}${suffix}`;
}
