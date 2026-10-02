import { DATASETS } from "./datasets";
import { formatBoundedValue } from "./formatBoundedValue";
import { getUnit } from "./getUnit";
import { getValueAtPosition } from "./getValueAtPosition";
import type { DataEdge, LoadedDataset, ParameterSelection, PercentilePosition } from "./percentileTypes";

const MAXIMUM_EXPANDED_OPTIONS = 5;

interface EverythingTableParams {
  container: HTMLElement;
  position: PercentilePosition;
  positionClampedAt?: DataEdge;
  excludedDatasetId: string;
  excludedSelection: ParameterSelection;
  loadDataset: (datasetId: string) => Promise<LoadedDataset>;
}

interface EverythingRow {
  datasetLabel: string;
  population: string;
  valueText: string;
}

export async function renderEverythingTable({
  container,
  position,
  positionClampedAt,
  excludedDatasetId,
  excludedSelection,
  loadDataset
}: EverythingTableParams) {
  const rowGroups = await Promise.all(
    DATASETS.map(async (definition) => {
      const dataset = await loadDataset(definition.id);
      return getRowSelections(dataset)
        .filter((selection) => definition.id !== excludedDatasetId || !isSameSelection(selection, excludedSelection))
        .map((selection): EverythingRow => {
          const lookup = getValueAtPosition(dataset.getDistribution(selection), position);
          const bound = lookup.clampedAt ?? positionClampedAt;
          return {
            datasetLabel: definition.label,
            population: dataset.describePopulation(selection),
            valueText: formatBoundedValue(lookup.value, getUnit(definition, dataset, selection), bound)
          };
        });
    })
  );

  const table = document.createElement("table");
  const body = document.createElement("tbody");
  for (const row of rowGroups.flat()) {
    const tableRow = document.createElement("tr");
    const populationCell = document.createElement("td");
    const datasetLabel = document.createElement("span");
    datasetLabel.className = "everything__dataset";
    datasetLabel.textContent = row.datasetLabel;
    populationCell.append(datasetLabel, row.population);
    const valueCell = document.createElement("td");
    valueCell.className = "everything__value";
    valueCell.textContent = row.valueText;
    tableRow.append(populationCell, valueCell);
    body.append(tableRow);
  }
  table.append(body);
  container.replaceChildren(table);
}

/**
 * Expands the first small parameter (e.g. sex, time control) into one row per option so the table shows every
 * readily comparable group; large parameters such as country stay on their default.
 */
function getRowSelections(dataset: LoadedDataset): ParameterSelection[] {
  const defaultSelection = Object.fromEntries(dataset.parameters.map(({ id, defaultOptionId }) => [id, defaultOptionId]));
  const expandableParameter = dataset.parameters.find(({ options }) => options.length <= MAXIMUM_EXPANDED_OPTIONS);
  if (expandableParameter == null) return [defaultSelection];
  return expandableParameter.options.map(({ id }) => ({ ...defaultSelection, [expandableParameter.id]: id }));
}

function isSameSelection(selection: ParameterSelection, otherSelection: ParameterSelection) {
  return Object.entries(selection).every(([parameterId, optionId]) => otherSelection[parameterId] === optionId);
}
