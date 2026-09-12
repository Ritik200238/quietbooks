#!/bin/bash
# Bring up the local network and run the end-to-end suite in one session.
#
# SPDX-License-Identifier: Apache-2.0
#
# This exists as a script rather than a sequence of commands because WSL shuts
# a distro down once no session is attached to it, which takes the Docker daemon
# and every container with it. Running the whole sequence inside one invocation
# keeps the distro alive for the duration.
#
# Usage, from inside WSL or any Linux host with Docker:
#   ./run-e2e.sh

set -u

export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
REPO_ROOT="${QB_REPO_ROOT:-/mnt/c/Users/ritik/midnight/quietbooks}"
export QB_ZK="${QB_ZK:-$REPO_ROOT/contract/build}"
RUNNER="${QB_RUNNER:-$REPO_ROOT/e2e}"

if ! pgrep dockerd >/dev/null 2>&1; then
  echo "starting the Docker daemon"
  nohup dockerd >/var/log/dockerd.log 2>&1 &
  sleep 15
fi

cd "$REPO_ROOT/localnet" || exit 1
echo "bringing up the local Midnight network"
docker compose -f standalone.yml up -d >/dev/null 2>&1

echo "waiting for node, indexer and proof server to report healthy"
for _ in $(seq 1 60); do
  healthy=$(docker ps --format '{{.Status}}' | grep -c healthy)
  [ "$healthy" -ge 3 ] && break
  sleep 5
done
docker ps --format '{{.Names}}  {{.Status}}'

echo
echo "=== end-to-end ==="
cd "$RUNNER" || exit 1
node dist/run.js
echo "E2E_EXIT=$?"
