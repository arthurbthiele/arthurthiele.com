import {
  AmbientLight,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
  type Material,
  type Object3D
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import historyFile from "./data/wealthHistory.json";

const WEALTH_BIN_COUNT = 90;
const VISIBLE_TAIL_FRACTION = 0.005;
// Near-linear within ±£1,000 (2025 money): 1820's typical adult held a few thousand of today's pounds, so a wider zone
// would squash early Britain into a sliver.
const SIGNED_LOG_LINEAR_WIDTH = 1000;
const SURFACE_WIDTH = 10;
const SURFACE_DEPTH = 7;
const SURFACE_HEIGHT = 2.6;
const DENSITY_CAP_QUANTILE = 0.999;
const SMOOTHING_STANDARD_DEVIATION_BINS = 1.5;
const SMOOTHING_RADIUS_BINS = 4;
const LOW_COLOUR = new Color("#4f7f4a");
const HIGH_COLOUR = new Color("#d8b25a");
const RIDGE_COLOUR = "#3b2a17";
const HIGHLIGHT_COLOUR = "#8d2a1c";
const FADED_COLOUR = new Color("#e6d8b4");
const FADE_AMOUNT = 0.7;
const WEALTH_TICKS = [-10_000, 0, 1_000, 10_000, 100_000, 1_000_000, 10_000_000];
const YEAR_TICK_STEP = 50;
const INITIAL_CAMERA_POSITION = new Vector3(8, 7.5, 8.5);
const MARKER_RADIUS = 0.09;
// WID's British series switches method in 1995 (survey-based accounts replace a reconstruction of the lower half), which
// shows as a sudden flattening; labelling it keeps that from reading as real history.
const METHOD_BREAK_YEAR_BY_COUNTRY: Record<string, number> = { GB: 1995 };
// Before that break, Britain's lower half keeps fixed proportions to the median from 1913 to 1994 while the top swings,
// which looks like a template rather than measurement, so the part below each year's median is faded.

interface HistoryVariant {
  todaysMoneyPerUnit: number;
  cdf: number[][];
}

interface SurfaceParams {
  countryId: string;
  year: number;
  nominalValue: number;
}

interface YearSlice {
  year: number;
  densities: number[];
  todaysMoneyPerUnit: number;
  fadedBelowBin: number;
}

export interface WealthHistorySurface {
  update: (params: SurfaceParams) => void;
  dispose: () => void;
}

/**
 * One ridge per year: x is net wealth per adult in 2025 money on a signed log axis, depth is the year, height is the
 * share of adults per unit of axis (Δfraction / Δaxis within each bin), so every ridge holds the same total area and
 * years compare fairly. Some years' published percentiles bunch tightly, which turns into needle-thin spikes, so each
 * ridge is smoothed with a small Gaussian kernel (weights renormalised at the edges, so a year's area is kept), and
 * heights are capped at a high quantile so one tall year can't flatten all the others.
 */
export function createWealthHistorySurface(container: HTMLElement): WealthHistorySurface {
  const scene = new Scene();
  const camera = new PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.copy(INITIAL_CAMERA_POSITION);
  const renderer = new WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.className = "history-3d__labels";
  container.replaceChildren(renderer.domElement, labelRenderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, SURFACE_HEIGHT / 4, -SURFACE_DEPTH / 2);
  scene.add(new AmbientLight("#ffffff", 1.6));
  const sun = new DirectionalLight("#fff4dc", 1.8);
  sun.position.set(4, 10, 6);
  scene.add(sun);

  const content = new Group();
  scene.add(content);
  let isDisposed = false;

  const resize = () => {
    const width = Math.max(container.clientWidth, 1);
    const height = Math.max(container.clientHeight, 1);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    labelRenderer.setSize(width, height);
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  resize();

  const animate = () => {
    if (isDisposed) return;
    if (!container.isConnected) {
      dispose();
      return;
    }
    controls.update();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
    requestAnimationFrame(animate);
  };
  requestAnimationFrame(animate);

  function dispose() {
    isDisposed = true;
    resizeObserver.disconnect();
    controls.dispose();
    clearGroup(content);
    renderer.dispose();
  }

  return {
    update: ({ countryId, year, nominalValue }) => {
      clearGroup(content);
      buildSurface({ content, countryId, year, nominalValue });
    },
    dispose
  };
}

interface BuildSurfaceParams {
  content: Group;
  countryId: string;
  year: number;
  nominalValue: number;
}

function buildSurface({ content, countryId, year, nominalValue }: BuildSurfaceParams) {
  const variants: Record<string, HistoryVariant> = historyFile.variants;
  const countryEntries = Object.entries(variants)
    .filter(([key]) => key.startsWith(`${countryId}|`))
    .map(([key, variant]) => ({ year: Number(key.split("|")[1]), variant }))
    .sort((first, second) => first.year - second.year);
  if (countryEntries.length === 0) return;

  const toTodaysPoints = (variant: HistoryVariant) =>
    variant.cdf.map(([value = 0, fraction = 0]) => [value * variant.todaysMoneyPerUnit, fraction] as const);
  const lowestValue = Math.min(...countryEntries.map(({ variant }) => valueAtFraction(toTodaysPoints(variant), VISIBLE_TAIL_FRACTION)));
  const highestValue = Math.max(...countryEntries.map(({ variant }) => valueAtFraction(toTodaysPoints(variant), 1 - VISIBLE_TAIL_FRACTION)));
  const axisLowest = toAxis(lowestValue);
  const axisBinWidth = (toAxis(highestValue) - axisLowest) / WEALTH_BIN_COUNT;
  const binEdges = Array.from({ length: WEALTH_BIN_COUNT + 1 }, (_, index) => fromAxis(axisLowest + index * axisBinWidth));

  const methodBreakYear = METHOD_BREAK_YEAR_BY_COUNTRY[countryId];
  const slices: YearSlice[] = countryEntries.map(({ year: sliceYear, variant }) => {
    const points = toTodaysPoints(variant);
    const fractions = binEdges.map((edge) => fractionAtValue(points, edge));
    const isReconstructed = methodBreakYear != null && sliceYear < methodBreakYear;
    const medianBin = Math.floor((toAxis(valueAtFraction(points, 0.5)) - axisLowest) / axisBinWidth);
    return {
      year: sliceYear,
      todaysMoneyPerUnit: variant.todaysMoneyPerUnit,
      fadedBelowBin: isReconstructed ? medianBin : -1,
      densities: smooth(fractions.slice(1).map((fraction, index) => (fraction - (fractions[index] ?? 0)) / axisBinWidth))
    };
  });
  const allDensities = slices.flatMap(({ densities }) => densities).sort((first, second) => first - second);
  const densityCap = allDensities[Math.floor(allDensities.length * DENSITY_CAP_QUANTILE)] ?? 1;
  const firstYear = slices[0]?.year ?? 0;
  const lastYear = slices.at(-1)?.year ?? 1;

  const toX = (value: number) => ((toAxis(value) - axisLowest) / (toAxis(highestValue) - axisLowest) - 0.5) * SURFACE_WIDTH;
  const toZ = (sliceYear: number) => -((sliceYear - firstYear) / (lastYear - firstYear)) * SURFACE_DEPTH;
  const toHeight = (density: number) => (Math.min(density, densityCap) / densityCap) * SURFACE_HEIGHT;
  const binCentreX = (binIndex: number) => toX(fromAxis(axisLowest + (binIndex + 0.5) * axisBinWidth));

  content.add(createSurfaceMesh({ slices, binCentreX, toZ, toHeight }));
  for (const slice of slices) {
    const isHighlighted = slice.year === nearestYear(slices, year);
    content.add(createRidge({ slice, binCentreX, toZ, toHeight, isHighlighted }));
    if (slice.year === methodBreakYear && !isHighlighted) content.add(createMethodBreakRidge({ slice, binCentreX, toZ, toHeight }));
  }

  const highlightedSlice = slices.find((slice) => slice.year === nearestYear(slices, year));
  if (highlightedSlice != null) {
    const todaysValue = nominalValue * highlightedSlice.todaysMoneyPerUnit;
    const clampedValue = Math.min(Math.max(todaysValue, lowestValue), highestValue);
    const binIndex = Math.min(Math.max(Math.floor((toAxis(clampedValue) - axisLowest) / axisBinWidth), 0), WEALTH_BIN_COUNT - 1);
    const marker = new Mesh(new SphereGeometry(MARKER_RADIUS, 16, 12), new MeshLambertMaterial({ color: HIGHLIGHT_COLOUR }));
    marker.position.set(toX(clampedValue), toHeight(highlightedSlice.densities[binIndex] ?? 0) + MARKER_RADIUS, toZ(highlightedSlice.year));
    content.add(marker);
  }

  for (const tickValue of WEALTH_TICKS.filter((value) => value >= lowestValue && value <= highestValue)) {
    content.add(createLabel(formatPounds(tickValue, countryId), new Vector3(toX(tickValue), -0.15, 0.45)));
  }
  content.add(createLabel(String(firstYear), new Vector3(SURFACE_WIDTH / 2 + 0.5, 0, toZ(firstYear))));
  for (let tickYear = Math.ceil((firstYear + 1) / YEAR_TICK_STEP) * YEAR_TICK_STEP; tickYear < lastYear; tickYear += YEAR_TICK_STEP) {
    content.add(createLabel(String(tickYear), new Vector3(SURFACE_WIDTH / 2 + 0.5, 0, toZ(tickYear))));
  }
  content.add(createLabel(String(lastYear), new Vector3(SURFACE_WIDTH / 2 + 0.5, 0, toZ(lastYear))));
  content.add(
    createLabel(`net wealth per adult, 2025 ${countryId === "FR" ? "euros" : "pounds"}`, new Vector3(0, -0.6, 0.9), "history-3d__axis-title")
  );
  if (methodBreakYear != null) {
    content.add(createLabel(`${methodBreakYear}: method change`, new Vector3(SURFACE_WIDTH / 2 + 0.2, 1.3, toZ(methodBreakYear)), "history-3d__method-break"));
    content.add(
      createLabel(
        `faded: lower half before ${methodBreakYear}, reconstructed rather than measured`,
        new Vector3(-SURFACE_WIDTH / 4, SURFACE_HEIGHT * 1.3, toZ((firstYear + methodBreakYear) / 2)),
        "history-3d__method-break"
      )
    );
  }
}

interface SurfaceMeshParams {
  slices: YearSlice[];
  binCentreX: (binIndex: number) => number;
  toZ: (year: number) => number;
  toHeight: (density: number) => number;
}

function createSurfaceMesh({ slices, binCentreX, toZ, toHeight }: SurfaceMeshParams) {
  const positions: number[] = [];
  const colours: number[] = [];
  const indices: number[] = [];
  for (const slice of slices) {
    for (let binIndex = 0; binIndex < WEALTH_BIN_COUNT; binIndex += 1) {
      const height = toHeight(slice.densities[binIndex] ?? 0);
      positions.push(binCentreX(binIndex), height, toZ(slice.year));
      const colour = LOW_COLOUR.clone().lerp(HIGH_COLOUR, height / SURFACE_HEIGHT);
      if (binIndex < slice.fadedBelowBin) colour.lerp(FADED_COLOUR, FADE_AMOUNT);
      colours.push(colour.r, colour.g, colour.b);
    }
  }
  for (let sliceIndex = 0; sliceIndex < slices.length - 1; sliceIndex += 1) {
    for (let binIndex = 0; binIndex < WEALTH_BIN_COUNT - 1; binIndex += 1) {
      const corner = sliceIndex * WEALTH_BIN_COUNT + binIndex;
      const nextSliceCorner = corner + WEALTH_BIN_COUNT;
      indices.push(corner, nextSliceCorner, corner + 1, corner + 1, nextSliceCorner, nextSliceCorner + 1);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(colours, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return new Mesh(geometry, new MeshLambertMaterial({ vertexColors: true, side: DoubleSide, transparent: true, opacity: 0.92 }));
}

interface RidgeParams {
  slice: YearSlice;
  binCentreX: (binIndex: number) => number;
  toZ: (year: number) => number;
  toHeight: (density: number) => number;
  isHighlighted: boolean;
}

function createRidge({ slice, binCentreX, toZ, toHeight, isHighlighted }: RidgeParams) {
  const lift = isHighlighted ? 0.03 : 0.004;
  const points = slice.densities.map((density, binIndex) => new Vector3(binCentreX(binIndex), toHeight(density) + lift, toZ(slice.year)));
  const material = new LineBasicMaterial({
    color: isHighlighted ? HIGHLIGHT_COLOUR : RIDGE_COLOUR,
    transparent: true,
    opacity: isHighlighted ? 1 : 0.18
  });
  return new Line(new BufferGeometry().setFromPoints(points), material);
}

function createMethodBreakRidge({ slice, binCentreX, toZ, toHeight }: Omit<RidgeParams, "isHighlighted">) {
  const points = slice.densities.map((density, binIndex) => new Vector3(binCentreX(binIndex), toHeight(density) + 0.02, toZ(slice.year)));
  const ridge = new Line(new BufferGeometry().setFromPoints(points), new LineDashedMaterial({ color: HIGHLIGHT_COLOUR, dashSize: 0.12, gapSize: 0.08 }));
  ridge.computeLineDistances();
  return ridge;
}

function createLabel(text: string, position: Vector3, className = "history-3d__label") {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  const label = new CSS2DObject(element);
  label.position.copy(position);
  return label;
}

function smooth(densities: number[]) {
  return densities.map((_, centre) => {
    let weightedTotal = 0;
    let weightTotal = 0;
    for (let offset = -SMOOTHING_RADIUS_BINS; offset <= SMOOTHING_RADIUS_BINS; offset += 1) {
      const density = densities[centre + offset];
      if (density == null) continue;
      const weight = Math.exp(-(offset * offset) / (2 * SMOOTHING_STANDARD_DEVIATION_BINS ** 2));
      weightedTotal += weight * density;
      weightTotal += weight;
    }
    return weightedTotal / weightTotal;
  });
}

function nearestYear(slices: YearSlice[], year: number) {
  return slices.reduce((closest, slice) => (Math.abs(slice.year - year) < Math.abs(closest - year) ? slice.year : closest), slices[0]?.year ?? year);
}

function fractionAtValue(points: ReadonlyArray<readonly [number, number]>, value: number) {
  const first = points[0];
  const last = points.at(-1);
  if (first == null || last == null || value <= first[0]) return 0;
  if (value >= last[0]) return 1;
  const upperIndex = points.findIndex(([pointValue]) => pointValue >= value);
  const [lowerValue, lowerFraction] = points[upperIndex - 1] ?? first;
  const [upperValue, upperFraction] = points[upperIndex] ?? last;
  return lowerFraction + ((value - lowerValue) / (upperValue - lowerValue)) * (upperFraction - lowerFraction);
}

function valueAtFraction(points: ReadonlyArray<readonly [number, number]>, fraction: number) {
  const upperIndex = points.findIndex(([, pointFraction]) => pointFraction >= fraction);
  if (upperIndex <= 0) return points[0]?.[0] ?? 0;
  const [lowerValue, lowerFraction] = points[upperIndex - 1] ?? [0, 0];
  const [upperValue, upperFraction] = points[upperIndex] ?? [0, 1];
  return lowerValue + ((fraction - lowerFraction) / (upperFraction - lowerFraction)) * (upperValue - lowerValue);
}

function toAxis(value: number) {
  return Math.sign(value) * Math.log1p(Math.abs(value) / SIGNED_LOG_LINEAR_WIDTH);
}

function fromAxis(axisValue: number) {
  return Math.sign(axisValue) * SIGNED_LOG_LINEAR_WIDTH * Math.expm1(Math.abs(axisValue));
}

function formatPounds(value: number, countryId: string) {
  const symbol = countryId === "FR" ? "€" : "£";
  const magnitude = Math.abs(value).toLocaleString("en-AU", { notation: "compact" });
  return `${value < 0 ? "−" : ""}${symbol}${magnitude}`;
}

function clearGroup(group: Group) {
  for (const child of [...group.children]) {
    disposeObject(child);
    group.remove(child);
  }
}

function disposeObject(object: Object3D) {
  if (object instanceof Mesh || object instanceof Line) {
    object.geometry.dispose();
    const materials: Material[] = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) material.dispose();
  }
  if (object instanceof CSS2DObject) object.element.remove();
}
