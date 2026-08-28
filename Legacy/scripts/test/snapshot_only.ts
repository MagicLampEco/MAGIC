// scripts/test/snapshot_only.ts — SnapshotGen-only smoke test on Preview testnet
// Standalone: runs exactly 1 SnapshotGen tx; reports result clearly.
// Prereq: deploy/04_create_vault.ts has been run (vault UTxO at parameterized address).
//
//   NETWORK=Preview npm run test:snapshot

import {
  Lucid, Blockfrost, Data,
  applyParamsToScript, validatorToScriptHash,
  credentialToAddress, scriptHashToCredential,
  getAddressDetails,
} from "@lucid-evolution/lucid";
import { readFile } from "node:fs/promises";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet,
  PROTOCOL, POLICY_IDS,
} from "../../../scripts/config.js";

/** Fetch tip slot + POSIX ms via Blockfrost REST (more reliable than Lucid provider). */
async function fetchTip(): Promise<{ slot: bigint; posixMs: bigint }> {
  const res = await fetch(`${BLOCKFROST_URL}/blocks/latest`, {
    headers: { project_id: BLOCKFROST_KEY },
  });
  if (!res.ok) throw new Error(`Blockfrost /blocks/latest: ${res.status} ${res.statusText}`);
  const tip = await res.json() as { slot: number; time: number };
  return { slot: BigInt(tip.slot), posixMs: BigInt(tip.time) * 1000n };
}
import { buildSnapshotGenTx } from "../../stale-genmodel-2026-07/SnapshotGen/offchain/src/snapshot.js";
import { VaultDatumSchema } from "../../stale-genmodel-2026-07/SnapshotGen/offchain/src/types.js";

async function main() {
  console.log("╔════════════════════════════════════════════╗");
  console.log("║  SnapshotGen smoke test — Preview testnet  ║");
  console.log("╚════════════════════════════════════════════╝\n");

  // ── 1. Load + apply vault script ─────────────────────────────
  const plutusJson = JSON.parse(
    await readFile(new URL("../../stale-genmodel-2026-07/SnapshotGen/onchain/plutus.json", import.meta.url), "utf8"),
  );
  const unapplied = plutusJson.validators.find((v: any) => v.title === "vault.vault.spend");
  if (!unapplied) throw new Error("vault.vault.spend not found in SnapshotGen/onchain/plutus.json");

  // v1.0: SnapshotGen vault signature thêm lamp_policy_id (cho WithdrawLamp W-6 check).
  const vaultScript = {
    type: "PlutusV3" as const,
    script: applyParamsToScript(unapplied.compiledCode, [POLICY_IDS.lamp, ASSET_NAMES.lamp, PROTOCOL.MS_PER_EPOCH]),
  };
  const vaultScriptHash = validatorToScriptHash(vaultScript);
  const vaultAddr = credentialToAddress(
    NETWORK,
    scriptHashToCredential(vaultScriptHash),
  );

  console.log(`Network:           ${NETWORK}`);
  console.log(`ms_per_epoch:      ${PROTOCOL.MS_PER_EPOCH}`);
  console.log(`Vault script hash: ${vaultScriptHash}`);
  console.log(`Vault address:     ${vaultAddr}\n`);

  // ── 2. Lucid + wallet ────────────────────────────────────────
  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);

  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error("Cannot get payment credential from wallet");
  const ownerPkh = paymentCredential.hash;

  console.log(`Wallet address:    ${address}`);
  console.log(`Owner PKH:         ${ownerPkh}\n`);

  // ── 3. Find vault UTxO owned by this wallet ──────────────────
  const utxos = await lucid.utxosAt(vaultAddr);
  console.log(`UTxOs at vault:    ${utxos.length}`);

  // If VAULT_TX_HASH env var is set, pick that specific vault (for case-by-case tests).
  // Otherwise pick any UTxO owned by us at this address.
  const wantedTx = process.env.VAULT_TX_HASH;
  const vaultUtxo = utxos.find((u) => {
    if (!u.datum) return false;
    if (wantedTx && u.txHash !== wantedTx) return false;
    try {
      const d = Data.from(u.datum, VaultDatumSchema);
      return d.owner === ownerPkh;
    } catch { return false; }
  });

  if (!vaultUtxo) {
    console.error("\n❌ Vault UTxO not found for owner.");
    console.error("   Run: npm run deploy:vault");
    process.exit(1);
  }

  console.log(`Vault UTxO:        ${vaultUtxo.txHash}#${vaultUtxo.outputIndex}\n`);

  // ── 4. Build + submit SnapshotGen tx ─────────────────────────
  try {
    const tip = await fetchTip();
    console.log(`Tip slot:          ${tip.slot}`);
    console.log(`Tip POSIX ms:      ${tip.posixMs}`);
    console.log(`Current epoch:     ${tip.posixMs / PROTOCOL.MS_PER_EPOCH}\n`);

    // TEST ONLY: TAMPER env var controls output-datum mutation for negative tests.
    //   lamp_balance     → bump lamp_balance (case 11)
    //   loyalty_holdings → clear loyalty_holdings (case 12)
    //   no_batch_added   → remove the new magic batch (case 13)
    //   wrong_batch_id   → flip a byte in the new batch_id (case 14)
    //   skip_activity    → keep stale activity (case 15)
    // SKIP_OWNER_SIG=1 omits required-signer for case 5.
    const tamper = process.env.TAMPER;
    const tamperOutputDatum = tamper ? ((d: any) => {
      if (tamper === "lamp_balance")     return { ...d, lamp_balance: d.lamp_balance + 1n };
      if (tamper === "loyalty_holdings") return { ...d, loyalty_holdings: [] };
      if (tamper === "no_batch_added")   return { ...d, magic_batches: [], next_batch_index: d.next_batch_index - 1n };
      if (tamper === "wrong_batch_id")   return {
        ...d,
        magic_batches: d.magic_batches.map((b: any, i: number) =>
          i === d.magic_batches.length - 1
            ? { ...b, batch_id: b.batch_id.replace(/^../, "ff") }   // flip first byte
            : b),
      };
      if (tamper === "skip_activity_prune") return {
        ...d,
        activity_state: {
          ...d.activity_state,
          // Inject a stale entry (epoch=1, way < current-12) → validator expects pruned, sees extra → reject.
          recent_burn_epochs: [...d.activity_state.recent_burn_epochs, ["ff".repeat(32), 1n] as [string, bigint]],
        },
      };
      throw new Error(`Unknown TAMPER: ${tamper}`);
    }) : undefined;

    const result = await buildSnapshotGenTx({
      lucid,
      vaultUtxo,
      userAddress: address,
      network:     NETWORK,
      vaultScript,
      tipSlot:    tip.slot,
      tipPosixMs: tip.posixMs,
      tamperOutputDatum,
      skipOwnerSig: process.env.SKIP_OWNER_SIG === "1",
    });

    if (tamper || process.env.SKIP_OWNER_SIG === "1") {
      console.log(`\n⚠  TEST MODE: ${tamper ?? "skipOwnerSig"} — expecting validator REJECT.\n`);
    }

    console.log(result.summary);
    console.log();

    const signed = await result.tx.sign.withWallet().complete();
    const txHash = await signed.submit();

    console.log("╔════════════════════════════════════════════╗");
    console.log("║              ✅ SUCCESS                    ║");
    console.log("╚════════════════════════════════════════════╝");
    console.log(`TX hash:   ${txHash}`);
    console.log(`Explorer:  https://${NETWORK.toLowerCase()}.cardanoscan.io/transaction/${txHash}`);
  } catch (err: any) {
    console.error("\n╔════════════════════════════════════════════╗");
    console.error("║              ❌ FAILED                     ║");
    console.error("╚════════════════════════════════════════════╝");
    const msg = String(err?.message ?? err);
    console.error(msg);
    if (err?.stack) console.error("\nStack:\n" + err.stack);

    if (/UnConstrData|ScriptError|Plutus|evaluat/i.test(msg)) {
      console.error("\n⚠  Likely Aiken stdlib v2 + Conway PlutusV3 bug (`ctx.transaction.*` UnConstrData).");
      console.error("   See plan caveats. Document in TESTNET_BLOCKED.md.");
    }
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
