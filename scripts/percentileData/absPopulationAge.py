# /// script
# requires-python = ">=3.11"
# dependencies = ["openpyxl"]
# ///
"""Builds the ABS Australian population-by-age dataset (persons, male, female).

Source: ABS "National, state and territory population", March 2026 release (latest at time of
writing), Table 59 "Estimated Resident Population By Single Year Of Age, Australia"
(file 3101059.xlsx, found via the release's "Population - Australia" download). Its annual
single-year-of-age series runs to reference date 30 June 2025 — a year behind the March-2026
quarterly headline figures, because ABS only recompiles the single-year-of-age breakdown once a
year, with the June-quarter release.

The workbook splits the "Persons" series across two sheets purely because of a historical column
budget: `Data1` holds Male ages 0-100+, Female ages 0-100+, then Persons ages 0-47; `Data2`
continues Persons ages 48-100+. Age 100 is top-coded as "100 and over". We verified Persons equals
Male + Female at every age for the latest row before trusting the split.

Ages are treated as continuous: someone aged k occupies the interval [k, k+1), so the CDF carries
a point at each integer age with the cumulative share of the population strictly younger than that
age, plus one extra point at `TOP_CODE_AGE + 1` closing the "100 and over" bucket out to 1.0 — i.e.
everyone top-coded is treated as occupying [100, 101) for percentile purposes, same as any other
single-year bucket.
"""

import json
import subprocess
from pathlib import Path

import openpyxl

SCRIPT_DIRECTORY = Path(__file__).parent
CACHE_DIRECTORY = SCRIPT_DIRECTORY / ".cache"
OUTPUT_DIRECTORY = SCRIPT_DIRECTORY.parent.parent / "src" / "tools" / "percentileConverter" / "data"

ABS_POPULATION_BY_AGE_URL = (
    "https://www.abs.gov.au/statistics/people/population/national-state-and-territory-population/mar-2026/3101059.xlsx"
)
ABS_REFERENCE_DATE = "30 June 2025"

BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
DOWNLOAD_ATTEMPTS = 5

TOP_CODE_AGE = 100
AGES_PER_SEX_IN_DATA1 = 101  # ages 0..99 plus the "100 and over" top-code column
PERSONS_AGES_IN_DATA1 = 48  # Data1 only has room left for Persons ages 0..47 before running out of columns
CDF_FRACTION_DECIMAL_PLACES = 6


def main():
    workbook = openpyxl.load_workbook(download_cached(), read_only=True, data_only=True)
    latest_data1_row, latest_data2_row = latest_rows(workbook)

    male = list(latest_data1_row[1 : 1 + AGES_PER_SEX_IN_DATA1])
    female = list(latest_data1_row[1 + AGES_PER_SEX_IN_DATA1 : 1 + 2 * AGES_PER_SEX_IN_DATA1])
    persons = list(latest_data1_row[1 + 2 * AGES_PER_SEX_IN_DATA1 : 1 + 2 * AGES_PER_SEX_IN_DATA1 + PERSONS_AGES_IN_DATA1])
    persons += list(latest_data2_row[1 : 1 + AGES_PER_SEX_IN_DATA1 - PERSONS_AGES_IN_DATA1])

    mismatches = [age for age in range(TOP_CODE_AGE + 1) if male[age] + female[age] != persons[age]]
    if mismatches:
        raise RuntimeError(f"Persons != Male + Female at ages {mismatches}")

    output = {
        "source": {
            "name": f"ABS National, state and territory population, March 2026 release, Table 59 "
                    f"(Estimated Resident Population by single year of age, Australia, {ABS_REFERENCE_DATE})",
            "url": ABS_POPULATION_BY_AGE_URL,
            "licence": "CC BY 4.0"
        },
        "variants": {
            "persons": {"label": "Australian population, persons", "population": sum(persons), "cdf": build_cdf(persons)},
            "male": {"label": "Australian population, male", "population": sum(male), "cdf": build_cdf(male)},
            "female": {"label": "Australian population, female", "population": sum(female), "cdf": build_cdf(female)}
        }
    }
    write_json("absPopulationAge.json", output)
    print("totals:", {"persons": sum(persons), "male": sum(male), "female": sum(female)})
    print("median ages:", {name: median_age(counts) for name, counts in [("persons", persons), ("male", male), ("female", female)]})


def latest_rows(workbook):
    data1_rows = list(workbook["Data1"].iter_rows(min_row=11, values_only=True))
    data2_rows = list(workbook["Data2"].iter_rows(min_row=11, values_only=True))
    latest_data1_row = data1_rows[-1]
    latest_data2_row = data2_rows[-1]
    if latest_data1_row[0] != latest_data2_row[0]:
        raise RuntimeError("Data1 and Data2 sheets end on different reference dates")
    return latest_data1_row, latest_data2_row


def build_cdf(counts_by_age):
    total = sum(counts_by_age)
    points = [[0, 0.0]]
    cumulative = 0
    for age, count in enumerate(counts_by_age):
        cumulative += count
        points.append([age + 1, round(cumulative / total, CDF_FRACTION_DECIMAL_PLACES)])
    return points


def median_age(counts_by_age):
    total = sum(counts_by_age)
    cumulative = 0
    for age, count in enumerate(counts_by_age):
        previous_cumulative = cumulative
        cumulative += count
        if cumulative >= total / 2:
            return round(age + (total / 2 - previous_cumulative) / count, 2)
    return len(counts_by_age) - 1


def download_cached():
    cached_path = CACHE_DIRECTORY / "3101059.xlsx"
    if cached_path.exists():
        return cached_path
    CACHE_DIRECTORY.mkdir(parents=True, exist_ok=True)
    for _ in range(DOWNLOAD_ATTEMPTS):
        subprocess.run(
            ["curl", "-s", "--http1.1", "-A", BROWSER_USER_AGENT, "-o", str(cached_path), ABS_POPULATION_BY_AGE_URL],
            check=True
        )
        if not cached_path.read_bytes().lstrip().startswith(b"<"):
            return cached_path
    cached_path.unlink()
    raise RuntimeError(f"Got an HTML error page instead of data from {ABS_POPULATION_BY_AGE_URL}")


def write_json(file_name, content):
    OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIRECTORY / file_name).write_text(json.dumps(content, separators=(",", ":"), ensure_ascii=False))


if __name__ == "__main__":
    main()
