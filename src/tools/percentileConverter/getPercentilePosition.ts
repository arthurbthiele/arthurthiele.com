import type {
  CumulativePoint,
  DataEdge,
  Distribution,
  LogNormalDistribution,
  MixtureDistribution,
  NormalDistribution,
  PercentilePosition
} from "./percentileTypes";
import { standardNormalTails } from "./standardNormalTails";

const EXTREME_TAIL_FRACTION = 1e-6;

interface PercentileLookup {
  position: PercentilePosition;
  clampedAt?: DataEdge;
}

export function getPercentilePosition(distribution: Distribution, value: number): PercentileLookup {
  if (distribution.kind === "normal") return getNormalPercentilePosition(distribution, value);
  if (distribution.kind === "logNormal") return getLogNormalPercentilePosition(distribution, value);
  if (distribution.kind === "mixture") return getMixturePercentilePosition(distribution, value);
  return getEmpiricalPercentilePosition(distribution.cumulativePoints, value);
}

/**
 * Normal tails are computed precisely, but no real dataset supports claims rarer than ~1 in a million, and a typo
 * like "1 cm" would otherwise produce a 1-in-10¹¹⁸ position and a negative height on the other side.
 */
function getNormalPercentilePosition(distribution: NormalDistribution, value: number): PercentileLookup {
  return clampExtremeTails(standardNormalTails((value - distribution.mean) / distribution.standardDeviation));
}

/** ln(value − shift) is normal, so the z-score is taken on the log; values at or below the shift sit below all data. */
function getLogNormalPercentilePosition(distribution: LogNormalDistribution, value: number): PercentileLookup {
  const shiftedValue = value - (distribution.shift ?? 0);
  if (shiftedValue <= 0) return { position: positionFromFractionBelow(0), clampedAt: "belowData" };
  return clampExtremeTails(standardNormalTails((Math.log(shiftedValue) - distribution.logMean) / distribution.logStandardDeviation));
}

/**
 * The pooled crowd's share below a value is each group's share below it, weighted by the group's size:
 * F(x) = Σ wᵢ·Fᵢ(x). Both tails are summed separately to keep precision far out in either. It is only past the data
 * if every group is.
 */
function getMixturePercentilePosition(distribution: MixtureDistribution, value: number): PercentileLookup {
  const lookups = distribution.components.map(({ weight, distribution: component }) => ({
    weight,
    lookup: getPercentilePosition(component, value)
  }));
  const position = {
    fractionBelow: lookups.reduce((total, { weight, lookup }) => total + weight * lookup.position.fractionBelow, 0),
    fractionAbove: lookups.reduce((total, { weight, lookup }) => total + weight * lookup.position.fractionAbove, 0)
  };
  const firstEdge = lookups[0]?.lookup.clampedAt;
  const isPastAllData = firstEdge != null && lookups.every(({ lookup }) => lookup.clampedAt === firstEdge);
  return isPastAllData ? { position, clampedAt: firstEdge } : { position };
}

function clampExtremeTails(position: PercentilePosition): PercentileLookup {
  if (position.fractionAbove < EXTREME_TAIL_FRACTION) return { position: positionFromFractionBelow(1), clampedAt: "aboveData" };
  if (position.fractionBelow < EXTREME_TAIL_FRACTION) return { position: positionFromFractionBelow(0), clampedAt: "belowData" };
  return { position };
}

/**
 * Linear interpolation between CDF points, i.e. values are treated as uniformly spread within each bin. Outside the
 * data we pin to the outermost point, and never report exactly 0 or 1 so the result can still be mapped into an
 * unbounded (normal) distribution.
 */
function getEmpiricalPercentilePosition(cumulativePoints: CumulativePoint[], value: number): PercentileLookup {
  const [lowestValue, lowestFraction] = cumulativePoints[0];
  const [highestValue, highestFraction] = cumulativePoints[cumulativePoints.length - 1];
  if (value < lowestValue) return { position: positionFromFractionBelow(lowestFraction), clampedAt: "belowData" };
  if (value > highestValue) return { position: positionFromFractionBelow(highestFraction), clampedAt: "aboveData" };

  const upperIndex = cumulativePoints.findIndex(([pointValue]) => pointValue >= value);
  if (upperIndex === 0) return { position: positionFromFractionBelow(lowestFraction) };
  const [lowerValue, lowerFraction] = cumulativePoints[upperIndex - 1];
  const [upperValue, upperFraction] = cumulativePoints[upperIndex];
  const progressThroughBin = (value - lowerValue) / (upperValue - lowerValue);
  return { position: positionFromFractionBelow(lowerFraction + progressThroughBin * (upperFraction - lowerFraction)) };
}

function positionFromFractionBelow(fractionBelow: number): PercentilePosition {
  const boundedFractionBelow = Math.min(Math.max(fractionBelow, EXTREME_TAIL_FRACTION), 1 - EXTREME_TAIL_FRACTION);
  return { fractionBelow: boundedFractionBelow, fractionAbove: 1 - boundedFractionBelow };
}
