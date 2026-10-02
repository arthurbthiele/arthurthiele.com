import { createEmpiricalDataset } from "./createEmpiricalDataset";
import { createSexAndAgeDataset } from "./createSexAndAgeDataset";
import type {
  CumulativePoint,
  DatasetDefinition,
  DatasetSource,
  Distribution,
  DatasetParameter,
  LoadedDataset,
  ParameterSelection,
  UnitFormat
} from "./percentileTypes";

const SEX_OPTIONS = [
  { id: "male", label: "Men" },
  { id: "female", label: "Women" }
];

const EVERYONE = "everyone";
const SEX_OPTIONS_WITH_EVERYONE = [{ id: EVERYONE, label: "Everyone" }, ...SEX_OPTIONS];
const PLURAL_NOUN_BY_SEX: Record<string, string> = { male: "men", female: "women" };
const EQUAL_SPLIT_MALE_SHARE = 0.5;
// About 105 boys are born per 100 girls, and a life table follows a cohort from birth.
const MALE_SHARE_AT_BIRTH = 105 / 205;

const HEIGHT_SPREAD_CAVEAT =
  "No source publishes the spread of heights for these populations, only averages. The spread is borrowed from measured US data (NHANES 2015–2018), whose averages are within half a centimetre of Australia's, and heights are modelled as a normal distribution.";
const POOLED_BY_HEADCOUNT_NOTE = "“Everyone” pools men and women in proportion to the ABS headcount of each.";

const DEFAULT_COHORT_COUNTRY_ID = "AUS";
const HISTORY_COUNTRIES = [
  { id: "GB", label: "Britain", adjective: "British" },
  { id: "FR", label: "France", adjective: "French" }
];
const DEFAULT_HISTORY_COUNTRY_ID = "GB";
const DEFAULT_HISTORY_YEAR = 1820;
const UNIT_BY_HISTORICAL_CURRENCY: Record<string, UnitFormat> = {
  pound: { prefix: "£", decimals: 0 },
  oldFranc: { suffix: " old francs", decimals: 0 },
  newFranc: { suffix: " francs", decimals: 0 },
  euro: { prefix: "€", decimals: 0 }
};
const COUNTRY_NAMES_TAKING_THE = new Set(["United States", "United Kingdom", "Netherlands", "Czech Republic", "Philippines", "United Arab Emirates", "Gambia", "Bahamas"]);
const DEFAULT_COHORT_BIRTH_YEAR = 1900;

async function loadAustralianHeight(): Promise<LoadedDataset> {
  const { default: file } = await import("./data/australianHeight.json");
  const variants: Record<string, { mean: number; standardDeviation: number; population: number }> = file.variants;
  return createAustralianAdultsDataset({
    source: file.source,
    populationBySex: { male: variants.male?.population ?? 0, female: variants.female?.population ?? 0 },
    getSexDistribution: (sex) => {
      const variant = variants[sex];
      if (variant == null) throw new Error(`No height data for sex "${sex}"`);
      return { kind: "normal", mean: variant.mean, standardDeviation: variant.standardDeviation };
    }
  });
}

async function loadAustralianWeight(): Promise<LoadedDataset> {
  const { default: file } = await import("./data/australianWeight.json");
  const variants: Record<string, { logMean: number; logStandardDeviation: number; population: number }> = file.variants;
  return createAustralianAdultsDataset({
    source: file.source,
    populationBySex: { male: variants.male?.population ?? 0, female: variants.female?.population ?? 0 },
    getSexDistribution: (sex) => {
      const variant = variants[sex];
      if (variant == null) throw new Error(`No weight data for sex "${sex}"`);
      return { kind: "logNormal", logMean: variant.logMean, logStandardDeviation: variant.logStandardDeviation };
    }
  });
}

interface AustralianAdultsDatasetParams {
  source: DatasetSource;
  populationBySex: { male: number; female: number };
  getSexDistribution: (sex: string) => Distribution;
}

/** Men, women, or everyone pooled in proportion to the ABS headcount of each. */
function createAustralianAdultsDataset({ source, populationBySex, getSexDistribution }: AustralianAdultsDatasetParams): LoadedDataset {
  const totalPopulation = populationBySex.male + populationBySex.female;
  const getSex = (selection: ParameterSelection) => selection.sex ?? EVERYONE;
  return {
    source,
    parameters: [{ id: "sex", label: "Sex", options: SEX_OPTIONS_WITH_EVERYONE, defaultOptionId: EVERYONE }],
    getDistribution: (selection) => {
      const sex = getSex(selection);
      if (sex !== EVERYONE) return getSexDistribution(sex);
      return poolSexes(getSexDistribution("male"), getSexDistribution("female"), populationBySex.male / totalPopulation);
    },
    describePopulation: (selection) => {
      const sex = getSex(selection);
      return sex === EVERYONE ? "Australian adults (2022)" : `Australian ${PLURAL_NOUN_BY_SEX[sex]} (adults, 2022)`;
    },
    findPopulationSize: (selection) => {
      const sex = getSex(selection);
      if (sex === EVERYONE) return totalPopulation;
      return sex === "male" ? populationBySex.male : populationBySex.female;
    }
  };
}

function poolSexes(maleDistribution: Distribution, femaleDistribution: Distribution, maleShare: number): Distribution {
  return {
    kind: "mixture",
    components: [
      { weight: maleShare, distribution: maleDistribution },
      { weight: 1 - maleShare, distribution: femaleDistribution }
    ]
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
    { id: "sex", label: "Sex", options: SEX_OPTIONS_WITH_EVERYONE, defaultOptionId: EVERYONE },
    {
      id: "birthYear",
      label: "Born in",
      options: birthYears.map((year) => ({ id: String(year), label: String(year) })).reverse(),
      defaultOptionId: String(DEFAULT_COHORT_BIRTH_YEAR)
    }
  ];
  const getSelection = (selection: ParameterSelection) => ({
    countryId: selection.country ?? DEFAULT_COHORT_COUNTRY_ID,
    sex: selection.sex ?? EVERYONE,
    birthYear: Number(selection.birthYear ?? DEFAULT_COHORT_BIRTH_YEAR)
  });
  return {
    source: file.source,
    parameters,
    getDistribution: (selection) => {
      const { countryId, sex, birthYear } = getSelection(selection);
      const getSexDistribution = (cohortSex: string): Distribution => {
        const mean = countries[countryId]?.meanBySex[cohortSex]?.[birthYear - file.firstBirthYear];
        const standardDeviation = standardDeviationBySex[cohortSex];
        if (mean == null || standardDeviation == null) throw new Error(`No height for ${countryId} ${cohortSex} ${birthYear}`);
        return { kind: "normal", mean, standardDeviation };
      };
      if (sex !== EVERYONE) return getSexDistribution(sex);
      return poolSexes(getSexDistribution("male"), getSexDistribution("female"), EQUAL_SPLIT_MALE_SHARE);
    },
    describePopulation: (selection) => {
      const { countryId, sex, birthYear } = getSelection(selection);
      const people = sex === EVERYONE ? "people" : PLURAL_NOUN_BY_SEX[sex];
      return `${people} born in ${countries[countryId]?.label ?? countryId} in ${birthYear} (height at 18)`;
    },
    findPopulationSize: () => undefined
  };
}

async function loadAustralianLifespan(): Promise<LoadedDataset> {
  const { default: file } = await import("./data/australianLifespan.json");
  const variants: Record<string, { cdf: number[][] }> = file.variants;
  const getSex = (selection: ParameterSelection) => selection.sex ?? EVERYONE;
  const getSexDistribution = (sex: string): Distribution => {
    const variant = variants[sex];
    if (variant == null) throw new Error(`No lifespan data for sex "${sex}"`);
    return { kind: "empirical", cumulativePoints: variant.cdf.map(([value = 0, fraction = 0]): CumulativePoint => [value, fraction]) };
  };
  return {
    source: file.source,
    parameters: [{ id: "sex", label: "Sex", options: SEX_OPTIONS_WITH_EVERYONE, defaultOptionId: EVERYONE }],
    getDistribution: (selection) => {
      const sex = getSex(selection);
      if (sex !== EVERYONE) return getSexDistribution(sex);
      return poolSexes(getSexDistribution("male"), getSexDistribution("female"), MALE_SHARE_AT_BIRTH);
    },
    describePopulation: (selection) => {
      const sex = getSex(selection);
      const people = sex === EVERYONE ? "Australians" : `Australian ${PLURAL_NOUN_BY_SEX[sex]}`;
      return `${people} (age at death, at 2022–24 death rates)`;
    },
    findPopulationSize: () => undefined
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
        : `people in ${withArticle(variantLabel)} (${variant?.year ?? "latest survey"})`
  });
}

async function loadAustralianWealth() {
  const { default: file } = await import("./data/wealthAustralia.json");
  return createEmpiricalDataset({
    file,
    parameterId: "group",
    parameterLabel: "Group",
    defaultVariantId: "adults",
    describePopulation: (_variantId, _variantLabel, variant) => `Australian adults (${variant?.year ?? "latest"})`
  });
}

async function loadWorldWealth() {
  const { default: file } = await import("./data/wealthWorldwide.json");
  return createEmpiricalDataset({
    file,
    parameterId: "country",
    parameterLabel: "Where",
    defaultVariantId: "world",
    describePopulation: (variantId, variantLabel, variant) =>
      variantId === "world"
        ? `adults worldwide (${variant?.year ?? "latest"})`
        : `adults in ${withArticle(variantLabel)} (${variant?.year ?? "latest"})`
  });
}

async function loadGripStrength() {
  const { default: file } = await import("./data/gripStrength.json");
  return createSexAndAgeDataset({
    source: file.source,
    variants: file.variants as Record<string, { mean: number; standardDeviation: number }>,
    defaultAgeBand: "30–34",
    toDistribution: ({ mean, standardDeviation }) => ({ kind: "normal", mean, standardDeviation }),
    describePopulation: (sex, ageBand) => `${sex === EVERYONE ? "Canadians" : `Canadian ${PLURAL_NOUN_BY_SEX[sex]}`} aged ${ageBand}`
  });
}

async function loadTypingSpeed(): Promise<LoadedDataset> {
  const { default: file } = await import("./data/typingSpeed.json");
  const { logMean, logStandardDeviation, shift, population } = file.variants.all;
  return {
    source: file.source,
    parameters: [],
    getDistribution: () => ({ kind: "logNormal", logMean, logStandardDeviation, shift }),
    describePopulation: () => "people who took a large online typing test (2018)",
    findPopulationSize: () => population
  };
}

async function loadSuperannuation() {
  const { default: file } = await import("./data/superannuation.json");
  return createSexAndAgeDataset({
    source: file.source,
    variants: file.variants as Record<string, { cdf: number[][] }>,
    defaultAgeBand: "30–34",
    toDistribution: ({ cdf }) => ({
      kind: "empirical",
      cumulativePoints: cdf.map(([value = 0, fraction = 0]): [number, number] => [value, fraction])
    }),
    describePopulation: (sex, ageBand) =>
      `${sex === EVERYONE ? "Australians" : `Australian ${PLURAL_NOUN_BY_SEX[sex]}`} with super, aged ${ageBand.toLowerCase()} (2023)`
  });
}

interface HistoricalWealthVariant {
  currency: string;
  population: number;
  cdf: number[][];
}

/**
 * Britain and France have different sets of years, so a year chosen for one country falls back to the other
 * country's nearest year; the description always names the year actually used.
 */
async function loadWealthHistory(): Promise<LoadedDataset> {
  const { default: file } = await import("./data/wealthHistory.json");
  const variants: Record<string, HistoricalWealthVariant> = file.variants;
  const yearsByCountry = new Map<string, number[]>();
  for (const key of Object.keys(variants)) {
    const [countryId = "", year = ""] = key.split("|");
    yearsByCountry.set(countryId, [...(yearsByCountry.get(countryId) ?? []), Number(year)]);
  }
  const allYears = [...new Set([...yearsByCountry.values()].flat())].sort((first, second) => first - second);

  const getChoice = (selection: ParameterSelection) => {
    const countryId = selection.country ?? DEFAULT_HISTORY_COUNTRY_ID;
    const requestedYear = Number(selection.year ?? DEFAULT_HISTORY_YEAR);
    const countryYears = yearsByCountry.get(countryId) ?? [];
    const year = countryYears.reduce(
      (closest, candidate) => (Math.abs(candidate - requestedYear) < Math.abs(closest - requestedYear) ? candidate : closest),
      countryYears[0] ?? requestedYear
    );
    const variant = variants[`${countryId}|${year}`];
    if (variant == null) throw new Error(`No wealth history for ${countryId} ${year}`);
    return { countryId, year, variant };
  };

  return {
    source: file.source,
    parameters: [
      { id: "country", label: "Country", options: HISTORY_COUNTRIES, defaultOptionId: DEFAULT_HISTORY_COUNTRY_ID },
      {
        id: "year",
        label: "Year",
        options: allYears.map((year) => ({ id: String(year), label: String(year) })),
        defaultOptionId: String(DEFAULT_HISTORY_YEAR)
      }
    ],
    getDistribution: (selection) => ({
      kind: "empirical",
      cumulativePoints: getChoice(selection).variant.cdf.map(([value = 0, fraction = 0]): CumulativePoint => [value, fraction])
    }),
    describePopulation: (selection) => {
      const { countryId, year } = getChoice(selection);
      const adjective = HISTORY_COUNTRIES.find(({ id }) => id === countryId)?.adjective ?? countryId;
      return `${adjective} adults in ${year}`;
    },
    findPopulationSize: (selection) => getChoice(selection).variant.population,
    findUnit: (selection) => UNIT_BY_HISTORICAL_CURRENCY[getChoice(selection).variant.currency]
  };
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

function withArticle(countryName: string) {
  return COUNTRY_NAMES_TAKING_THE.has(countryName) ? `the ${countryName}` : countryName;
}

export const DATASETS: DatasetDefinition[] = [
  {
    id: "height",
    label: "Height (Australia, today)",
    unit: { suffix: " cm", decimals: 1 },
    defaultValue: 180,
    rankWords: { higher: "tallest", lower: "shortest" },
    caveat: `${HEIGHT_SPREAD_CAVEAT} ${POOLED_BY_HEADCOUNT_NOTE}`,
    load: loadAustralianHeight
  },
  {
    id: "heightByBirthYear",
    label: "Height by birth year (any country, 1896–1996)",
    unit: { suffix: " cm", decimals: 1 },
    defaultValue: 175,
    caveat: `Average heights are NCD-RisC estimates, pooled from measured surveys, of height at 18 for each birth year. ${HEIGHT_SPREAD_CAVEAT} We assume that spread has stayed the same across countries and over the century. “Everyone” pools men and women equally.`,
    load: loadHeightByBirthYear
  },
  {
    id: "weight",
    label: "Weight (Australia, today)",
    unit: { suffix: " kg", decimals: 1 },
    defaultValue: 80,
    rankWords: { higher: "heaviest", lower: "lightest" },
    caveat:
      `Averages are the ABS's measured 2022 figures. The shape of the distribution, which is skewed towards heavier weights, is borrowed from measured US data (NHANES 2015–2018) and modelled as lognormal. ${POOLED_BY_HEADCOUNT_NOTE}`,
    load: loadAustralianWeight
  },
  {
    id: "lifespan",
    label: "Lifespan (Australia)",
    unit: { suffix: " years", decimals: 1 },
    defaultValue: 85,
    caveat:
      "From the ABS life table: the ages at which a group born today would die if 2022–24 death rates held for their whole lives. Death rates keep falling, so real lifespans will probably be longer. The table stops at 100. “Everyone” pools men and women in the ratio they're born, about 105 boys to 100 girls.",
    load: loadAustralianLifespan
  },
  {
    id: "taxableIncome",
    label: "Taxable income (Australia)",
    unit: { prefix: "A$", decimals: 0 },
    defaultValue: 80_000,
    chartAxis: "logarithmic",
    rankWords: { higher: "highest-earning", lower: "lowest-earning" },
    caveat:
      "Covers people who lodged a tax return with taxable income, not every Australian, so the bottom of the distribution is missing. The ATO's top band is open-ended above A$429,530, so anything higher is treated as the top band.",
    load: loadAustralianTaxableIncome
  },
  {
    id: "worldIncome",
    label: "Income (international, price-adjusted)",
    unit: { prefix: "US$", suffix: " / year", decimals: 0 },
    defaultValue: 30_000,
    chartAxis: "logarithmic",
    rankWords: { higher: "highest-income", lower: "lowest-income" },
    caveat:
      "Household income or consumption per person, in 2021 international dollars (adjusted for local prices). Some countries measure consumption rather than income, as the World Bank does.",
    load: loadWorldIncome
  },
  {
    id: "wealthAustralia",
    label: "Net wealth (Australia)",
    unit: { prefix: "A$", decimals: 0 },
    defaultValue: 300_000,
    chartAxis: "signedLogarithmic",
    rankWords: { higher: "wealthiest", lower: "least wealthy" },
    caveat:
      "Net personal wealth (housing, land, savings, shares and other assets, minus debts) per adult, with couples' shared wealth split equally between them, in 2025 dollars. These are the World Inequality Database's modelled estimates for Australia. They sit close to the ABS's household survey in the middle, but put more wealth at the top (WID corrects for surveys under-counting the very rich) and more adults below zero.",
    load: loadAustralianWealth
  },
  {
    id: "wealthWorldwide",
    label: "Net wealth (international, US$)",
    unit: { prefix: "US$", decimals: 0 },
    defaultValue: 100_000,
    chartAxis: "signedLogarithmic",
    rankWords: { higher: "wealthiest", lower: "least wealthy" },
    caveat:
      "Net personal wealth (housing, land, savings, shares and other assets, minus debts) per adult, with couples' shared wealth split equally, converted to US dollars at 2025 market exchange rates. Countries are those where the World Inequality Database builds wealth from country-specific research or European household surveys, plus Australia, Brazil, Canada, Indonesia, Japan, Mexico, New Zealand and South Africa, whose figures lean more on modelling. \"World\" is our own pool of 216 countries weighted by adult population.",
    load: loadWorldWealth
  },
  {
    id: "wealthHistory",
    label: "Net wealth through history (Britain, France)",
    unit: { prefix: "£", decimals: 0 },
    defaultValue: 1000,
    chartAxis: "signedLogarithmic",
    rankWords: { higher: "wealthiest", lower: "least wealthy" },
    caveat:
      "Net personal wealth per adult (couples' wealth split equally) from the World Inequality Database, in each year's own money: pounds for Britain; old francs before 1960, then francs, then euros from 2002 for France. France's series back to 1800 is reconstructed from inheritance records (Garbinti, Goupille-Lebret & Piketty). Britain's top end rests on estate records from about 1895, and its earlier years (1820, 1850, 1880) are WID's modelled reconstruction. Britain also has a method change in 1995: from then on WID uses household-survey accounts that capture debts and people with almost nothing, while before 1995 the lower half is a smooth reconstruction in which nobody has zero or negative wealth. So pre-1995 British percentiles are more trustworthy for large fortunes than for ordinary wealth.\n\nFor a large chunk of Britain's history (from 1913 to 1994), the data from this data source is suspiciously similar-shaped - the poorest 1% always have about 15% of median wealth, the 10th percentile about 28%. You can see the shape in the 3D view quite easily.\n\nBest guess (though WID doesn't state their methods in easily findable ways) is that only the top half of individuals by wealth were measured, and the bottom half is a reasonable pattern extrapolated to all the other years and scaled to fit. This is just a guess, but if it's true it would explain the very uniform shapes there. If you can find a better data source please let me know! Amounts were converted to each year's money with WID's own price index.",
    load: loadWealthHistory
  },
  {
    id: "superannuation",
    label: "Super balance (Australia)",
    unit: { prefix: "A$", decimals: 0 },
    defaultValue: 100_000,
    chartAxis: "signedLogarithmic",
    caveat:
      "Total super across all of a person's accounts, at June 2023, from ASFA's analysis of the ATO's 2% sample of tax records. ASFA publishes the 10th, 25th, 50th, 75th and 90th percentiles; between them we interpolate, and above the 90th we extend each group with a fitted curve, which runs slightly generous against the ATO's own counts of $2M+ balances. The oldest band is 70–74 for men and 70 and over for women. “Everyone” pools men and women equally.",
    load: loadSuperannuation
  },
  {
    id: "gripStrength",
    label: "Grip strength (both hands combined)",
    unit: { suffix: " kg", decimals: 1 },
    defaultValue: 90,
    caveat:
      "Measured in Canada's national health survey (2016–17): the best of two squeezes with each hand on a dynamometer, added together. One hand alone is roughly half. Modelled as a normal curve fitted to Statistics Canada's published percentiles, within 2.4 kg of every one of them. “Everyone” pools men and women equally.",
    load: loadGripStrength
  },
  {
    id: "typingSpeed",
    label: "Typing speed",
    unit: { suffix: " WPM", decimals: 0 },
    defaultValue: 60,
    rankWords: { higher: "fastest", lower: "slowest" },
    caveat:
      "Not a random sample. These are 168,000 volunteers who chose to take an online typing test (Dhakal et al., CHI 2018), likely faster than the population at large and about two-thirds American. No population-wide measurement of typing speed seems to exist. The curve matches the paper's published mean (51.6 WPM), spread and skew; typists of 120+ WPM do exist in it.",
    load: loadTypingSpeed
  },
  {
    id: "lichessRating",
    label: "Chess rating (Lichess blitz)",
    unit: { decimals: 0 },
    defaultValue: 1500,
    rankWords: { higher: "highest-rated", lower: "lowest-rated" },
    caveat:
      "Not a random sample. These are Lichess players who played at least two rated blitz games that week: a self-selected, keen crowd rather than everyone who plays chess, let alone everyone.",
    load: loadLichessRating
  },
  {
    id: "age",
    label: "Age (Australia)",
    unit: { suffix: " years", decimals: 1 },
    defaultValue: 30,
    rankWords: { higher: "oldest", lower: "youngest" },
    load: loadAustralianAge
  }
];
