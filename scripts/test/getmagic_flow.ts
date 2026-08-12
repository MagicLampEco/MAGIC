// scripts/test/getmagic_flow.ts — E2E GetMAGIC flow on Preview testnet
// Dùng 1 ví cho cả Org và User (self-test). Oracle key sinh tự động.
//
// Flow:
//   1. Sinh oracle keypair (Ed25519)
//   2. Tạo OrderDatum UTxO tại otc_order address
//   3. Ký oracle settle message
//   4. Sinh 6 epoch vouchers
//   5. Settle order → tạo AllocationDatum UTxO
//   6. Claim epoch (start_epoch)
//
// Chạy: npx tsx test/getmagic_flow.ts
// Prerequisite:
//   - scripts/.env: BLOCKFROST_KEY, PRIVATE_KEY (hoặc WALLET_SEED), NETWORK=Preview
//   - Sau khi chạy 08_deploy_getmagic.ts: GETMAGIC_ALLOC_HASH, GETMAGIC_ORDER_HASH

import {
  Lucid, Blockfrost, Data,
  validatorToScriptHash,
  credentialToAddress, scriptHashToCredential,
  getAddressDetails, type UTxO,
} from "@lucid-evolution/lucid";
import { readFile } from "node:fs/promises";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet,
} from "../config.js";
import {
  OrderDatumSchema, AllocationDatumSchema,
  OrderRedeemerSchema, AllocationRedeemerSchema,
  MAGIC_PER_EPOCH, DEFAULT_TOTAL_EPOCHS, ORDER_EXPIRY_MS,
  type OrderDatum, type AllocationDatum,
} from "../../GetMAGIC/offchain/src/types.js";
import {
  signMsg, verifyMsg, generateNonce, generateEpochVouchers, deriveAllocId,
  buildOracleSettleMsg, hexToBytes, bytesToHex,
} from "../../GetMAGIC/offchain/src/oracle.js";
import { ed25519 } from "@noble/curves/ed25519";
import { loadBlueprint, findValidator, appliedScript } from "../applyParams.js";
import { otcOrderParams } from "../deployParams.js";

// ── Helpers ──────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function wait(label: string, ms = 20_000): Promise<void> {
  process.stdout.write(`   ⏳ ${label} (${ms / 1000}s)...`);
  return sleep(ms).then(() => { process.stdout.write(" done\n"); });
}

// Return true if UTxO has only lovelace (no other assets) — safe for collateral.
function isPureAda(u: UTxO): boolean {
  return Object.keys(u.assets).every(k => k === "lovelace");
}

/**
 * Ensure there is a pure-ADA UTxO available for use as collateral in Plutus txs.
 * Cardano protocol requires collateral inputs to contain only ADA.
 * Creates one if none found (regular tx — no Plutus, no collateral needed).
 */
async function ensureCollateralUtxo(
  lucid: ReturnType<typeof Lucid> extends Promise<infer T> ? T : never,
  walletAddr: string,
): Promise<UTxO> {
  const utxos = await lucid.wallet().getUtxos();
  const existing = utxos.find(u => isPureAda(u) && (u.assets.lovelace ?? 0n) >= 5_000_000n);
  if (existing) {
    console.log(`Collateral UTxO found: ${existing.txHash}#${existing.outputIndex} (${existing.assets.lovelace} lovelace)\n`);
    return existing;
  }

  console.log("No pure-ADA UTxO found — creating one (5 ADA to self)...");
  const splitTx = await lucid.newTx()
    .pay.ToAddress(walletAddr, { lovelace: 5_000_000n })
    .complete();
  const signedSplit = await splitTx.sign.withWallet().complete();
  const splitTxHash = await signedSplit.submit();
  console.log(`   TxHash:   ${splitTxHash}`);
  console.log(`   Explorer: https://preview.cardanoscan.io/transaction/${splitTxHash}`);

  await wait("Confirming collateral UTxO", 60_000);

  const fresh = await lucid.wallet().getUtxos();
  const newUtxo = fresh.find(u => u.txHash === splitTxHash && isPureAda(u));
  if (!newUtxo) throw new Error("Collateral UTxO not found after 60s — raise wait time.");
  console.log(`Collateral UTxO ready: ${newUtxo.txHash}#${newUtxo.outputIndex}\n`);
  return newUtxo;
}

// Convert hex order ID (ASCII bytes) → human-readable
function hexToAscii(hex: string): string {
  let str = "";
  for (let i = 0; i < hex.length; i += 2) {
    str += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  return str;
}

// Generate a random 16-char [A-Z0-9] order ID and return as hex bytes
function genOrderId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "";
  for (let i = 0; i < 16; i++) id += chars[Math.floor(Math.random() * chars.length)];
  // Encode as hex (ASCII)
  return Array.from(id).map(c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log("=== GetMAGIC E2E Flow — Preview Testnet ===\n");

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

  // ── Derive script hashes + addresses ─────────────────────────
  const allocRaw    = findV("magic_allocation.magic_allocation.spend");
  const allocScript = { type: "PlutusV3" as const, script: allocRaw.compiledCode };
  const allocHash   = validatorToScriptHash(allocScript);
  const allocAddr   = credentialToAddress(NETWORK, scriptHashToCredential(allocHash));

  // Apply THEO TÊN — cùng đường với deploy/08, nếu không hai bên sinh hash khác nhau.
  const bpGetMagic  = await loadBlueprint("GetMAGIC");
  const orderRaw    = findValidator(bpGetMagic, "otc_order.otc_order.spend");
  const { script: orderScript, hash: orderHash } = appliedScript(
    orderRaw, otcOrderParams({ allocScriptHash: allocHash }),
  );
  const orderAddr   = credentialToAddress(NETWORK, scriptHashToCredential(orderHash));

  console.log(`AllocationDatum address: ${allocAddr}`);
  console.log(`OTCOrder address:        ${orderAddr}\n`);

  // ── Setup Lucid + wallet ──────────────────────────────────────
  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);

  const walletAddr = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(walletAddr);
  if (!paymentCredential) throw new Error("Cannot derive payment credential");
  const walletPkh = paymentCredential.hash;

  console.log(`Wallet: ${walletAddr}`);
  console.log(`PKH:    ${walletPkh}`);

  const utxos   = await lucid.wallet().getUtxos();
  const balance = utxos.reduce((s, u) => s + (u.assets.lovelace ?? 0n), 0n);
  console.log(`Balance: ${balance / 1_000_000n} tADA\n`);

  if (balance < 10_000_000n) {
    throw new Error("Cần ≥ 10 tADA. Faucet: https://docs.cardano.org/cardano-testnet/tools/faucet");
  }

  // ── Step 0: Đảm bảo có pure-ADA UTxO để làm collateral ───────
  // Cardano yêu cầu collateral không được chứa token (ADA-only).
  // Ví này có nhiều token — cần tạo riêng nếu chưa có.
  console.log("── Step 0: Collateral UTxO ──");
  const collateralUtxo = await ensureCollateralUtxo(lucid, walletAddr);

  // ── Step 1: Sinh oracle Ed25519 keypair ───────────────────────
  console.log("── Step 1: Oracle keypair ──");
  const oraclePrivKey = bytesToHex(ed25519.utils.randomPrivateKey());
  const oracleVkey    = bytesToHex(ed25519.getPublicKey(hexToBytes(oraclePrivKey)));
  console.log(`Oracle private key: ${oraclePrivKey}`);
  console.log(`Oracle vkey:        ${oracleVkey}\n`);
  console.log("⚠️  Lưu oracle private key vào .env: ORACLE_PRIVATE_KEY nếu muốn dùng lại\n");

  // ── Step 2: Tạo OrderDatum UTxO ───────────────────────────────
  console.log("── Step 2: Tạo OrderDatum UTxO ──");

  const orderId       = genOrderId();
  const nowMs         = BigInt(Date.now());
  const expiryMs      = nowMs + BigInt(ORDER_EXPIRY_MS);
  // Org = User (self-test: ví đơn làm cả hai vai)
  const orgPkh        = walletPkh;
  const userPkh       = walletPkh;

  const orderDatum: OrderDatum = {
    order_id:         orderId,
    org_pkh:          orgPkh,
    user_pkh:         userPkh,
    user_stake_cred:  null,
    magic_per_epoch:  MAGIC_PER_EPOCH,
    total_epochs:     DEFAULT_TOTAL_EPOCHS,
    fiat_amount_vnd:  200_000n,
    created_posix_ms: nowMs,
    expiry_posix_ms:  expiryMs,
    oracle_vkey:      oracleVkey,
  };

  console.log(`Order ID: ${hexToAscii(orderId)}`);
  console.log(`Expires:  ${new Date(Number(expiryMs)).toISOString()}`);
  console.log(`Magic/epoch: ${MAGIC_PER_EPOCH} nanogic (10 MAGIC)`);
  console.log(`Total epochs: ${DEFAULT_TOTAL_EPOCHS}\n`);

  const orderDatumCbor = Data.to(orderDatum, OrderDatumSchema);

  const createOrderTx = await lucid
    .newTx()
    .pay.ToAddressWithData(
      orderAddr,
      { kind: "inline", value: orderDatumCbor },
      { lovelace: 2_000_000n },  // min ADA for UTxO
    )
    .validFrom(Date.now() - 60_000)
    .validTo(Date.now() + 3_600_000)
    .complete();

  const signedCreate = await createOrderTx.sign.withWallet().complete();
  const createTxHash = await signedCreate.submit();
  console.log(`✅ OrderDatum UTxO created!`);
  console.log(`   TxHash: ${createTxHash}`);
  console.log(`   Explorer: https://preview.cardanoscan.io/transaction/${createTxHash}\n`);

  await wait("Chờ confirmation", 45_000);

  // ── Step 3: Ký oracle settle message ─────────────────────────
  console.log("── Step 3: Oracle signing ──");

  const bankTxRef  = "NAPAS-TEST-" + Math.random().toString(36).slice(2, 10).toUpperCase();
  const oracleNonce = generateNonce(orderId, bankTxRef);
  const oracleTsMs  = BigInt(Date.now());

  const settleMsg = buildOracleSettleMsg(orderId, userPkh, oracleNonce, oracleTsMs);
  const oracleSig = await signMsg(oraclePrivKey, settleMsg);

  const sigValid = verifyMsg(oracleVkey, settleMsg, oracleSig);
  console.log(`Oracle nonce:     ${oracleNonce}`);
  console.log(`Oracle timestamp: ${oracleTsMs}`);
  console.log(`Oracle sig valid: ${sigValid}`);
  if (!sigValid) throw new Error("Oracle signature verification failed — aborting");

  // ── Step 4: Sinh epoch vouchers ───────────────────────────────
  console.log("\n── Step 4: Epoch vouchers ──");

  // Derive current epoch from Preview genesis (Preview genesis = 1666656000000 ms)
  const PREVIEW_GENESIS_MS = 1_666_656_000_000n;
  const MS_PER_EPOCH       = 86_400_000n;  // 1 day on Preview
  const currentEpoch       = (BigInt(Date.now()) - PREVIEW_GENESIS_MS) / MS_PER_EPOCH;
  const startEpoch         = currentEpoch;
  const expiryEpoch        = startEpoch + DEFAULT_TOTAL_EPOCHS;

  const allocId = deriveAllocId(orderId, userPkh);
  const vouchers = await generateEpochVouchers(
    oraclePrivKey,
    allocId,
    startEpoch,
    DEFAULT_TOTAL_EPOCHS,
    MAGIC_PER_EPOCH,
    expiryEpoch,
  );

  console.log(`Current epoch: ${currentEpoch}`);
  console.log(`Alloc ID:      ${allocId}`);
  console.log(`Vouchers (${vouchers.length}):`);
  vouchers.forEach((v, i) => console.log(`  epoch ${startEpoch + BigInt(i)}: ${v.slice(0, 16)}...`));

  // ── Step 5: Settle order → AllocationDatum ──────────────────
  console.log("\n── Step 5: Settle order ──");

  // Find the OrderDatum UTxO
  await wait("Fetch UTxOs", 3_000);
  const orderUtxos = await lucid.utxosAt(orderAddr);
  const orderUtxo  = orderUtxos.find(u =>
    u.txHash === createTxHash
  );
  if (!orderUtxo) throw new Error(`OrderDatum UTxO not found at ${orderAddr}. Tx may not be confirmed yet.`);

  console.log(`Found OrderDatum UTxO: ${orderUtxo.txHash}#${orderUtxo.outputIndex}`);

  // Construct AllocationDatum
  // org_vault_nft_policy: empty bytes for Phase 1 (no BurnBatch integration yet)
  const allocDatum: AllocationDatum = {
    alloc_id:             allocId,
    order_id:             orderId,
    org_pkh:              orgPkh,
    org_vault_nft_policy: "00",           // Phase 1 placeholder (no BurnBatch yet)
    beneficiary_pkh:      userPkh,
    beneficiary_stake:    null,
    magic_per_epoch:      MAGIC_PER_EPOCH,
    total_epochs:         DEFAULT_TOTAL_EPOCHS,
    claimed_epochs:       [],
    start_epoch:          startEpoch,
    expiry_epoch:         expiryEpoch,
    vouchers:             vouchers,
    oracle_vkey:          oracleVkey,
  };

  const allocDatumCbor  = Data.to(allocDatum, AllocationDatumSchema);
  const settleRedeemer  = Data.to(
    {
      Settle: {
        oracle_nonce:     oracleNonce,
        oracle_timestamp: oracleTsMs,
        oracle_signature: oracleSig,
        epoch_vouchers:   vouchers,
      },
    },
    OrderRedeemerSchema,
  );

  const settleTx = await lucid
    .newTx()
    .collectFrom([orderUtxo], settleRedeemer)
    .attach.SpendingValidator(orderScript)
    .pay.ToAddressWithData(
      allocAddr,
      { kind: "inline", value: allocDatumCbor },
      { lovelace: 2_000_000n },
    )
    .validFrom(Date.now() - 60_000)
    .validTo(Date.now() + 3_600_000)
    // presetWalletInputs: chỉ dùng pure-ADA UTxO để tránh CollateralContainsNonADA
    // và tránh stale UTxO từ tx trước chưa sync Blockfrost.
    .complete({ presetWalletInputs: [collateralUtxo] });

  const signedSettle = await settleTx.sign.withWallet().complete();
  const settleTxHash = await signedSettle.submit();

  console.log(`✅ Order settled! AllocationDatum created.`);
  console.log(`   TxHash:  ${settleTxHash}`);
  console.log(`   Explorer: https://preview.cardanoscan.io/transaction/${settleTxHash}\n`);

  await wait("Chờ confirmation settle tx", 50_000);

  // ── Step 6: Claim epoch ───────────────────────────────────────
  console.log("── Step 6: Claim epoch ──");

  const allocUtxos = await lucid.utxosAt(allocAddr);
  const allocUtxo  = allocUtxos.find(u => u.txHash === settleTxHash);

  // Tìm change output từ settle tx làm collateral cho claim tx.
  // Settle tx inputs: collateralUtxo (pure ADA) + orderDatumUtxo (pure ADA).
  // → Change output at walletAddr cũng là pure ADA.
  const walletUtxosAfterSettle = await lucid.utxosAt(walletAddr);
  const settleChangeUtxo = walletUtxosAfterSettle.find(u =>
    u.txHash === settleTxHash && isPureAda(u),
  );
  if (!settleChangeUtxo) throw new Error("Settle tx change UTxO not found — raise wait time or re-run.");
  if (!allocUtxo) throw new Error(`AllocationDatum UTxO not found. Tx may not be confirmed yet.`);

  console.log(`Found AllocationDatum: ${allocUtxo.txHash}#${allocUtxo.outputIndex}`);

  const epochToClaim = startEpoch;
  const newClaimed   = [epochToClaim];  // sorted ascending

  // Build updated AllocationDatum (claimed_epochs += [epochToClaim])
  const updatedAllocDatum: AllocationDatum = {
    ...allocDatum,
    claimed_epochs: newClaimed,
  };
  const updatedAllocCbor = Data.to(updatedAllocDatum, AllocationDatumSchema);

  const claimRedeemer = Data.to(
    {
      ClaimEpoch: {
        epoch:  epochToClaim,
        um_ref: 0n,   // Phase 1: integer 0 placeholder (um_ref = Data, ignored on-chain)
      },
    },
    AllocationRedeemerSchema,
  );

  const claimTx = await lucid
    .newTx()
    .collectFrom([allocUtxo], claimRedeemer)
    .attach.SpendingValidator(allocScript)
    .pay.ToAddressWithData(
      allocAddr,
      { kind: "inline", value: updatedAllocCbor },
      { lovelace: 2_000_000n },
    )
    .addSigner(walletAddr)   // beneficiary must sign
    .validFrom(Date.now() - 60_000)
    .validTo(Date.now() + 3_600_000)
    // Use settle tx change as collateral (pure ADA, confirmed fresh).
    .complete({ presetWalletInputs: [settleChangeUtxo] });

  const signedClaim = await claimTx.sign.withWallet().complete();
  const claimTxHash = await signedClaim.submit();

  console.log(`✅ Epoch ${epochToClaim} claimed!`);
  console.log(`   TxHash:  ${claimTxHash}`);
  console.log(`   Explorer: https://preview.cardanoscan.io/transaction/${claimTxHash}\n`);

  // ── Summary ───────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════════");
  console.log("✅ GetMAGIC E2E flow hoàn thành!");
  console.log("═══════════════════════════════════════════════════");
  console.log(`\nAlloc ID: ${allocId}`);
  console.log(`Epochs: ${Number(DEFAULT_TOTAL_EPOCHS)} total, 1 claimed (epoch ${epochToClaim}), ${Number(DEFAULT_TOTAL_EPOCHS) - 1} remaining`);
  console.log(`\nTx summary:`);
  console.log(`  Create order:  ${createTxHash}`);
  console.log(`  Settle order:  ${settleTxHash}`);
  console.log(`  Claim epoch:   ${claimTxHash}`);
  console.log(`\nLưu oracle key để claim các epoch còn lại:`);
  console.log(`  ORACLE_PRIVATE_KEY=${oraclePrivKey}`);
  console.log(`  ORACLE_VKEY=${oracleVkey}`);
  console.log(`  ALLOC_ID=${allocId}`);
  console.log(`  START_EPOCH=${startEpoch}`);
}

main().catch(e => { console.error("\n❌", e.message ?? e); process.exit(1); });
