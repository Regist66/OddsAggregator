#!/usr/bin/env bash
set -euo pipefail

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
compose_file="$project_dir/infra/docker/compose.yml"

if ! docker inspect pia-gluetun >/dev/null 2>&1; then
  echo "A pia-gluetun konténer nem található." >&2
  exit 1
fi

state="$(docker inspect --format '{{.State.Status}}' pia-gluetun)"
health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' pia-gluetun)"
if [ "$state" != "running" ] || { [ "$health" != "healthy" ] && [ "$health" != "no-healthcheck" ]; }; then
  echo "A pia-gluetun nem használható: state=$state health=$health" >&2
  exit 1
fi

exec docker compose -f "$compose_file" up -d --build
