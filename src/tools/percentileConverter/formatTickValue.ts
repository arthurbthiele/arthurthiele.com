import type { UnitFormat } from "./percentileTypes";

const MAXIMUM_TICK_SUFFIX_LENGTH = 4;

/** Compact axis labels ("A$100K", "170 cm"); long suffixes like " years" are dropped to keep ticks short. */
export function formatTickValue(value: number, { prefix = "", suffix = "" }: UnitFormat) {
  const magnitude = Math.abs(value);
  const number =
    magnitude >= 1000
      ? magnitude.toLocaleString("en-AU", { notation: "compact", maximumFractionDigits: 1 })
      : magnitude.toLocaleString("en-AU", { maximumFractionDigits: 1 });
  const shortSuffix = suffix.trim().length <= MAXIMUM_TICK_SUFFIX_LENGTH ? suffix : "";
  return `${value < 0 ? "−" : ""}${prefix}${number}${shortSuffix}`;
}
