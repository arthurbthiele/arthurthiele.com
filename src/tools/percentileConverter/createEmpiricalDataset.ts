import type { CumulativePoint, DatasetParameterOption, DatasetSource, LoadedDataset } from "./percentileTypes";

export interface EmpiricalDatasetFile {
  source: DatasetSource;
  variants: Record<string, EmpiricalVariant>;
}

interface EmpiricalVariant {
  label?: string;
  year?: number;
  cdf: number[][];
}

interface EmpiricalDatasetParams {
  file: EmpiricalDatasetFile;
  parameterId: string;
  parameterLabel: string;
  defaultVariantId: string;
  orderedVariantOptions?: DatasetParameterOption[];
  describePopulation: (variantId: string, variantLabel: string, variant?: EmpiricalVariant) => string;
}

export function createEmpiricalDataset({
  file,
  parameterId,
  parameterLabel,
  defaultVariantId,
  orderedVariantOptions,
  describePopulation
}: EmpiricalDatasetParams): LoadedDataset {
  const options =
    orderedVariantOptions ??
    Object.entries(file.variants).map(([variantId, variant]) => ({ id: variantId, label: variant.label ?? variantId }));
  const labelByVariantId = new Map(options.map(({ id, label }) => [id, label]));
  const getVariantId = (selection: Record<string, string>) => selection[parameterId] ?? defaultVariantId;

  return {
    source: file.source,
    parameters: [{ id: parameterId, label: parameterLabel, options, defaultOptionId: defaultVariantId }],
    getDistribution: (selection) => {
      const variantId = getVariantId(selection);
      const variant = file.variants[variantId];
      if (variant == null) throw new Error(`No "${variantId}" variant in ${file.source.name}`);
      return { kind: "empirical", cumulativePoints: toCumulativePoints(variant.cdf) };
    },
    describePopulation: (selection) => {
      const variantId = getVariantId(selection);
      return describePopulation(variantId, labelByVariantId.get(variantId) ?? variantId, file.variants[variantId]);
    }
  };
}

function toCumulativePoints(rawPoints: number[][]) {
  return rawPoints.map(([value = 0, fractionAtOrBelow = 0]): CumulativePoint => [value, fractionAtOrBelow]);
}
