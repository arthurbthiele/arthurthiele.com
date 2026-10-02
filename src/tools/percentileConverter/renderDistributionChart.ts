import { describePosition } from "./describePosition";
import { formatValue } from "./formatValue";
import { getPercentilePosition } from "./getPercentilePosition";
import { getValueAtPosition } from "./getValueAtPosition";
import type { ChartAxis, Distribution, UnitFormat } from "./percentileTypes";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const PLOT_TOP_PADDING_PX = 18;
const AXIS_LABEL_HEIGHT_PX = 18;
const FALLBACK_CHART_HEIGHT_PX = 96;
const NORMAL_CURVE_SAMPLE_COUNT = 160;
const VISIBLE_TAIL_FRACTION = 0.005;
const EMPIRICAL_DISPLAY_BIN_COUNT = 60;
// The signed-log axis is near-linear within ±(this fraction of the median). Narrower zones made a false dip around
// zero, because a log axis gives each dollar near zero less width than it gives dollars out in the millions; a quarter of
// the median removed the dip without crowding the top end (compared by eye on wealth, super and 1820 Britain).
const SIGNED_LOG_LINEAR_WIDTH_PER_MEDIAN = 0.25;
const MINIMUM_SIGNED_LOG_LINEAR_WIDTH = 1;
const EDGE_LABEL_MARGIN_PX = 40;
const TARGET_TICK_COUNT = 5;
const MINIMUM_TICK_SPACING_PX = 64;
const TICK_LENGTH_PX = 4;
const MAXIMUM_TICK_SUFFIX_LENGTH = 4;
const NICE_STEP_MULTIPLIERS = [1, 2, 2.5, 5, 10];
const LOG_TICK_MULTIPLIERS = [1, 2, 5];
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

interface AxisTransform {
  axis: ChartAxis;
  signedLogLinearWidth: number;
}

interface CurvePoint {
  value: number;
  density: number;
}

interface ChartScale {
  transform: AxisTransform;
  minimumValue: number;
  maximumValue: number;
  maximumDensity: number;
  widthPx: number;
  heightPx: number;
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
  const heightPx = container.clientHeight || FALLBACK_CHART_HEIGHT_PX;
  const minimumValue = getValueAtPosition(distribution, { fractionBelow: VISIBLE_TAIL_FRACTION, fractionAbove: 1 - VISIBLE_TAIL_FRACTION }).value;
  const maximumValue = getValueAtPosition(distribution, { fractionBelow: 1 - VISIBLE_TAIL_FRACTION, fractionAbove: VISIBLE_TAIL_FRACTION }).value;
  const medianValue = getValueAtPosition(distribution, MEDIAN_POSITION).value;
  const transform: AxisTransform = {
    axis,
    signedLogLinearWidth: Math.max(MINIMUM_SIGNED_LOG_LINEAR_WIDTH, Math.abs(medianValue) * SIGNED_LOG_LINEAR_WIDTH_PER_MEDIAN)
  };
  const curve = getDensityCurve(distribution, minimumValue, maximumValue, transform);
  const scale: ChartScale = {
    transform,
    minimumValue,
    maximumValue,
    maximumDensity: Math.max(...curve.map(({ density }) => density)),
    widthPx,
    heightPx,
    plotBottomPx: heightPx - AXIS_LABEL_HEIGHT_PX
  };
  const clampedMarkerValue = Math.min(Math.max(markerValue, minimumValue), maximumValue);

  const svg = createSvgElement("svg", {
    width: String(widthPx),
    height: String(heightPx),
    viewBox: `0 0 ${widthPx} ${heightPx}`,
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
    ...createAxisTicks(unit, scale),
    createMedianLine(medianValue, unit, scale),
    createMarker(clampedMarkerValue, scale)
  );

  container.replaceChildren(svg, createHoverLayer({ container, svg, distribution, unit, scale, onPickValue }));
}

/**
 * Normal: the probability density φ((x − μ)/σ)/σ. Lognormal: φ((ln(x − s) − μ)/σ)/((x − s)σ) for shift s, the
 * extra 1/(x − s) being the Jacobian of the log. Empirical: the CDF is piecewise linear, so its derivative (the
 * density) is constant within each bin at Δfraction / Δvalue. Source bins vary wildly in width, so for display we
 * re-bin into equal widths along the axis and draw steps: a coarser but still honest histogram.
 * On a logarithmic axis the density is per unit of ln(value), Δfraction / Δln(value), so equal areas still hold equal
 * shares of people; incomes then look like a hump instead of a wall against the left edge. The signed logarithmic axis,
 * sign(v)·ln(1 + |v|/c), does the same for data that goes negative (net wealth): logarithmic for large debts and
 * fortunes alike, near-linear within ±c of zero.
 */
function getDensityCurve(distribution: Distribution, minimumValue: number, maximumValue: number, transform: AxisTransform): CurvePoint[] {
  const smoothDensity = findSmoothDensity(distribution);
  if (smoothDensity != null) return sampleCurve(minimumValue, maximumValue, smoothDensity);
  return getEmpiricalStepCurve(distribution, minimumValue, maximumValue, transform);
}

/** A mixture's density is the weighted sum of its groups' densities, smooth only if every group's is. */
function findSmoothDensity(distribution: Distribution): ((value: number) => number) | undefined {
  switch (distribution.kind) {
    case "normal": {
      const { mean, standardDeviation } = distribution;
      return (value) => standardNormalDensity((value - mean) / standardDeviation) / standardDeviation;
    }
    case "logNormal": {
      const { logMean, logStandardDeviation, shift = 0 } = distribution;
      return (value) => {
        const shiftedValue = value - shift;
        if (shiftedValue <= 0) return 0;
        return standardNormalDensity((Math.log(shiftedValue) - logMean) / logStandardDeviation) / (shiftedValue * logStandardDeviation);
      };
    }
    case "mixture": {
      const componentDensities = distribution.components.map(({ weight, distribution: component }) => ({
        weight,
        density: findSmoothDensity(component)
      }));
      if (componentDensities.some(({ density }) => density == null)) return undefined;
      return (value) => componentDensities.reduce((total, { weight, density }) => total + weight * (density?.(value) ?? 0), 0);
    }
    default:
      return undefined;
  }
}

function sampleCurve(minimumValue: number, maximumValue: number, getDensity: (value: number) => number): CurvePoint[] {
  return Array.from({ length: NORMAL_CURVE_SAMPLE_COUNT + 1 }, (_, index) => {
    const value = minimumValue + ((maximumValue - minimumValue) * index) / NORMAL_CURVE_SAMPLE_COUNT;
    return { value, density: getDensity(value) };
  });
}

function standardNormalDensity(zScore: number) {
  return Math.exp((-zScore * zScore) / 2) / Math.sqrt(2 * Math.PI);
}

function getEmpiricalStepCurve(distribution: Distribution, minimumValue: number, maximumValue: number, transform: AxisTransform) {
  const axisMinimum = toAxisUnits(minimumValue, transform);
  const axisBinWidth = (toAxisUnits(maximumValue, transform) - axisMinimum) / EMPIRICAL_DISPLAY_BIN_COUNT;
  const steps: CurvePoint[] = [];
  for (let binIndex = 0; binIndex < EMPIRICAL_DISPLAY_BIN_COUNT; binIndex += 1) {
    const lowerValue = fromAxisUnits(axisMinimum + binIndex * axisBinWidth, transform);
    const upperValue = fromAxisUnits(axisMinimum + (binIndex + 1) * axisBinWidth, transform);
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

function toX(value: number, { transform, minimumValue, maximumValue, widthPx }: ChartScale) {
  const axisMinimum = toAxisUnits(minimumValue, transform);
  return ((toAxisUnits(value, transform) - axisMinimum) / (toAxisUnits(maximumValue, transform) - axisMinimum)) * widthPx;
}

function toAxisUnits(value: number, { axis, signedLogLinearWidth }: AxisTransform) {
  switch (axis) {
    case "logarithmic":
      return Math.log(value);
    case "signedLogarithmic":
      return Math.sign(value) * Math.log1p(Math.abs(value) / signedLogLinearWidth);
    default:
      return value;
  }
}

function fromAxisUnits(axisValue: number, { axis, signedLogLinearWidth }: AxisTransform) {
  switch (axis) {
    case "logarithmic":
      return Math.exp(axisValue);
    case "signedLogarithmic":
      return Math.sign(axisValue) * signedLogLinearWidth * Math.expm1(Math.abs(axisValue));
    default:
      return axisValue;
  }
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

function createMedianLine(medianValue: number, unit: UnitFormat, scale: ChartScale) {
  const x = toX(medianValue, scale);
  const group = createSvgElement("g", { class: "distribution-chart__median" });
  group.append(
    createSvgElement("line", { x1: String(x), x2: String(x), y1: String(PLOT_TOP_PADDING_PX - 2), y2: String(scale.plotBottomPx) })
  );
  const label = createSvgElement("text", {
    x: String(x),
    y: String(PLOT_TOP_PADDING_PX - 6),
    "text-anchor": getEdgeAwareAnchor(x, scale.widthPx)
  });
  label.textContent = `median ${formatValue(medianValue, unit)}`;
  group.append(label);
  return group;
}

function getEdgeAwareAnchor(x: number, widthPx: number) {
  if (x < EDGE_LABEL_MARGIN_PX) return "start";
  if (x > widthPx - EDGE_LABEL_MARGIN_PX) return "end";
  return "middle";
}

/** Round-valued ticks: 1–2–5 steps on a linear axis, powers of ten on a log axis, plus zero on a signed-log one. */
function createAxisTicks(unit: UnitFormat, scale: ChartScale) {
  const candidates = getTickCandidates(scale).filter((value) => toX(value, scale) >= 0 && toX(value, scale) <= scale.widthPx);
  const byPriority = [...candidates.filter((value) => value === 0), ...candidates.filter((value) => value !== 0)];
  const kept: number[] = [];
  for (const value of byPriority) {
    const x = toX(value, scale);
    if (kept.some((keptValue) => Math.abs(toX(keptValue, scale) - x) < MINIMUM_TICK_SPACING_PX)) continue;
    kept.push(value);
  }
  return kept.map((value) => {
    const x = toX(value, scale);
    const group = createSvgElement("g", { class: value === 0 ? "distribution-chart__tick distribution-chart__tick--zero" : "distribution-chart__tick" });
    group.append(
      createSvgElement("line", {
        x1: String(x),
        x2: String(x),
        y1: String(value === 0 ? PLOT_TOP_PADDING_PX : scale.plotBottomPx),
        y2: String(scale.plotBottomPx + TICK_LENGTH_PX)
      })
    );
    const label = createSvgElement("text", { x: String(x), y: String(scale.heightPx - 3), "text-anchor": getEdgeAwareAnchor(x, scale.widthPx) });
    label.textContent = formatTickValue(value, unit);
    group.append(label);
    return group;
  });
}

function getTickCandidates({ transform, minimumValue, maximumValue }: ChartScale) {
  if (transform.axis === "linear") {
    const step = getNiceStep((maximumValue - minimumValue) / TARGET_TICK_COUNT);
    const firstTick = Math.ceil(minimumValue / step) * step;
    return Array.from({ length: Math.floor((maximumValue - firstTick) / step) + 1 }, (_, index) => firstTick + index * step);
  }
  const powersOfTen = (lowest: number, highest: number) => {
    const values: number[] = [];
    for (let exponent = Math.floor(Math.log10(lowest)); exponent <= Math.ceil(Math.log10(highest)); exponent += 1) {
      values.push(10 ** exponent);
    }
    return values;
  };
  if (transform.axis === "logarithmic") {
    return powersOfTen(minimumValue, maximumValue).flatMap((power) => LOG_TICK_MULTIPLIERS.map((multiplier) => multiplier * power));
  }
  const positive = maximumValue > 0 ? powersOfTen(Math.max(transform.signedLogLinearWidth, 1), maximumValue) : [];
  const negative = minimumValue < 0 ? powersOfTen(Math.max(transform.signedLogLinearWidth, 1), -minimumValue).map((value) => -value).reverse() : [];
  return [...negative, ...(minimumValue < 0 && maximumValue > 0 ? [0] : []), ...positive];
}

function getNiceStep(roughStep: number) {
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const multiplier = NICE_STEP_MULTIPLIERS.find((candidate) => candidate * magnitude >= roughStep) ?? 10;
  return multiplier * magnitude;
}

function formatTickValue(value: number, { prefix = "", suffix = "" }: UnitFormat) {
  const magnitude = Math.abs(value);
  const number = magnitude >= 1000 ? magnitude.toLocaleString("en-AU", { notation: "compact", maximumFractionDigits: 1 }) : magnitude.toLocaleString("en-AU", { maximumFractionDigits: 1 });
  const shortSuffix = suffix.trim().length <= MAXIMUM_TICK_SUFFIX_LENGTH ? suffix : "";
  return `${value < 0 ? "\u2212" : ""}${prefix}${number}${shortSuffix}`;
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
    const axisMinimum = toAxisUnits(scale.minimumValue, scale.transform);
    const axisMaximum = toAxisUnits(scale.maximumValue, scale.transform);
    return fromAxisUnits(axisMinimum + fractionAcross * (axisMaximum - axisMinimum), scale.transform);
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
