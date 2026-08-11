#!/usr/bin/env bash
set -euo pipefail

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
compose_file="$project_dir/infra/docker/compose.direct.yml"
duration_minutes="${1:-0}"

if ! [[ "$duration_minutes" =~ ^[0-9]+$ ]]; then
  echo "Használat: $0 [duration_minutes]" >&2
  exit 2
fi

if ! docker inspect pia-gluetun >/dev/null 2>&1; then
  echo "A pia-gluetun konténer nem található." >&2
  exit 1
fi

if [[ "${ALLOW_PARALLEL_DIRECT:-0}" != "1" ]]; then
  production_containers=(
    oddsaggregator-chrome
    oddsaggregator-tippmixpro
    oddsaggregator-sharpx
    oddsaggregator-vegas
  )
  for container in "${production_containers[@]}"; do
    if [[ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" == "true" ]]; then
      echo "A production headless stack fut: $container" >&2
      echo "A direct smoke ugyanazt a pia-gluetun network namespace-t használná." >&2
      echo "Állítsd le előbb a production stacket, vagy tudatosan használd: ALLOW_PARALLEL_DIRECT=1 $0 ..." >&2
      exit 1
    fi
  done
fi

state="$(docker inspect --format '{{.State.Status}}' pia-gluetun)"
health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' pia-gluetun)"
if [[ "$state" != "running" || ( "$health" != "healthy" && "$health" != "no-healthcheck" ) ]]; then
  echo "A pia-gluetun nem használható: state=$state health=$health" >&2
  exit 1
fi

if (( duration_minutes == 0 )); then
  duration_hours="0"
else
  duration_hours="$(awk -v minutes="$duration_minutes" 'BEGIN { printf "%.6f", minutes / 60 }')"
fi

mkdir -p "$project_dir/runtime/direct-primary"
echo "Direct primary indítása: ${duration_minutes:-0} perc"
if ! docker image inspect oddsaggregator-headless:local >/dev/null 2>&1; then
  echo "Hiányzik az oddsaggregator-headless:local image. Előbb indítsd vagy építsd a headless Compose stacket." >&2
  exit 1
fi
DIRECT_DURATION_HOURS="$duration_hours" docker compose -f "$compose_file" up -d
docker compose -f "$compose_file" ps
