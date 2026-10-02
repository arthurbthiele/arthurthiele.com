import type { PercentilePosition } from "./percentileTypes";

// Peter Acklam's rational approximation to Φ⁻¹, relative error < 1.15e-9:
// https://web.archive.org/web/20151030215612/http://home.online.no/~pjacklam/notes/invnorm/
const CENTRAL_NUMERATOR = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
const CENTRAL_DENOMINATOR = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572, 1];
const TAIL_NUMERATOR = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const TAIL_DENOMINATOR = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416, 1];
const CENTRAL_REGION_TAIL_FRACTION = 0.02425;

/**
 * Returns z such that the standard normal has `fractionBelow` below z. The smaller of the two tails is used as the
 * input so precision survives near both 0 and 1, e.g. a "1 in a billion" upper tail doesn't collapse to fraction 1.
 */
export function inverseStandardNormal({ fractionBelow, fractionAbove }: PercentilePosition) {
  if (fractionAbove < fractionBelow) return -lowerTailInverse(fractionAbove);
  return lowerTailInverse(fractionBelow);
}

function lowerTailInverse(tailFraction: number) {
  if (tailFraction < CENTRAL_REGION_TAIL_FRACTION) {
    const q = Math.sqrt(-2 * Math.log(tailFraction));
    return evaluatePolynomial(TAIL_NUMERATOR, q) / evaluatePolynomial(TAIL_DENOMINATOR, q);
  }
  const q = tailFraction - 0.5;
  const r = q * q;
  return (q * evaluatePolynomial(CENTRAL_NUMERATOR, r)) / evaluatePolynomial(CENTRAL_DENOMINATOR, r);
}

function evaluatePolynomial(coefficientsHighestFirst: number[], x: number) {
  return coefficientsHighestFirst.reduce((accumulated, coefficient) => accumulated * x + coefficient, 0);
}
