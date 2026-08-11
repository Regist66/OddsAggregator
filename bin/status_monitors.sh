#!/usr/bin/env bash
set -euo pipefail

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
compose_file="$project_dir/infra/docker/compose.yml"
data_dir="$project_dir/runtime/data"
max_age_seconds=10
overall_status=0

printf '%s\n' "Docker konténerek:"
if command -v docker >/dev/null 2>&1; then
  docker compose -f "$compose_file" ps || overall_status=1
else
  echo "MISSING  docker parancs"
  overall_status=1
fi

printf '\n%s\n' "Kimenetek életkora (max ${max_age_seconds}s):"
for file in \
  "$data_dir/tippmixpro_odds_snapshot.json" \
  "$data_dir/vegas_odds_snapshot.json" \
  "$data_dir/sharpx_status_snapshot.json" \
  "$data_dir/combined_odds.txt" \
  "$data_dir/football/surebets_live_odds.txt"; do
  display_name="${file#"$project_dir/"}"
  if [[ ! -f "$file" ]]; then
    printf '%-7s %s\n' "MISSING" "$display_name"
    overall_status=1
    continue
  fi

  age_seconds=$(( $(date +%s) - $(stat -c %Y "$file") ))
  if (( age_seconds < 0 )); then
    state="FUTURE"
    overall_status=1
  elif (( age_seconds <= max_age_seconds )); then
    state="OK"
  else
    state="STALE"
    overall_status=1
  fi
  printf '%-7s age=%4ss %s\n' "$state" "$age_seconds" "$display_name"
done

printf '\n%s\n' "JSON health mezők:"
if command -v jq >/dev/null 2>&1; then
  for file in \
    "$data_dir/vegas_odds_snapshot.json" \
    "$data_dir/tippmixpro_odds_snapshot.json" \
    "$data_dir/sharpx_status_snapshot.json"; do
    display_name="${file#"$project_dir/"}"
    if [[ -f "$file" ]]; then
      jq -r --arg name "$display_name" '
        [$name,
         (.generatedAt // "-"),
         (.connected // "-"),
         (.lastError // "null"),
         (.snapshotConsistency.consistent // "-")]
        | @tsv
      ' "$file" 2>/dev/null || {
        printf '%s\t%s\n' "$display_name" "INVALID_JSON"
        overall_status=1
      }
    fi
  done
else
  echo "jq nincs telepítve; a JSON mezők kihagyva."
fi

exit "$overall_status"
