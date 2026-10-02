import { describe, expect, it } from "vitest";
import { describeRank } from "./describeRank";
import { findTypedNumber } from "./findTypedNumber";
import { getPercentilePosition } from "./getPercentilePosition";
import { getValueAtPosition } from "./getValueAtPosition";
import { inverseStandardNormal } from "./inverseStandardNormal";
import type { EmpiricalDistribution, LogNormalDistribution, NormalDistribution } from "./percentileTypes";
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

describe("lognormal distributions", () => {
  // Australian men's weight: Python's statistics.NormalDist gives P90 = 113.21 kg and 76.84% below 100 kg.
  const australianMensWeight: LogNormalDistribution = { kind: "logNormal", logMean: 4.4391, logStandardDeviation: 0.2264 };

  it("matches reference quantiles", () => {
    expect(getValueAtPosition(australianMensWeight, { fractionBelow: 0.9, fractionAbove: 0.1 }).value).toBeCloseTo(113.21, 1);
    expect(getPercentilePosition(australianMensWeight, 100).position.fractionBelow).toBeCloseTo(0.7684, 3);
  });

  it("applies a shift", () => {
    // Typing speed: Python's statistics.NormalDist gives 98.26% below 100 WPM and a median of 49.89 WPM.
    const typingSpeed: LogNormalDistribution = { kind: "logNormal", logMean: 4.76715, logStandardDeviation: 0.16818, shift: -67.698 };
    expect(getPercentilePosition(typingSpeed, 100).position.fractionBelow).toBeCloseTo(0.9826, 3);
    expect(getValueAtPosition(typingSpeed, { fractionBelow: 0.5, fractionAbove: 0.5 }).value).toBeCloseTo(49.89, 1);
  });

  it("puts non-positive values below the data", () => {
    expect(getPercentilePosition(australianMensWeight, 0).clampedAt).toBe("belowData");
  });
});

describe("describeRank", () => {
  const heightWords = { higher: "tallest", lower: "shortest" };

  it("counts from the top in the upper half", () => {
    expect(describeRank({ fractionBelow: 0.76, fractionAbove: 0.24 }, 9_712_900, heightWords)).toBe(
      "about the 2.3 millionth tallest of 9.7 million"
    );
  });

  it("counts from the bottom in the lower half", () => {
    expect(describeRank({ fractionBelow: 0.0012, fractionAbove: 0.9988 }, 700_358, heightWords)).toBe(
      "about the 840th shortest of 700,000"
    );
  });

  it("names billions and keeps digits below a million", () => {
    expect(describeRank({ fractionBelow: 0.85, fractionAbove: 0.15 }, 7_780_315_940, heightWords)).toBe(
      "about the 1.2 billionth tallest of 7.8 billion"
    );
    expect(describeRank({ fractionBelow: 0.88, fractionAbove: 0.12 }, 700_358, heightWords)).toBe(
      "about the 84,000th tallest of 700,000"
    );
  });

  it("rounds small ranks to whole people", () => {
    expect(describeRank({ fractionBelow: 1 - 1e-6, fractionAbove: 1e-6 }, 9_712_900, heightWords)).toBe(
      "about the 10th tallest of 9.7 million"
    );
  });

  it("calls a rank of one the tallest", () => {
    expect(describeRank({ fractionBelow: 1 - 1e-9, fractionAbove: 1e-9 }, 9_712_900, heightWords)).toBe(
      "about the tallest of 9.7 million"
    );
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

describe("findTypedNumber", () => {
  it.each([
    ["180", 180],
    ["80k", 80_000],
    ["1.5M", 1_500_000],
    ["2b", 2_000_000_000],
    ["-20,000", -20_000],
    ["\u221220k", -20_000],
    ["A$300k", 300_000],
    ["US$ 1.2m", 1_200_000],
    [".5k", 500]
  ])("reads %s", (text, expected) => {
    expect(findTypedNumber(text)).toBe(expected);
  });

  it.each(["", "k", "abc", "1.2.3", "5kk", "-"])("rejects %s", (text) => {
    expect(findTypedNumber(text)).toBeUndefined();
  });
});
