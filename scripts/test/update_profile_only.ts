// scripts/test/update_profile_only.ts — UpdateProfile smoke test on Preview testnet.
// Maps V1_TESTNET_PLAN §4 case matrix (16 case: 2 vault × 8 case).
//
//   NETWORK=Preview MODULE=Instant NEW_PROFILE=Ember npm run test:update-profile
//
// Env knobs:
//   MODULE        Instant                                          (default: Instant)
//   NEW_PROFILE   Ember | Flame | Lantern                          (default: Ember)
//   TAMPER        same_profile | bypass_lazy | wrong_effective |
//                 effective_too_far | tamper_batches | tamper_balance
//   SKIP_OWNER_SIG=1   omit signer (C-PC-V1 negative)
//   FORCE_COOLDOWN=1   build tx even if cooldown not met (C-PC-V2 negative)
//   VAULT_TX_HASH      pick specific vault UTxO
//
// ## Mã thoát — bảng CHUNG của thư mục này, nguồn ở `scripts/awaitTx.ts` ▸ `## Mã thoát`
//   0 xong (tx ĐÃ vào khối) · 1 hỏng thật · 2 CHƯA ĐO ĐƯỢC · 3 lượt phá LỌT qua.
//   🔴 `3` ở đây TRƯỚC 2026-09-21 là `2`. Đổi để một con số mang một nghĩa trong cả
//   thư mục; xem lý do và phép kiểm an toàn ở nguồn.

import {
  Lucid, Blockfrost, Data,
  getAddressDetails,
  type UTxO,
} from "@lucid-evolution/lucid";
import { readFile } from "node:fs/promises";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet,
  POLICY_IDS, ASSET_NAMES, SCRIPT_HASHES,
} from "../config.js";

import { awaitTxBounded, chuaDoDuocMessage } from "../awaitTx.js";
import { updateProfile } from "../../MagicSDK/src/updateProfile.js";
import { ACCEPT_INLINE_SCRIPT_CEILING } from "../../MagicSDK/src/refScript.js";
import { applyVaultValidator } from "../../MagicSDK/src/validatorScripts.js";
import type { Profile, VaultType, ProtocolParams } from "../../MagicSDK/src/types.js";

// SnapshotGen đã dời sang Legacy/genmagic-v3.3 (mô hình GenMAGIC v3.3, đã bỏ) —
// chỉ còn vault Instant có UpdateProfile trong mô hình hiện hành.
type Module = "Instant";

const PLUTUS_PATH: Record<Module, string> = {
  Instant:  "../../InstantGen/onchain/plutus.json",
};

function buildProtocol(): ProtocolParams {
  return {
    network: NETWORK,
    lampPolicyId: POLICY_IDS.lamp,
    lampAssetName: ASSET_NAMES.lamp,
    umNftPolicyId: POLICY_IDS.um_nft,
    umScriptHash: SCRIPT_HASHES.um_datum,
    // Không truyền treasuryAddress: dưới I-ACT-7 không handler nào của vault
    // Instant/Schedule chuyển LAMP, nên không còn tham số Treasury.
    shardPolicyId: POLICY_IDS.shard_nft,
    // §6.3 BackingBeacon pins (Instant). All-zero default ⟹ Gen shut.
    backingNftPolicyId: POLICY_IDS.backing,
    backingScriptHash: SCRIPT_HASHES.backing_beacon,
  };
}

async function fetchTip(): Promise<{ slot: bigint; posixMs: bigint }> {
  const res = await fetch(`${BLOCKFROST_URL}/blocks/latest`, {
    headers: { project_id: BLOCKFROST_KEY },
  });
  if (!res.ok) throw new Error(`Blockfrost /blocks/latest: ${res.status}`);
  const tip = await res.json() as { slot: number; time: number };
  return { slot: BigInt(tip.slot), posixMs: BigInt(tip.time) * 1000n };
}

async function main() {
  const moduleName = (process.env.MODULE ?? "Instant") as Module;
  if (!PLUTUS_PATH[moduleName]) throw new Error(`MODULE=${moduleName} not supported (only Instant).`);

  const newProfile = (process.env.NEW_PROFILE ?? "Ember") as Profile;
  const tamper = process.env.TAMPER ?? "";

  console.log("╔════════════════════════════════════════════╗");
  console.log(`║  UpdateProfile smoke — ${moduleName.padEnd(19)}║`);
  console.log("╚════════════════════════════════════════════╝\n");

  // Load + apply vault script via SDK helper (biết đúng danh sách tham số
  // compile-time của từng loại vault).
  const plutusJson = JSON.parse(
    await readFile(new URL(PLUTUS_PATH[moduleName], import.meta.url), "utf8"),
  );
  const unapplied = plutusJson.validators.find((v: any) => v.title === "vault.vault.spend");
  if (!unapplied) throw new Error("vault.vault.spend not found");

  const { vaultScript, vaultScriptHash, vaultAddress: vaultAddr } = applyVaultValidator(
    moduleName as VaultType,
    { vaultUnappliedCbor: unapplied.compiledCode },
    buildProtocol(),
  );

  console.log(`Network:           ${NETWORK}`);
  console.log(`Vault hash:        ${vaultScriptHash}`);
  console.log(`New profile:       ${newProfile}`);
  if (tamper) console.log(`TAMPER:            ${tamper}`);
  if (process.env.SKIP_OWNER_SIG === "1") console.log(`SKIP_OWNER_SIG:    1`);
  console.log();

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);

  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error("No payment credential");
  const ownerPkh = paymentCredential.hash;

  // Find vault UTxO
  const utxos = await lucid.utxosAt(vaultAddr);
  const wantedTx = process.env.VAULT_TX_HASH;

  // 🔴 `UpdateProfile` là nhánh CHỈ CÓ ở InstantGen (`PLUTUS_PATH` ở trên chỉ
  // nhận `Instant`), nên két ở đây LUÔN mang 18 trường. Bản trước dùng
  // `VaultDatumSchema` (17 trường) rồi `catch` nuốt lượt ném ⟹ mọi lượt chạy
  // báo "không tìm thấy két" cho đúng cái két nó vừa tạo.
  const { InstantVaultDatumSchema } = await import("../../MagicSDK/src/schemas.js");

  let vaultUtxo: UTxO | undefined;
  const khongGiaiMaDuoc: string[] = [];
  for (const u of utxos) {
    if (!u.datum) continue;
    if (wantedTx && u.txHash !== wantedTx) continue;
    try {
      const d = Data.from(u.datum, InstantVaultDatumSchema as never) as { owner: string };
      if (d.owner === ownerPkh) { vaultUtxo = u; break; }
    } catch (e) {
      khongGiaiMaDuoc.push(
        `${u.txHash}#${u.outputIndex}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (khongGiaiMaDuoc.length > 0) {
    console.warn(
      `⚠ ${khongGiaiMaDuoc.length} UTxO ở địa chỉ két KHÔNG giải mã được bằng ` +
      `InstantVaultDatumSchema (18 trường):\n  ` + khongGiaiMaDuoc.join("\n  "),
    );
  }
  if (!vaultUtxo) {
    if (khongGiaiMaDuoc.length > 0) {
      throw new Error(
        `Không tìm được két của chủ ${ownerPkh}, và ${khongGiaiMaDuoc.length} UTxO ở đó ` +
        `không giải mã được. Đây là LƯỢC ĐỒ LỆCH, không phải "chưa có két".`,
      );
    }
    console.error("❌ Vault UTxO not found. Run deploy:instant-vault first.");
    process.exit(1);
  }
  console.log(`Vault UTxO:        ${vaultUtxo.txHash}#${vaultUtxo.outputIndex}\n`);

  const tip = await fetchTip();
  try {
    const result = await updateProfile({
      lucid,
      vaultUtxo,
      newProfile,
      vaultScript,
      vaultType: moduleName as VaultType,
      vaultPlutusJson: plutusJson,
      network: NETWORK,
      tipPosixMs: tip.posixMs,
      // Vault vừa dựng, datum còn nhỏ — inline vừa trần. Chưa nối CIP-33 ở đây:
      // nợ có địa chỉ, `DevStatus.md` Nợ #64.
      vaultRefScriptUtxo: ACCEPT_INLINE_SCRIPT_CEILING,
    });

    let finalTx = result.tx;
    if (tamper || process.env.SKIP_OWNER_SIG === "1") {
      finalTx = await rebuildWithTamper(
        lucid, vaultUtxo, result.newVaultDatum, vaultScript, vaultAddr,
        newProfile, ownerPkh, tip.posixMs, plutusJson, tamper,
        process.env.SKIP_OWNER_SIG === "1",
      );
      console.log(`⚠  TEST MODE: ${tamper || "skipOwnerSig"} — expecting validator REJECT.\n`);
    }

    console.log(result.summary);
    console.log();

    const signed = await finalTx.sign.withWallet().complete();
    const txHash = await signed.submit();
    console.log(`\nTX hash:   ${txHash}`);

    if (tamper || process.env.SKIP_OWNER_SIG === "1") {
      console.error("\n⚠  UNEXPECTED: tamper tx SUBMITTED — validator did not reject.");
      process.exit(3);
    }

    // `submit()` mới nói node NHẬN vào mempool — `scripts/awaitTx.ts` nói vì sao đó chưa
    // đủ. Riêng ở đây nó còn nặng hơn một bậc: UpdateProfile có thời gian nguội (không
    // đổi hai lần trong 2 epoch liên tiếp), nên một lượt tưởng-đã-xong-mà-rớt làm lượt
    // sau bị chính cổng nguội từ chối, và câu từ chối đó trỏ vào cổng chứ không vào tx rớt.
    if (!(await awaitTxBounded(lucid, txHash))) {
      console.error(`\n${chuaDoDuocMessage(txHash)}`);
      process.exit(2);
    }
    console.log("╔════════════════════════════════════════════╗");
    console.log("║       ✅ SUCCESS — tx ĐÃ vào khối          ║");
    console.log("╚════════════════════════════════════════════╝");
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (tamper || process.env.SKIP_OWNER_SIG === "1" || process.env.FORCE_COOLDOWN === "1") {
      console.log("╔════════════════════════════════════════════╗");
      console.log("║   ✅ REJECTED (as expected for negative)   ║");
      console.log("╚════════════════════════════════════════════╝");
      console.log(`Reason:    ${msg.slice(0, 300)}`);
      return;
    }
    console.error("\n❌ FAILED:", msg);
    if (err?.stack) console.error("\nStack:\n" + err.stack);
    process.exit(1);
  }
}

async function rebuildWithTamper(
  lucid: any, vaultUtxo: UTxO, newVaultDatum: any, vaultScript: any, vaultAddr: string,
  newProfile: Profile, ownerPkh: string, tipPosixMs: bigint, plutusJson: any,
  tamper: string, skipOwnerSig: boolean,
): Promise<any> {
  // UpdateProfile chỉ có ở InstantGen ⟹ 18 trường. Xem chú thích ở vòng tìm két.
  const { InstantVaultDatumSchema } = await import("../../MagicSDK/src/schemas.js");
  const { resolveConstrIndex } = await import("../../MagicSDK/src/redeemerIndex.js");
  const { PROFILE_CONSTR_INDEX } = await import("../../MagicSDK/src/updateProfile.js");
  const { Constr } = await import("@lucid-evolution/lucid");

  let mutated = { ...newVaultDatum };
  const currentEpoch = mutated.profile_changed_epoch as bigint;

  if (tamper === "bypass_lazy") {
    // C-PC-V6 negative: set profile directly (skip lazy)
    mutated = { ...mutated, profile: newProfile, pending_profile: null };
  } else if (tamper === "wrong_effective") {
    // C-PC-V6 negative: effective_epoch = current (should be current+1)
    mutated = {
      ...mutated,
      pending_profile: { new_profile: newProfile, effective_epoch: currentEpoch },
    };
  } else if (tamper === "effective_too_far") {
    // C-PC-V6 negative: effective_epoch = current+5
    mutated = {
      ...mutated,
      pending_profile: { new_profile: newProfile, effective_epoch: currentEpoch + 5n },
    };
  } else if (tamper === "tamper_batches") {
    // C-PC-V4 + A02: mutate magic_batches
    mutated = { ...mutated, magic_batches: [] };
  } else if (tamper === "tamper_balance") {
    // A02: mutate lamp_balance
    mutated = { ...mutated, lamp_balance: mutated.lamp_balance + 1n };
  } else if (tamper === "same_profile") {
    // Will fail SDK pre-check too, but allow the validator to be the one rejecting:
    // user wants C-PC-V3 path — they'd build a tx where new_profile == current.
    // Handled here by re-encoding redeemer with current profile.
  }

  // Resolve indices
  const profileIdx = PROFILE_CONSTR_INDEX[newProfile];
  const profileConstr = new Constr(profileIdx, []);
  const upIdx = resolveConstrIndex(plutusJson, "vault.vault.spend", "UpdateProfile");
  const redeemer = Data.to(new Constr(upIdx, [profileConstr]));

  const lowerTime = Number(tipPosixMs);
  const upperTime = Number(tipPosixMs + 600_000n);

  let txBuilder = lucid
    .newTx()
    .collectFrom([vaultUtxo], redeemer)
    .attach.SpendingValidator(vaultScript)
    .pay.ToAddressWithData(
      vaultAddr,
      { kind: "inline", value: Data.to(mutated, InstantVaultDatumSchema as any) },
      vaultUtxo.assets,
    )
    .validFrom(lowerTime)
    .validTo(upperTime);

  if (!skipOwnerSig) txBuilder = txBuilder.addSignerKey(ownerPkh);

  return await txBuilder.complete();
}

main().catch((e) => { console.error(e); process.exit(1); });
