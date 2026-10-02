#!/usr/bin/env bash
# Checks, fast-forwards main to the current branch, pushes (which triggers the GitHub Pages deploy), waits for the
# deploy, then confirms every built page answers 200 on the live site.
set -euo pipefail

SITE_URL="https://arthurthiele.com"
RUN_APPEAR_TIMEOUT_SECONDS=60

cd "$(dirname "$0")/.."

uncommitted_changes=$(git status --porcelain)
if [[ -n "$uncommitted_changes" ]]; then
  echo "Not deployed (uncommitted, staying local):"
  echo "$uncommitted_changes" | sed 's/^/  /'
  echo
fi

run_quietly() {
  local step_output
  if ! step_output=$("$@" 2>&1); then
    echo "$step_output"
    echo "Failed: $*" >&2
    exit 1
  fi
}

echo "== Typecheck, tests, build"
run_quietly yarn -s typecheck
run_quietly yarn -s test
run_quietly yarn -s build

current_branch=$(git rev-parse --abbrev-ref HEAD)
git fetch -q origin main
if [[ "$current_branch" != "main" ]]; then
  echo "== Fast-forwarding main to $current_branch"
  git checkout -q main
  git merge --ff-only -q origin/main
  git merge --ff-only -q "$current_branch"
fi

deployed_commit=$(git rev-parse HEAD)
if [[ "$deployed_commit" == "$(git rev-parse origin/main)" ]]; then
  echo "main is already at origin/main ($(git log --oneline -1)); nothing to deploy."
  exit 0
fi

echo "== Pushing $(git log --oneline -1)"
git push -q origin main

echo "== Waiting for the deploy run"
run_id=""
for _ in $(seq "$RUN_APPEAR_TIMEOUT_SECONDS"); do
  run_id=$(gh run list --branch main --commit "$deployed_commit" --limit 1 --json databaseId -q '.[0].databaseId // empty')
  [[ -n "$run_id" ]] && break
  sleep 1
done
if [[ -z "$run_id" ]]; then
  echo "No GitHub Actions run appeared for $deployed_commit within ${RUN_APPEAR_TIMEOUT_SECONDS}s." >&2
  exit 1
fi
gh run watch "$run_id" --exit-status --interval 10 > /dev/null

echo "== Smoke-testing every built page on $SITE_URL"
failed_pages=0
while IFS= read -r built_page; do
  page_url="$SITE_URL/${built_page#dist/}"
  page_url="${page_url%index.html}"
  status=$(curl -s -o /dev/null -w '%{http_code}' "$page_url")
  echo "  $status $page_url"
  [[ "$status" == "200" ]] || failed_pages=$((failed_pages + 1))
done < <(find dist -name index.html | sort)

if [[ "$failed_pages" -gt 0 ]]; then
  echo "$failed_pages page(s) did not return 200." >&2
  exit 1
fi
echo "Deployed $(git log --oneline -1)."
