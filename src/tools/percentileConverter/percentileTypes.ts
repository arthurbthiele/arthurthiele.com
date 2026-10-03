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

/** Several groups pooled into one crowd, e.g. men and women, each weighted by its share of the population. */
export interface MixtureDistribution {
  kind: "mixture";
  components: MixtureComponent[];
}

export interface MixtureComponent {
  weight: number;
  distribution: Distribution;
}

export type Distribution = NormalDistribution | LogNormalDistribution | EmpiricalDistribution | MixtureDistribution;

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
  /** Datasets with an ordered selector (years, age bands) can offer every option at once as a 3D surface. */
  findSurface?: (selection: ParameterSelection, value: number) => SurfaceSpec | undefined;
}

export interface SurfaceSlice {
  position: number;
  label: string;
  distribution: Distribution;
  isFadedBelowMedian?: boolean;
}

export interface SurfaceMarker {
  position: number;
  label: string;
}

export interface SurfaceSpec {
  slices: SurfaceSlice[];
  highlightPosition: number;
  highlightValue: number;
  depthTitle: string;
  valueTitle: string;
  unit: UnitFormat;
  axis: ChartAxis;
  signedLogLinearWidth?: number;
  markers?: SurfaceMarker[];
  notes?: string[];
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
