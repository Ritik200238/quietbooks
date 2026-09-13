#!/bin/bash
# Compile a generated contract with N entry points and try to deploy it.
#
# SPDX-License-Identifier: Apache-2.0
#
#   ./run-probe.sh <N>
set -u
N="$1"
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE" || exit 1

node gen.mjs "$N" >/dev/null
rm -rf "build-$N"
compact compile "probe.compact" "build-$N" >/dev/null 2>&1 || { echo "N=$N COMPILE_FAILED"; exit 2; }
KEYS=$(cat "build-$N"/keys/*.verifier | wc -c)
cd "$HERE/.." || exit 1
OUT=$(node dist/probe.js "$HERE/build-$N" "n$N" 2>&1)
COST=$(echo "$OUT" | grep -o "transaction cost: .*" | tail -1)
RESULT=$(echo "$OUT" | grep -o "PROBE .* \(DEPLOYED\|REJECTED.*\)" | tail -1)
echo "N=$N verifierKeyBytes=$KEYS"
echo "  $COST"
echo "  $RESULT"
