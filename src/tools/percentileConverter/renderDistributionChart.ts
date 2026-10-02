import { describePosition } from "./describePosition";
import { formatValue } from "./formatValue";
import { getPercentilePosition } from "./getPercentilePosition";
import { getValueAtPosition } from "./getValueAtPosition";
import type { ChartAxis, Distribution, UnitFormat } from "./percentileTypes";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const CHART_HEIGHT_PX = 96;
const PLOT_TOP_PADDING_PX = 8;
const AXIS_LABEL_HEIGHT_PX = 18;
const NORMAL_CURVE_SAMPLE_COUNT = 160;
const VISIBLE_TAIL_FRACTION = 0.005;
const EMPIRICAL_DISPLAY_BIN_COUNT = 60;
const MEDIAN_POSITION = { fractionBelow: 0.5, fractionAbove: 0.5 };

export type ShadedSide = "below" | "above";

interface DistributionChartParams {
  container: HTMLElement;
  distribution: Distribution;
  unit: UnitFormat;
  markerValue: number;
  shadedSide: ShadedSide;
  axis?: ChartAxis;
  onPickValue?: (value: number) => void;
}

interface CurvePoint {
  value: number;
  density: number;
}

interface ChartScale {
  axis: ChartAxis;
  minimumValue: number;
  maximumValue: number;
  maximumDensity: number;
  widthPx: number;
  plotBottomPx: number;
}

export function renderDistributionChart({
  container,
  distribution,
  unit,
  markerValue,
  shadedSide,
  axis = "linear",
  onPickValue
}: DistributionChartParams) {
  const widthPx = Math.max(container.clientWidth, 1);
  const minimumValue = getValueAtPosition(distribution, { fractionBelow: VISIBLE_TAIL_FRACTION, fractionAbove: 1 - VISIBLE_TAIL_FRACTION }).value;
  const maximumValue = getValueAtPosition(distribution, { fractionBelow: 1 - VISIBLE_TAIL_FRACTION, fractionAbove: VISIBLE_TAIL_FRACTION }).value;
  const curve = getDensityCurve(distribution, minimumValue, maximumValue, axis);
  const scale: ChartScale = {
    axis,
    minimumValue,
    maximumValue,
    maximumDensity: Math.max(...curve.map(({ density }) => density)),
    widthPx,
    plotBottomPx: CHART_HEIGHT_PX - AXIS_LABEL_HEIGHT_PX
  };
  const clampedMarkerValue = Math.min(Math.max(markerValue, minimumValue), maximumValue);

  const svg = createSvgElement("svg", {
    width: String(widthPx),
    height: String(CHART_HEIGHT_PX),
    viewBox: `0 0 ${widthPx} ${CHART_HEIGHT_PX}`,
    role: "img",
    "aria-label": `Distribution curve with ${formatValue(markerValue, unit)} marked`
  });
  const shadedCurve = curve.filter(({ value }) => (shadedSide === "below" ? value <= clampedMarkerValue : value >= clampedMarkerValue));
  const shadedEdgePoint = { value: clampedMarkerValue, density: getDensityAt(curve, clampedMarkerValue) };
  const shadedPoints = shadedSide === "below" ? [...shadedCurve, shadedEdgePoint] : [shadedEdgePoint, ...shadedCurve];

  svg.append(
    createSvgElement("line", {
      class: "distribution-chart__baseline",
      x1: "0",
      x2: String(widthPx),
      y1: String(scale.plotBottomPx),
      y2: String(scale.plotBottomPx)
    }),
    createSvgElement("path", { class: "distribution-chart__wash", d: toAreaPath(curve, scale) }),
    createSvgElement("path", { class: "distribution-chart__shade", d: toAreaPath(shadedPoints, scale) }),
    createSvgElement("path", { class: "distribution-chart__line", d: toLinePath(curve, scale) }),
    createMarker(clampedMarkerValue, scale),
    createMedianTick(distribution, unit, scale)
  );

  container.replaceChildren(svg, createHoverLayer({ container, svg, distribution, unit, scale, onPickValue }));
}

/**
 * Normal: the probability density φ((x − μ)/σ)/σ. Empirical: the CDF is piecewise linear, so its derivative (the
 * density) is constant within each bin at Δfraction / Δvalue. Source bins vary wildly in width, so for display we
 * re-bin into equal widths along the axis and draw steps: a coarser but still honest histogram.
 * On a logarithmic axis the density is per unit of ln(value), Δfraction / Δln(value), so equal areas still hold equal
 * shares of people; incomes then look like a hump instead of a wall against the left edge.
 */
function getDensityCurve(distribution: Distribution, minimumValue: number, maximumValue: number, axis: ChartAxis): CurvePoint[] {
  if (distribution.kind === "normal") {
    const { mean, standardDeviation } = distribution;
    return Array.from({ length: NORMAL_CURVE_SAMPLE_COUNT + 1 }, (_, index) => {
      const value = minimumValue + ((maximumValue - minimumValue) * index) / NORMAL_CURVE_SAMPLE_COUNT;
      const zScore = (value - mean) / standardDeviation;
      return { value, density: Math.exp((-zScore * zScore) / 2) / (standardDeviation * Math.sqrt(2 * Math.PI)) };
    });
  }
  return getEmpiricalStepCurve(distribution, minimumValue, maximumValue, axis);
}

function getEmpiricalStepCurve(distribution: Distribution, minimumValue: number, maximumValue: number, axis: ChartAxis) {
  const axisMinimum = toAxisUnits(minimumValue, axis);
  const axisBinWidth = (toAxisUnits(maximumValue, axis) - axisMinimum) / EMPIRICAL_DISPLAY_BIN_COUNT;
  const steps: CurvePoint[] = [];
  for (let binIndex = 0; binIndex < EMPIRICAL_DISPLAY_BIN_COUNT; binIndex += 1) {
    const lowerValue = fromAxisUnits(axisMinimum + binIndex * axisBinWidth, axis);
    const upperValue = fromAxisUnits(axisMinimum + (binIndex + 1) * axisBinWidth, axis);
    const fractionInBin =
      getPercentilePosition(distribution, upperValue).position.fractionBelow -
      getPercentilePosition(distribution, lowerValue).position.fractionBelow;
    const density = fractionInBin / axisBinWidth;
    steps.push({ value: lowerValue, density }, { value: upperValue, density });
  }
  return steps;
}

function getDensityAt(curve: CurvePoint[], value: number) {
  const upperIndex = curve.findIndex((point) => point.value >= value);
  if (upperIndex <= 0) return curve[0]?.density ?? 0;
  const lower = curve[upperIndex - 1];
  const upper = curve[upperIndex];
  if (upper.value === lower.value) return upper.density;
  return lower.density + ((value - lower.value) / (upper.value - lower.value)) * (upper.density - lower.density);
}

function toAreaPath(points: CurvePoint[], scale: ChartScale) {
  if (points.length === 0) return "";
  const firstX = toX(points[0].value, scale);
  const lastX = toX(points[points.length - 1].value, scale);
  return `M${firstX},${scale.plotBottomPx} ${points.map((point) => `L${toX(point.value, scale)},${toY(point.density, scale)}`).join(" ")} L${lastX},${scale.plotBottomPx}Z`;
}

function toLinePath(points: CurvePoint[], scale: ChartScale) {
  return points.map((point, index) => `${index === 0 ? "M" : "L"}${toX(point.value, scale)},${toY(point.density, scale)}`).join(" ");
}

function toX(value: number, { axis, minimumValue, maximumValue, widthPx }: ChartScale) {
  const axisMinimum = toAxisUnits(minimumValue, axis);
  return ((toAxisUnits(value, axis) - axisMinimum) / (toAxisUnits(maximumValue, axis) - axisMinimum)) * widthPx;
}

function toAxisUnits(value: number, axis: ChartAxis) {
  return axis === "logarithmic" ? Math.log(value) : value;
}

function fromAxisUnits(axisValue: number, axis: ChartAxis) {
  return axis === "logarithmic" ? Math.exp(axisValue) : axisValue;
}

function toY(density: number, { maximumDensity, plotBottomPx }: ChartScale) {
  return plotBottomPx - (density / maximumDensity) * (plotBottomPx - PLOT_TOP_PADDING_PX);
}

function createMarker(value: number, scale: ChartScale) {
  const x = String(toX(value, scale));
  return createSvgElement("line", {
    class: "distribution-chart__marker",
    x1: x,
    x2: x,
    y1: String(PLOT_TOP_PADDING_PX / 2),
    y2: String(scale.plotBottomPx)
  });
}

function createMedianTick(distribution: Distribution, unit: UnitFormat, scale: ChartScale) {
  const medianValue = getValueAtPosition(distribution, MEDIAN_POSITION).value;
  const label = createSvgElement("text", {
    class: "distribution-chart__axis-label",
    x: String(toX(medianValue, scale)),
    y: String(CHART_HEIGHT_PX - 4),
    "text-anchor": "middle"
  });
  label.textContent = `median ${formatValue(medianValue, unit)}`;
  return label;
}

interface HoverLayerParams {
  container: HTMLElement;
  svg: SVGSVGElement;
  distribution: Distribution;
  unit: UnitFormat;
  scale: ChartScale;
  onPickValue?: (value: number) => void;
}

function createHoverLayer({ container, svg, distribution, unit, scale, onPickValue }: HoverLayerParams) {
  const tooltip = document.createElement("div");
  tooltip.className = "distribution-chart__tooltip";
  tooltip.hidden = true;
  const crosshair = createSvgElement("line", {
    class: "distribution-chart__crosshair",
    y1: "0",
    y2: String(scale.plotBottomPx),
    visibility: "hidden"
  });
  svg.append(crosshair);

  const getValueAtPointer = (event: PointerEvent) => {
    const fractionAcross = Math.min(Math.max((event.clientX - svg.getBoundingClientRect().left) / scale.widthPx, 0), 1);
    const axisMinimum = toAxisUnits(scale.minimumValue, scale.axis);
    const axisMaximum = toAxisUnits(scale.maximumValue, scale.axis);
    return fromAxisUnits(axisMinimum + fractionAcross * (axisMaximum - axisMinimum), scale.axis);
  };

  svg.addEventListener("pointermove", (event) => {
    const value = getValueAtPointer(event);
    const x = toX(value, scale);
    crosshair.setAttribute("x1", String(x));
    crosshair.setAttribute("x2", String(x));
    crosshair.setAttribute("visibility", "visible");
    const { position } = getPercentilePosition(distribution, value);
    tooltip.textContent = `${formatValue(value, unit)} · ${describePosition(position)}`;
    tooltip.hidden = false;
    tooltip.style.left = `${Math.min(Math.max(x, 0), container.clientWidth)}px`;
  });
  svg.addEventListener("pointerleave", () => {
    crosshair.setAttribute("visibility", "hidden");
    tooltip.hidden = true;
  });
  if (onPickValue != null) {
    svg.classList.add("distribution-chart--pickable");
    svg.addEventListener("click", (event) => onPickValue(getValueAtPointer(event)));
  }
  return tooltip;
}

function createSvgElement<TagName extends keyof SVGElementTagNameMap>(
  tagName: TagName,
  attributes: Record<string, string>
): SVGElementTagNameMap[TagName] {
  const element = document.createElementNS(SVG_NAMESPACE, tagName);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}
