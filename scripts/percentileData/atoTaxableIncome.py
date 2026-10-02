# /// script
# requires-python = ">=3.11"
# dependencies = ["openpyxl"]
# ///
"""Builds the Australian taxable income dataset from ATO Taxation Statistics 2023-24,
Individuals Table 16A ("Percentile distribution of taxable individuals, by taxable income,
state/territory and sex").

Table 16A splits all taxable individuals nationally into 100 percentile bands of taxable
income (band 1 is "$22,146 or less", band 2 is "$22,147 to $23,472", ..., band 100 is
"$429,531 or more"), then reports how many individuals of each sex, in each state, fall into
each band. The band edges are fixed by the national distribution, not recomputed per sex, so
a sex's own CDF is built empirically: we sum that sex's headcount into each national band
(across all states), take the cumulative sum over bands, and divide by that sex's total. The
"all" variant does the same after summing both sexes' counts per band.

Bands 1 and 100 are open-ended ("$X or less" / "$X or more"), so the table never gives the
population's true minimum or maximum. We start the CDF at band 1's upper edge and end it at
band 99's upper edge (band 100's lower edge minus one dollar), rather than inventing extremes.
"""

import json
import re
import subprocess
from collections import defaultdict
from pathlib import Path

import openpyxl

SCRIPT_DIRECTORY = Path(__file__).parent
CACHE_DIRECTORY = SCRIPT_DIRECTORY / ".cache"
OUTPUT_DIRECTORY = SCRIPT_DIRECTORY.parent.parent / "src" / "tools" / "percentileConverter" / "data"

ATO_TABLE_16_XLSX_URL = (
    "https://data.gov.au/data/dataset/faea4485-f407-457d-97f8-3f0822ccd654/resource/"
    "abb69db8-b053-4cd2-84d1-64ac75d02cb1/download/"
    "ts24individual16percentiledistributionontaxableincomebysexstate.xlsx"
)
ATO_TABLE_16_PAGE_URL = (
    "https://www.ato.gov.au/about-ato/research-and-statistics/in-detail/taxation-statistics/"
    "taxation-statistics-2023-24/statistics-in-taxation-statistics-2023-24/"
    "individuals-statistics-for-taxation-statistics-2023-24"
)

BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
DOWNLOAD_ATTEMPTS = 5

TABLE_16A_SHEET_NAME = "Table 16A"
TABLE_16A_HEADER_ROW_COUNT = 2
PERCENTILE_COLUMN_INDEX = 0
RANGED_TAXABLE_INCOME_COLUMN_INDEX = 1
SEX_COLUMN_INDEX = 3
INDIVIDUALS_COUNT_COLUMN_INDEX = 4

LAST_PERCENTILE_WITH_A_KNOWN_UPPER_BOUND = 99  # percentile 100's band is open-ended ("$X or more")

VARIANT_SEXES = {"all": ("Male", "Female"), "male": ("Male",), "female": ("Female",)}


def main():
    counts_by_percentile = read_percentile_sex_counts(download_cached(ATO_TABLE_16_XLSX_URL, "ts24individual16.xlsx"))
    output = {
        "source": {
            "name": "ATO Taxation Statistics 2023–24, Individuals Table 16",
            "url": ATO_TABLE_16_PAGE_URL,
            "licence": "CC BY 4.0"
        },
        "variants": {
            variant: {
                "population": count_individuals(counts_by_percentile, sexes),
                "cdf": build_cdf(counts_by_percentile, sexes)
            }
            for variant, sexes in VARIANT_SEXES.items()
        }
    }
    write_json("atoTaxableIncome.json", output)
    for variant, data in output["variants"].items():
        cdf = data["cdf"]
        print(f"{variant}: {len(cdf)} points, first {cdf[0]}, last {cdf[-1]}")


def read_percentile_sex_counts(xlsx_path):
    workbook = openpyxl.load_workbook(xlsx_path, data_only=True, read_only=True)
    rows = list(workbook[TABLE_16A_SHEET_NAME].iter_rows(values_only=True))
    data_rows = [row for row in rows[TABLE_16A_HEADER_ROW_COUNT:] if row[PERCENTILE_COLUMN_INDEX] is not None]

    counts_by_percentile = defaultdict(lambda: {"rangedTaxableIncome": None, "Male": 0, "Female": 0})
    for row in data_rows:
        percentile = row[PERCENTILE_COLUMN_INDEX]
        sex = row[SEX_COLUMN_INDEX]
        bucket = counts_by_percentile[percentile]
        bucket["rangedTaxableIncome"] = row[RANGED_TAXABLE_INCOME_COLUMN_INDEX]
        bucket[sex] += row[INDIVIDUALS_COUNT_COLUMN_INDEX]
    return counts_by_percentile


def count_individuals(counts_by_percentile, sexes):
    return sum(counts_by_percentile[percentile][sex] for percentile in counts_by_percentile for sex in sexes)


def build_cdf(counts_by_percentile, sexes):
    total_individuals = count_individuals(counts_by_percentile, sexes)
    cumulative_individuals = 0
    cdf = []
    for percentile in sorted(counts_by_percentile):
        bucket = counts_by_percentile[percentile]
        cumulative_individuals += sum(bucket[sex] for sex in sexes)
        if percentile > LAST_PERCENTILE_WITH_A_KNOWN_UPPER_BOUND:
            continue
        upper_bound = parse_upper_bound(bucket["rangedTaxableIncome"])
        cdf.append([upper_bound, cumulative_individuals / total_individuals])
    return drop_non_increasing_points(cdf)


def parse_upper_bound(ranged_taxable_income):
    digits_only = ranged_taxable_income.replace("$", "").replace(",", "")
    if "or more" in digits_only:
        return None
    return int(re.findall(r"\d+", digits_only)[-1])


def drop_non_increasing_points(cdf):
    kept = []
    for value, cumulative_fraction in cdf:
        while kept and (value <= kept[-1][0] or cumulative_fraction <= kept[-1][1]):
            kept.pop()
        kept.append([value, cumulative_fraction])
    return kept


def download_cached(url, file_name):
    cached_path = CACHE_DIRECTORY / file_name
    if cached_path.exists():
        return cached_path
    CACHE_DIRECTORY.mkdir(parents=True, exist_ok=True)
    for _ in range(DOWNLOAD_ATTEMPTS):
        subprocess.run(
            ["curl", "-s", "--http1.1", "-A", BROWSER_USER_AGENT, "-o", str(cached_path), url], check=True
        )
        if not cached_path.read_bytes().lstrip().startswith(b"<"):
            return cached_path
    cached_path.unlink()
    raise RuntimeError(f"Got an HTML error page instead of data from {url}")


def write_json(file_name, content):
    OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIRECTORY / file_name).write_text(json.dumps(content, separators=(",", ":"), ensure_ascii=False))


if __name__ == "__main__":
    main()
