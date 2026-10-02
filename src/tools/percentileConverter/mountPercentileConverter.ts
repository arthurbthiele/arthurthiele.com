import { DATASETS } from "./datasets";
import { describePosition } from "./describePosition";
import { describeRank } from "./describeRank";
import { formatBoundedValue } from "./formatBoundedValue";
import { findTypedNumber } from "./findTypedNumber";
import { formatValue } from "./formatValue";
import { getPercentilePosition } from "./getPercentilePosition";
import { getUnit } from "./getUnit";
import { getValueAtPosition } from "./getValueAtPosition";
import { renderDistributionChart } from "./renderDistributionChart";
import { renderEverythingTable } from "./renderEverythingTable";
import type { WealthHistorySurface } from "./createWealthHistorySurface";
import type {
  DataEdge,
  DatasetDefinition,
  DatasetParameter,
  LoadedDataset,
  ParameterSelection,
  PercentilePosition,
  UnitFormat
} from "./percentileTypes";

const DEFAULT_FROM_DATASET_ID = "height";
const DEFAULT_TO_DATASET_ID = "height";
const DEFAULT_FROM_SELECTION: ParameterSelection = { sex: "male" };
const DEFAULT_TO_SELECTION: ParameterSelection = { sex: "female" };
const MAXIMUM_SEGMENTED_OPTIONS = 3;
const HISTORY_DATASET_ID = "wealthHistory";
const HISTORY_DEFAULT_COUNTRY_ID = "GB";
const HISTORY_DEFAULT_YEAR = 1820;
const SELECTION_QUERY_PREFIX_BY_SIDE: Record<Side, string> = { from: "f.", to: "t." };

type Side = "from" | "to";

interface SideState {
  datasetId: string;
  selection: ParameterSelection;
}

interface ConverterState {
  from: SideState;
  to: SideState;
  inputValue: number;
  flipped: boolean;
  showEverything: boolean;
  showHistorySurface: boolean;
}

interface SideElements {
  datasetSelect: HTMLSelectElement;
  parameters: HTMLElement;
  chart: HTMLElement;
}

interface ConverterElements {
  sides: Record<Side, SideElements>;
  valueInput: HTMLInputElement;
  unitPrefix: HTMLElement;
  unitSuffix: HTMLElement;
  result: HTMLElement;
  flipToggle: HTMLInputElement;
  swapButton: HTMLButtonElement;
  explanation: HTMLElement;
  warnings: HTMLElement;
  sources: HTMLElement;
  everythingToggle: HTMLButtonElement;
  everything: HTMLElement;
  everythingHeading: HTMLElement;
  everythingTable: HTMLElement;
  historyPanel: HTMLElement;
  historyToggle: HTMLInputElement;
  historyCanvas: HTMLElement;
  historyHint: HTMLElement;
}

interface Conversion {
  inputPosition: PercentilePosition;
  outputPosition: PercentilePosition;
  outputValue: number;
  inputClampedAt?: DataEdge;
  outputClampedAt?: DataEdge;
  outputPositionClampedAt?: DataEdge;
  outputBound?: DataEdge;
}

export function mountPercentileConverter(root: HTMLElement) {
  const elements = getConverterElements(root);
  const loadedDatasets = new Map<string, Promise<LoadedDataset>>();
  const state = readStateFromUrl();
  let latestOutputValue: number | undefined;
  let historySurface: WealthHistorySurface | undefined;
  let renderGeneration = 0;

  const loadDataset = (datasetId: string) => {
    const cached = loadedDatasets.get(datasetId);
    if (cached != null) return cached;
    const loading = getDatasetDefinition(datasetId).load();
    loadedDatasets.set(datasetId, loading);
    return loading;
  };

  const render = async () => {
    renderGeneration += 1;
    const generation = renderGeneration;
    const [fromDataset, toDataset] = await Promise.all([loadDataset(state.from.datasetId), loadDataset(state.to.datasetId)]);
    if (generation !== renderGeneration || !root.isConnected) return;

    renderParameters({ side: "from", dataset: fromDataset, state, elements, onChange: render });
    renderParameters({ side: "to", dataset: toDataset, state, elements, onChange: render });
    const fromDefinition = getDatasetDefinition(state.from.datasetId);
    const toDefinition = getDatasetDefinition(state.to.datasetId);
    const fromUnit = getUnit(fromDefinition, fromDataset, state.from.selection);
    const toUnit = getUnit(toDefinition, toDataset, state.to.selection);
    elements.unitPrefix.textContent = fromUnit.prefix ?? "";
    elements.unitSuffix.textContent = fromUnit.suffix ?? "";

    const conversion = convert({ state, fromDataset, toDataset });
    latestOutputValue = conversion.outputValue;
    elements.result.textContent = formatBoundedValue(conversion.outputValue, toUnit, conversion.outputBound);
    renderExplanation({ state, conversion, fromDataset, toDataset, fromDefinition, toDefinition, fromUnit, toUnit, elements });
    renderSources({ fromDataset, toDataset, fromDefinition, toDefinition, elements });
    renderDistributionChart({
      container: elements.sides.from.chart,
      distribution: fromDataset.getDistribution(state.from.selection),
      unit: fromUnit,
      markerValue: state.inputValue,
      shadedSide: state.flipped ? "above" : "below",
      axis: fromDefinition.chartAxis,
      onPickValue: (pickedValue) => {
        state.inputValue = roundToDecimals(pickedValue, fromUnit.decimals);
        elements.valueInput.value = String(state.inputValue);
        void render();
      }
    });
    renderDistributionChart({
      container: elements.sides.to.chart,
      distribution: toDataset.getDistribution(state.to.selection),
      unit: toUnit,
      markerValue: conversion.outputValue,
      shadedSide: "below",
      axis: toDefinition.chartAxis
    });
    writeStateToUrl(state);

    const historySide = findHistorySide(state);
    const isSurfaceShown = historySide != null && state.showHistorySurface;
    elements.historyPanel.hidden = historySide == null;
    elements.historyToggle.checked = state.showHistorySurface;
    elements.historyCanvas.hidden = !isSurfaceShown;
    elements.historyHint.hidden = !isSurfaceShown;
    if (!isSurfaceShown) {
      historySurface?.dispose();
      historySurface = undefined;
    }
    if (isSurfaceShown) {
      const { createWealthHistorySurface } = await import("./createWealthHistorySurface");
      if (generation !== renderGeneration || !root.isConnected) return;
      historySurface ??= createWealthHistorySurface(elements.historyCanvas);
      const historySelection = state[historySide].selection;
      historySurface.update({
        countryId: historySelection.country ?? HISTORY_DEFAULT_COUNTRY_ID,
        year: Number(historySelection.year ?? HISTORY_DEFAULT_YEAR),
        nominalValue: historySide === "from" ? state.inputValue : conversion.outputValue
      });
    }

    elements.everything.hidden = !state.showEverything;
    elements.everythingToggle.textContent = state.showEverything ? "Hide the full list" : "Compare against everything →";
    if (!state.showEverything) return;
    elements.everythingHeading.textContent = `${formatValue(state.inputValue, fromUnit)} among ${fromDataset.describePopulation(state.from.selection)} is the same position${state.flipped ? ", flipped," : ""} as…`;
    await renderEverythingTable({
      container: elements.everythingTable,
      position: conversion.outputPosition,
      positionClampedAt: conversion.outputPositionClampedAt,
      excludedDatasetId: state.from.datasetId,
      excludedSelection: state.from.selection,
      loadDataset
    });
  };

  for (const side of ["from", "to"] as const) {
    const { datasetSelect } = elements.sides[side];
    datasetSelect.replaceChildren(...DATASETS.map(({ id, label }) => new Option(label, id)));
    datasetSelect.value = state[side].datasetId;
    datasetSelect.addEventListener("change", () => {
      state[side] = { datasetId: datasetSelect.value, selection: {} };
      if (side === "from") {
        state.inputValue = getDatasetDefinition(datasetSelect.value).defaultValue;
        elements.valueInput.value = String(state.inputValue);
      }
      void render();
    });
  }

  elements.valueInput.value = String(state.inputValue);
  elements.valueInput.addEventListener("input", () => {
    const typedValue = findTypedNumber(elements.valueInput.value);
    if (typedValue == null || !Number.isFinite(typedValue)) return;
    state.inputValue = typedValue;
    void render();
  });

  elements.flipToggle.checked = state.flipped;
  elements.flipToggle.addEventListener("change", () => {
    state.flipped = elements.flipToggle.checked;
    void render();
  });

  elements.swapButton.addEventListener("click", () => {
    const previousFrom = state.from;
    state.from = state.to;
    state.to = previousFrom;
    const fromUnit = getDatasetDefinition(state.from.datasetId).unit;
    state.inputValue = roundToDecimals(latestOutputValue ?? state.inputValue, fromUnit.decimals);
    elements.valueInput.value = String(state.inputValue);
    elements.sides.from.datasetSelect.value = state.from.datasetId;
    elements.sides.to.datasetSelect.value = state.to.datasetId;
    void render();
  });

  elements.historyToggle.addEventListener("change", () => {
    state.showHistorySurface = elements.historyToggle.checked;
    void render();
  });

  elements.everythingToggle.addEventListener("click", () => {
    state.showEverything = !state.showEverything;
    void render();
  });

  const chartResizeObserver = new ResizeObserver(() => {
    if (!root.isConnected) {
      chartResizeObserver.disconnect();
      return;
    }
    void render();
  });
  chartResizeObserver.observe(elements.sides.from.chart);

  void render();
}

function findHistorySide(state: ConverterState): Side | undefined {
  if (state.from.datasetId === HISTORY_DATASET_ID) return "from";
  if (state.to.datasetId === HISTORY_DATASET_ID) return "to";
  return undefined;
}

function getConverterElements(root: HTMLElement): ConverterElements {
  return {
    sides: {
      from: getSideElements(root, "from"),
      to: getSideElements(root, "to")
    },
    valueInput: getElement(root, "value", HTMLInputElement),
    unitPrefix: getElement(root, "unit-prefix", HTMLElement),
    unitSuffix: getElement(root, "unit-suffix", HTMLElement),
    result: getElement(root, "result", HTMLElement),
    flipToggle: getElement(root, "flip", HTMLInputElement),
    swapButton: getElement(root, "swap", HTMLButtonElement),
    explanation: getElement(root, "explanation", HTMLElement),
    warnings: getElement(root, "warnings", HTMLElement),
    sources: getElement(root, "sources", HTMLElement),
    everythingToggle: getElement(root, "everything-toggle", HTMLButtonElement),
    everything: getElement(root, "everything", HTMLElement),
    everythingHeading: getElement(root, "everything-heading", HTMLElement),
    everythingTable: getElement(root, "everything-table", HTMLElement),
    historyPanel: getElement(root, "history-3d", HTMLElement),
    historyToggle: getElement(root, "history-3d-toggle", HTMLInputElement),
    historyCanvas: getElement(root, "history-3d-canvas", HTMLElement),
    historyHint: getElement(root, "history-3d-hint", HTMLElement)
  };
}

function getSideElements(root: HTMLElement, side: Side): SideElements {
  return {
    datasetSelect: getElement(root, `${side}-dataset`, HTMLSelectElement),
    parameters: getElement(root, `${side}-parameters`, HTMLElement),
    chart: getElement(root, `${side}-chart`, HTMLElement)
  };
}

function getElement<ElementType extends HTMLElement>(
  root: HTMLElement,
  role: string,
  elementClass: new () => ElementType
): ElementType {
  const element = root.querySelector(`[data-role="${role}"]`);
  if (!(element instanceof elementClass)) throw new Error(`Missing percentile converter element "${role}"`);
  return element;
}

function readStateFromUrl(): ConverterState {
  const query = new URLSearchParams(window.location.search);
  const fromDatasetId = findKnownDatasetId(query.get("from")) ?? DEFAULT_FROM_DATASET_ID;
  const toDatasetId = findKnownDatasetId(query.get("to"));
  const queryValue = Number(query.get("v"));
  return {
    from: { datasetId: fromDatasetId, selection: query.has("from") ? readSelection(query, "from") : DEFAULT_FROM_SELECTION },
    to:
      toDatasetId == null
        ? { datasetId: DEFAULT_TO_DATASET_ID, selection: DEFAULT_TO_SELECTION }
        : { datasetId: toDatasetId, selection: readSelection(query, "to") },
    inputValue: query.has("v") && Number.isFinite(queryValue) ? queryValue : getDatasetDefinition(fromDatasetId).defaultValue,
    flipped: query.get("flip") === "1",
    showEverything: query.get("all") === "1",
    showHistorySurface: query.get("3d") === "1"
  };
}

function findKnownDatasetId(datasetId: string | null) {
  return DATASETS.find(({ id }) => id === datasetId)?.id;
}

function readSelection(query: URLSearchParams, side: Side) {
  const prefix = SELECTION_QUERY_PREFIX_BY_SIDE[side];
  const selection: ParameterSelection = {};
  for (const [key, value] of query) {
    if (!key.startsWith(prefix)) continue;
    selection[key.slice(prefix.length)] = value;
  }
  return selection;
}

function writeStateToUrl(state: ConverterState) {
  const query = new URLSearchParams({ from: state.from.datasetId, to: state.to.datasetId, v: String(state.inputValue) });
  if (state.flipped) query.set("flip", "1");
  if (state.showEverything) query.set("all", "1");
  if (state.showHistorySurface) query.set("3d", "1");
  for (const side of ["from", "to"] as const) {
    for (const [parameterId, optionId] of Object.entries(state[side].selection)) {
      query.set(`${SELECTION_QUERY_PREFIX_BY_SIDE[side]}${parameterId}`, optionId);
    }
  }
  window.history.replaceState(window.history.state, "", `${window.location.pathname}?${query}`);
}

function getDatasetDefinition(datasetId: string): DatasetDefinition {
  const definition = DATASETS.find(({ id }) => id === datasetId);
  if (definition == null) throw new Error(`Unknown dataset "${datasetId}"`);
  return definition;
}

interface RenderParametersParams {
  side: Side;
  dataset: LoadedDataset;
  state: ConverterState;
  elements: ConverterElements;
  onChange: () => void;
}

function renderParameters({ side, dataset, state, elements, onChange }: RenderParametersParams) {
  const container = elements.sides[side].parameters;
  const sideState = state[side];
  for (const parameter of dataset.parameters) {
    const isValidOption = parameter.options.some(({ id }) => id === sideState.selection[parameter.id]);
    if (!isValidOption) sideState.selection[parameter.id] = parameter.defaultOptionId;
  }
  if (container.dataset.renderedFor !== sideState.datasetId) {
    container.dataset.renderedFor = sideState.datasetId;
    const onSelect = (parameterId: string, optionId: string) => {
      state[side].selection[parameterId] = optionId;
      onChange();
    };
    container.replaceChildren(
      ...dataset.parameters
        .filter(({ options }) => options.length > 1)
        .map((parameter) => createParameterControl(parameter, onSelect))
    );
  }
  syncParameterControls(container, sideState.selection);
}

function createParameterControl(
  parameter: DatasetParameter,
  onSelect: (parameterId: string, optionId: string) => void
) {
  if (parameter.options.length <= MAXIMUM_SEGMENTED_OPTIONS) {
    const group = document.createElement("div");
    group.className = "segmented";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", parameter.label);
    group.dataset.parameterId = parameter.id;
    group.append(
      ...parameter.options.map(({ id, label }) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.dataset.optionId = id;
        button.addEventListener("click", () => onSelect(parameter.id, id));
        return button;
      })
    );
    return group;
  }
  const label = document.createElement("label");
  label.className = "parameter-select";
  const select = document.createElement("select");
  select.dataset.parameterId = parameter.id;
  select.replaceChildren(...parameter.options.map(({ id, label: optionLabel }) => new Option(optionLabel, id)));
  select.addEventListener("change", () => onSelect(parameter.id, select.value));
  label.append(parameter.label, select);
  return label;
}

function syncParameterControls(container: HTMLElement, selection: ParameterSelection) {
  for (const select of container.querySelectorAll("select")) {
    select.value = selection[select.dataset.parameterId ?? ""] ?? select.value;
  }
  for (const group of container.querySelectorAll<HTMLElement>(".segmented")) {
    const selectedOptionId = selection[group.dataset.parameterId ?? ""];
    for (const button of group.querySelectorAll<HTMLButtonElement>("button")) {
      button.setAttribute("aria-pressed", String(button.dataset.optionId === selectedOptionId));
    }
  }
}

interface ConvertParams {
  state: ConverterState;
  fromDataset: LoadedDataset;
  toDataset: LoadedDataset;
}

function convert({ state, fromDataset, toDataset }: ConvertParams): Conversion {
  const inputLookup = getPercentilePosition(fromDataset.getDistribution(state.from.selection), state.inputValue);
  const outputPosition = state.flipped ? flipPosition(inputLookup.position) : inputLookup.position;
  const outputLookup = getValueAtPosition(toDataset.getDistribution(state.to.selection), outputPosition);
  const outputPositionClampedAt =
    state.flipped && inputLookup.clampedAt != null ? oppositeEdge(inputLookup.clampedAt) : inputLookup.clampedAt;
  return {
    inputPosition: inputLookup.position,
    outputPosition,
    outputValue: outputLookup.value,
    inputClampedAt: inputLookup.clampedAt,
    outputClampedAt: outputLookup.clampedAt,
    outputPositionClampedAt,
    outputBound: outputLookup.clampedAt ?? outputPositionClampedAt
  };
}

function oppositeEdge(edge: DataEdge): DataEdge {
  return edge === "aboveData" ? "belowData" : "aboveData";
}

function flipPosition({ fractionBelow, fractionAbove }: PercentilePosition): PercentilePosition {
  return { fractionBelow: fractionAbove, fractionAbove: fractionBelow };
}

interface RenderExplanationParams {
  state: ConverterState;
  conversion: Conversion;
  fromDataset: LoadedDataset;
  toDataset: LoadedDataset;
  fromDefinition: DatasetDefinition;
  toDefinition: DatasetDefinition;
  elements: ConverterElements;
  fromUnit: UnitFormat;
  toUnit: UnitFormat;
}

function renderExplanation({
  state,
  conversion,
  fromDataset,
  toDataset,
  fromDefinition,
  toDefinition,
  elements,
  fromUnit,
  toUnit
}: RenderExplanationParams) {
  const fromPopulation = fromDataset.describePopulation(state.from.selection);
  const toPopulation = toDataset.describePopulation(state.to.selection);
  const inputText = formatValue(state.inputValue, fromUnit);
  const outputText = formatBoundedValue(conversion.outputValue, toUnit, conversion.outputBound);
  const inputPositionText = describePosition(conversion.inputPosition, conversion.inputClampedAt);
  const outputPositionText = describePosition(conversion.outputPosition, conversion.outputPositionClampedAt);
  const inputRank = findRankSuffix({
    dataset: fromDataset,
    definition: fromDefinition,
    selection: state.from.selection,
    position: conversion.inputPosition,
    isClamped: conversion.inputClampedAt != null
  });
  const outputRank = findRankSuffix({
    dataset: toDataset,
    definition: toDefinition,
    selection: state.to.selection,
    position: conversion.outputPosition,
    isClamped: conversion.outputBound != null
  });
  const inputSentence = `${inputText} puts you in ${inputPositionText} among ${fromPopulation}${inputRank}.`;
  const outputSentence = state.flipped
    ? `Flipped, that's ${outputPositionText}, which among ${toPopulation} is ${outputText}${outputRank}.`
    : `The same position among ${toPopulation} is ${outputText}${outputRank}.`;
  elements.explanation.textContent = `${inputSentence} ${outputSentence}`;

  const warnings = [
    conversion.inputClampedAt == null ? undefined : describeInputClamp(inputText),
    conversion.outputClampedAt == null ? undefined : describeOutputClamp(conversion.outputClampedAt)
  ].filter((warning) => warning != null);
  elements.warnings.replaceChildren(
    ...warnings.map((warning) => {
      const item = document.createElement("li");
      item.textContent = warning;
      return item;
    })
  );
}

interface RankSuffixParams {
  dataset: LoadedDataset;
  definition: DatasetDefinition;
  selection: ParameterSelection;
  position: PercentilePosition;
  isClamped: boolean;
}

/** Ranks are skipped past the edge of the data, where "the 1st tallest" would overstate what we know. */
function findRankSuffix({ dataset, definition, selection, position, isClamped }: RankSuffixParams) {
  const populationSize = dataset.findPopulationSize(selection);
  if (isClamped || populationSize == null || definition.rankWords == null) return "";
  return `: ${describeRank(position, populationSize, definition.rankWords)}`;
}

function describeInputClamp(inputText: string) {
  return `${inputText} is further out than this data can place, so it's counted at the edge of what it covers.`;
}

function describeOutputClamp(clampedAt: DataEdge) {
  const direction = clampedAt === "aboveData" ? "top" : "bottom";
  return `That position is past the ${direction} of the target data, so the answer is shown as a bound.`;
}

interface RenderSourcesParams {
  fromDataset: LoadedDataset;
  toDataset: LoadedDataset;
  fromDefinition: DatasetDefinition;
  toDefinition: DatasetDefinition;
  elements: ConverterElements;
}

function renderSources({ fromDataset, toDataset, fromDefinition, toDefinition, elements }: RenderSourcesParams) {
  const fromSide = { definition: fromDefinition, dataset: fromDataset };
  const toSide = { definition: toDefinition, dataset: toDataset };
  const uniqueSides = fromDefinition.id === toDefinition.id ? [fromSide] : [fromSide, toSide];
  elements.sources.replaceChildren(
    ...uniqueSides.map(({ definition, dataset }) => {
      const section = document.createElement("div");
      const heading = document.createElement("h3");
      heading.textContent = definition.label;
      const sourceLine = document.createElement("p");
      const link = document.createElement("a");
      link.href = dataset.source.url;
      link.textContent = dataset.source.name;
      sourceLine.append("Source: ", link, ` (${dataset.source.licence})`);
      section.append(heading, sourceLine);
      if (definition.caveat != null) {
        const caveat = document.createElement("p");
        caveat.textContent = definition.caveat;
        section.append(caveat);
      }
      return section;
    })
  );
}

function roundToDecimals(value: number, decimals: number) {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}
