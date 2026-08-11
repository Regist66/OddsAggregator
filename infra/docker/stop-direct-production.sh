#!/usr/bin/env bash
set -euo pipefail

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
compose_file="$project_dir/infra/docker/compose.direct-production.yml"
data_dir="$project_dir/runtime/direct-production"
state_file="$data_dir/run-manifest.json"
source "$project_dir/infra/docker/direct-production-state.sh"

write_direct_production_state "$state_file" "$compose_file" "$project_dir" "$data_dir" "stopping"
if ! docker compose -f "$compose_file" down --remove-orphans; then
  write_direct_production_state "$state_file" "$compose_file" "$project_dir" "$data_dir" "stop-failed"
  exit 1
fi
write_direct_production_state "$state_file" "$compose_file" "$project_dir" "$data_dir" "stopped"
