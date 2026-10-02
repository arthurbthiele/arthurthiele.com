# /// script
# requires-python = ">=3.11"
# dependencies = ["openpyxl"]
# ///
"""Builds the Australian lifespan (age at death) dataset from the ABS life tables, 2022–2024, Table 9 (Australia).

A period life table follows a notional 100,000 newborns through the age-specific death rates of 2022–2024. Its lx
column is how many are still alive at exact age x, so the share who have died by age x, which is the CDF of age at
death, is 1 − lx / l0. Deaths within each year of age are treated as evenly spread, the usual life-table assumption,
which is what linear interpolation between integer ages gives. The table's last row is the open-ended "100 and over",
so the CDF stops at 100: older ages are beyond the data rather than guessed.
"""

import json
import subprocess
from pathlib import Path

import openpyxl

SCRIPT_DIRECTORY = Path(__file__).parent
CACHE_DIRECTORY = SCRIPT_DIRECTORY / ".cache"
OUTPUT_DIRECTORY = SCRIPT_DIRECTORY.parent.parent / "src" / "tools" / "percentileConverter" / "data"

LIFE_TABLES_URL = "https://www.abs.gov.au/statistics/people/population/life-expectancy/2022-2024/3302055001DO001_20222024.xlsx"
LIFE_TABLES_PAGE_URL = "https://www.abs.gov.au/statistics/people/population/life-expectancy/2022-2024"
BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"

AUSTRALIA_SHEET_NAME = "Table 9"
EXPECTED_TITLE_FRAGMENT = "by Australia"
FIRST_DATA_ROW_INDEX = 7
SURVIVORS_COLUMN_INDEX_BY_SEX = {"male": 1, "female": 5}
LIFE_EXPECTANCY_COLUMN_INDEX_BY_SEX = {"male": 4, "female": 8}
RADIX = 100_000
CDF_FRACTION_DECIMAL_PLACES = 6


def main():
    rows = read_life_table_rows()
    variants = {sex: {"cdf": build_cdf(rows, column_index)} for sex, column_index in SURVIVORS_COLUMN_INDEX_BY_SEX.items()}
    output = {
        "source": {
            "name": "ABS Life tables, Australia, 2022–2024 (Table 9)",
            "url": LIFE_TABLES_PAGE_URL,
            "licence": "CC BY 4.0"
        },
        "variants": variants
    }
    write_json("australianLifespan.json", output)
    for sex, column_index in LIFE_EXPECTANCY_COLUMN_INDEX_BY_SEX.items():
        cdf = variants[sex]["cdf"]
        print(f"{sex}: life expectancy at birth {rows[0][column_index]:.1f}, median age at death {median(cdf):.1f}, "
              f"still alive at 100: {1 - cdf[-1][1]:.2%}")


def read_life_table_rows():
    workbook = openpyxl.load_workbook(download_cached(), read_only=True)
    rows = list(workbook[AUSTRALIA_SHEET_NAME].iter_rows(values_only=True))
    if EXPECTED_TITLE_FRAGMENT not in str(rows[2][0]):
        raise RuntimeError(f"{AUSTRALIA_SHEET_NAME} is no longer the Australia table: {rows[2][0]}")
    data_rows = [row for row in rows[FIRST_DATA_ROW_INDEX:] if isinstance(row[0], int)]
    if [row[0] for row in data_rows] != list(range(len(data_rows))):
        raise RuntimeError("life table ages are not a contiguous run from 0")
    return data_rows


def build_cdf(rows, survivors_column_index):
    return [[age, round(1 - row[survivors_column_index] / RADIX, CDF_FRACTION_DECIMAL_PLACES)] for age, row in enumerate(rows)]


def median(cdf):
    for (lower_age, lower_fraction), (upper_age, upper_fraction) in zip(cdf, cdf[1:]):
        if upper_fraction >= 0.5:
            return lower_age + (0.5 - lower_fraction) / (upper_fraction - lower_fraction) * (upper_age - lower_age)
    raise RuntimeError("median is beyond the table")


def download_cached():
    cached_path = CACHE_DIRECTORY / "lifeTables20222024.xlsx"
    if cached_path.exists():
        return cached_path
    CACHE_DIRECTORY.mkdir(parents=True, exist_ok=True)
    subprocess.run(["curl", "-s", "--http1.1", "-A", BROWSER_USER_AGENT, "-o", str(cached_path), LIFE_TABLES_URL], check=True)
    if cached_path.read_bytes().lstrip().startswith(b"<"):
        cached_path.unlink()
        raise RuntimeError(f"Got an HTML error page instead of data from {LIFE_TABLES_URL}")
    return cached_path


def write_json(file_name, content):
    OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIRECTORY / file_name).write_text(json.dumps(content, separators=(",", ":"), ensure_ascii=False))


if __name__ == "__main__":
    main()
