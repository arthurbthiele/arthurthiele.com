import type { DatasetSource, Distribution, LoadedDataset, ParameterSelection } from "./percentileTypes";

const EVERYONE = "everyone";
const SEX_OPTIONS = [
  { id: "male", label: "Men" },
  { id: "female", label: "Women" },
  { id: EVERYONE, label: "Everyone" }
];
// These sources publish no headcount by sex and age, so "everyone" pools men and women equally.
const EVERYONE_MALE_SHARE = 0.5;

interface SexAndAgeDatasetParams<Variant> {
  source: DatasetSource;
  /** Keyed "sex|age band", e.g. "female|30–34". */
  variants: Record<string, Variant>;
  defaultAgeBand: string;
  toDistribution: (variant: Variant) => Distribution;
  describePopulation: (sex: string, ageBand: string) => string;
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
  describePopulation
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
    const sex = selection.sex ?? "male";
    const requestedAgeBand = selection.age ?? defaultAgeBand;
    if (sex === EVERYONE) return { ...getKeyForSex("male", requestedAgeBand), sex };
    return getKeyForSex(sex, requestedAgeBand);
  };
  const getVariantDistribution = (key: string) => {
    const variant = variants[key];
    if (variant == null) throw new Error(`No "${key}" variant in ${source.name}`);
    return toDistribution(variant);
  };

  return {
    source,
    parameters: [
      { id: "sex", label: "Sex", options: SEX_OPTIONS, defaultOptionId: "male" },
      { id: "age", label: "Age", options: allAgeBands.map((ageBand) => ({ id: ageBand, label: ageBand })), defaultOptionId: defaultAgeBand }
    ],
    getDistribution: (selection) => {
      const { sex, key } = getKey(selection);
      if (sex !== EVERYONE) return getVariantDistribution(key);
      const requestedAgeBand = selection.age ?? defaultAgeBand;
      return {
        kind: "mixture",
        components: [
          { weight: EVERYONE_MALE_SHARE, distribution: getVariantDistribution(getKeyForSex("male", requestedAgeBand).key) },
          { weight: 1 - EVERYONE_MALE_SHARE, distribution: getVariantDistribution(getKeyForSex("female", requestedAgeBand).key) }
        ]
      };
    },
    describePopulation: (selection) => {
      const { sex, ageBand } = getKey(selection);
      return describePopulation(sex, ageBand);
    },
    findPopulationSize: () => undefined
  };
}
