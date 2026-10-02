# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Builds the typing speed dataset from Dhakal, Feit, Kristensson & Oulasvirta (2018), "Observations on Typing from
136 Million Keystrokes", CHI '18. 168,000 volunteers transcribed 15 sentences each in an online test.

The paper reports (Table 3 and text) mean 51.56 WPM, SD 20.20, skewness 0.513, so the distribution leans right: a
normal curve would understate fast typists. We fit a shifted lognormal, X = shift + exp(N(μ, σ)), whose first three
moments match. For the exp(N(μ, σ)) part, with w = exp(σ²):
  skewness = (w + 2)·√(w − 1)      → solve for w, so σ = √(ln w)
  variance = exp(2μ)·w·(w − 1)     → exp(μ) = SD / √(w·(w − 1))
  mean     = exp(μ)·√w             → shift = 51.56 − exp(μ)·√w
"""

import json
import math
from pathlib import Path

OUTPUT_DIRECTORY = Path(__file__).parent.parent.parent / "src" / "tools" / "percentileConverter" / "data"
PAPER_URL = "https://userinterfaces.aalto.fi/136Mkeystrokes/resources/chi-18-analysis.pdf"

MEAN_WPM = 51.56
STANDARD_DEVIATION_WPM = 20.20
SKEWNESS = 0.513
PARTICIPANT_COUNT = 168_000


def main():
    exp_sigma_squared = solve_for_exp_sigma_squared(SKEWNESS)
    log_standard_deviation = math.sqrt(math.log(exp_sigma_squared))
    scale = STANDARD_DEVIATION_WPM / math.sqrt(exp_sigma_squared * (exp_sigma_squared - 1))
    shift = MEAN_WPM - scale * math.sqrt(exp_sigma_squared)
    output = {
        "source": {
            "name": "Dhakal et al., 'Observations on Typing from 136 Million Keystrokes', CHI 2018",
            "url": PAPER_URL,
            "licence": "Figures cited from the paper"
        },
        "variants": {
            "all": {
                "logMean": round(math.log(scale), 5),
                "logStandardDeviation": round(log_standard_deviation, 5),
                "shift": round(shift, 3),
                "population": PARTICIPANT_COUNT
            }
        }
    }
    (OUTPUT_DIRECTORY / "typingSpeed.json").write_text(json.dumps(output, separators=(",", ":")))
    print(output["variants"]["all"])


def solve_for_exp_sigma_squared(skewness):
    """Skewness rises monotonically with w above 1, so bisection finds the unique solution."""
    lower, upper = 1.0, 2.0
    for _ in range(200):
        middle = (lower + upper) / 2
        if (middle + 2) * math.sqrt(middle - 1) < skewness:
            lower = middle
            continue
        upper = middle
    return upper


if __name__ == "__main__":
    main()
