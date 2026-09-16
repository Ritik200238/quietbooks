#!/usr/bin/env bash
# Build the web interface on Vercel, from a clean checkout.
#
# SPDX-License-Identifier: Apache-2.0
#
# The proving keys are not in git -- `contract/build/keys` alone is well over a
# hundred megabytes -- so a deployment cannot just bundle the interface. It has
# to compile the contract first, exactly as CI does, with the same pinned
# toolchain. `compact update` with no argument installs the latest compiler,
# whose language version has moved past the 0.23 this contract declares, so the
# version is stated here rather than inherited.
#
# The interface fetches `/keys/<circuit>.prover` and `/zkir/<circuit>.bzkir`
# from its own origin, and `vite.config.ts` copies both beside the bundle. A
# build that skipped the compile would still produce a page that loads, and
# every proof it tried to build would fail -- so this stops rather than
# continuing without them.

set -euo pipefail

COMPACT_DEVTOOLS_VERSION="0.5.1"
COMPACT_TOOLCHAIN_VERSION="0.31.1"

echo "Installing Compact developer tools ${COMPACT_DEVTOOLS_VERSION}"
curl --proto '=https' --tlsv1.2 -LsSf \
  "https://github.com/midnightntwrk/compact/releases/download/compact-v${COMPACT_DEVTOOLS_VERSION}/compact-installer.sh" | sh
export PATH="$HOME/.local/bin:$PATH"

echo "Installing the pinned Compact compiler ${COMPACT_TOOLCHAIN_VERSION}"
compact update "${COMPACT_TOOLCHAIN_VERSION}"

echo "Compiling the contract and its proving keys"
npm run compact

count=$(ls contract/build/keys/*.prover 2>/dev/null | wc -l)
if [ "$count" -eq 0 ]; then
  echo "No proving keys were produced; refusing to ship an interface that cannot prove." >&2
  exit 1
fi
echo "Proving keys: ${count}"

echo "Building the contract and API packages"
npm run build --workspace @quietbooks/contract
npm run build --workspace @quietbooks/api

# Unset means `undeployed`, the local network, which a browser wallet on a public
# network refuses. A public deployment targets Preview unless the project says
# otherwise.
export VITE_NETWORK_ID="${VITE_NETWORK_ID:-preview}"
echo "Building the interface for network ${VITE_NETWORK_ID}"
npm run build --workspace @quietbooks/ui
