#!/usr/bin/env bash

# A direct-production lifecycle scriptek által közösen használt állapotíró.
# A run-manifest runtime-artifact, ezért minden lifecycle művelet atomikusan
# frissíti, és a Compose pillanatnyi service állapotát is beleírja.

write_direct_production_state() {
  local state_file="$1"
  local compose_file="$2"
  local project_dir="$3"
  local data_dir="$4"
  local state="$5"
  local compose_output
  local compose_state
  local timestamp
  local temporary_file

  compose_output="$(docker compose -f "$compose_file" ps --format json 2>/dev/null || true)"
  if [[ -z "$compose_output" || "$compose_output" == "[]" ]]; then
    compose_state='[]'
  else
    # Compose v5 JSON formátuma futó service-enként egy JSON objektumot ír
    # külön sorba; a manifestben ezt érvényes JSON tömbbé normalizáljuk.
    compose_state="$(printf '%s\n' "$compose_output" | awk 'BEGIN { printf "[" } { if (NR > 1) printf ","; printf "%s", $0 } END { print "]" }')"
  fi
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  temporary_file="${state_file}.tmp.$$"

  mkdir -p "$(dirname -- "$state_file")"
  printf '{\n  "profile": "direct-production",\n  "mode": "passive-canary",\n  "state": "%s",\n  "updatedAt": "%s",\n  "composeFile": "%s",\n  "outputDirectory": "%s",\n  "services": %s\n}\n' \
    "$state" \
    "$timestamp" \
    "${compose_file#"$project_dir/"}" \
    "${data_dir#"$project_dir/"}" \
    "$compose_state" > "$temporary_file"
  mv -f -- "$temporary_file" "$state_file"
}
