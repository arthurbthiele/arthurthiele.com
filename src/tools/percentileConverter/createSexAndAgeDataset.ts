import type { ChartAxis, DatasetSource, Distribution, LoadedDataset, ParameterSelection, UnitFormat } from "./percentileTypes";

const EVERYONE = "everyone";
const SEX_OPTIONS = [
  { id: EVERYONE, label: "Everyone" },
  { id: "male", label: "Men" },
  { id: "female", label: "Women" }
];
// These sources publish no headcount by sex and age, so "everyone" pools men and women equally.
const EVERYONE_MALE_SHARE = 0.5;
const CLOSED_AGE_BAND_PATTERN = /^(\d+)\D+(\d+)$/;
const OPEN_ENDED_AGE_BAND_PATTERN = /^(\d+)\D*(?:and over|\+)$/i;
// Open-ended bands get a central age by assumption: "Under 20" is mostly 15–19 in these sources, and "70 and over"
// is treated as about 70–79.
const UNDER_TWENTY_CENTRE = 17.5;
const OPEN_ENDED_BAND_CENTRE_OFFSET = 5;

interface SexAndAgeDatasetParams<Variant> {
  source: DatasetSource;
  /** Keyed "sex|age band", e.g. "female|30–34". */
  variants: Record<string, Variant>;
  defaultAgeBand: string;
  toDistribution: (variant: Variant) => Distribution;
  describePopulation: (sex: string, ageBand: string) => string;
  surface: { valueTitle: string; unit: UnitFormat; axis: ChartAxis };
}

/**
 * Sex and age band become two independent selectors. Some sources end their age bands differently for men and women
 * (e.g. "70–74" vs "70 and over"); a band missing for the chosen sex falls back to that sex's oldest band.
 */
export function createSexAndAgeDataset<Variant>({
  source,
  variants,
  defaultAgeBand,
  toDistribution,
  describePopulation,
  surface
}: SexAndAgeDatasetParams<Variant>): LoadedDataset {
  const ageBandsBySex = new Map<string, string[]>();
  for (const key of Object.keys(variants)) {
    const [sex = "", ageBand = ""] = key.split("|");
    ageBandsBySex.set(sex, [...(ageBandsBySex.get(sex) ?? []), ageBand]);
  }
  const allAgeBands = [...new Set([...ageBandsBySex.values()].flat())];

  const getKeyForSex = (sex: string, requestedAgeBand: string) => {
    const ageBandsForSex = ageBandsBySex.get(sex) ?? [];
    const ageBand = ageBandsForSex.includes(requestedAgeBand) ? requestedAgeBand : (ageBandsForSex.at(-1) ?? requestedAgeBand);
    return { sex, ageBand, key: `${sex}|${ageBand}` };
  };
  const getKey = (selection: ParameterSelection) => {
    const sex = selection.sex ?? EVERYONE;
    const requestedAgeBand = selection.age ?? defaultAgeBand;
    if (sex === EVERYONE) return { ...getKeyForSex("male", requestedAgeBand), sex };
    return getKeyForSex(sex, requestedAgeBand);
  };
  const getVariantDistribution = (key: string) => {
    const variant = variants[key];
    if (variant == null) throw new Error(`No "${key}" variant in ${source.name}`);
    return toDistribution(variant);
  };
  const getBandDistribution = (sex: string, ageBand: string): Distribution => {
    if (sex !== EVERYONE) return getVariantDistribution(getKeyForSex(sex, ageBand).key);
    return {
      kind: "mixture",
      components: [
        { weight: EVERYONE_MALE_SHARE, distribution: getVariantDistribution(getKeyForSex("male", ageBand).key) },
        { weight: 1 - EVERYONE_MALE_SHARE, distribution: getVariantDistribution(getKeyForSex("female", ageBand).key) }
      ]
    };
  };

  return {
    source,
    parameters: [
      { id: "sex", label: "Sex", options: SEX_OPTIONS, defaultOptionId: EVERYONE },
      { id: "age", label: "Age", options: allAgeBands.map((ageBand) => ({ id: ageBand, label: ageBand })), defaultOptionId: defaultAgeBand }
    ],
    getDistribution: (selection) => getBandDistribution(selection.sex ?? EVERYONE, selection.age ?? defaultAgeBand),
    findSurface: (selection, value) => {
      const sex = selection.sex ?? EVERYONE;
      const { ageBand } = getKey(selection);
      const sliceAgeBands = ageBandsBySex.get(sex === EVERYONE ? "male" : sex) ?? [];
      return {
        slices: sliceAgeBands.map((band) => ({ position: getAgeBandCentre(band), label: band, distribution: getBandDistribution(sex, band) })),
        highlightPosition: getAgeBandCentre(ageBand),
        highlightValue: value,
        depthTitle: "age",
        valueTitle: surface.valueTitle,
        unit: surface.unit,
        axis: surface.axis
      };
    },
    describePopulation: (selection) => {
      const { sex, ageBand } = getKey(selection);
      return describePopulation(sex, ageBand);
    },
    findPopulationSize: () => undefined
  };
}

/** The middle of a band of whole years: "30–34" covers ages 30.0 up to 35.0, so its centre is 32.5. */
function getAgeBandCentre(ageBand: string) {
  if (/^under 20$/i.test(ageBand)) return UNDER_TWENTY_CENTRE;
  const closedBand = CLOSED_AGE_BAND_PATTERN.exec(ageBand);
  if (closedBand != null) return (Number(closedBand[1]) + Number(closedBand[2]) + 1) / 2;
  const openEndedBand = OPEN_ENDED_AGE_BAND_PATTERN.exec(ageBand);
  if (openEndedBand != null) return Number(openEndedBand[1]) + OPEN_ENDED_BAND_CENTRE_OFFSET;
  throw new Error(`Unrecognised age band "${ageBand}"`);
}
