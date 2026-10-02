import { ordinalSuffix } from "./ordinalSuffix";
import type { PercentilePosition, RankWords } from "./percentileTypes";

const RANK_SIGNIFICANT_DIGITS = 2;
const ONE_MILLION = 1_000_000;
const ONE_BILLION = 1_000_000_000;

/**
 * "about the 2,300,000th tallest of 9.7 million": the rank counts from whichever end is nearer, so the top half reads
 * as "tallest" and the bottom half as "shortest".
 */
export function describeRank({ fractionBelow, fractionAbove }: PercentilePosition, populationSize: number, rankWords: RankWords) {
  const isUpperHalf = fractionAbove <= fractionBelow;
  const exactRank = (isUpperHalf ? fractionAbove : fractionBelow) * populationSize;
  const roundedRank = Math.max(1, Math.round(Number(exactRank.toPrecision(RANK_SIGNIFICANT_DIGITS))));
  const word = isUpperHalf ? rankWords.higher : rankWords.lower;
  const ofPopulation = `of ${describePopulationSize(populationSize)}`;
  if (roundedRank === 1) return `about the ${word} ${ofPopulation}`;
  return `about the ${roundedRank.toLocaleString("en-AU")}${ordinalSuffix(roundedRank)} ${word} ${ofPopulation}`;
}

function describePopulationSize(populationSize: number) {
  if (populationSize >= ONE_BILLION) return `${Number((populationSize / ONE_BILLION).toPrecision(2))} billion`;
  if (populationSize >= ONE_MILLION) return `${Number((populationSize / ONE_MILLION).toPrecision(2))} million`;
  return Number(populationSize.toPrecision(RANK_SIGNIFICANT_DIGITS)).toLocaleString("en-AU");
}
