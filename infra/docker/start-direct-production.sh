#!/usr/bin/env bash
set -euo pipefail

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
compose_file="$project_dir/infra/docker/compose.direct-production.yml"
data_dir="$project_dir/runtime/direct-production"
state_file="$data_dir/run-manifest.json"
source "$project_dir/infra/docker/direct-production-state.sh"

if (( $# != 0 )); then
  echo "Használat: $0" >&2
  echo "A direct-production profile folyamatosan fut; duration-paraméter nincs." >&2
  exit 2
fi

if ! docker inspect pia-gluetun >/dev/null 2>&1; then
  echo "A pia-gluetun konténer nem található." >&2
  exit 1
fi

state="$(docker inspect --format '{{.State.Status}}' pia-gluetun)"
health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' pia-gluetun)"
if [[ "$state" != "running" || ( "$health" != "healthy" && "$health" != "no-healthcheck" ) ]]; then
  echo "A pia-gluetun nem használható: state=$state health=$health" >&2
  exit 1
fi

if ! docker image inspect oddsaggregator-headless:local >/dev/null 2>&1; then
  echo "Hiányzik az oddsaggregator-headless:local image. Előbb építsd fel a headless image-et." >&2
  exit 1
fi

mkdir -p "$data_dir"
write_direct_production_state "$state_file" "$compose_file" "$project_dir" "$data_dir" "starting"
echo "Direct production canary indítása (folyamatos, passzív output)."
echo "Kimenet: ${data_dir#"$project_dir/"}"

# Ez a profile szándékosan futhat a headless production stack mellett:
# nincs közös output writer és nincs ALLOW_PARALLEL_DIRECT tesztkapcsoló.
if ! docker compose -f "$compose_file" up -d; then
  write_direct_production_state "$state_file" "$compose_file" "$project_dir" "$data_dir" "start-failed"
  exit 1
fi
write_direct_production_state "$state_file" "$compose_file" "$project_dir" "$data_dir" "running"
docker compose -f "$compose_file" ps
