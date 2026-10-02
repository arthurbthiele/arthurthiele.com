import { inverseStandardNormal } from "./inverseStandardNormal";
import type { CumulativePoint, DataEdge, Distribution, PercentilePosition } from "./percentileTypes";

interface ValueLookup {
  value: number;
  clampedAt?: DataEdge;
}

export function getValueAtPosition(distribution: Distribution, position: PercentilePosition): ValueLookup {
  if (distribution.kind === "normal") {
    return { value: distribution.mean + distribution.standardDeviation * inverseStandardNormal(position) };
  }
  if (distribution.kind === "logNormal") {
    return { value: Math.exp(distribution.logMean + distribution.logStandardDeviation * inverseStandardNormal(position)) };
  }
  return getEmpiricalValue(distribution.cumulativePoints, position.fractionBelow);
}

function getEmpiricalValue(cumulativePoints: CumulativePoint[], fractionBelow: number): ValueLookup {
  const [lowestValue, lowestFraction] = cumulativePoints[0];
  const [highestValue, highestFraction] = cumulativePoints[cumulativePoints.length - 1];
  if (fractionBelow < lowestFraction) return { value: lowestValue, clampedAt: "belowData" };
  if (fractionBelow > highestFraction) return { value: highestValue, clampedAt: "aboveData" };

  const upperIndex = cumulativePoints.findIndex(([, pointFraction]) => pointFraction >= fractionBelow);
  if (upperIndex === 0) return { value: lowestValue };
  const [lowerValue, lowerFraction] = cumulativePoints[upperIndex - 1];
  const [upperValue, upperFraction] = cumulativePoints[upperIndex];
  const progressThroughBin = (fractionBelow - lowerFraction) / (upperFraction - lowerFraction);
  return { value: lowerValue + progressThroughBin * (upperValue - lowerValue) };
}
