# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Builds the net personal wealth datasets from the World Inequality Database (WID) bulk download.

Source: https://wid.world/bulk_download/wid_all_data.zip, the file behind "Download full dataset" on
https://wid.world/data/ (CC BY 4.0). One CSV per country or region, semicolon-separated:
country;variable;percentile;year;value;age;pop;...

Variables used (the bulk file spells them type + concept + population + age):
  thwealj992  threshold of net personal wealth, equal-split adults (aged 20+), in constant local currency
  npopuli992  number of adults (20+)
  xlcuspi999  PPP conversion factor, local currency per US dollar
  xlcusxi999  market exchange rate, local currency per US dollar
  inyixxi999  national income price index (1 in WID's reference year)

"Equal-split" divides a couple's joint wealth evenly between them, so every adult counts once: the closest thing to
individual wealth when assets are held jointly. A threshold row pXpY gives the wealth at the Xth percentile, so every
row is a CDF point (wealth, X / 100). WID's generalised percentiles run in 1% steps up to the 99th, then 0.1%, 0.01%
and 0.001% steps through the top, which keeps the very top of the distribution resolved.

Extracting from the 6.9 GB of CSVs takes minutes, so the first stage caches a compact extract to .cache/.

Countries are tiered by what WID cites as the source of their wealth series. "Researched" countries cite country-specific
studies or WID's Distributional Financial Accounts for Europe (built on the ECB's household wealth surveys); "extended"
countries cite only WID's 2025 extended-coverage note, which leans on modelling; the rest cite only WID's generic
imputation note. We publish the researched countries plus a few notable extended ones, flagged as rougher.

The world distribution is our own pool of every country with data, each converted to US dollars at purchasing-power
parity (2025 prices) and weighted by its adult population: the mixture CDF F(x) = Σ wᵢ Fᵢ(x), inverted at chosen
fractions. Pooling ourselves keeps the world in exactly the same units as the per-country distributions. WID's own world
series agrees to within about 5% at the median; it also imputes the countries without data, which we leave out.
"""

import bisect
import csv
import io
import json
import math
import re
import subprocess
import zipfile
from pathlib import Path

SCRIPT_DIRECTORY = Path(__file__).parent
CACHE_DIRECTORY = SCRIPT_DIRECTORY / ".cache"
OUTPUT_DIRECTORY = SCRIPT_DIRECTORY.parent.parent / "src" / "tools" / "percentileConverter" / "data"

WID_BULK_URL = "https://wid.world/bulk_download/wid_all_data.zip"
WID_BULK_PATH = CACHE_DIRECTORY / "wid_all_data.zip"
WID_EXTRACT_PATH = CACHE_DIRECTORY / "widWealthExtract.json"
BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
DOWNLOAD_ATTEMPTS = 6
DOWNLOAD_TIMEOUT_SECONDS = 600

WEALTH_THRESHOLD_VARIABLE = "thwealj992"
ADULT_POPULATION_VARIABLE = "npopuli992"
PPP_RATE_VARIABLE = "xlcuspi999"
MARKET_RATE_VARIABLE = "xlcusxi999"
PRICE_INDEX_VARIABLE = "inyixxi999"
SERIES_VARIABLES = (ADULT_POPULATION_VARIABLE, PPP_RATE_VARIABLE, MARKET_RATE_VARIABLE, PRICE_INDEX_VARIABLE)
WORLD_CODE = "WO"
PERCENTILE_PATTERN = re.compile(r"^p([0-9.]+)p([0-9.]+)$")
SOURCE_DOCUMENT_PATTERN = re.compile(r"document/([a-z0-9-]+)")
GENERIC_IMPUTATION_DOCUMENT = "global-wealth-inequality-on-wid-world-estimates-and-imputations"
EXTENDED_COVERAGE_DOCUMENT = "wid-income-and-wealth-distributional-series-updated-and-extended-coverage"

POOL_YEAR = "2023"
PRICE_REFERENCE_YEAR = "2025"
EXTENDED_COUNTRIES_TO_PUBLISH = ["AU", "BR", "CA", "ID", "JP", "MX", "NZ", "ZA"]
DISPLAY_NAME_BY_WID_NAME = {"USA": "United States", "Russian Federation": "Russia", "Korea": "South Korea", "Viet Nam": "Vietnam"}
VALUE_SIGNIFICANT_DIGITS = 4

BOTTOM_POOL_FRACTIONS = [index / 1000 for index in range(1, 10)]
BODY_POOL_FRACTIONS = [index / 200 for index in range(2, 199)]
TOP_POOL_FRACTIONS = [0.99 + index / 2000 for index in range(1, 18)] + [0.999, 0.9995, 0.9999, 0.99995, 0.99999]
POOL_FRACTIONS = BOTTOM_POOL_FRACTIONS + BODY_POOL_FRACTIONS + TOP_POOL_FRACTIONS


def main():
    extract = load_extract()
    countries = extract["countries"]
    published_codes = sorted(
        (code for code, country in countries.items() if is_published(code, country) and has_wealth_data(country)),
        key=lambda code: display_name(countries[code])
    )
    world_variant = build_world_variant(countries)
    country_variants = {code: build_country_variant(countries[code]) for code in published_codes}
    write_json("wealthWorldwide.json", {
        "source": SOURCE,
        "unit": f"US dollars at purchasing-power parity, {PRICE_REFERENCE_YEAR} prices",
        "extendedCoverageCountries": [code for code in published_codes if countries[code]["sourceTier"] == "extended"],
        "variants": {"world": world_variant, **country_variants}
    })
    australia = countries["AU"]
    write_json("wealthAustralia.json", {"source": SOURCE, "variants": {"adults": build_local_currency_variant(australia)}})
    report(extract, world_variant, country_variants)


SOURCE = {
    "name": "World Inequality Database, net personal wealth (equal-split adults), via the WID bulk download",
    "url": "https://wid.world/data/",
    "licence": "CC BY 4.0"
}


def is_published(code, country):
    return country["sourceTier"] == "researched" or code in EXTENDED_COUNTRIES_TO_PUBLISH


def has_wealth_data(country):
    return POOL_YEAR in country["thresholds"] and country[ADULT_POPULATION_VARIABLE].get(POOL_YEAR)


def display_name(country):
    return DISPLAY_NAME_BY_WID_NAME.get(country["label"], country["label"])


def latest_threshold_year(country):
    return max(country["thresholds"], key=int)


def build_country_variant(country):
    year = latest_threshold_year(country)
    ppp_rate = country[PPP_RATE_VARIABLE][PRICE_REFERENCE_YEAR]
    return {
        "label": display_name(country),
        "year": int(year),
        "population": round(country[ADULT_POPULATION_VARIABLE][year]),
        "cdf": to_cdf(threshold_points(country, year, ppp_rate))
    }


def build_local_currency_variant(country):
    year = latest_threshold_year(country)
    return {
        "label": display_name(country),
        "year": int(year),
        "population": round(country[ADULT_POPULATION_VARIABLE][year]),
        "cdf": to_cdf(threshold_points(country, year, 1))
    }


def threshold_points(country, year, local_currency_per_unit):
    """(fraction below, wealth) pairs sorted by fraction, converted from constant local currency."""
    return sorted((float(fraction), wealth / local_currency_per_unit) for fraction, wealth in country["thresholds"][year].items())


def to_cdf(points):
    """Strictly increasing [wealth, fraction] pairs. Where several percentiles share one wealth value (e.g. a block of
    adults with exactly zero), the CDF jumps there, so the value keeps the highest fraction."""
    fraction_by_value = {}
    for fraction, wealth in points:
        value = round_significant(wealth)
        fraction_by_value[value] = max(fraction, fraction_by_value.get(value, 0))
    cdf = []
    for value, fraction in sorted(fraction_by_value.items()):
        if cdf and fraction <= cdf[-1][1]:
            continue
        cdf.append([value, round(fraction, 6)])
    return cdf


def round_significant(value):
    if value == 0:
        return 0
    digits = VALUE_SIGNIFICANT_DIGITS - int(math.floor(math.log10(abs(value)))) - 1
    return round(value, digits) if digits > 0 else int(round(value, digits))


def build_world_variant(countries):
    components = []
    for country in countries.values():
        ppp_rate = country[PPP_RATE_VARIABLE].get(PRICE_REFERENCE_YEAR)
        if not has_wealth_data(country) or not ppp_rate:
            continue
        points = threshold_points(country, POOL_YEAR, ppp_rate)
        components.append(([wealth for _, wealth in points], [fraction for fraction, _ in points], country[ADULT_POPULATION_VARIABLE][POOL_YEAR]))
    total_adults = sum(adults for *_, adults in components)

    def pooled_fraction_below(wealth):
        return sum(fraction_below(values, fractions, wealth) * adults for values, fractions, adults in components) / total_adults

    lowest = min(values[0] for values, *_ in components)
    highest = max(values[-1] for values, *_ in components)
    points = [(fraction, invert(pooled_fraction_below, fraction, lowest, highest)) for fraction in POOL_FRACTIONS]
    return {
        "label": "World",
        "year": int(POOL_YEAR),
        "population": round(total_adults),
        "countryCount": len(components),
        "cdf": to_cdf(points)
    }


def fraction_below(values, fractions, wealth):
    """One country's CDF, linear between its threshold points; nobody below its lowest or above its highest threshold."""
    if wealth <= values[0]:
        return 0.0
    if wealth >= values[-1]:
        return 1.0
    upper_index = bisect.bisect_right(values, wealth)
    lower_value, upper_value = values[upper_index - 1], values[upper_index]
    lower_fraction, upper_fraction = fractions[upper_index - 1], fractions[upper_index]
    if upper_value == lower_value:
        return upper_fraction
    return lower_fraction + (upper_fraction - lower_fraction) * (wealth - lower_value) / (upper_value - lower_value)


def invert(cumulative, target_fraction, lowest, highest):
    """Bisection on a non-decreasing function; 100 halvings resolve any wealth range to well under a dollar."""
    lower, upper = lowest, highest
    for _ in range(100):
        middle = (lower + upper) / 2
        if cumulative(middle) < target_fraction:
            lower = middle
            continue
        upper = middle
    return upper


def report(extract, world_variant, country_variants):
    wid_world = extract["world"]["thresholds"][POOL_YEAR]
    print(f"World pool: {world_variant['countryCount']} countries, {world_variant['population']:,} adults")
    for fraction in ("0.1", "0.5", "0.9", "0.99"):
        print(f"  P{float(fraction) * 100:g}: ours {value_at(world_variant['cdf'], float(fraction)):,.0f} vs WID world {wid_world[fraction]:,.0f}")
    print(f"Countries published: {len(country_variants)}")
    for code in ("AU", "US", "GB", "IN", "CN"):
        variant = country_variants[code]
        print(f"  {code} {variant['year']}: median ${value_at(variant['cdf'], 0.5):,.0f} PPP, adults {variant['population']:,}")


def value_at(cdf, target_fraction):
    for (lower_value, lower_fraction), (upper_value, upper_fraction) in zip(cdf, cdf[1:]):
        if upper_fraction >= target_fraction:
            return lower_value + (target_fraction - lower_fraction) / (upper_fraction - lower_fraction) * (upper_value - lower_value)
    return cdf[-1][0]


def write_json(file_name, content):
    OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIRECTORY / file_name).write_text(json.dumps(content, separators=(",", ":"), ensure_ascii=False))


def load_extract():
    if WID_EXTRACT_PATH.exists():
        return json.loads(WID_EXTRACT_PATH.read_text())
    download_bulk_file()
    with zipfile.ZipFile(WID_BULK_PATH) as archive:
        countries = read_country_names(archive)
        extract = {
            "world": read_area(archive, WORLD_CODE),
            "countries": {
                code: {"label": label, "sourceTier": read_source_tier(archive, code), **read_area(archive, code)}
                for code, label in countries.items()
            }
        }
    WID_EXTRACT_PATH.write_text(json.dumps(extract))
    return extract


def download_bulk_file():
    if WID_BULK_PATH.exists() and WID_BULK_PATH.stat().st_size == get_content_length(WID_BULK_URL):
        return
    CACHE_DIRECTORY.mkdir(parents=True, exist_ok=True)
    for _ in range(DOWNLOAD_ATTEMPTS):
        subprocess.run(
            ["curl", "-s", "--http1.1", "-A", BROWSER_USER_AGENT, "--max-time", str(DOWNLOAD_TIMEOUT_SECONDS),
             "-C", "-", "-o", str(WID_BULK_PATH), WID_BULK_URL]
        )
        if WID_BULK_PATH.stat().st_size == get_content_length(WID_BULK_URL):
            return
    raise RuntimeError(f"Could not download {WID_BULK_URL} completely")


def get_content_length(url):
    headers = subprocess.run(
        ["curl", "-sI", "--http1.1", "-A", BROWSER_USER_AGENT, url], capture_output=True, text=True, check=True
    ).stdout
    return int(next(line for line in headers.lower().splitlines() if line.startswith("content-length:")).split(":")[1])


def read_country_names(archive):
    """WID_countries.csv lists countries and aggregate regions; only countries have a continent in `region`."""
    with archive.open("WID_countries.csv") as file:
        rows = csv.DictReader(io.TextIOWrapper(file, encoding="utf-8"), delimiter=";")
        return {
            row["alpha2"]: row["shortname"]
            for row in rows
            if row["region"] and len(row["alpha2"]) == 2 and f"WID_data_{row['alpha2']}.csv" in archive.namelist()
        }


def read_source_tier(archive, code):
    metadata_name = f"WID_metadata_{code}.csv"
    if metadata_name not in archive.namelist():
        return "imputed"
    with archive.open(metadata_name) as file:
        rows = csv.DictReader(io.TextIOWrapper(file, encoding="utf-8"), delimiter=";")
        source = next((row["source"] for row in rows if row["variable"] == WEALTH_THRESHOLD_VARIABLE), "")
    documents = SOURCE_DOCUMENT_PATTERN.findall(source)
    if any(GENERIC_IMPUTATION_DOCUMENT not in document and EXTENDED_COVERAGE_DOCUMENT not in document for document in documents):
        return "researched"
    if any(EXTENDED_COVERAGE_DOCUMENT in document for document in documents):
        return "extended"
    return "imputed"


def read_area(archive, code):
    """Wealth thresholds as {year: {fraction below: wealth}}, plus {year: value} for each series variable."""
    thresholds = {}
    series = {variable: {} for variable in SERIES_VARIABLES}
    with archive.open(f"WID_data_{code}.csv") as file:
        rows = csv.reader(io.TextIOWrapper(file, encoding="utf-8"), delimiter=";")
        next(rows)
        for _, variable, percentile, year, value, *_ in rows:
            if variable == WEALTH_THRESHOLD_VARIABLE and value != "":
                match = PERCENTILE_PATTERN.match(percentile)
                if match is None:
                    continue
                thresholds.setdefault(year, {})[str(float(match.group(1)) / 100)] = float(value)
            if variable in series and percentile == "p0p100" and value != "":
                series[variable][year] = float(value)
    return {"thresholds": thresholds, **series}


if __name__ == "__main__":
    main()
