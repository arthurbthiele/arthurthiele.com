import { describe, expect, it } from "vitest";
import { getPercentilePosition } from "./getPercentilePosition";
import { getValueAtPosition } from "./getValueAtPosition";
import { inverseStandardNormal } from "./inverseStandardNormal";
import type { EmpiricalDistribution, NormalDistribution } from "./percentileTypes";
import { standardNormalTails } from "./standardNormalTails";

const ERFC_RELATIVE_TOLERANCE = 2e-7;
const INVERSE_ABSOLUTE_TOLERANCE = 1e-8;

// Reference values from Python's statistics.NormalDist (exact to double precision).
const LOWER_TAIL_BY_Z_SCORE: [zScore: number, fractionBelow: number][] = [
  [-8, 6.22096057427182e-16],
  [-6, 9.865876450377014e-10],
  [-3, 0.0013498980316300957],
  [-1, 0.15865525393145705],
  [0, 0.5],
  [0.5, 0.691462461274013],
  [2, 0.9772498680518208]
];

const Z_SCORE_BY_FRACTION_BELOW: [fractionBelow: number, zScore: number][] = [
  [1e-10, -6.361340902404057],
  [1e-6, -4.753424308822899],
  [0.001, -3.090232306167813],
  [0.02, -2.0537489106318225],
  [0.1, -1.2815515655446006],
  [0.5, 0],
  [0.9, 1.2815515655446006],
  [0.975, 1.9599639845400534]
];

describe("standardNormalTails", () => {
  it.each(LOWER_TAIL_BY_Z_SCORE)("z = %d", (zScore, fractionBelow) => {
    const tails = standardNormalTails(zScore);
    expect(relativeError(tails.fractionBelow, fractionBelow)).toBeLessThan(ERFC_RELATIVE_TOLERANCE);
    expect(relativeError(standardNormalTails(-zScore).fractionAbove, fractionBelow)).toBeLessThan(ERFC_RELATIVE_TOLERANCE);
  });
});

describe("inverseStandardNormal", () => {
  it.each(Z_SCORE_BY_FRACTION_BELOW)("fraction below %d", (fractionBelow, zScore) => {
    expect(inverseStandardNormal({ fractionBelow, fractionAbove: 1 - fractionBelow })).toBeCloseTo(zScore, 7);
  });

  it("keeps precision when only the upper tail is tiny", () => {
    const zScore = inverseStandardNormal({ fractionBelow: 1 - 1e-10, fractionAbove: 1e-10 });
    expect(Math.abs(zScore - 6.361340902404057)).toBeLessThan(INVERSE_ABSOLUTE_TOLERANCE);
  });
});

describe("normal round trip", () => {
  const australianMen: NormalDistribution = { kind: "normal", mean: 174.8, standardDeviation: 7.45 };
  const australianWomen: NormalDistribution = { kind: "normal", mean: 161.5, standardDeviation: 6.97 };

  it("maps a value back to itself", () => {
    const { position } = getPercentilePosition(australianMen, 210);
    expect(getValueAtPosition(australianMen, position).value).toBeCloseTo(210, 4);
  });

  it("maps a man to the same z-score as a woman", () => {
    const { position } = getPercentilePosition(australianMen, 174.8 + 2 * 7.45);
    expect(getValueAtPosition(australianWomen, position).value).toBeCloseTo(161.5 + 2 * 6.97, 4);
  });
});

describe("empirical distributions", () => {
  const ratings: EmpiricalDistribution = {
    kind: "empirical",
    cumulativePoints: [
      [1000, 0],
      [1500, 0.5],
      [2000, 0.9],
      [2500, 1]
    ]
  };

  it("interpolates within a bin", () => {
    expect(getPercentilePosition(ratings, 1750).position.fractionBelow).toBeCloseTo(0.7);
    expect(getValueAtPosition(ratings, { fractionBelow: 0.7, fractionAbove: 0.3 }).value).toBeCloseTo(1750);
  });

  it("flags and clamps values above the data without reaching exactly 1", () => {
    const lookup = getPercentilePosition(ratings, 3000);
    expect(lookup.clampedAt).toBe("aboveData");
    expect(lookup.position.fractionAbove).toBeGreaterThan(0);
  });

  it("flags percentiles the target data doesn't reach", () => {
    const partial: EmpiricalDistribution = { kind: "empirical", cumulativePoints: [[22146, 0.01], [429530, 0.99]] };
    expect(getValueAtPosition(partial, { fractionBelow: 0.995, fractionAbove: 0.005 })).toEqual({ value: 429530, clampedAt: "aboveData" });
  });
});

function relativeError(actual: number, expected: number) {
  return Math.abs(actual - expected) / expected;
}
