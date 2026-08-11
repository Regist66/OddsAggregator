#!/usr/bin/env bash
set -euo pipefail

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
compose_file="$project_dir/infra/docker/compose.direct.yml"

docker compose -f "$compose_file" down --remove-orphans

