#!/usr/bin/env bash
set -euo pipefail

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
compose_file="$project_dir/infra/docker/compose.direct-production.yml"
data_dir="$project_dir/runtime/direct-production"
state_file="$data_dir/run-manifest.json"
source "$project_dir/infra/docker/direct-production-state.sh"

docker compose -f "$compose_file" ps

echo
echo "Container állapotok:"
observed_state="running"
for container in \
  oddsaggregator-direct-prod-sharpx \
  oddsaggregator-direct-prod-tippmixpro \
  oddsaggregator-direct-prod-vegas \
  oddsaggregator-direct-prod-aggregator; do
  container_state="$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null || printf '%s' 'missing')"
  if [[ "$container_state" != "running" ]]; then
    observed_state="degraded"
  fi
  docker inspect --format '{{.Name}}: {{.State.Status}}{{if .State.Health}} health={{.State.Health.Status}}{{end}}' "$container" 2>/dev/null || echo "$container: hiányzik"
done

write_direct_production_state "$state_file" "$compose_file" "$project_dir" "$data_dir" "$observed_state"
echo
echo "Run-manifest: ${state_file#"$project_dir/"} (state=$observed_state)"

echo
echo "Kimenetek életkora:"
for file in \
  "$data_dir/sharpx_raw_snapshot.json" \
  "$data_dir/tippmixpro_raw_snapshot.json" \
  "$data_dir/vegas_raw_snapshot.json" \
  "$data_dir/direct_primary_health.json" \
  "$data_dir/combined_odds.txt" \
  "$data_dir/football/surebets_live_odds.txt"; do
  if [[ -f "$file" ]]; then
    age_seconds=$(( $(date +%s) - $(stat -c %Y "$file") ))
    printf '%4ss  %s\n' "$age_seconds" "${file#"$project_dir/"}"
  else
    echo "MISSING  ${file#"$project_dir/"}"
  fi
done

echo
echo "Utolsó aggregátor health:"
if [[ -f "$data_dir/direct_primary_health.json" ]]; then
  sed -n '1,160p' "$data_dir/direct_primary_health.json"
else
  echo "Még nincs health snapshot."
fi
