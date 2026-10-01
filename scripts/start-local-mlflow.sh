#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="${PI_EPICS_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/pi-epics-agent}"
MLFLOW_DIR="$STATE_DIR/mlflow"
MLFLOW_BIN="${MLFLOW_BIN:-$HOME/.local/bin/mlflow}"
PORT="${PI_EPICS_MLFLOW_PORT:-5000}"
URI="http://127.0.0.1:$PORT"

mkdir -p "$MLFLOW_DIR/artifacts"

if ! curl -fsS --max-time 2 "$URI/health" >/dev/null 2>&1; then
  nohup "$MLFLOW_BIN" server \
    --host 127.0.0.1 \
    --port "$PORT" \
    --backend-store-uri "sqlite:///$MLFLOW_DIR/mlflow.db" \
    --serve-artifacts \
    --artifacts-destination "file://$MLFLOW_DIR/artifacts" \
    >"$MLFLOW_DIR/server.log" 2>&1 &
  echo $! >"$MLFLOW_DIR/server.pid"
fi

for _ in $(seq 1 90); do
  if curl -fsS --max-time 2 "$URI/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS --max-time 2 "$URI/health" >/dev/null

experiment="$(curl -fsS --get "$URI/api/2.0/mlflow/experiments/get-by-name" \
  --data-urlencode 'experiment_name=pi-epics-agent' 2>/dev/null || true)"
if [[ -z "$experiment" ]]; then
  experiment="$(curl -fsS -X POST "$URI/api/2.0/mlflow/experiments/create" \
    -H 'content-type: application/json' \
    -d '{"name":"pi-epics-agent"}')"
fi
experiment_id="$(printf '%s' "$experiment" | python3 -c 'import json,sys; data=json.load(sys.stdin); print(data.get("experiment", data)["experiment_id"])')"
printf '%s\n' "$experiment_id" >"$MLFLOW_DIR/experiment-id"
printf 'MLflow is ready at %s (experiment %s)\n' "$URI" "$experiment_id"
