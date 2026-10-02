import { ordinalSuffix } from "./ordinalSuffix";
import type { DataEdge, PercentilePosition } from "./percentileTypes";

const EXTREME_TAIL_FRACTION = 0.01;
const TAIL_SIGNIFICANT_DIGITS = 2;

export function describePosition({ fractionBelow, fractionAbove }: PercentilePosition, clampedAt?: DataEdge) {
  if (clampedAt === "aboveData") return `the top <${describeTail(fractionAbove, "rarer than")}`;
  if (clampedAt === "belowData") return `the bottom <${describeTail(fractionBelow, "rarer than")}`;
  if (fractionAbove < EXTREME_TAIL_FRACTION) return `the top ${describeTail(fractionAbove)}`;
  if (fractionBelow < EXTREME_TAIL_FRACTION) return `the bottom ${describeTail(fractionBelow)}`;
  const wholePercentile = Math.round(fractionBelow * 100);
  return `the ${wholePercentile}${ordinalSuffix(wholePercentile)} percentile`;
}

function describeTail(tailFraction: number, rarityPrefix = "") {
  const percentage = Number((tailFraction * 100).toPrecision(TAIL_SIGNIFICANT_DIGITS));
  const oneIn = Number((1 / tailFraction).toPrecision(TAIL_SIGNIFICANT_DIGITS));
  return `${percentage}% (${rarityPrefix ? `${rarityPrefix} ` : ""}1 in ${oneIn.toLocaleString("en-AU")})`;
}
