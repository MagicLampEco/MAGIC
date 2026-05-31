#!/usr/bin/env bash
# LampDistribution — chạy toàn bộ test (onchain Aiken + offchain vitest).
# Cách dùng: bash LampDistribution/verify.sh
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "════════════════════════════════════════════"
echo "  ONCHAIN — aiken check (lib + validators)"
echo "════════════════════════════════════════════"
cd "$ROOT/onchain"
aiken check 2>&1 | grep -E '"total"|"passed"|"failed"' | head -3
aiken build >/dev/null 2>&1 && echo "blueprint: plutus.json OK"

echo
echo "════════════════════════════════════════════"
echo "  OFFCHAIN — vitest (foundation + builders)"
echo "════════════════════════════════════════════"
cd "$ROOT/offchain"
[ -d node_modules ] || npm install --silent --no-audit --no-fund
npm test 2>&1 | tail -6
