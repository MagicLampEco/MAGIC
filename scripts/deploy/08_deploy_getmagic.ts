// scripts/deploy/08_deploy_getmagic.ts — Deploy GetMAGIC validators to Preview
// Chạy: npx tsx deploy/08_deploy_getmagic.ts
// Prerequisite: scripts/.env có BLOCKFROST_KEY + PRIVATE_KEY + NETWORK=Preview

import {
  Lucid, Blockfrost, Data,
  validatorToScriptHash,
  credentialToAddress, scriptHashToCredential,
} from "@lucid-evolution/lucid";
import { readFile } from "node:fs/promises";
import { NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet } from "../config.js";
import { loadBlueprint, findValidator, appliedScript } from "../applyParams.js";
import { otcOrderParams } from "../deployParams.js";

async function main() {
  console.log("=== GetMAGIC Deploy — Step 8 ===\n");
  console.log(`Network: ${NETWORK}\n`);

  // ── 1. Load plutus.json ───────────────────────────────────────
  const plutusPath = new URL(
    "../../GetMAGIC/onchain/plutus.json",
    import.meta.url,
  );
  const plutus = JSON.parse(await readFile(plutusPath, "utf-8")) as {
    validators: Array<{ title: string; hash: string; compiledCode: string }>;
  };

  const find = (title: string) => {
    const v = plutus.validators.find(v => v.title === title);
    if (!v) throw new Error(`Validator not found: ${title}`);
    return v;
  };

  // ── 2. MagicAllocation (no params) ───────────────────────────
  const allocRaw = find("magic_allocation.magic_allocation.spend");
  const allocScript = { type: "PlutusV3" as const, script: allocRaw.compiledCode };
  const allocHash   = validatorToScriptHash(allocScript);
  const allocAddr   = credentialToAddress(NETWORK, scriptHashToCredential(allocHash));

  console.log("MagicAllocation validator:");
  console.log(`  Hash:    ${allocHash}`);
  console.log(`  Address: ${allocAddr}\n`);

  // ── 3. OTCOrder (parameterized by alloc_script_hash) ─────────
  // Apply THEO TÊN, đọc thứ tự từ blueprint — không truyền theo vị trí. Đây từng
  // là script deploy duy nhất còn apply theo vị trí, tức nằm ngoài `check:params`.
  const bpGetMagic = await loadBlueprint("GetMAGIC");
  const orderRaw   = findValidator(bpGetMagic, "otc_order.otc_order.spend");
  const { script: orderScript, hash: orderHash } = appliedScript(
    orderRaw, otcOrderParams({ allocScriptHash: allocHash }),
  );
  const orderAddr  = credentialToAddress(NETWORK, scriptHashToCredential(orderHash));

  console.log("OTCOrder validator (parameterized with allocHash):");
  console.log(`  Hash:    ${orderHash}`);
  console.log(`  Address: ${orderAddr}\n`);

  // ── 4. Print .env additions ───────────────────────────────────
  console.log("📋 Thêm vào scripts/.env:");
  console.log(`GETMAGIC_ALLOC_HASH=${allocHash}`);
  console.log(`GETMAGIC_ALLOC_ADDR=${allocAddr}`);
  console.log(`GETMAGIC_ORDER_HASH=${orderHash}`);
  console.log(`GETMAGIC_ORDER_ADDR=${orderAddr}`);

  // ── 5. Verify ADA balance ─────────────────────────────────────
  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const address = await lucid.wallet().address();
  const utxos   = await lucid.wallet().getUtxos();
  const balance = utxos.reduce((s, u) => s + (u.assets.lovelace ?? 0n), 0n);

  console.log(`\nWallet: ${address}`);
  console.log(`Balance: ${balance / 1_000_000n} tADA`);

  if (balance < 5_000_000n) {
    console.warn("\n⚠️  Cần ≥ 5 tADA. Faucet: https://docs.cardano.org/cardano-testnet/tools/faucet");
  } else {
    console.log("\n✅ Validators ready. Chạy tiếp: npx tsx test/getmagic_flow.ts");
  }

  console.log("\nGhi chú: Validators không cần deploy tx — chúng là script-only addresses.");
  console.log("OrderDatum và AllocationDatum UTxOs được tạo khi test flow chạy.\n");
}

main().catch(e => { console.error(e); process.exit(1); });
