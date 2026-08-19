#!/usr/bin/env bash
set -Eeuo pipefail

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
headless_compose="$project_dir/infra/docker/compose.yml"
direct_compose="$project_dir/infra/docker/compose.direct.yml"
duration_minutes="${1:-120}"
duration_hours="$(awk -v minutes="$duration_minutes" 'BEGIN { printf "%.6f", minutes / 60 }')"

if ! [[ "$duration_minutes" =~ ^[1-9][0-9]*$ ]]; then
  echo "Használat: $0 [duration_minutes]" >&2
  exit 2
fi
for command in docker jq awk date; do
  command -v "$command" >/dev/null 2>&1 || { echo "Hiányzó parancs: $command" >&2; exit 1; }
done

pia_state="$(docker inspect --format '{{.State.Status}}' pia-gluetun 2>/dev/null || true)"
pia_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' pia-gluetun 2>/dev/null || true)"
if [[ "$pia_state" != "running" || ( "$pia_health" != "healthy" && "$pia_health" != "no-healthcheck" ) ]]; then
  echo "A pia-gluetun nem használható: state=$pia_state health=$pia_health" >&2
  exit 1
fi
docker image inspect oddsaggregator-headless:local >/dev/null 2>&1 || {
  echo "Hiányzik az oddsaggregator-headless:local image." >&2
  exit 1
}

headless_containers=(
  oddsaggregator-chrome
  oddsaggregator-tippmixpro
  oddsaggregator-sharpx
  oddsaggregator-vegas
)
direct_containers=(
  oddsaggregator-direct-sharpx
  oddsaggregator-direct-tippmixpro
  oddsaggregator-direct-vegas
  oddsaggregator-direct-aggregator
)
for container in "${headless_containers[@]}" "${direct_containers[@]}"; do
  if [[ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" == "true" ]]; then
    echo "Már fut a teszttel ütköző konténer: $container" >&2
    exit 1
  fi
done

run_id="$(date -u +%Y%m%d-%H%M%S)-$$"
run_dir="$project_dir/runtime/comparator/direct-headless/$run_id"
comparison_dir="$run_dir/comparison"
log_dir="$run_dir/logs"
manifest_file="$run_dir/run-manifest.json"
mkdir -p "$comparison_dir" "$log_dir"

headless_running=0
for container in "${headless_containers[@]}"; do
  if [[ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" == "true" ]]; then
    headless_running=$((headless_running + 1))
  fi
done
if (( headless_running > 0 && headless_running < ${#headless_containers[@]} )); then
  echo "A headless stack részlegesen fut; előbb állítsd konzisztens állapotba." >&2
  exit 1
fi

headless_started_by_run=0
direct_started_by_run=0
comparator_names=()
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
deadline_epoch=0
failure=""

write_manifest() {
  local status="$1"
  local comparator_text
  comparator_text="$(printf '%s\n' "${comparator_names[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))')"
  jq -n \
    --arg runId "$run_id" \
    --arg status "$status" \
    --arg failure "$failure" \
    --arg startedAt "$started_at" \
    --arg deadlineAt "$(if (( deadline_epoch > 0 )); then date -u -d "@$deadline_epoch" +%Y-%m-%dT%H:%M:%SZ; else echo null; fi)" \
    --arg durationMinutes "$duration_minutes" \
    --arg durationHours "$duration_hours" \
    --arg dataDir "$run_dir" \
    --arg comparisonDir "$comparison_dir" \
    --arg logDir "$log_dir" \
    --argjson headlessStartedByRun "$headless_started_by_run" \
    --argjson directStartedByRun "$direct_started_by_run" \
    --argjson comparators "$comparator_text" \
    '{schemaVersion:1,runId:$runId,status:$status,
      failure:(if $failure == "" then null else $failure end),
      startedAt:$startedAt,
      deadlineAt:(if $deadlineAt == "null" then null else $deadlineAt end),
      durationMinutes:($durationMinutes|tonumber),durationHours:($durationHours|tonumber),
      dataDir:$dataDir,comparisonDir:$comparisonDir,logDir:$logDir,
      headlessStartedByRun:$headlessStartedByRun,directStartedByRun:$directStartedByRun,
      comparators:$comparators}' > "$manifest_file.tmp"
  mv -f "$manifest_file.tmp" "$manifest_file"
}

capture_logs() {
  local name="$1"
  local container="$2"
  docker logs "$container" > "$log_dir/$name.log" 2>&1 || true
}

cleanup() {
  local rc="$?"
  set +e
  for container in "${comparator_names[@]}"; do
    capture_logs "${container#oddsaggregator-comparator-$run_id-}" "$container"
    docker rm -f "$container" >/dev/null 2>&1 || true
  done
  if (( direct_started_by_run == 1 )); then
    docker compose -f "$direct_compose" stop >/dev/null 2>&1 || true
  fi
  if (( headless_started_by_run == 1 )); then
    docker compose -f "$headless_compose" stop >/dev/null 2>&1 || true
  fi
  if (( rc != 0 )); then
    write_manifest "failed"
  fi
  trap - EXIT INT TERM
  exit "$rc"
}
trap cleanup EXIT INT TERM

wait_for_headless_health() {
  local timeout_seconds="$1"
  local started_epoch="$(date +%s)"
  while (( $(date +%s) - started_epoch < timeout_seconds )); do
    local all_healthy=1
    for container in "${headless_containers[@]}"; do
      local state health
      state="$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null || true)"
      health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$container" 2>/dev/null || true)"
      if [[ "$state" != "running" || ( "$health" != "healthy" && "$health" != "no-healthcheck" ) ]]; then
        all_healthy=0
        break
      fi
    done
    if (( all_healthy == 1 )); then return 0; fi
    sleep 5
  done
  return 1
}

wait_for_fresh_json() {
  local file="$1"
  local timeout_seconds="$2"
  local started_epoch="$(date +%s)"
  while (( $(date +%s) - started_epoch < timeout_seconds )); do
    if [[ -s "$file" ]]; then
      local generated_at now age_ms
      generated_at="$(jq -r '.generatedAt // 0' "$file" 2>/dev/null || echo 0)"
      now="$(date +%s%3N)"
      age_ms=$((now - generated_at))
      if (( generated_at > 0 && age_ms >= -5000 && age_ms <= 120000 )); then return 0; fi
    fi
    sleep 2
  done
  return 1
}

write_manifest "starting"
if (( headless_running == 0 )); then
  docker compose -f "$headless_compose" up -d
  headless_started_by_run=1
fi
write_manifest "headless-started"
wait_for_headless_health 240 || { failure="headless readiness timeout"; exit 1; }
for file in \
  "$project_dir/runtime/data/sharpx_status_snapshot.json" \
  "$project_dir/runtime/data/tippmixpro_odds_snapshot.json" \
  "$project_dir/runtime/data/vegas_odds_snapshot.json"; do
  wait_for_fresh_json "$file" 120 || { failure="headless output readiness timeout: $file"; exit 1; }
done

direct_duration_minutes=$((duration_minutes + 2))
ALLOW_PARALLEL_DIRECT=1 DIRECT_PRIMARY_MIN_COVERAGE_RATIO=0.90 \
  "$project_dir/infra/docker/start-direct.sh" "$direct_duration_minutes"
direct_started_by_run=1
write_manifest "direct-started"
for file in \
  "$project_dir/runtime/direct-primary/sharpx_raw_snapshot.json" \
  "$project_dir/runtime/direct-primary/tippmixpro_raw_snapshot.json" \
  "$project_dir/runtime/direct-primary/vegas_raw_snapshot.json"; do
  wait_for_fresh_json "$file" 120 || { failure="direct output readiness timeout: $file"; exit 1; }
done

start_comparator() {
  local name="$1"
  local script="$2"
  local normal_file="$3"
  local direct_file="$4"
  local provider="${5:-}"
  local host_output_dir="$run_dir/comparison/$name"
  local container_output_dir="/workspace/runtime/comparator/direct-headless/$run_id/comparison/$name"
  local container="oddsaggregator-comparator-$run_id-$name"
  mkdir -p "$host_output_dir"
  local comparator_args=(
    node "$script"
    --normal-file "$normal_file"
    --direct-file "$direct_file"
    --output-dir "$container_output_dir"
    --duration-hours "$duration_hours"
  )
  if [[ -n "$provider" ]]; then comparator_args+=(--provider "$provider"); fi
  docker run --detach --name "$container" --network "container:pia-gluetun" \
    --mount "type=bind,src=$project_dir,dst=/workspace" \
    --workdir /workspace oddsaggregator-headless:local "${comparator_args[@]}" >/dev/null
  comparator_names+=("$container")
}

start_comparator "sharpx" "src/sharpx_direct_shadow_comparator.js" \
  "/workspace/runtime/data/sharpx_status_snapshot.json" \
  "/workspace/runtime/direct-primary/sharpx_raw_snapshot.json"
start_comparator "vegas" "src/provider_direct_shadow_comparator.js" \
  "/workspace/runtime/data/vegas_odds_snapshot.json" \
  "/workspace/runtime/direct-primary/vegas_raw_snapshot.json" \
  "vegas"
start_comparator "tippmixpro" "src/provider_direct_shadow_comparator.js" \
  "/workspace/runtime/data/tippmixpro_odds_snapshot.json" \
  "/workspace/runtime/direct-primary/tippmixpro_raw_snapshot.json" \
  "tippmixpro"

deadline_epoch=$(( $(date +%s) + duration_minutes * 60 ))
write_manifest "running"
echo "Direct-headless comparator fut: $run_id"
echo "Kimenet: ${run_dir#"$project_dir/"}"
echo "Deadline: $(date -u -d "@$deadline_epoch" +%Y-%m-%dT%H:%M:%SZ)"

while (( $(date +%s) < deadline_epoch )); do
  for container in "${comparator_names[@]}"; do
    if [[ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" != "true" ]]; then
      failure="comparator stopped before deadline: $container"
      exit 1
    fi
  done
  for container in "${direct_containers[@]}"; do
    if [[ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" != "true" ]]; then
      failure="direct collector stopped before deadline: $container"
      exit 1
    fi
  done
  sleep 30
done

grace_deadline=$(( $(date +%s) + 90 ))
while (( $(date +%s) < grace_deadline )); do
  all_stopped=1
  for container in "${comparator_names[@]}"; do
    if [[ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" == "true" ]]; then
      all_stopped=0
      break
    fi
  done
  if (( all_stopped == 1 )); then break; fi
  sleep 5
done

for container in "${comparator_names[@]}"; do
  exit_status="$(docker inspect --format '{{.State.ExitCode}}' "$container" 2>/dev/null || echo 1)"
  if [[ "$exit_status" != "0" ]]; then
    failure="comparator exit=$exit_status: $container"
    exit 1
  fi
done

write_manifest "completed"
exit 0
