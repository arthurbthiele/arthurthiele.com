import { formatValue } from "./formatValue";
import type { DataEdge, UnitFormat } from "./percentileTypes";

export function formatBoundedValue(value: number, unit: UnitFormat, bound: DataEdge | undefined) {
  const formattedValue = formatValue(value, unit);
  if (bound === "aboveData") return `> ${formattedValue}`;
  if (bound === "belowData") return `< ${formattedValue}`;
  return formattedValue;
}
