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
import { formatTickValue } from "./formatTickValue";
import { getAxisTickCandidates } from "./getAxisTickCandidates";
import { getPercentilePosition } from "./getPercentilePosition";
import { getValueAtPosition } from "./getValueAtPosition";
import type { ChartAxis, SurfaceSpec } from "./percentileTypes";

const VALUE_BIN_COUNT = 90;
const VISIBLE_TAIL_FRACTION = 0.005;
const MEDIAN_POSITION = { fractionBelow: 0.5, fractionAbove: 0.5 };
const SIGNED_LOG_LINEAR_WIDTH_PER_MEDIAN = 0.25;
const MINIMUM_SIGNED_LOG_LINEAR_WIDTH = 1;
const SURFACE_WIDTH = 10;
const SURFACE_DEPTH = 7;
const SURFACE_HEIGHT = 2.6;
const DENSITY_CAP_QUANTILE = 0.999;
const PEAK_CAP_MULTIPLE_OF_TYPICAL = 1.5;
const SMOOTHING_STANDARD_DEVIATION_BINS = 1.5;
const SMOOTHING_RADIUS_BINS = 4;
const LOW_COLOUR = new Color("#4f7f4a");
const HIGH_COLOUR = new Color("#d8b25a");
const FADED_COLOUR = new Color("#e6d8b4");
const FADE_AMOUNT = 0.7;
const RIDGE_COLOUR = "#3b2a17";
const HIGHLIGHT_COLOUR = "#8d2a1c";
const INITIAL_CAMERA_POSITION = new Vector3(8, 7.5, 8.5);
const MARKER_RADIUS = 0.09;
const MINIMUM_VALUE_TICK_GAP = 1.1;
const MAXIMUM_DEPTH_LABELS = 7;
const LABEL_ALL_SLICES_UP_TO = 14;
const NICE_DEPTH_STEPS = [1, 2, 5, 10, 20, 25, 50, 100];

interface PlacedSlice {
  position: number;
  label: string;
  densities: number[];
  fadedBelowBin: number;
}

interface AxisTransform {
  toAxis: (value: number) => number;
  fromAxis: (axisValue: number) => number;
}

export interface DistributionSurface {
  update: (spec: SurfaceSpec) => void;
  dispose: () => void;
}

/**
 * A ridge per slice (a year, an age band…): across is the value on the dataset's chart axis, depth is the slice's
 * position, height is the share of people per unit of axis (Δfraction / Δaxis within each bin), so every ridge holds the
 * same area and slices compare fairly. Ridges are lightly smoothed with a Gaussian kernel (weights renormalised at the
 * edges, so area is kept), because some sources' published percentiles bunch into needle-thin spikes. Heights are
 * capped at a high quantile and at 1.5× the typical ridge's peak, so one tall ridge (super balances under 20, which are
 * nearly all tiny) can't flatten the rest.
 */
export function createDistributionSurface(container: HTMLElement): DistributionSurface {
  const scene = new Scene();
  const camera = new PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.copy(INITIAL_CAMERA_POSITION);
  const renderer = new WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.className = "surface-3d__labels";
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
    update: (spec) => {
      clearGroup(content);
      buildSurface(content, spec);
    },
    dispose
  };
}

function buildSurface(content: Group, spec: SurfaceSpec) {
  const sortedSlices = [...spec.slices].sort((first, second) => first.position - second.position);
  if (sortedSlices.length < 2) return;

  const lowestValue = Math.min(...sortedSlices.map(({ distribution }) => getValueAtPosition(distribution, tailPosition(VISIBLE_TAIL_FRACTION)).value));
  const highestValue = Math.max(...sortedSlices.map(({ distribution }) => getValueAtPosition(distribution, tailPosition(1 - VISIBLE_TAIL_FRACTION)).value));
  const medians = sortedSlices.map(({ distribution }) => getValueAtPosition(distribution, MEDIAN_POSITION).value);
  const signedLogLinearWidth =
    spec.signedLogLinearWidth ?? Math.max(MINIMUM_SIGNED_LOG_LINEAR_WIDTH, Math.abs(middleOf(medians)) * SIGNED_LOG_LINEAR_WIDTH_PER_MEDIAN);
  const transform = createAxisTransform(spec.axis, signedLogLinearWidth);
  const axisLowest = transform.toAxis(lowestValue);
  const axisBinWidth = (transform.toAxis(highestValue) - axisLowest) / VALUE_BIN_COUNT;
  const binEdges = Array.from({ length: VALUE_BIN_COUNT + 1 }, (_, index) => transform.fromAxis(axisLowest + index * axisBinWidth));
  const toBinIndex = (value: number) => Math.min(Math.max(Math.floor((transform.toAxis(value) - axisLowest) / axisBinWidth), 0), VALUE_BIN_COUNT - 1);

  const slices: PlacedSlice[] = sortedSlices.map(({ position, label, distribution, isFadedBelowMedian }, sliceIndex) => {
    const fractions = binEdges.map((edge) => getPercentilePosition(distribution, edge).position.fractionBelow);
    return {
      position,
      label,
      densities: smooth(fractions.slice(1).map((fraction, index) => (fraction - (fractions[index] ?? 0)) / axisBinWidth)),
      fadedBelowBin: isFadedBelowMedian ? toBinIndex(medians[sliceIndex] ?? 0) : -1
    };
  });
  const allDensities = slices.flatMap(({ densities }) => densities).sort((first, second) => first - second);
  const typicalPeak = middleOf(slices.map(({ densities }) => Math.max(...densities)));
  const densityCap = Math.min(allDensities[Math.floor(allDensities.length * DENSITY_CAP_QUANTILE)] || 1, typicalPeak * PEAK_CAP_MULTIPLE_OF_TYPICAL);
  const firstPosition = slices[0]?.position ?? 0;
  const lastPosition = slices.at(-1)?.position ?? 1;

  const toX = (value: number) => ((transform.toAxis(value) - axisLowest) / (transform.toAxis(highestValue) - axisLowest) - 0.5) * SURFACE_WIDTH;
  const toZ = (position: number) => -((position - firstPosition) / (lastPosition - firstPosition)) * SURFACE_DEPTH;
  const toHeight = (density: number) => (Math.min(density, densityCap) / densityCap) * SURFACE_HEIGHT;
  const binCentreX = (binIndex: number) => toX(transform.fromAxis(axisLowest + (binIndex + 0.5) * axisBinWidth));
  const highlightedSlice = nearestSlice(slices, spec.highlightPosition);
  const markedPositions = new Set((spec.markers ?? []).map(({ position }) => nearestSlice(slices, position)?.position));

  content.add(createSurfaceMesh(slices, binCentreX, toZ, toHeight));
  for (const slice of slices) {
    const style = slice === highlightedSlice ? "highlighted" : markedPositions.has(slice.position) ? "marked" : "plain";
    content.add(createRidge(slice, style, binCentreX, toZ, toHeight));
  }

  if (highlightedSlice != null) {
    const clampedValue = Math.min(Math.max(spec.highlightValue, lowestValue), highestValue);
    const marker = new Mesh(new SphereGeometry(MARKER_RADIUS, 16, 12), new MeshLambertMaterial({ color: HIGHLIGHT_COLOUR }));
    marker.position.set(toX(clampedValue), toHeight(highlightedSlice.densities[toBinIndex(clampedValue)] ?? 0) + MARKER_RADIUS, toZ(highlightedSlice.position));
    content.add(marker);
  }

  addValueTicks({ content, spec, lowestValue, highestValue, signedLogLinearWidth, toX });
  for (const slice of getLabelledSlices(slices)) {
    content.add(createLabel(slice.label, new Vector3(SURFACE_WIDTH / 2 + 0.5, 0, toZ(slice.position))));
  }
  content.add(createLabel(spec.valueTitle, new Vector3(0, -0.9, 1.4), "surface-3d__axis-title"));
  content.add(createLabel(spec.depthTitle, new Vector3(SURFACE_WIDTH / 2 + 1.1, -0.5, -SURFACE_DEPTH / 2), "surface-3d__axis-title"));
  for (const marker of spec.markers ?? []) {
    content.add(createLabel(marker.label, new Vector3(SURFACE_WIDTH / 2 + 0.2, 1.3, toZ(marker.position)), "surface-3d__note"));
  }
  for (const [noteIndex, note] of (spec.notes ?? []).entries()) {
    content.add(createLabel(note, new Vector3(-SURFACE_WIDTH / 4, SURFACE_HEIGHT * 1.3 + noteIndex * 0.35, -SURFACE_DEPTH / 4), "surface-3d__note"));
  }
}

interface ValueTickParams {
  content: Group;
  spec: SurfaceSpec;
  lowestValue: number;
  highestValue: number;
  signedLogLinearWidth: number;
  toX: (value: number) => number;
}

function addValueTicks({ content, spec, lowestValue, highestValue, signedLogLinearWidth, toX }: ValueTickParams) {
  const candidates = getAxisTickCandidates({ axis: spec.axis, minimumValue: lowestValue, maximumValue: highestValue, signedLogLinearWidth }).filter(
    (value) => value >= lowestValue && value <= highestValue
  );
  const byPriority = [...candidates.filter((value) => value === 0), ...candidates.filter((value) => value !== 0)];
  const keptX: number[] = [];
  for (const value of byPriority) {
    const x = toX(value);
    if (keptX.some((keptPosition) => Math.abs(keptPosition - x) < MINIMUM_VALUE_TICK_GAP)) continue;
    keptX.push(x);
    content.add(createLabel(formatTickValue(value, spec.unit), new Vector3(x, -0.15, 0.45)));
  }
}

/** Every slice when there are few; otherwise the ends plus round-numbered positions, so year axes read 1900, 1950… */
function getLabelledSlices(slices: PlacedSlice[]) {
  if (slices.length <= LABEL_ALL_SLICES_UP_TO) return slices;
  const first = slices[0];
  const last = slices.at(-1);
  if (first == null || last == null) return slices;
  const span = last.position - first.position;
  const step = NICE_DEPTH_STEPS.find((candidate) => span / candidate <= MAXIMUM_DEPTH_LABELS - 2) ?? span;
  const minimumGap = step / 2;
  const middle = slices.filter(
    (slice) => slice.position % step === 0 && slice.position - first.position >= minimumGap && last.position - slice.position >= minimumGap
  );
  return [first, ...middle, last];
}

function createSurfaceMesh(
  slices: PlacedSlice[],
  binCentreX: (binIndex: number) => number,
  toZ: (position: number) => number,
  toHeight: (density: number) => number
) {
  const positions: number[] = [];
  const colours: number[] = [];
  const indices: number[] = [];
  for (const slice of slices) {
    for (let binIndex = 0; binIndex < VALUE_BIN_COUNT; binIndex += 1) {
      const height = toHeight(slice.densities[binIndex] ?? 0);
      positions.push(binCentreX(binIndex), height, toZ(slice.position));
      const colour = LOW_COLOUR.clone().lerp(HIGH_COLOUR, height / SURFACE_HEIGHT);
      if (binIndex < slice.fadedBelowBin) colour.lerp(FADED_COLOUR, FADE_AMOUNT);
      colours.push(colour.r, colour.g, colour.b);
    }
  }
  for (let sliceIndex = 0; sliceIndex < slices.length - 1; sliceIndex += 1) {
    for (let binIndex = 0; binIndex < VALUE_BIN_COUNT - 1; binIndex += 1) {
      const corner = sliceIndex * VALUE_BIN_COUNT + binIndex;
      const nextSliceCorner = corner + VALUE_BIN_COUNT;
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

type RidgeStyle = "plain" | "highlighted" | "marked";

function createRidge(
  slice: PlacedSlice,
  style: RidgeStyle,
  binCentreX: (binIndex: number) => number,
  toZ: (position: number) => number,
  toHeight: (density: number) => number
) {
  const lift = style === "plain" ? 0.004 : 0.03;
  const points = slice.densities.map((density, binIndex) => new Vector3(binCentreX(binIndex), toHeight(density) + lift, toZ(slice.position)));
  const geometry = new BufferGeometry().setFromPoints(points);
  if (style === "marked") {
    const ridge = new Line(geometry, new LineDashedMaterial({ color: HIGHLIGHT_COLOUR, dashSize: 0.12, gapSize: 0.08 }));
    ridge.computeLineDistances();
    return ridge;
  }
  const isHighlighted = style === "highlighted";
  return new Line(
    geometry,
    new LineBasicMaterial({ color: isHighlighted ? HIGHLIGHT_COLOUR : RIDGE_COLOUR, transparent: true, opacity: isHighlighted ? 1 : 0.18 })
  );
}

function createLabel(text: string, position: Vector3, className = "surface-3d__label") {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  const label = new CSS2DObject(element);
  label.position.copy(position);
  return label;
}

function createAxisTransform(axis: ChartAxis, signedLogLinearWidth: number): AxisTransform {
  switch (axis) {
    case "logarithmic":
      return { toAxis: Math.log, fromAxis: Math.exp };
    case "signedLogarithmic":
      return {
        toAxis: (value) => Math.sign(value) * Math.log1p(Math.abs(value) / signedLogLinearWidth),
        fromAxis: (axisValue) => Math.sign(axisValue) * signedLogLinearWidth * Math.expm1(Math.abs(axisValue))
      };
    default:
      return { toAxis: (value) => value, fromAxis: (axisValue) => axisValue };
  }
}

function tailPosition(fractionBelow: number) {
  return { fractionBelow, fractionAbove: 1 - fractionBelow };
}

function middleOf(values: number[]) {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
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

function nearestSlice(slices: PlacedSlice[], position: number) {
  return slices.reduce<PlacedSlice | undefined>(
    (closest, slice) => (closest == null || Math.abs(slice.position - position) < Math.abs(closest.position - position) ? slice : closest),
    undefined
  );
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
