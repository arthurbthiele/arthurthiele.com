# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Builds the Lichess blitz rating distribution dataset. (Other time controls work the same way; the site only
shows blitz, the one most people mean by "my chess rating".)

Each `/stat/rating/distribution/<perf>` page embeds a 97-element histogram as JSON in a
`<script id="page-init-data">` tag: `{"freq": [...], "myRating": null, "otherRating": null,
"otherPlayer": null}` when viewed logged out. `freq[i]` is the number of players whose rating,
floored to the nearest 25, equals `RATING_DISTRIBUTION_MIN_RATING + i * RATING_DISTRIBUTION_GROUP_WIDTH`
— i.e. bin i covers the half-open rating interval [min + 25*i, min + 25*(i+1)). Confirmed against
lichess-org/lila:
  - modules/perfStat/src/main/PerfStatApi.scala (`weeklyRatingDistribution.compute`): buckets by
    `rating - (rating mod percentileOf.group)`, ranging `minRating.value to 2800 by percentileOf.group`.
  - modules/perfStat/src/main/package.scala: `percentileOf.group = 25`.
  - modules/rating/src/main/Glicko.scala: `minRating: IntRating = IntRating(400)`. (The inline
    comment "// from 600 to 2800 by Stat.group" above `compute` is stale — the live constant is 400,
    confirmed by freq always having exactly 97 elements: (2800 - 400) / 25 + 1 = 97.)

Population: a player is counted here if they have a ranking document for that perf, which
RankingApi.save() writes whenever they finish a rated game, gated on `perf.nb >= 2` (at least two
rated games played) and the perf being in `PerfType.leaderboardable`. That document TTLs out after
`expiresAt = now + 7 days`, refreshed on every qualifying game — so "players this week" means
played at least 2 rated games of that time control, with at least one in the last 7 days. The
distribution query itself (`Match(bdoc("perf" -> perfId))`) does *not* filter on the `stable`
(established/non-provisional) flag, unlike the separate leaderboard query — so provisional ratings
are included here, despite the per-profile percentile feature only firing once a player's own
rating is established.

Correspondence has no distribution page (`/stat/rating/distribution/correspondence` 404s): per
modules/rating/src/main/PerfType.scala, `correspondence` is in `PerfType.standard` but missing
from `PerfType.leaderboardable`, which is the list `ratingDistribution` requires
(`Found(perfKey.some.filter(lila.rating.PerfType.isLeaderboardable))` in app/controllers/User.scala).
So there is no "correspondence" variant in the output — inventing one would violate the brief.

Each page also states the exact weekly player count in prose (e.g. "700,358 Blitz players this
week."), which we assert against `sum(freq)` as a sanity check.
"""

import json
import re
import subprocess
from pathlib import Path

SCRIPT_DIRECTORY = Path(__file__).parent
CACHE_DIRECTORY = SCRIPT_DIRECTORY / ".cache"
OUTPUT_DIRECTORY = SCRIPT_DIRECTORY.parent.parent / "src" / "tools" / "percentileConverter" / "data"

LICHESS_DISTRIBUTION_URL_TEMPLATE = "https://lichess.org/stat/rating/distribution/{perf}"

# lichess-org/lila modules/rating/src/main/Glicko.scala: `val minRating: IntRating = IntRating(400)`
RATING_DISTRIBUTION_MIN_RATING = 400
# lichess-org/lila modules/perfStat/src/main/package.scala: `object percentileOf: val group = 25`
RATING_DISTRIBUTION_GROUP_WIDTH = 25

# id -> (lila PerfKey, display label, prose noun used in "<N> <noun> players this week")
TIME_CONTROLS = {
    "blitz": ("blitz", "Lichess blitz rating", "Blitz")
}

BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
DOWNLOAD_ATTEMPTS = 5

PAGE_INIT_DATA_PATTERN = re.compile(r'page-init-data">(.*?)</script>', re.S)


def main():
    variants = {}
    for variant_id, (perf, label, prose_noun) in TIME_CONTROLS.items():
        url = LICHESS_DISTRIBUTION_URL_TEMPLATE.format(perf=perf)
        html = download_cached(url, f"lichess_{perf}.html").read_text()
        freq = parse_freq(html)
        assert_matches_stated_player_count(html, freq, prose_noun)
        variants[variant_id] = {"label": label, "population": sum(freq), "cdf": build_cdf(freq)}
        print(f"{perf}: {len(freq)} bins, {sum(freq)} weekly players")

    output = {
        "source": {
            "name": "Lichess weekly rating distribution by time control (active players per time control, last 7 days)",
            "url": LICHESS_DISTRIBUTION_URL_TEMPLATE.format(perf="blitz"),
            "licence": "Lichess source is AGPL-3.0; bulk data exports are CC0 (database.lichess.org), "
                       "but this live stats page is not itself one of the published CC0 exports — attributed informationally"
        },
        "variants": variants
    }
    write_json("lichessRating.json", output)


def parse_freq(html):
    match = PAGE_INIT_DATA_PATTERN.search(html)
    if match is None:
        raise RuntimeError("page-init-data script tag not found")
    return json.loads(match.group(1))["freq"]


def assert_matches_stated_player_count(html, freq, prose_noun):
    match = re.search(rf"([\d,]+)</strong> {prose_noun} players this week", html)
    if match is None:
        raise RuntimeError(f"could not find the '{prose_noun} players this week' sentence to cross-check against")
    stated_total = int(match.group(1).replace(",", ""))
    if stated_total != sum(freq):
        raise RuntimeError(f"sum(freq)={sum(freq)} does not match page text total {stated_total}")


CDF_FRACTION_DECIMAL_PLACES = 6


def build_cdf(freq):
    """Builds strictly-increasing (value, cumulativeFraction) points from a binned histogram.

    Leading/trailing all-zero bins are dropped down to a single zero point at the bottom edge, per
    the brief. A handful of *internal* bins can also be zero (e.g. classical, the lowest-volume
    time control, has 8 such bins near its top) — those would otherwise repeat the previous
    cumulative fraction and break strict monotonicity, so a zero bin is folded into the following
    run: no point is emitted until the cumulative count changes, which simply widens the segment
    to the next bin edge that actually has players in it.
    """
    edges = [RATING_DISTRIBUTION_MIN_RATING + i * RATING_DISTRIBUTION_GROUP_WIDTH for i in range(len(freq) + 1)]
    first_nonzero_bin = next(i for i, count in enumerate(freq) if count > 0)
    last_nonzero_bin = len(freq) - 1 - next(i for i, count in enumerate(reversed(freq)) if count > 0)
    total = sum(freq)

    points = [[edges[first_nonzero_bin], 0.0]]
    cumulative = 0
    last_emitted_cumulative = 0
    for bin_index in range(first_nonzero_bin, last_nonzero_bin + 1):
        cumulative += freq[bin_index]
        if cumulative == last_emitted_cumulative:
            continue
        points.append([edges[bin_index + 1], round(cumulative / total, CDF_FRACTION_DECIMAL_PLACES)])
        last_emitted_cumulative = cumulative
    assert_strictly_increasing(points)
    return points


def assert_strictly_increasing(points):
    for (previous_value, previous_fraction), (value, fraction) in zip(points, points[1:]):
        if value <= previous_value or fraction <= previous_fraction:
            raise RuntimeError(f"cdf is not strictly increasing at {(value, fraction)}")


def download_cached(url, file_name):
    cached_path = CACHE_DIRECTORY / file_name
    if cached_path.exists():
        return cached_path
    CACHE_DIRECTORY.mkdir(parents=True, exist_ok=True)
    for _ in range(DOWNLOAD_ATTEMPTS):
        subprocess.run(
            ["curl", "-s", "--http1.1", "-A", BROWSER_USER_AGENT, "-o", str(cached_path), url], check=True
        )
        if b"page-init-data" in cached_path.read_bytes():
            return cached_path
    cached_path.unlink()
    raise RuntimeError(f"Got a page without page-init-data from {url}")


def write_json(file_name, content):
    OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIRECTORY / file_name).write_text(json.dumps(content, separators=(",", ":"), ensure_ascii=False))


if __name__ == "__main__":
    main()
