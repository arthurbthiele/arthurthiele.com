import { createEmpiricalDataset } from "./createEmpiricalDataset";
import type { DatasetDefinition, DatasetParameter, LoadedDataset, ParameterSelection } from "./percentileTypes";

const SEX_OPTIONS = [
  { id: "male", label: "Men" },
  { id: "female", label: "Women" }
];

const PLURAL_NOUN_BY_SEX: Record<string, string> = { male: "men", female: "women" };

const HEIGHT_SPREAD_CAVEAT =
  "No source publishes the spread of heights for these populations, only averages. The spread is borrowed from measured US data (NHANES 2015–2018), whose averages are within half a centimetre of Australia's, and heights are modelled as a normal distribution.";

const DEFAULT_COHORT_COUNTRY_ID = "AUS";
const DEFAULT_COHORT_BIRTH_YEAR = 1900;

async function loadAustralianHeight(): Promise<LoadedDataset> {
  const { default: file } = await import("./data/australianHeight.json");
  const variants: Record<string, { mean: number; standardDeviation: number }> = file.variants;
  const getSex = (selection: ParameterSelection) => selection.sex ?? "male";
  return {
    source: file.source,
    parameters: [{ id: "sex", label: "Sex", options: SEX_OPTIONS, defaultOptionId: "male" }],
    getDistribution: (selection) => {
      const variant = variants[getSex(selection)];
      if (variant == null) throw new Error(`No height data for sex "${getSex(selection)}"`);
      return { kind: "normal", ...variant };
    },
    describePopulation: (selection) => `Australian ${PLURAL_NOUN_BY_SEX[getSex(selection)]} (adults, 2022)`
  };
}

async function loadHeightByBirthYear(): Promise<LoadedDataset> {
  const { default: file } = await import("./data/heightByBirthYear.json");
  const countries: Record<string, { label: string; meanBySex: Record<string, number[]> }> = file.countries;
  const standardDeviationBySex: Record<string, number> = file.standardDeviationBySex;
  const birthYears = Array.from(
    { length: file.lastBirthYear - file.firstBirthYear + 1 },
    (_, index) => file.firstBirthYear + index
  );
  const parameters: DatasetParameter[] = [
    {
      id: "country",
      label: "Country",
      options: Object.entries(countries).map(([countryId, { label }]) => ({ id: countryId, label })),
      defaultOptionId: DEFAULT_COHORT_COUNTRY_ID
    },
    { id: "sex", label: "Sex", options: SEX_OPTIONS, defaultOptionId: "male" },
    {
      id: "birthYear",
      label: "Born in",
      options: birthYears.map((year) => ({ id: String(year), label: String(year) })).reverse(),
      defaultOptionId: String(DEFAULT_COHORT_BIRTH_YEAR)
    }
  ];
  const getSelection = (selection: ParameterSelection) => ({
    countryId: selection.country ?? DEFAULT_COHORT_COUNTRY_ID,
    sex: selection.sex ?? "male",
    birthYear: Number(selection.birthYear ?? DEFAULT_COHORT_BIRTH_YEAR)
  });
  return {
    source: file.source,
    parameters,
    getDistribution: (selection) => {
      const { countryId, sex, birthYear } = getSelection(selection);
      const mean = countries[countryId]?.meanBySex[sex]?.[birthYear - file.firstBirthYear];
      const standardDeviation = standardDeviationBySex[sex];
      if (mean == null || standardDeviation == null) throw new Error(`No height for ${countryId} ${sex} ${birthYear}`);
      return { kind: "normal", mean, standardDeviation };
    },
    describePopulation: (selection) => {
      const { countryId, sex, birthYear } = getSelection(selection);
      return `${PLURAL_NOUN_BY_SEX[sex]} born in ${countries[countryId]?.label ?? countryId} in ${birthYear} (height at 18)`;
    }
  };
}

async function loadAustralianTaxableIncome() {
  const { default: file } = await import("./data/atoTaxableIncome.json");
  return createEmpiricalDataset({
    file,
    parameterId: "sex",
    parameterLabel: "Sex",
    defaultVariantId: "all",
    orderedVariantOptions: [{ id: "all", label: "Everyone" }, ...SEX_OPTIONS],
    describePopulation: (variantId) =>
      variantId === "all" ? "Australian taxpayers (2023–24)" : `${PLURAL_NOUN_BY_SEX[variantId]} paying tax in Australia (2023–24)`
  });
}

async function loadWorldIncome() {
  const { default: file } = await import("./data/worldBankIncome.json");
  return createEmpiricalDataset({
    file,
    parameterId: "country",
    parameterLabel: "Where",
    defaultVariantId: "world",
    describePopulation: (variantId, variantLabel, variant) =>
      variantId === "world"
        ? "everyone in the world (latest surveys)"
        : `people in ${variantLabel} (${variant?.year ?? "latest survey"})`
  });
}

async function loadLichessRating() {
  const { default: file } = await import("./data/lichessRating.json");
  return createEmpiricalDataset({
    file,
    parameterId: "timeControl",
    parameterLabel: "Time control",
    defaultVariantId: "blitz",
    orderedVariantOptions: [{ id: "blitz", label: "Blitz" }],
    describePopulation: (variantId) => `Lichess ${variantId} players (active in the week to 2 Oct 2026)`
  });
}

async function loadAustralianAge() {
  const { default: file } = await import("./data/absPopulationAge.json");
  return createEmpiricalDataset({
    file,
    parameterId: "sex",
    parameterLabel: "Sex",
    defaultVariantId: "persons",
    orderedVariantOptions: [{ id: "persons", label: "Everyone" }, ...SEX_OPTIONS],
    describePopulation: (variantId) =>
      variantId === "persons" ? "Australian residents" : `Australian ${PLURAL_NOUN_BY_SEX[variantId]}`
  });
}

export const DATASETS: DatasetDefinition[] = [
  {
    id: "height",
    label: "Height (Australia, today)",
    unit: { suffix: " cm", decimals: 1 },
    defaultValue: 180,
    caveat: HEIGHT_SPREAD_CAVEAT,
    load: loadAustralianHeight
  },
  {
    id: "heightByBirthYear",
    label: "Height by birth year (any country, 1896–1996)",
    unit: { suffix: " cm", decimals: 1 },
    defaultValue: 175,
    caveat: `Average heights are NCD-RisC estimates, pooled from measured surveys, of height at 18 for each birth year. ${HEIGHT_SPREAD_CAVEAT} We assume that spread has stayed the same across countries and over the century.`,
    load: loadHeightByBirthYear
  },
  {
    id: "taxableIncome",
    label: "Taxable income (Australia)",
    unit: { prefix: "A$", decimals: 0 },
    defaultValue: 80_000,
    chartAxis: "logarithmic",
    caveat:
      "Covers people who lodged a tax return with taxable income, not every Australian, so the bottom of the distribution is missing. The ATO's top band is open-ended above A$429,530, so anything higher is treated as the top band.",
    load: loadAustralianTaxableIncome
  },
  {
    id: "worldIncome",
    label: "Income (worldwide)",
    unit: { prefix: "$", suffix: " / year", decimals: 0 },
    defaultValue: 30_000,
    chartAxis: "logarithmic",
    caveat:
      "Household income or consumption per person, in 2021 international dollars (adjusted for local prices). Some countries measure consumption rather than income, as the World Bank does.",
    load: loadWorldIncome
  },
  {
    id: "lichessRating",
    label: "Chess rating (Lichess blitz)",
    unit: { decimals: 0 },
    defaultValue: 1500,
    caveat: "Recently active Lichess players only, which is a self-selected, keen crowd rather than everyone who plays chess.",
    load: loadLichessRating
  },
  {
    id: "age",
    label: "Age (Australia)",
    unit: { suffix: " years", decimals: 1 },
    defaultValue: 30,
    load: loadAustralianAge
  }
];
