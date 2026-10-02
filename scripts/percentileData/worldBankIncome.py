# /// script
# requires-python = ">=3.11"
# dependencies = ["pandas"]
# ///
"""Builds src/tools/percentileConverter/data/worldBankIncome.json from the World Bank
Poverty and Inequality Platform (PIP) Percentiles dataset, 2021 PPP vintage.

Run with: uv run scripts/percentileData/worldBankIncome.py

Dataset: https://datacatalog.worldbank.org/search/dataset/0063646/poverty-and-inequality-platform-pip-percentiles
Licence: CC BY 4.0

PIP's "Percentiles" bulk file reports, for every surveyed country-year (and for
national/urban/rural reporting levels, and income/consumption welfare types), 100
percentile bins with columns:
  country_code     ISO3 code
  year              survey year
  reporting_level   "national" | "urban" | "rural"
  welfare_type      "income" | "consumption"
  percentile        1..100
  avg_welfare       mean daily welfare $ within the bin
  pop_share         always 0.01 (each bin is exactly 1% of that population)
  welfare_share     the bin's share of total welfare
  quantile          the bin's UPPER THRESHOLD, i.e. the value below which
                    `percentile`% of the population falls -- this is exactly a CDF point
  pop               population in the bin (1% of the country-year-level-type population;
                    multiply by 100 to recover the total population PIP used)
All dollar columns are in 2021 PPP$ **per day**. This script converts to **per year**
(x365) because that's the unit the percentile-converter tool displays.
"""

import json
import urllib.request
from pathlib import Path

import pandas as pd

SCRIPT_DIR = Path(__file__).resolve().parent
CACHE_DIR = SCRIPT_DIR / ".cache"
PERCENTILES_CSV_PATH = CACHE_DIR / "world_100bin_2021ppp.csv"
AUX_COUNTRIES_JSON_PATH = CACHE_DIR / "aux_countries.json"
OUTPUT_PATH = SCRIPT_DIR.parent.parent / "src" / "tools" / "percentileConverter" / "data" / "worldBankIncome.json"

PERCENTILES_CSV_URL = "https://datacatalogfiles.worldbank.org/ddh-published/0063646/DR0090357/world_100bin.csv"
AUX_COUNTRIES_URL = "https://api.worldbank.org/pip/v1/aux?table=countries"
DATASET_PAGE_URL = "https://datacatalog.worldbank.org/search/dataset/0063646/poverty-and-inequality-platform-pip-percentiles"

# A real browser UA; PIP's CDN (Akamai) sometimes blocks bare-urllib/curl default UAs.
BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)

DAYS_PER_YEAR = 365
MAX_WORLD_CDF_POINTS = 400
WORLD_TOP_TAIL_POINT_COUNT = 100
WORLD_TOP_TAIL_START_FRACTION = 0.99

# When a country-year has both an income and a consumption row at its chosen reporting
# level (this happens for a handful of countries where WB received both an income and
# an expenditure survey for the same year, e.g. PHL), PIP's own `pip` API consistently
# orders consumption first. We follow that precedent and prefer consumption on a tie.
PREFERRED_WELFARE_TYPE_ON_TIE = "consumption"

REPORTED_COUNTRY_CODES = ["AUS", "USA", "IND", "GBR", "CHN", "NGA"]

DISPLAY_NAME_BY_WORLD_BANK_NAME = {
    "Congo, Dem. Rep.": "DR Congo",
    "Congo, Rep.": "Republic of the Congo",
    "Egypt, Arab Rep.": "Egypt",
    "Micronesia, Fed. Sts.": "Micronesia",
    "Gambia, The": "The Gambia",
    "Iran, Islamic Rep.": "Iran",
    "Korea, Rep.": "South Korea",
    "St. Lucia": "Saint Lucia",
    "Taiwan, China": "Taiwan",
    "Venezuela, RB": "Venezuela",
    "Yemen, Rep.": "Yemen",
}


def main() -> None:
    download_if_absent(PERCENTILES_CSV_URL, PERCENTILES_CSV_PATH)
    download_if_absent(AUX_COUNTRIES_URL, AUX_COUNTRIES_JSON_PATH)

    percentiles = pd.read_csv(PERCENTILES_CSV_PATH)
    country_names = load_country_names(AUX_COUNTRIES_JSON_PATH)

    country_choices = choose_latest_country_rows(percentiles)

    country_variants = {}
    for country_code, choice in country_choices.items():
        world_bank_name = country_names.get(country_code, country_code)
        label = DISPLAY_NAME_BY_WORLD_BANK_NAME.get(world_bank_name, world_bank_name)
        country_variants[country_code] = build_country_variant(choice, label)

    variants = {"world": build_world_variant(country_choices)}
    for country_code, variant in sorted(country_variants.items(), key=lambda entry: entry[1]["label"]):
        variants[country_code] = variant

    output = {
        "source": {
            "name": "World Bank Poverty and Inequality Platform (PIP), Percentiles, 2021 PPP",
            "url": DATASET_PAGE_URL,
            "licence": "CC BY 4.0",
        },
        "unit": "2021 PPP$ per person per year",
        "variants": variants,
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(output, separators=(",", ":")))

    report(country_choices, variants, percentiles)


def download_if_absent(url: str, destination: Path) -> None:
    if destination.exists():
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": BROWSER_USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response:
        destination.write_bytes(response.read())


def load_country_names(path: Path) -> dict[str, str]:
    countries = json.loads(path.read_text())
    return {country["country_code"]: country["country_name"] for country in countries}


class CountryChoice:
    """The reporting-level/welfare-type/year PIP data we picked to represent one country."""

    def __init__(self, country_code: str, year: int, welfare_type: str, bins: pd.DataFrame):
        self.country_code = country_code
        self.year = year
        self.welfare_type = welfare_type
        # bins: 100 rows (or 200 if urban+rural were combined) with columns
        # percentile, quantile, pop -- already filtered to the chosen level(s)/type.
        self.bins = bins


def choose_latest_country_rows(percentiles: pd.DataFrame) -> dict[str, CountryChoice]:
    """For each country, pick its most recent survey year, preferring the national
    reporting level. If a country's latest year only has urban and rural (no national),
    combine the two population-weighted into one 200-bin pseudo-national set, which PIP
    itself does for China/India in older vintages (not needed for the current
    2021-PPP/Sep-2026 vintage, where both report "national" directly -- but kept for
    robustness against future PIP updates). If only a single non-national level exists
    (true for Argentina, whose EPH survey only ever covers urban areas), use that level
    as-is."""
    choices: dict[str, CountryChoice] = {}
    for country_code, country_rows in percentiles.groupby("country_code"):
        latest_year = int(country_rows["year"].max())
        year_rows = country_rows[country_rows["year"] == latest_year]
        levels_available = set(year_rows["reporting_level"].unique())

        if "national" in levels_available:
            level_rows = year_rows[year_rows["reporting_level"] == "national"]
        elif levels_available == {"urban", "rural"}:
            level_rows = combine_urban_rural(year_rows)
        else:
            only_level = next(iter(levels_available))
            level_rows = year_rows[year_rows["reporting_level"] == only_level]

        welfare_types_available = level_rows["welfare_type"].unique()
        if len(welfare_types_available) > 1:
            welfare_type = (
                PREFERRED_WELFARE_TYPE_ON_TIE
                if PREFERRED_WELFARE_TYPE_ON_TIE in welfare_types_available
                else welfare_types_available[0]
            )
        else:
            welfare_type = welfare_types_available[0]

        bins = level_rows[level_rows["welfare_type"] == welfare_type]
        choices[country_code] = CountryChoice(country_code, latest_year, welfare_type, bins)
    return choices


def combine_urban_rural(year_rows: pd.DataFrame) -> pd.DataFrame:
    """Population-weighted merge of urban and rural 100-bin sets into one 200-bin set.
    Each bin keeps its own (quantile, pop); pooling and re-sorting by value happens the
    same way as the world pool does, so no information is invented."""
    return year_rows[year_rows["reporting_level"].isin(["urban", "rural"])]


def build_country_variant(choice: CountryChoice, label: str) -> dict:
    cdf = quantile_bins_to_cdf(choice.bins)
    return {
        "label": label,
        "year": choice.year,
        "welfareType": choice.welfare_type,
        "population": round(choice.bins["pop"].sum()),
        "cdf": cdf,
    }


def quantile_bins_to_cdf(bins: pd.DataFrame) -> list[list[float]]:
    """Each bin's `quantile` is the upper threshold of that percentile bin, i.e. exactly
    a CDF point. Pool (possibly >100, for urban+rural combos) bins by population-weighted
    cumulative share, sort by value, and drop duplicate values keeping the highest
    fraction, per the output spec."""
    bins = fill_open_ended_top_bin(bins)
    total_pop = bins["pop"].sum()
    sorted_bins = bins.sort_values("quantile")
    fractions = cumulative_fractions(sorted_bins, total_pop)
    values = (sorted_bins["quantile"] * DAYS_PER_YEAR).map(round_sensibly)
    return dedupe_cdf_keeping_highest_fraction(values.tolist(), fractions.tolist())


def fill_open_ended_top_bin(bins: pd.DataFrame) -> pd.DataFrame:
    """PIP's 100th percentile bin has no finite upper threshold (`quantile` is NaN --
    the richest 1% is unbounded above). We use that bin's reported average welfare
    (`avg_welfare`, always populated) as its CDF value instead. The average sits inside
    the bin, not at its top, so cumulative_fractions places it halfway through the bin's
    population (the 99.5th percentile for a single country) rather than at 100%."""
    bins = bins.copy()
    open_ended = bins["quantile"].isna()
    bins["open_ended"] = open_ended
    bins.loc[open_ended, "quantile"] = bins.loc[open_ended, "avg_welfare"]
    return bins


def cumulative_fractions(sorted_bins: pd.DataFrame, total_pop: float) -> pd.Series:
    """Each threshold bin contributes its whole population at its upper threshold; an
    open-ended bin's average stands for its middle, so only half its population is
    counted by that point."""
    cumulative_pop = sorted_bins["pop"].cumsum()
    half_of_open_ended_pop = sorted_bins["pop"].where(sorted_bins["open_ended"], 0) / 2
    return (cumulative_pop - half_of_open_ended_pop) / total_pop


def round_sensibly(value: float) -> int:
    if value < 1_000:
        increment = 1
    elif value < 10_000:
        increment = 10
    elif value < 100_000:
        increment = 100
    else:
        increment = 1_000
    return round(value / increment) * increment


def dedupe_cdf_keeping_highest_fraction(values: list[float], fractions: list[float]) -> list[list[float]]:
    deduped: dict[float, float] = {}
    for value, raw_fraction in zip(values, fractions):
        # Floating-point cumulative sums can overshoot 1.0 by a sliver (e.g. 1.0000000000000011).
        fraction = min(max(raw_fraction, 0.0), 1.0)
        if value not in deduped or fraction > deduped[value]:
            deduped[value] = fraction
    return [[value, fraction] for value, fraction in sorted(deduped.items())]


def build_world_variant(country_choices: dict[str, CountryChoice]) -> dict:
    """Pool every chosen country-year's percentile bins into one global distribution,
    weighted by each bin's population (PIP's own `pop` column -- 1% of that
    country-year-level-type's total population, which is itself PIP's population
    estimate for that survey). Sort all bins by their threshold value ascending and
    accumulate population mass into a global CDF, exactly as PIP pools countries for
    its own regional/global aggregates. Mixes income and consumption countries in the
    same pool, matching PIP's own practice."""
    all_bins = pd.concat(
        [fill_open_ended_top_bin(choice.bins).assign(_year=choice.year) for choice in country_choices.values()],
        ignore_index=True,
    )
    total_pop = all_bins["pop"].sum()
    weighted_year_sum = (all_bins["pop"] * all_bins["_year"]).sum()
    representative_year = round(weighted_year_sum / total_pop)

    sorted_bins = all_bins.sort_values("quantile")
    fractions = cumulative_fractions(sorted_bins, total_pop)
    values = (sorted_bins["quantile"] * DAYS_PER_YEAR).map(round_sensibly)

    full_cdf = dedupe_cdf_keeping_highest_fraction(values.tolist(), fractions.tolist())
    downsampled_cdf = downsample_cdf(full_cdf)

    return {
        "label": "World",
        "year": representative_year,
        "welfareType": "mixed",
        "population": round(total_pop),
        "cdf": downsampled_cdf,
    }


def downsample_cdf(cdf: list[list[float]]) -> list[list[float]]:
    """Keep both ends, and keep the top tail (above the 99th population percentile)
    dense, since that's where a few-hundred-point downsample would otherwise blur the
    most eye-catching part of a global income distribution."""
    if len(cdf) <= MAX_WORLD_CDF_POINTS:
        return cdf

    tail_start_index = next(
        (index for index, (_, fraction) in enumerate(cdf) if fraction >= WORLD_TOP_TAIL_START_FRACTION),
        len(cdf) - 1,
    )
    body = cdf[:tail_start_index]
    tail = cdf[tail_start_index:]

    body_point_count = MAX_WORLD_CDF_POINTS - min(len(tail), WORLD_TOP_TAIL_POINT_COUNT)
    sampled_body = pick_evenly_spaced(body, body_point_count)
    sampled_tail = pick_evenly_spaced(tail, WORLD_TOP_TAIL_POINT_COUNT)

    combined = sampled_body + sampled_tail
    # Re-dedupe: evenly-spaced sampling of the body and tail can still collide on value
    # (e.g. if the tail start falls mid-run of a repeated low-tail value).
    values = [point[0] for point in combined]
    fractions = [point[1] for point in combined]
    return dedupe_cdf_keeping_highest_fraction(values, fractions)


def pick_evenly_spaced(points: list[list[float]], count: int) -> list[list[float]]:
    if count <= 0:
        return []
    if len(points) <= count:
        return points
    if count == 1:
        return [points[-1]]
    step = (len(points) - 1) / (count - 1)
    indices = [round(index * step) for index in range(count)]
    return [points[index] for index in indices]


def report(country_choices: dict[str, CountryChoice], variants: dict, percentiles: pd.DataFrame) -> None:
    world = variants["world"]
    total_pop = sum(choice.bins["pop"].sum() for choice in country_choices.values())

    print(f"Countries included: {len(country_choices)}")
    print(f"World reference year (population-weighted avg of each country's latest survey year): {world['year']}")
    print(f"Pooled population: {total_pop:,.0f}")
    print(f"Survey year range across countries: {percentiles['year'].min()}-{percentiles['year'].max()}")
    print()

    for variant_id in ["world", *REPORTED_COUNTRY_CODES]:
        variant = variants.get(variant_id)
        if variant is None:
            print(f"{variant_id}: not present in output")
            continue
        p10 = value_at_fraction(variant["cdf"], 0.10)
        p50 = value_at_fraction(variant["cdf"], 0.50)
        p90 = value_at_fraction(variant["cdf"], 0.90)
        p99 = value_at_fraction(variant["cdf"], 0.99)
        print(
            f"{variant_id:6s} ({variant['label']}, {variant['year']}, {variant['welfareType']}): "
            f"p10=${p10:,.0f}  p50=${p50:,.0f}  p90=${p90:,.0f}  p99=${p99:,.0f}"
        )

    output_size_bytes = OUTPUT_PATH.stat().st_size
    print(f"\nOutput file size: {output_size_bytes:,} bytes ({output_size_bytes / 1_000_000:.2f} MB)")


def value_at_fraction(cdf: list[list[float]], target_fraction: float) -> float:
    for value, fraction in cdf:
        if fraction >= target_fraction:
            return value
    return cdf[-1][0]


if __name__ == "__main__":
    main()
