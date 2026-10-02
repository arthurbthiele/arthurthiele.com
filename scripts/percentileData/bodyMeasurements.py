# /// script
# requires-python = ">=3.11"
# dependencies = ["openpyxl"]
# ///
"""Builds the body-measurement datasets: Australian adult height and weight today, and height at 18 by birth year.

No Australian source publishes the spread of adult height or weight, only means. We take the mean from the ABS
(or NCD-RisC for birth cohorts) and borrow the spread from the measured US NHANES 2015–2018 percentile tables.

Height is close to normal, so its SD is recovered from three symmetric percentile spreads of a normal distribution:
P95 − P5 = 2 × 1.6449σ, P90 − P10 = 2 × 1.2816σ, P75 − P25 = 2 × 0.6745σ.

Weight is right-skewed and close to lognormal (ln(weight) is normal), so the same three spreads are taken on
ln(weight) to get σ of the log. The log-mean μ is then set so the distribution's mean matches the ABS mean, using
mean = exp(μ + σ²/2), i.e. μ = ln(mean) − σ²/2. NHANES's three log spreads agree to within 0.005, so the shape fits.
"""

import math

import csv
import io
import json
import subprocess
from pathlib import Path

import openpyxl

SCRIPT_DIRECTORY = Path(__file__).parent
CACHE_DIRECTORY = SCRIPT_DIRECTORY / ".cache"
OUTPUT_DIRECTORY = SCRIPT_DIRECTORY.parent.parent / "src" / "tools" / "percentileConverter" / "data"

ABS_HEIGHT_URL = "https://www.abs.gov.au/statistics/health/health-conditions-and-risks/national-health-survey/2022/NHSDC08.xlsx"
NCD_RISC_HEIGHT_URL = "https://www.ncdrisc.org/downloads/height/NCD_RisC_eLife_2016_height_age18_countries.csv"

BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
DOWNLOAD_ATTEMPTS = 8
DOWNLOAD_TIMEOUT_SECONDS = 30

ABS_ADULT_COLUMN_HEADER = "Total 18 years and over"
ABS_MEAN_HEIGHT_ROW_LABEL = "Average measured height (cm)"
ABS_MEAN_WEIGHT_ROW_LABEL = "Average measured weight (kg)"
ABS_ADULT_COUNT_ROW_LABEL_BY_SEX = {
    "male": "Total males aged 18 years and over",
    "female": "Total females aged 18 years and over"
}
ABS_COUNTS_IN_THOUSANDS = 1000

# Fryar et al. 2021, Vital Health Stat 3(46), Tables 9 and 11, "All race and Hispanic-origin groups, 20 and over".
# Transcribed by hand because the CDC CDN refuses scripted downloads.
NHANES_ADULT_HEIGHT_PERCENTILES_CM = {
    "male": {5: 162.8, 10: 165.8, 25: 170.1, 75: 180.2, 90: 184.7, 95: 187.4},
    "female": {5: 149.8, 10: 152.5, 25: 156.4, 75: 166.0, 90: 170.2, 95: 172.5}
}

# Fryar et al. 2021, Tables 3 and 5, "All race and Hispanic-origin groups, 20 and over", kilograms.
NHANES_ADULT_WEIGHT_PERCENTILES_KG = {
    "male": {5: 61.7, 10: 66.6, 25: 75.3, 75: 101.9, 90: 119.4, 95: 130.3},
    "female": {5: 49.8, 10: 53.9, 25: 62.2, 75: 88.6, 90: 105.3, 95: 119.6}
}

STANDARD_NORMAL_QUANTILE_BY_UPPER_PERCENTILE = {95: 1.6449, 90: 1.2816, 75: 0.6745}

NCD_RISC_SEX_TO_VARIANT = {"Men": "male", "Women": "female"}


def main():
    standard_deviation_by_sex = {
        sex: estimate_standard_deviation(percentiles) for sex, percentiles in NHANES_ADULT_HEIGHT_PERCENTILES_CM.items()
    }
    print("NHANES-derived SD (cm):", standard_deviation_by_sex)
    abs_adults = read_abs_adults()
    write_australian_height(abs_adults, standard_deviation_by_sex)
    write_australian_weight(abs_adults)
    write_height_by_birth_year(standard_deviation_by_sex)


def estimate_standard_deviation(percentiles, transform=lambda value: value, decimals=2):
    estimates = [
        (transform(percentiles[upper]) - transform(percentiles[100 - upper])) / (2 * quantile)
        for upper, quantile in STANDARD_NORMAL_QUANTILE_BY_UPPER_PERCENTILE.items()
    ]
    return round(sum(estimates) / len(estimates), decimals)


def read_abs_adults():
    """Mean height, mean weight and headcount of adults (18+) by sex, from ABS NHS 2022 Table 8.1. The sheet lists
    persons, then males, then females, so the second and third matching rows of each measure are male and female."""
    workbook = openpyxl.load_workbook(download_cached(ABS_HEIGHT_URL, "NHSDC08.xlsx"), read_only=True)
    rows = list(workbook.worksheets[1].iter_rows(values_only=True))
    header_row = next(row for row in rows if ABS_ADULT_COLUMN_HEADER in row)
    adult_column_index = header_row.index(ABS_ADULT_COLUMN_HEADER)

    def adult_values(row_label):
        _, male_row, female_row = [row for row in rows if row[0] == row_label]
        return {"male": male_row[adult_column_index], "female": female_row[adult_column_index]}

    population_by_sex = {
        sex: round(next(row for row in rows if row[0] == row_label)[adult_column_index] * ABS_COUNTS_IN_THOUSANDS)
        for sex, row_label in ABS_ADULT_COUNT_ROW_LABEL_BY_SEX.items()
    }
    return {
        "meanHeightBySex": adult_values(ABS_MEAN_HEIGHT_ROW_LABEL),
        "meanWeightBySex": adult_values(ABS_MEAN_WEIGHT_ROW_LABEL),
        "populationBySex": population_by_sex
    }


def write_australian_height(abs_adults, standard_deviation_by_sex):
    output = {
        "source": {
            "name": "ABS National Health Survey 2022 (Table 8, mean measured height, adults 18+); spread from NHANES 2015–2018 (Fryar et al. 2021)",
            "url": ABS_HEIGHT_URL,
            "licence": "CC BY 4.0"
        },
        "variants": {
            sex: {
                "mean": mean,
                "standardDeviation": standard_deviation_by_sex[sex],
                "population": abs_adults["populationBySex"][sex]
            }
            for sex, mean in abs_adults["meanHeightBySex"].items()
        }
    }
    write_json("australianHeight.json", output)
    print("ABS adult means (cm):", abs_adults["meanHeightBySex"], "adults:", abs_adults["populationBySex"])


def write_australian_weight(abs_adults):
    variants = {}
    for sex, mean in abs_adults["meanWeightBySex"].items():
        log_standard_deviation = estimate_standard_deviation(NHANES_ADULT_WEIGHT_PERCENTILES_KG[sex], math.log, 4)
        log_mean = math.log(mean) - log_standard_deviation**2 / 2
        variants[sex] = {
            "logMean": round(log_mean, 4),
            "logStandardDeviation": log_standard_deviation,
            "population": abs_adults["populationBySex"][sex]
        }
    output = {
        "source": {
            "name": "ABS National Health Survey 2022 (Table 8, mean measured weight, adults 18+); shape from NHANES 2015–2018 (Fryar et al. 2021)",
            "url": ABS_HEIGHT_URL,
            "licence": "CC BY 4.0"
        },
        "variants": variants
    }
    write_json("australianWeight.json", output)
    medians = {sex: round(math.exp(variant["logMean"]), 1) for sex, variant in variants.items()}
    print("ABS adult mean weights (kg):", abs_adults["meanWeightBySex"], "lognormal medians:", medians, variants)


def write_height_by_birth_year(standard_deviation_by_sex):
    raw_csv = download_cached(NCD_RISC_HEIGHT_URL, "ncdRiscHeight.csv").read_text()
    countries = {}
    birth_years = set()
    for row in csv.DictReader(io.StringIO(raw_csv)):
        iso_code = row["ISO"]
        birth_year = int(row["Year of birth"])
        birth_years.add(birth_year)
        country = countries.setdefault(iso_code, {"label": row["Country"], "male": {}, "female": {}})
        country[NCD_RISC_SEX_TO_VARIANT[row["Sex"]]][birth_year] = round(float(row["Mean height (cm)"]), 1)

    first_birth_year = min(birth_years)
    last_birth_year = max(birth_years)
    ordered_years = range(first_birth_year, last_birth_year + 1)
    for iso_code, country in countries.items():
        for sex in ("male", "female"):
            if len(country[sex]) != len(ordered_years):
                raise RuntimeError(
                    f"{iso_code} {sex} has {len(country[sex])} birth years; the NCD-RisC server sometimes truncates "
                    f"downloads, so delete {CACHE_DIRECTORY / 'ncdRiscHeight.csv'} and retry"
                )
    output = {
        "source": {
            "name": "NCD Risk Factor Collaboration, 'A century of trends in adult human height', eLife 2016; spread from NHANES 2015–2018",
            "url": "https://elifesciences.org/articles/13410",
            "licence": "Cite NCD-RisC (eLife 2016)"
        },
        "firstBirthYear": first_birth_year,
        "lastBirthYear": last_birth_year,
        "standardDeviationBySex": standard_deviation_by_sex,
        "countries": {
            iso_code: {
                "label": country["label"],
                "meanBySex": {sex: [country[sex][year] for year in ordered_years] for sex in ("male", "female")}
            }
            for iso_code, country in sorted(countries.items(), key=lambda entry: entry[1]["label"])
        }
    }
    write_json("heightByBirthYear.json", output)
    print(f"NCD-RisC: {len(countries)} countries, birth years {first_birth_year}–{last_birth_year}")


def download_cached(url, file_name):
    """The NCD-RisC server drops connections mid-transfer, so resume (curl -C -) until the reported size arrives."""
    cached_path = CACHE_DIRECTORY / file_name
    if cached_path.exists():
        return cached_path
    CACHE_DIRECTORY.mkdir(parents=True, exist_ok=True)
    partial_path = cached_path.with_suffix(cached_path.suffix + ".partial")
    expected_size = get_content_length(url)
    for _ in range(DOWNLOAD_ATTEMPTS):
        curl_command = ["curl", "-s", "--http1.1", "-A", BROWSER_USER_AGENT, "--max-time", str(DOWNLOAD_TIMEOUT_SECONDS)]
        subprocess.run([*curl_command, "-C", "-", "-o", str(partial_path), url])
        if partial_path.exists() and partial_path.stat().st_size == expected_size:
            break
    if not partial_path.exists() or partial_path.read_bytes().lstrip().startswith(b"<"):
        raise RuntimeError(f"Got an HTML error page or nothing instead of data from {url}")
    partial_path.rename(cached_path)
    return cached_path


def get_content_length(url):
    headers = subprocess.run(
        ["curl", "-sI", "--http1.1", "-A", BROWSER_USER_AGENT, url], capture_output=True, text=True, check=True
    ).stdout
    content_length_lines = [line for line in headers.lower().splitlines() if line.startswith("content-length:")]
    return int(content_length_lines[-1].split(":")[1]) if content_length_lines else None


def write_json(file_name, content):
    OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIRECTORY / file_name).write_text(json.dumps(content, separators=(",", ":"), ensure_ascii=False))


if __name__ == "__main__":
    main()
