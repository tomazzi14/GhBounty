#!/usr/bin/env bash
# Deploy the Anchor escrow program to Solana devnet.
# Wired up in GHB-63.
set -euo pipefail

cd "$(dirname "$0")/../contracts/solana"

echo "Building program..."
NO_DNA=1 anchor build >/dev/null

echo "Deploying to $(solana config get | grep 'RPC URL' | awk '{print $3}')..."
solana program deploy \
  target/deploy/ghbounty_escrow.so \
  --program-id target/deploy/ghbounty_escrow-keypair.json
