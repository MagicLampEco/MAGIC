// scripts/test/getmagic_claim.ts — Claim một epoch từ AllocationDatum đã có
//
// Dùng sau khi getmagic_flow.ts đã chạy xong.
//
// Cách dùng:
//   ORACLE_PRIVATE_KEY=... ALLOC_ID=... START_EPOCH=... npm run claim:getmagic
//   EPOCH=1329 ORACLE_PRIVATE_KEY=... ALLOC_ID=... START_EPOCH=... npm run claim:getmagic
//
// Env vars bắt buộc (lấy từ output của getmagic_flow.ts):
//   ORACLE_PRIVATE_KEY  — oracle Ed25519 private key (hex)
//   ALLOC_ID            — 32-byte alloc ID (hex)
//   START_EPOCH         — epoch đầu của allocation
//
// Optional:
//   EPOCH=<n>           — claim epoch cụ thể; mặc định: tự tìm epoch chưa claimed

import {
  Lucid, Blockfrost, Data,
  applyParamsToScript, validatorToScriptHash,
  credentialToAddress, scriptHashToCredential,
  getAddressDetails, type UTxO,
} from "@lucid-evolution/lucid";
import { readFile } from "node:fs/promises";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet,
} from "../config.js";
import {
  AllocationDatumSchema, AllocationRedeemerSchema,
  type AllocationDatum, type AllocationRedeemer,
} from "../../GetMAGIC/offchain/src/types.js";
import { generateEpochVouchers } from "../../GetMAGIC/offchain/src/oracle.js";

// ── Codec companions ─────────────────────────────────────────────
// `Data.to`/`Data.from` suy kiểu kết quả từ THAM SỐ THỨ HAI, nên tham số đó
// phải là một GIÁ TRỊ mang kiểu tĩnh phẳng — không phải chính đối tượng lược
// đồ. Truyền thẳng `XxxSchema` làm lời gọi trả về `TObject<…>` và mọi truy cập
// trường bên dưới mất kiểu.
//
// GetMAGIC/offchain/src/types.ts hiện chỉ xuất lược đồ, chưa có hằng
// bạn-đồng-hành, nên khai tại chỗ. Hậu tố `Codec` vì tên trần đã bị kiểu nhập
// từ GetMAGIC chiếm. KHÔNG suy lại bằng `Data.Static<typeof XxxSchema>`: lược
// đồ nhập từ GetMAGIC mang nhãn của bản lucid cài trong GetMAGIC/offchain, nên
// không thoả ràng buộc `TSchema` của bản lucid trong scripts/.
// Giá trị thời-chạy y nguyên, chỉ gắn lại nhãn.
const AllocationDatumCodec    = AllocationDatumSchema    as unknown as AllocationDatum;
const AllocationRedeemerCodec = AllocationRedeemerSchema as unknown as AllocationRedeemer;

// ── Helpers ──────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function wait(label: string, ms = 20_000): Promise<void> {
  process.stdout.write(`   ⏳ ${label} (${ms / 1000}s)...`);
  return sleep(ms).then(() => { process.stdout.write(" done\n"); });
}

function isPureAda(u: UTxO): boolean {
  return Object.keys(u.assets).every(k => k === "lovelace");
}

async function ensureCollateralUtxo(
  lucid: Awaited<ReturnType<typeof Lucid>>,
  walletAddr: string,
): Promise<UTxO> {
  const utxos = await lucid.wallet().getUtxos();
  const existing = utxos.find(u => isPureAda(u) && (u.assets.lovelace ?? 0n) >= 5_000_000n);
  if (existing) {
    console.log(`Collateral UTxO: ${existing.txHash}#${existing.outputIndex}\n`);
    return existing;
  }

  console.log("Tạo pure-ADA UTxO (5 ADA to self)...");
  const splitTx = await lucid.newTx()
    .pay.ToAddress(walletAddr, { lovelace: 5_000_000n })
    .complete();
  const signedSplit = await splitTx.sign.withWallet().complete();
  const splitTxHash = await signedSplit.submit();
  console.log(`   TxHash: ${splitTxHash}`);
  await wait("Confirming collateral UTxO", 60_000);

  const fresh = await lucid.wallet().getUtxos();
  const newUtxo = fresh.find(u => u.txHash === splitTxHash && isPureAda(u));
  if (!newUtxo) throw new Error("Collateral UTxO not found after 60s.");
  return newUtxo;
}

// Decode AllocationDatum inline datum from UTxO
function tryDecodeDatum(u: UTxO): AllocationDatum | null {
  if (!u.datum) return null;
  try {
    return Data.from(u.datum, AllocationDatumCodec);
  } catch {
    return null;
  }
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log("=== GetMAGIC Claim Epoch — Preview Testnet ===\n");

  // ── Env vars ──────────────────────────────────────────────────
  const ORACLE_PRIVATE_KEY = process.env.ORACLE_PRIVATE_KEY ?? "";
  const ALLOC_ID           = process.env.ALLOC_ID ?? "";
  const START_EPOCH_STR    = process.env.START_EPOCH ?? "";
  const EPOCH_ARG          = process.env.EPOCH ? BigInt(process.env.EPOCH) : null;

  if (!ORACLE_PRIVATE_KEY) throw new Error("Thiếu ORACLE_PRIVATE_KEY trong env.");
  if (!ALLOC_ID)           throw new Error("Thiếu ALLOC_ID trong env.");

  // ── Load plutus.json ──────────────────────────────────────────
  const plutusPath = new URL(
    "../../GetMAGIC/onchain/plutus.json",
    import.meta.url,
  );
  const plutus = JSON.parse(await readFile(plutusPath, "utf-8")) as {
    validators: Array<{ title: string; hash: string; compiledCode: string }>;
  };
  const findV = (title: string) => {
    const v = plutus.validators.find(v => v.title === title);
    if (!v) throw new Error(`Validator not found: ${title}`);
    return v;
  };

  // ── Derive addresses ──────────────────────────────────────────
  const allocRaw    = findV("magic_allocation.magic_allocation.spend");
  const allocScript = { type: "PlutusV3" as const, script: allocRaw.compiledCode };
  const allocHash   = validatorToScriptHash(allocScript);
  const allocAddr   = credentialToAddress(NETWORK, scriptHashToCredential(allocHash));

  console.log(`AllocationDatum address: ${allocAddr}`);
  console.log(`ALLOC_ID:                ${ALLOC_ID}\n`);

  // ── Setup Lucid + wallet ──────────────────────────────────────
  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);

  const walletAddr = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(walletAddr);
  if (!paymentCredential) throw new Error("Cannot derive payment credential");
  const walletPkh = paymentCredential.hash;
  console.log(`Wallet: ${walletAddr}\n`);

  // ── Tìm AllocationDatum UTxO theo alloc_id ───────────────────
  console.log("Đang tìm AllocationDatum UTxO...");
  const allocUtxos = await lucid.utxosAt(allocAddr);

  let targetUtxo: UTxO | null = null;
  let allocDatum: AllocationDatum | null = null;

  for (const u of allocUtxos) {
    const d = tryDecodeDatum(u);
    if (d && d.alloc_id === ALLOC_ID) {
      targetUtxo = u;
      allocDatum = d;
      break;
    }
  }

  if (!targetUtxo || !allocDatum) {
    throw new Error(
      `Không tìm thấy AllocationDatum với alloc_id=${ALLOC_ID}.\n` +
      `UTxOs tại ${allocAddr}: ${allocUtxos.length}`,
    );
  }

  console.log(`Tìm thấy: ${targetUtxo.txHash}#${targetUtxo.outputIndex}`);

  // ── In trạng thái hiện tại ────────────────────────────────────
  const { start_epoch, total_epochs, expiry_epoch, claimed_epochs, magic_per_epoch } = allocDatum;
  const claimedSet = new Set(claimed_epochs.map(e => e.toString()));

  console.log(`\nEpoch range: [${start_epoch}, ${start_epoch + total_epochs - 1n}]`);
  console.log(`Claimed:     [${claimed_epochs.join(", ") || "none"}]`);

  const remaining: bigint[] = [];
  for (let e = start_epoch; e < start_epoch + total_epochs; e++) {
    if (!claimedSet.has(e.toString())) remaining.push(e);
  }
  console.log(`Remaining:   [${remaining.join(", ")}]`);

  if (remaining.length === 0) {
    console.log("\n✅ Tất cả epochs đã được claimed. Không còn gì để làm.");
    return;
  }

  // ── Chọn epoch ────────────────────────────────────────────────
  let epochToClaim: bigint;
  if (EPOCH_ARG !== null) {
    if (!remaining.includes(EPOCH_ARG)) {
      throw new Error(`Epoch ${EPOCH_ARG} không hợp lệ hoặc đã claimed. Remaining: [${remaining.join(", ")}]`);
    }
    epochToClaim = EPOCH_ARG;
  } else {
    epochToClaim = remaining[0]; // Auto: epoch nhỏ nhất chưa claimed
  }

  console.log(`\nClaiming epoch: ${epochToClaim}`);

  // ── Sinh lại vouchers ─────────────────────────────────────────
  const vouchers = await generateEpochVouchers(
    ORACLE_PRIVATE_KEY,
    ALLOC_ID,
    start_epoch,
    total_epochs,
    magic_per_epoch,
    expiry_epoch,
  );
  const voucherIndex = Number(epochToClaim - start_epoch);
  console.log(`Voucher[${voucherIndex}]: ${vouchers[voucherIndex].slice(0, 16)}...`);

  // ── Collateral ────────────────────────────────────────────────
  const collateralUtxo = await ensureCollateralUtxo(lucid, walletAddr);

  // ── Build claim tx ────────────────────────────────────────────
  const newClaimed = [...claimed_epochs, epochToClaim].sort((a, b) => (a < b ? -1 : 1));
  const updatedDatum: AllocationDatum = { ...allocDatum, claimed_epochs: newClaimed };
  const updatedDatumCbor = Data.to(updatedDatum, AllocationDatumCodec);

  const claimRedeemer = Data.to(
    {
      ClaimEpoch: {
        epoch:  epochToClaim,
        um_ref: 0n,
      },
    },
    AllocationRedeemerCodec,
  );

  const claimTx = await lucid
    .newTx()
    .collectFrom([targetUtxo], claimRedeemer)
    .attach.SpendingValidator(allocScript)
    .pay.ToAddressWithData(
      allocAddr,
      { kind: "inline", value: updatedDatumCbor },
      { lovelace: 2_000_000n },
    )
    .addSigner(walletAddr)
    .validFrom(Date.now() - 60_000)
    .validTo(Date.now() + 3_600_000)
    .complete({ presetWalletInputs: [collateralUtxo] });

  const signedClaim = await claimTx.sign.withWallet().complete();
  const claimTxHash = await signedClaim.submit();

  console.log(`\n✅ Epoch ${epochToClaim} claimed!`);
  console.log(`   TxHash:   ${claimTxHash}`);
  console.log(`   Explorer: https://preview.cardanoscan.io/transaction/${claimTxHash}`);

  // ── Summary ───────────────────────────────────────────────────
  const stillRemaining = remaining.filter(e => e !== epochToClaim);
  console.log(`\nCòn lại ${stillRemaining.length} epochs: [${stillRemaining.join(", ")}]`);
  if (stillRemaining.length > 0) {
    console.log(`\nClaim tiếp: EPOCH=${stillRemaining[0]} ORACLE_PRIVATE_KEY=${ORACLE_PRIVATE_KEY} ALLOC_ID=${ALLOC_ID} START_EPOCH=${start_epoch} npm run claim:getmagic`);
  } else {
    console.log("\n🎉 Tất cả 6 epochs đã claimed!");
  }
}

main().catch(e => { console.error("\n❌", e.message ?? e); process.exit(1); });
