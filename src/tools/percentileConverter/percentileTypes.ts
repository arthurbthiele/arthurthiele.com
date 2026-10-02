export interface NormalDistribution {
  kind: "normal";
  mean: number;
  standardDeviation: number;
}

/** ln(value − shift) is normal; a shift (default 0) lets the curve start somewhere other than zero. */
export interface LogNormalDistribution {
  kind: "logNormal";
  logMean: number;
  logStandardDeviation: number;
  shift?: number;
}

export interface EmpiricalDistribution {
  kind: "empirical";
  cumulativePoints: CumulativePoint[];
}

export type CumulativePoint = [value: number, fractionAtOrBelow: number];

export type Distribution = NormalDistribution | LogNormalDistribution | EmpiricalDistribution;

export interface PercentilePosition {
  fractionBelow: number;
  fractionAbove: number;
}

export type DataEdge = "belowData" | "aboveData";

export type ChartAxis = "linear" | "logarithmic" | "signedLogarithmic";

export interface UnitFormat {
  prefix?: string;
  suffix?: string;
  decimals: number;
}

export interface DatasetSource {
  name: string;
  url: string;
  licence: string;
}

export interface DatasetParameterOption {
  id: string;
  label: string;
}

export interface DatasetParameter {
  id: string;
  label: string;
  options: DatasetParameterOption[];
  defaultOptionId: string;
}

export type ParameterSelection = Record<string, string>;

export interface LoadedDataset {
  parameters: DatasetParameter[];
  source: DatasetSource;
  getDistribution: (selection: ParameterSelection) => Distribution;
  describePopulation: (selection: ParameterSelection) => string;
  findPopulationSize: (selection: ParameterSelection) => number | undefined;
  findUnit?: (selection: ParameterSelection) => UnitFormat | undefined;
}

export interface RankWords {
  higher: string;
  lower: string;
}

export interface DatasetDefinition {
  id: string;
  label: string;
  unit: UnitFormat;
  defaultValue: number;
  chartAxis?: ChartAxis;
  rankWords?: RankWords;
  caveat?: string;
  load: () => Promise<LoadedDataset>;
}
