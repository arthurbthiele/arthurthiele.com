# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Builds the superannuation balance dataset from ASFA, "An update on superannuation account balances" (October 2025),
Tables 3 and 4: balance percentiles by sex and age at June 2023, which ASFA derived from the ATO's 2% sample file.

Transcribed by hand from the PDF (https://www.superannuation.asn.au/wp-content/uploads/2025/12/Account-Balances-Paper_v3-5.pdf).
Each row gives P10, P25, P50, P75 and P90. Between those we interpolate linearly, and below P10 linearly down from
$0. Above P90 the table says nothing, so we extend each row with a lognormal fitted through P75 and P90:
σ = (ln P90 − ln P75) / (z90 − z75), μ = ln P90 − z90·σ, evaluated at a few upper percentiles. The tool flags anything
beyond the last of those as past the data. Where several percentiles are $0 (people over 60 who have drawn their
super down), the CDF jumps at zero, so $0 keeps the highest of them.

ASFA's Table 5 (members by age and sex) has rows duplicated by mistake and different age bands, so no population is
recorded and these datasets carry no rank.
"""

import json
import math
from pathlib import Path
from statistics import NormalDist

OUTPUT_DIRECTORY = Path(__file__).parent.parent.parent / "src" / "tools" / "percentileConverter" / "data"
ASFA_URL = "https://www.superannuation.asn.au/wp-content/uploads/2025/12/Account-Balances-Paper_v3-5.pdf"

TABLE_PERCENTILES = [0.10, 0.25, 0.50, 0.75, 0.90]
EXTENDED_TAIL_PERCENTILES = [0.95, 0.98, 0.99]

# Age band → (P10, P25, P50, P75, P90), dollars at June 2023.
MALE_BALANCES = {
    "Under 20": (0, 16, 831, 2_726, 5_269),
    "20–24": (625, 3_059, 7_746, 14_483, 22_816),
    "25–29": (997, 7_114, 19_078, 36_921, 57_995),
    "30–34": (1_831, 13_615, 41_943, 78_098, 117_787),
    "35–39": (4_256, 25_340, 76_396, 136_656, 206_958),
    "40–44": (7_355, 41_032, 111_495, 197_453, 305_064),
    "45–49": (8_899, 55_987, 146_770, 269_148, 426_783),
    "50–54": (11_147, 71_545, 184_603, 353_799, 583_059),
    "55–59": (11_460, 82_057, 213_531, 427_627, 762_968),
    "60–64": (522, 60_172, 221_401, 504_347, 993_785),
    "65–69": (0, 13_520, 192_301, 534_533, 1_111_841),
    "70–74": (0, 0, 85_812, 485_953, 1_226_845)
}
FEMALE_BALANCES = {
    "Under 20": (0, 0, 651, 2_163, 4_307),
    "20–24": (733, 3_097, 7_401, 13_565, 20_770),
    "25–29": (862, 6_548, 18_923, 35_096, 52_131),
    "30–34": (1_477, 10_515, 35_193, 67_459, 99_587),
    "35–39": (2_133, 16_032, 55_953, 108_471, 164_874),
    "40–44": (3_658, 22_636, 77_859, 153_037, 243_589),
    "45–49": (5_646, 34_250, 103_641, 200_564, 332_432),
    "50–54": (7_773, 44_269, 123_096, 251_476, 432_454),
    "55–59": (9_058, 54_486, 145_682, 306_986, 576_249),
    "60–64": (721, 49_199, 164_502, 388_596, 769_800),
    "65–69": (0, 18_449, 159_516, 467_005, 960_606),
    "70 and over": (0, 0, 56_072, 419_019, 1_090_274)
}


def main():
    variants = {}
    for sex, table in (("male", MALE_BALANCES), ("female", FEMALE_BALANCES)):
        for age_band, balances in table.items():
            variants[f"{sex}|{age_band}"] = {"cdf": build_cdf(balances)}
    output = {
        "source": {
            "name": "ASFA, 'An update on superannuation account balances' (Oct 2025), Tables 3–4, from the ATO 2% sample (June 2023)",
            "url": ASFA_URL,
            "licence": "Figures cited from ASFA's research paper"
        },
        "variants": variants
    }
    (OUTPUT_DIRECTORY / "superannuation.json").write_text(json.dumps(output, separators=(",", ":"), ensure_ascii=False))
    for key in ("male|30–34", "female|60–64", "male|70–74"):
        print(key, variants[key]["cdf"])


def build_cdf(balances):
    points = [(0.0, 0.0)] + list(zip(TABLE_PERCENTILES, balances)) + upper_tail(balances)
    fraction_by_value = {}
    for fraction, value in points:
        fraction_by_value[value] = max(fraction, fraction_by_value.get(value, 0.0))
    return [[value, round(fraction, 6)] for value, fraction in sorted(fraction_by_value.items())]


def upper_tail(balances):
    standard_normal = NormalDist()
    p75, p90 = balances[3], balances[4]
    z75, z90 = standard_normal.inv_cdf(0.75), standard_normal.inv_cdf(0.90)
    log_standard_deviation = (math.log(p90) - math.log(p75)) / (z90 - z75)
    log_mean = math.log(p90) - z90 * log_standard_deviation
    return [
        (fraction, round(math.exp(log_mean + standard_normal.inv_cdf(fraction) * log_standard_deviation)))
        for fraction in EXTENDED_TAIL_PERCENTILES
    ]


if __name__ == "__main__":
    main()
