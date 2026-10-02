import { getPercentilePosition } from "./getPercentilePosition";
import { inverseStandardNormal } from "./inverseStandardNormal";
import type { CumulativePoint, DataEdge, Distribution, MixtureDistribution, PercentilePosition } from "./percentileTypes";

const MIXTURE_BISECTION_STEPS = 100;

interface ValueLookup {
  value: number;
  clampedAt?: DataEdge;
}

export function getValueAtPosition(distribution: Distribution, position: PercentilePosition): ValueLookup {
  if (distribution.kind === "normal") {
    return { value: distribution.mean + distribution.standardDeviation * inverseStandardNormal(position) };
  }
  if (distribution.kind === "logNormal") {
    const shift = distribution.shift ?? 0;
    return { value: shift + Math.exp(distribution.logMean + distribution.logStandardDeviation * inverseStandardNormal(position)) };
  }
  if (distribution.kind === "mixture") return getMixtureValue(distribution, position);
  return getEmpiricalValue(distribution.cumulativePoints, position.fractionBelow);
}

/**
 * A mixture's quantile has no closed form, but its CDF only rises, and the pooled quantile always lies between the
 * groups' own quantiles at that position, so bisection between those brackets converges. It matches on whichever tail
 * is smaller, to keep precision far out in the tails.
 */
function getMixtureValue(distribution: MixtureDistribution, position: PercentilePosition): ValueLookup {
  const componentLookups = distribution.components.map(({ distribution: component }) => getValueAtPosition(component, position));
  const firstEdge = componentLookups[0]?.clampedAt;
  const componentValues = componentLookups.map(({ value }) => value);
  let lower = Math.min(...componentValues);
  let upper = Math.max(...componentValues);
  if (firstEdge != null && componentLookups.every(({ clampedAt }) => clampedAt === firstEdge)) {
    return { value: firstEdge === "aboveData" ? upper : lower, clampedAt: firstEdge };
  }
  const matchOnUpperTail = position.fractionAbove < position.fractionBelow;
  for (let step = 0; step < MIXTURE_BISECTION_STEPS; step += 1) {
    const middle = (lower + upper) / 2;
    const { fractionBelow, fractionAbove } = getPercentilePosition(distribution, middle).position;
    const isBelowTarget = matchOnUpperTail ? fractionAbove > position.fractionAbove : fractionBelow < position.fractionBelow;
    if (isBelowTarget) {
      lower = middle;
      continue;
    }
    upper = middle;
  }
  return { value: (lower + upper) / 2 };
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
