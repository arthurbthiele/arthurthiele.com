import type { PercentilePosition } from "./percentileTypes";

const ERFC_COEFFICIENTS = [
  -1.26551223, 1.00002368, 0.37409196, 0.09678418, -0.18628806, 0.27886807, -1.13520398, 1.48851587, -0.82215223,
  0.17087277
];

/**
 * Φ(z) = ½·erfc(−z/√2) and 1 − Φ(z) = ½·erfc(z/√2). Computing each tail from erfc directly, rather than as
 * 1 − the other, keeps full relative precision far into the tails (a 2.2 m man is ~1 in 10⁹, which 1 − Φ would
 * round to zero).
 */
export function standardNormalTails(zScore: number): PercentilePosition {
  return {
    fractionBelow: complementaryErrorFunction(-zScore / Math.SQRT2) / 2,
    fractionAbove: complementaryErrorFunction(zScore / Math.SQRT2) / 2
  };
}

/**
 * Chebyshev-fitted erfc from Numerical Recipes (2nd ed., §6.2, `erfcc`), fractional error < 1.2e-7 everywhere,
 * including the far tail, which is the property we need.
 */
function complementaryErrorFunction(x: number) {
  const absoluteX = Math.abs(x);
  const t = 1 / (1 + absoluteX / 2);
  const polynomial = ERFC_COEFFICIENTS.reduceRight((accumulated, coefficient) => coefficient + t * accumulated, 0);
  const result = t * Math.exp(-absoluteX * absoluteX + polynomial);
  return x >= 0 ? result : 2 - result;
}
