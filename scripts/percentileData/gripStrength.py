# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Builds the grip strength dataset from Statistics Canada's normative percentiles (Canadian Health Measures Survey
cycle 5, 2016–2017), "Normative-referenced percentile values for physical fitness among Canadians", Table 1.

Grip strength there is combined: the best of two attempts with each hand, added together. The table gives P5 to P95 by
sex and age band. Each band is close to symmetric, so it is modelled as normal: the mean is the median, and σ is the
average of the four symmetric spreads, P(100−q) − Pq = 2·z_q·σ for q = 5, 10, 20, 30. We print the worst error of that
fit against the published percentiles so a poor fit would be visible.
"""

import html
import json
import re
import subprocess
from pathlib import Path

SCRIPT_DIRECTORY = Path(__file__).parent
CACHE_DIRECTORY = SCRIPT_DIRECTORY / ".cache"
OUTPUT_DIRECTORY = SCRIPT_DIRECTORY.parent.parent / "src" / "tools" / "percentileConverter" / "data"

TABLE_URL = "https://www150.statcan.gc.ca/n1/pub/82-003-x/2019010/article/00002/tbl/tbl01-eng.htm"
ARTICLE_URL = "https://www150.statcan.gc.ca/n1/pub/82-003-x/2019010/article/00002-eng.htm"
BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"

PERCENTILES = [5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95]
STANDARD_NORMAL_QUANTILE_BY_UPPER_PERCENTILE = {95: 1.6449, 90: 1.2816, 80: 0.8416, 70: 0.5244}
ADULT_MINIMUM_AGE = 18
SEX_BY_HEADING = {"Males": "male", "Females": "female"}
AGE_BAND_PATTERN = re.compile(r"^(\d+) to (\d+)$")


def main():
    variants = {}
    worst_error_kg = 0
    for sex, age_band, percentile_values in read_table_rows():
        lowest_age = int(AGE_BAND_PATTERN.match(age_band).group(1))
        if lowest_age < ADULT_MINIMUM_AGE:
            continue
        by_percentile = dict(zip(PERCENTILES, percentile_values))
        mean = by_percentile[50]
        standard_deviation = sum(
            (by_percentile[upper] - by_percentile[100 - upper]) / (2 * quantile)
            for upper, quantile in STANDARD_NORMAL_QUANTILE_BY_UPPER_PERCENTILE.items()
        ) / len(STANDARD_NORMAL_QUANTILE_BY_UPPER_PERCENTILE)
        worst_error_kg = max(worst_error_kg, worst_fit_error(by_percentile, mean, standard_deviation))
        variants[f"{sex}|{age_band.replace(' to ', '–')}"] = {"mean": mean, "standardDeviation": round(standard_deviation, 2)}

    output = {
        "source": {
            "name": "Statistics Canada, Canadian Health Measures Survey 2016–2017, normative grip strength percentiles (Table 1)",
            "url": ARTICLE_URL,
            "licence": "Statistics Canada Open Licence"
        },
        "variants": variants
    }
    write_json("gripStrength.json", output)
    print(f"{len(variants)} sex × age bands; worst normal-fit error against published percentiles: {worst_error_kg:.1f} kg")


def read_table_rows():
    page = download_cached().read_text(errors="ignore")
    sex = None
    for row in re.findall(r"<tr.*?</tr>", page, re.S):
        cells = [html.unescape(re.sub(r"<[^>]+>", "", cell)).strip() for cell in re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", row, re.S)]
        if cells and cells[0] in SEX_BY_HEADING:
            sex = SEX_BY_HEADING[cells[0]]
            continue
        if sex is None or len(cells) != len(PERCENTILES) + 1 or not AGE_BAND_PATTERN.match(cells[0]):
            continue
        yield sex, cells[0], [float(cell) for cell in cells[1:]]


def worst_fit_error(by_percentile, mean, standard_deviation):
    from statistics import NormalDist

    fitted = NormalDist(mean, standard_deviation)
    return max(abs(fitted.inv_cdf(percentile / 100) - value) for percentile, value in by_percentile.items())


def download_cached():
    cached_path = CACHE_DIRECTORY / "statcanGripTable.html"
    if cached_path.exists():
        return cached_path
    CACHE_DIRECTORY.mkdir(parents=True, exist_ok=True)
    subprocess.run(["curl", "-s", "--http1.1", "-A", BROWSER_USER_AGENT, "-o", str(cached_path), TABLE_URL], check=True)
    return cached_path


def write_json(file_name, content):
    OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIRECTORY / file_name).write_text(json.dumps(content, separators=(",", ":"), ensure_ascii=False))


if __name__ == "__main__":
    main()
