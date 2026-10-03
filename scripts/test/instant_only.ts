// scripts/test/instant_only.ts — InstantGen-only smoke test (Gen v2.0).
// Prereq:
//   - 01_mint_lamp + 11_deploy_gen_beacons (beacon ρ/GBB, 16 shard GB, ref gb_shard, sổ két)
//     + 05_create_instant_vault (két đã có trong sổ két VRG).
//   - Sổ trạng thái nạp vào env (thiếu khoá nào ⟹ NÉM nêu tên, không đệm):
//       RATE_PARAM_HASH · GREENBACK_BEACON_HASH · GB_SHARD_HASH — apply-param két
//       GB_SHARD_CAP_NANOGIC · VAULT_REGISTRY_HASH · REF_GB_SHARD_UTXO
//       REF_VAULT_INSTANT_UTXO — ref-script két (BẮT BUỘC: két ~14 KB + shard GB vượt trần tx)
//   - két Wakeme của NETWORK (apply-param #7) lấy từ `SCRIPT_HASHES.wakeme_vault`, không env.
//
//   NETWORK=Preview INSTANT_M=<nanogic|max> npm run test:instant
//
// Env-var knobs:
//   INSTANT_M=<nanogic>|max      — BẮT BUỘC: lượng MAGIC sinh ở lượt này (`claimed_amount`).
//                                  "max" = trần `instantGenLimits(..).maxM` ở ảnh chụp vừa đọc.
//                                  Không mặc định con số: `m` là lựa chọn của chủ két.
//   VAULT_TX_HASH=<hex>          — pick a specific vault UTxO (else first match by owner)
//   WAKEME_VAULT_UTXO=<tx#ix>    — két Wakeme cụ thể (tuỳ chọn). Vắng: `wakeme_link` khác ""
//                                  ⟹ tự tìm két mang NFT owner_commit; link "" ⟹ không đưa vào.
//   TAMPER=<mode>                — tamper mode for negative tests
//   SKIP_OWNER_SIG=1             — negative test for owner sig
//   DRY_RUN=1                    — dựng + chạy thử validator, KHÔNG ký, KHÔNG gửi
//
// ## Mã thoát — bảng CHUNG của thư mục này, nguồn ở `scripts/awaitTx.ts` ▸ `## Mã thoát`
//   0 xong (tx ĐÃ vào khối) · 1 hỏng thật · 2 CHƯA ĐO ĐƯỢC · 3 lượt phá LỌT qua.
//   🔴 `3` ở đây TRƯỚC 2026-09-21 là `2`. Đổi để một con số mang một nghĩa trong cả
//   thư mục; xem lý do và phép kiểm an toàn ở nguồn.

import {
  Lucid, Blockfrost, Data,
  credentialToAddress, scriptHashToCredential,
  getAddressDetails,
  type UTxO,
} from "@lucid-evolution/lucid";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet,
  POLICY_IDS, ASSET_NAMES, PROTOCOL, SCRIPT_HASHES,
} from "../config.js";
import { loadBlueprint, findValidator, appliedScript } from "../applyParams.js";
import { awaitTxBounded, chuaDoDuocMessage } from "../awaitTx.js";
import { instantVaultParams } from "../deployParams.js";
import { parseFlag } from "../runResult.js";
import {
  buildInstantGenTx, instantGenLimits, readWakemeVault,
} from "../../InstantGen/offchain/src/instant.js";
import {
  GbShard, GreenBackBeacon, RateParam, decodeVaultDatum,
  type VaultDatum,
} from "../../InstantGen/offchain/src/types.js";
import { shardNftName, vaultShardId } from "../../InstantGen/offchain/src/greenback.js";
import type { InstantVaultParams } from "../../InstantGen/offchain/src/vaultScript.js";
import { ownerRefOf, sameOwner, windowOf } from "@magiclamp/protocol-utils";
import {
  fetchRefScript, parseInstantM, pickByNft, readGenV2ChainRefs, readGenV2E2eBook,
  requireOutRefKey, resolveInstantM, resolveWakemeVaultUtxo,
} from "./genV2Chain.js";

async function fetchTip(): Promise<{ slot: bigint; posixMs: bigint }> {
  const res = await fetch(`${BLOCKFROST_URL}/blocks/latest`, {
    headers: { project_id: BLOCKFROST_KEY },
  });
  if (!res.ok) throw new Error(`Blockfrost /blocks/latest: ${res.status}`);
  const tip = await res.json() as { slot: number; time: number };
  return { slot: BigInt(tip.slot), posixMs: BigInt(tip.time) * 1000n };
}

/** Datum inline của một UTxO beacon/shard theo lược đồ gói nền. Sai ⟹ NÉM nêu UTxO. */
function decodeInline<T>(u: UTxO, schema: T, what: string): T {
  if (typeof u.datum !== "string" || u.datum === "") {
    throw new Error(`${what} ${u.txHash}#${u.outputIndex} không mang datum inline.`);
  }
  return Data.from(u.datum, schema as never) as T;
}

/** Tên NFT vault-id DUY NHẤT dưới policy = hash script két (INV-VAULT-IDENTITY). */
function vaultIdName(u: UTxO, vaultHash: string): string {
  const ids = Object.entries(u.assets).filter(([k]) => k !== "lovelace" && k.slice(0, 56) === vaultHash);
  if (ids.length !== 1 || ids[0]![1] !== 1n) {
    throw new Error(`Két ${u.txHash}#${u.outputIndex} không mang đúng một NFT vault-id dưới ${vaultHash}.`);
  }
  return ids[0]![0].slice(56);
}

async function main() {
  console.log("╔════════════════════════════════════════════╗");
  console.log(`║  InstantGen smoke test — ${NETWORK.padEnd(18)}║`);
  console.log("╚════════════════════════════════════════════╝\n");

  const dryRun = parseFlag(process.env.DRY_RUN, "DRY_RUN");
  const skipOwnerSig = parseFlag(process.env.SKIP_OWNER_SIG, "SKIP_OWNER_SIG");
  // Đọc mọi đầu vào bắt buộc TRƯỚC lệnh gọi mạng đầu tiên: thiếu là ném ngay, kể đủ.
  const mChoice = parseInstantM(process.env.INSTANT_M, "INSTANT_M");
  const gen = readGenV2E2eBook(process.env, { withScheduleCommit: false });
  const refVaultOutRef = requireOutRefKey(
    process.env, "REF_VAULT_INSTANT_UTXO", "bước 05_create_instant_vault in ra",
  );

  // Apply-param THEO TÊN (scripts/applyParams.ts) — tên + thứ tự đọc từ
  // blueprint, dùng chung bản đồ giá trị với deploy/05 nên hash không thể lệch.
  const vaultParams: InstantVaultParams = {
    lampPolicyId:    POLICY_IDS.lamp,
    lampAssetName:   ASSET_NAMES.lamp,
    ...gen.beacons,
    wakemeVaultHash: SCRIPT_HASHES.wakeme_vault,    // #7 — két Wakeme; mạng chưa có két ⟹ ném
    msPerEpoch:      PROTOCOL.MS_PER_EPOCH,
    windowOriginMs:      PROTOCOL.WINDOW_ORIGIN_MS,
  };
  const blueprint = await loadBlueprint("InstantGen");
  const { script: vaultScript, hash: vaultScriptHash } = appliedScript(
    findValidator(blueprint, "vault.vault.spend"),
    instantVaultParams(vaultParams),
  );
  const vaultScriptAddress = credentialToAddress(NETWORK, scriptHashToCredential(vaultScriptHash));

  console.log(`Network:            ${NETWORK}`);
  console.log(`Vault script hash:  ${vaultScriptHash}`);
  console.log(`Vault address:      ${vaultScriptAddress}`);

  // Lucid + wallet
  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error("Cannot get payment credential");
  const ownerPkh = paymentCredential.hash;

  // Find vault UTxO. Datum không giải mã được bằng lược đồ v2.0 (20 trường) KHÔNG bị nuốt:
  // đếm và in ra khi không tìm thấy két, để "két v1 còn nằm đó" không đọc thành "chưa có két".
  const wantedTx = process.env.VAULT_TX_HASH;
  const vaultUtxos = await lucid.utxosAt(vaultScriptAddress);
  console.log(`UTxOs at vault:     ${vaultUtxos.length}`);
  const undecodable: string[] = [];
  const mine: { utxo: UTxO; datum: VaultDatum }[] = [];
  for (const u of vaultUtxos) {
    if (!u.datum) continue;
    if (wantedTx && u.txHash !== wantedTx) continue;
    let d: VaultDatum;
    try {
      d = decodeVaultDatum(u.datum);
    } catch (e) {
      undecodable.push(`${u.txHash}#${u.outputIndex}: ${(e as Error).message.slice(0, 160)}`);
      continue;
    }
    if (sameOwner(ownerRefOf(d.owner), { type: "key", hash: ownerPkh })) mine.push({ utxo: u, datum: d });
  }
  if (mine.length === 0) {
    console.error("\n❌ Vault UTxO not found. Run: npm run deploy:instant-vault");
    if (undecodable.length > 0) {
      console.error(`   ${undecodable.length} UTxO không giải mã được bằng datum v2.0:\n   ` + undecodable.join("\n   "));
    }
    process.exit(1);
  }
  const { utxo: vaultUtxo, datum: vaultDatum } = mine[0]!;
  console.log(`Vault UTxO:         ${vaultUtxo.txHash}#${vaultUtxo.outputIndex}`);

  // ── Gen v2.0: beacon ρ + GB, sổ két, shard GB của két, ref-script ─────────────
  const chain = await readGenV2ChainRefs(lucid, gen);
  const vaultRefScriptUtxo = await fetchRefScript(lucid, refVaultOutRef, "REF_VAULT_INSTANT_UTXO", vaultScriptHash);
  const shardId = vaultShardId(vaultDatum.owner);
  const gbShardUtxo = pickByNft(chain.gbShardUtxos, gen.beacons.gbShardPolicyId + shardNftName(shardId), `shard GB ${shardId}`);

  // Tip POSIX ms.
  const tip = await fetchTip();
  const epoch = windowOf(tip.posixMs, PROTOCOL.MS_PER_EPOCH, PROTOCOL.WINDOW_ORIGIN_MS);
  console.log(`Tip POSIX ms:       ${tip.posixMs}`);
  console.log(`Current epoch:      ${epoch}`);
  const refresh = vaultDatum.cap_epoch < epoch;
  console.log(`Checkpoint:         cap_epoch ${vaultDatum.cap_epoch} ⟹ ${refresh ? "LÀM MỚI (đọc ρ)" : "giữ nguyên"}`);
  console.log(`Beacon ρ:           ${chain.rateBeaconUtxo.txHash}#${chain.rateBeaconUtxo.outputIndex}`);
  console.log(`Beacon GB:          ${chain.gbBeaconUtxo.txHash}#${chain.gbBeaconUtxo.outputIndex}`);
  console.log(`Shard GB ${String(shardId).padEnd(2)}:        ${gbShardUtxo.txHash}#${gbShardUtxo.outputIndex}`);

  // Két Wakeme: nhánh sinh đọc L_lent cả khi không làm mới (`expectedCheckpointForGen`).
  const wakemeVaultUtxo = await resolveWakemeVaultUtxo(
    lucid, vaultParams.wakemeVaultHash, vaultDatum.wakeme_link, process.env.WAKEME_VAULT_UTXO,
  );
  const wakeme = wakemeVaultUtxo === undefined ? null : readWakemeVault(wakemeVaultUtxo, {
    wakemeVaultHash: vaultParams.wakemeVaultHash,
    ownScriptHash:   vaultScriptHash,
    ownVaultName:    vaultIdName(vaultUtxo, vaultScriptHash),
    currentPeriod:   epoch,
    lampPolicyId:    vaultParams.lampPolicyId,
    lampAssetName:   vaultParams.lampAssetName,
    // Apply-param #8/#9 của két IG (vế genesis của `LentReadContext`) — cùng nguồn với vault.
    msPerEpoch:      PROTOCOL.MS_PER_EPOCH,
    windowOriginMs:  PROTOCOL.WINDOW_ORIGIN_MS,
  });
  console.log(`Két Wakeme:         ${wakemeVaultUtxo ? `${wakemeVaultUtxo.txHash}#${wakemeVaultUtxo.outputIndex} (L_lent ${wakeme!.lent})` : "(không đưa vào)"}`);

  // Trần `m` ở ảnh chụp này (gói nền, trùng bit validator) rồi chọn `m`.
  const limits = instantGenLimits({
    vaultDatum,
    vaultOutRef: { txHash: vaultUtxo.txHash, outputIndex: vaultUtxo.outputIndex },
    currentEpoch: epoch,
    rate: refresh ? decodeInline(chain.rateBeaconUtxo, RateParam, "beacon ρ") : null,
    wakeme,
    greenback: decodeInline(chain.gbBeaconUtxo, GreenBackBeacon, "beacon GreenBack"),
    shardIn: decodeInline(gbShardUtxo, GbShard, `shard GB ${shardId}`),
    gbShardCapNanogic: gen.gbShardCapNanogic,
  });
  console.log(`Trần:               maxM ${limits.maxM} · đã sinh ${limits.genSoFar} · cap_nanogic ${limits.capNanogic} · cap_lamp ${limits.capLamp} · GB ${limits.gbAvailable}`);
  const m = resolveInstantM(mChoice, limits.maxM, "INSTANT_M");
  console.log(`m:                  ${m} nanogic\n`);

  // Tamper helpers (negative tests).
  const tamper = process.env.TAMPER;
  if (tamper === "lamp_out") {
    // Bộ dựng v2.0 không còn móc đẩy LAMP ra khỏi két; ca I-ACT-7 nằm ở bộ ca Aiken + e2e
    // Emulator của gói nền. NÉM thay vì chạy một lượt "âm" không phá gì.
    throw new Error("TAMPER=lamp_out không còn hỗ trợ ở Gen v2.0 (bộ dựng không có tamperLampOutOil).");
  }
  const tamperOutputDatum = tamper ? ((d: VaultDatum): VaultDatum => {
    if (tamper === "lamp_balance") return { ...d, lamp_balance: d.lamp_balance + 1n };
    if (tamper === "keep_credit")
      return { ...d, activity_state: { ...d.activity_state, consumed_credit: 1n } };
    if (tamper === "wrong_owner") return { ...d, owner: { VerificationKey: ["ff".repeat(28)] } as VaultDatum["owner"] };
    if (tamper === "cap_nanogic") return { ...d, cap_nanogic: d.cap_nanogic + 1n };
    if (tamper === "usage_window") {
      const [open, ...rest] = d.usage_window;
      return { ...d, usage_window: [{ ...open!, generated: open!.generated + 1n }, ...rest] };
    }
    throw new Error(`Unknown TAMPER: ${tamper}`);
  }) : undefined;

  try {
    if (tamper || skipOwnerSig) {
      console.log(`⚠  TEST MODE: ${tamper ?? "skipOwnerSig"} — expecting REJECT.\n`);
    }

    const result = await buildInstantGenTx({
      lucid,
      vaultUtxo,
      vaultScript,
      vaultParams,
      vaultRefScriptUtxo,
      m,
      ...(refresh ? { rateBeaconUtxo: chain.rateBeaconUtxo } : {}),
      ...(wakemeVaultUtxo ? { wakemeVaultUtxo } : {}),
      greenbackBeaconUtxo:  chain.gbBeaconUtxo,
      gbShardUtxo,
      gbShardRefScriptUtxo: chain.gbShardRefUtxo,
      vaultRegistryUtxo:    chain.vaultRegistryUtxo,
      vaultRegistryPolicy:  gen.vaultRegistryHash,
      gbShardCapNanogic:    gen.gbShardCapNanogic,
      network:              NETWORK,
      tipPosixMs:           tip.posixMs,
      tamperOutputDatum,
      skipOwnerSig,
    });

    console.log(result.summary);

    // DRY_RUN=1: `buildInstantGenTx` đã `complete()` — validator đã chạy thử cục bộ.
    // Dừng trước khi ký, cùng quy ước với test/consume_only.ts và test/mint_engage_only.ts.
    // Lượt phá mà dựng được tới đây là lọt, nên vẫn thoát 3 như lượt gửi thật.
    if (dryRun) {
      if (tamper || skipOwnerSig) {
        console.error("\n⚠  UNEXPECTED (DRY RUN): tamper tx qua validator khi chạy thử.");
        process.exit(3);
      }
      console.log("\n✔ DRY RUN: tx dựng xong và qua validator khi chạy thử. Không ký, không gửi.");
      return;
    }

    const signed = await result.tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    console.log(`\nTX hash:   ${txHash}`);
    console.log(`Explorer:  https://${NETWORK.toLowerCase()}.cardanoscan.io/transaction/${txHash}`);

    // Cổng KIỂM CỰC — khuôn lấy từ bản NGHIÊM cùng thư mục (`withdraw_only.ts`).
    // Thiếu cổng này thì tệp KHAI "expecting REJECT" ở trên rồi KHÔNG kiểm, và hai
    // nhãn đi NGƯỢC đúng lúc có chuyện: lượt phá nộp LỌT in ✅ rồi thoát 0, còn lượt
    // bị từ chối ĐÚNG lại rơi vào `catch` và in ❌ rồi thoát 1. Một phép đo không mang
    // khái niệm "kỳ vọng" thì nó trả kết quả hợp lệ ở CẢ HAI cực — đúng ca `Forall`
    // §Cổng gác gọi là trạng thái mù, và nó mù đúng ở phía không ai đi kiểm.
    if (tamper || skipOwnerSig) {
      console.error("\n⚠  UNEXPECTED: tamper tx SUBMITTED — validator did not reject. Investigate.");
      process.exit(3);
    }

    // `submit()` mới nói node NHẬN vào mempool. Bản trước in ✅ SUCCESS ngay tại đây, tức
    // khai "xong" cho một việc chưa đo. Chuỗi [2]→[3]→[4] của `run_consume_e2e.sh` giả
    // định bước này để lại MAGIC mới trong vault; tx rớt thì bước [4] hỏng và câu lỗi trỏ
    // vào [4]. Lý do đầy đủ: `scripts/awaitTx.ts`.
    if (!(await awaitTxBounded(lucid, txHash))) {
      console.error(`\n${chuaDoDuocMessage(txHash)}`);
      process.exit(2);
    }
    console.log("\n╔════════════════════════════════════════════╗");
    console.log("║       ✅ SUCCESS — tx ĐÃ vào khối          ║");
    console.log("╚════════════════════════════════════════════╝");
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (tamper || skipOwnerSig) {
      console.log("╔════════════════════════════════════════════╗");
      console.log("║   ✅ REJECTED (as expected for negative)   ║");
      console.log("╚════════════════════════════════════════════╝");
      console.log(`Reason:    ${msg.slice(0, 300)}`);
      return;
    }
    console.error("\n╔════════════════════════════════════════════╗");
    console.error("║              ❌ FAILED                     ║");
    console.error("╚════════════════════════════════════════════╝");
    console.error(msg);
    if (err?.stack) console.error("\nStack:\n" + err.stack);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
