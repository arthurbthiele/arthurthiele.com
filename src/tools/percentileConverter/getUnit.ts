import type { DatasetDefinition, LoadedDataset, ParameterSelection, UnitFormat } from "./percentileTypes";

/** Most datasets have one unit; some (historical money) change currency with the selected country and year. */
export function getUnit(definition: DatasetDefinition, dataset: LoadedDataset, selection: ParameterSelection): UnitFormat {
  return dataset.findUnit?.(selection) ?? definition.unit;
}
