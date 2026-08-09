// MagicSDK/src/createVault.ts — public entry point for vault creation
//
// Builds an UNSIGNED tx that pays LAMP into a new vault UTxO with a clean
// initial datum. Caller signs + submits.
//
// Usage (PhoenixKey-style integration):
//
//   import { createVault } from "@magiclamp/sdk";
//   import { readFile } from "node:fs/promises";
//
//   // 1. Load the unapplied vault validator CBOR (from MAGIC repo build output).
//   const snapshotPlutus = JSON.parse(await readFile("path/to/SnapshotGen/onchain/plutus.json", "utf8"));
//   const vaultUnappliedCbor = snapshotPlutus.validators.find(
//     v => v.title === "vault.vault.spend"
//   ).compiledCode;
//
//   // 2. Build the unsigned tx.
//   const { tx, vaultAddress, summary } = await createVault({
//     lucid,                  // Lucid Evolution with wallet selected
//     vaultType: "Snapshot",
//     protocol: {
//       network: "Preview",
//       lampPolicyId: "...",
//     },
//     validators: { vaultUnappliedCbor },
//     vault: {
//       ownerPkh: "<28-byte hex>",
//       lampDeposit: 1_000_000_000n,   // 1000 LAMP in oildrop
//       profile: "Flame",
//     },
//   });
//   console.log(summary);
//
//   // 3. Sign + submit (PhoenixKey's wallet abstraction does this).
//   const signed = await tx.sign.withWallet().complete();
//   const txHash = await signed.submit();

import { Data, toUnit, type UTxO } from "@lucid-evolution/lucid";
import { msPerEpoch, lampAssetName, type Network } from "@magiclamp/protocol-utils";

import type { CreateVaultParams, CreateVaultResult } from "./types.js";
import { VaultDatumSchema, VaultIdRedeemerSchema } from "./schemas.js";
import { applyVaultValidator } from "./validatorScripts.js";
import { buildInitialVaultDatum } from "./vaultDatum.js";
import { vaultIdAssetName } from "./vaultId.js";

const DEFAULT_VAULT_LOVELACE  = 2_000_000n;
const DEFAULT_PROFILE         = "Flame" as const;

export async function createVault(params: CreateVaultParams): Promise<CreateVaultResult> {
  const { lucid, vaultType, protocol, validators, vault } = params;

  // ── Defaults ─────────────────────────────────────────────────
  // Network-derived, not a tLAMP literal — must match what buildParamsList
  // bakes into the validator, or the vault UTxO carries an asset the script
  // cannot see.
  const assetName = protocol.lampAssetName ?? lampAssetName(protocol.network);
  const vaultLovelace = vault.vaultLovelace ?? DEFAULT_VAULT_LOVELACE;
  const profile       = vault.profile ?? DEFAULT_PROFILE;

  // ── Sanity checks ────────────────────────────────────────────
  if (!protocol.lampPolicyId) {
    throw new Error("protocol.lampPolicyId is required");
  }
  if (vault.lampDeposit <= 0n) {
    throw new Error(`vault.lampDeposit must be > 0 oildrop (got ${vault.lampDeposit})`);
  }
  // Per-vault-type sanity is enforced inside applyVaultValidator.

  // ── Apply validator per-network → vault address ──────────────
  const { vaultScript, vaultScriptHash, vaultAddress } = applyVaultValidator(
    vaultType, validators, protocol,
  );

  // ── Current PROTOCOL epoch ────────────────────────────────────
  // Validator computes epoch = posix_ms / ms_per_epoch. Initial datum's
  // `last_updated_epoch` should match the current epoch so that snapshot
  // can fire from the NEXT epoch boundary.
  const tipPosixMs   = params.tipPosixMs ?? BigInt(Date.now());
  const msPer        = protocol.msPerEpoch ?? msPerEpoch(protocol.network);
  const currentEpoch = tipPosixMs / msPer;

  // ── Verify caller's wallet has enough LAMP ───────────────────
  const lampUnit = toUnit(protocol.lampPolicyId, assetName);
  const walletAddress = await lucid.wallet().address();
  const walletUtxos   = await lucid.wallet().getUtxos();
  const lampBalance   = walletUtxos.reduce(
    (s, u) => s + (u.assets[lampUnit] ?? 0n), 0n,
  );
  if (lampBalance < vault.lampDeposit) {
    throw new Error(
      `Wallet has ${lampBalance} oildrop LAMP (= ${lampBalance / 1_000_000n} LAMP); ` +
      `need ${vault.lampDeposit} oildrop (= ${vault.lampDeposit / 1_000_000n} LAMP).`,
    );
  }

  // ── Chọn seed UTxO → danh tính vault (INV-VAULT-IDENTITY) ────
  // NFT danh-tính là one-shot theo seed: seed phải là input THẬT của chính tx
  // này (`expect list.any(tx.inputs, ...)` trong validate_mint_vault_id), nên
  // nó được ép vào tx bằng .collectFrom([...]) chứ không để coin-selection
  // quyết định.
  const seedUtxo = params.seedUtxo ?? pickSeedUtxo(walletUtxos);
  const vaultIdName = vaultIdAssetName({
    txHash:      seedUtxo.txHash,
    outputIndex: seedUtxo.outputIndex,
  });
  const vaultIdUnit = toUnit(vaultScriptHash, vaultIdName);

  // Redeemer mint: MintVaultId { seed } — constructor 0 (xem schemas.ts).
  const mintRedeemer = Data.to(
    {
      MintVaultId: {
        seed: {
          transaction_id: seedUtxo.txHash,
          output_index:   BigInt(seedUtxo.outputIndex),
        },
      },
    } as never,
    VaultIdRedeemerSchema,
  );

  // ── Build initial VaultDatum ─────────────────────────────────
  // Mọi trường TÍCH LUỸ phải rỗng/0 — validate_mint_vault_id ép từng trường một.
  if (vault.personalDelegate != null) {
    throw new Error(
      `vault.personalDelegate không dùng được ở createVault: datum khởi sinh ` +
      `bắt buộc personal_delegate == None. Dùng SetDelegate sau khi vault tồn tại.`,
    );
  }
  const initialVault = buildInitialVaultDatum({
    ownerPkh:         vault.ownerPkh,
    lampBalanceOildrop:   vault.lampDeposit,
    profile,
    currentEpoch,
  });

  // Lucid Evolution's Data.to expects a TObject-typed value; the
  // plain-bigint shape from buildInitialVaultDatum() is structurally
  // compatible at runtime but the inferred TS type doesn't match the
  // schema's TUnsafe<...> wrappers. Cast — same workaround used by
  // every other vault SDK in this repo (snapshot.ts, instant.ts, ...).
  const vaultDatumCbor = Data.to(initialVault as never, VaultDatumSchema);

  // ── Build tx ─────────────────────────────────────────────────
  // 4 mảnh BẮT BUỘC khớp nhau, thiếu một là validator từ chối:
  //   (1) seed UTxO nằm trong inputs                → one-shot uniqueness
  //   (2) mint đúng 1 NFT (policy = vault hash)     → dict.size(own_tokens) == 1
  //   (3) NFT nằm trong output tại địa chỉ vault    → carriers == [vault_out]
  //   (4) owner ký (extra_signatories)              → list.has(tx.extra_signatories, vd.owner)
  // Vault vừa là spending validator vừa là minting policy ⇒ CÙNG một CBOR đã
  // apply params; policy_id chính là vaultScriptHash.
  const tx = await lucid
    .newTx()
    .collectFrom([seedUtxo])                          // (1)
    .mintAssets({ [vaultIdUnit]: 1n }, mintRedeemer)  // (2)
    .attach.MintingPolicy(vaultScript)
    .pay.ToAddressWithData(                           // (3)
      vaultAddress,
      { kind: "inline", value: vaultDatumCbor },
      {
        lovelace:      vaultLovelace,
        [lampUnit]:    vault.lampDeposit,
        [vaultIdUnit]: 1n,
      },
    )
    .addSignerKey(vault.ownerPkh)                     // (4)
    .complete();

  const summary = formatSummary({
    vaultType,
    network: protocol.network,
    walletAddress,
    vaultAddress,
    vaultScriptHash,
    ownerPkh: vault.ownerPkh,
    profile,
    lampDeposit: vault.lampDeposit,
    currentEpoch,
    vaultIdName,
    seedRef: `${seedUtxo.txHash}#${seedUtxo.outputIndex}`,
  });

  return {
    tx, vaultAddress, vaultScriptHash, vaultScript,
    vaultIdPolicyId: vaultScriptHash,
    vaultIdAssetName: vaultIdName,
    vaultIdUnit,
    seedUtxo,
    summary,
  };
}

// ── helpers ───────────────────────────────────────────────────

/**
 * Chọn seed UTxO một cách TẤT ĐỊNH (cùng ví + cùng tập UTxO ⇒ cùng seed ⇒ cùng
 * tên NFT), ưu tiên UTxO chỉ có ADA và nhiều ADA nhất: nó không kéo theo token
 * lạ vào tx và gần như luôn đủ trả phí. Bất kỳ UTxO ví nào cũng hợp lệ với
 * validator — đây chỉ là lựa chọn cho dễ dựng tx.
 */
export function pickSeedUtxo(utxos: UTxO[]): UTxO {
  if (utxos.length === 0) {
    throw new Error(
      "Ví không có UTxO nào để làm seed cho NFT danh-tính vault. Nạp ADA vào ví trước.",
    );
  }
  const rank = (u: UTxO) => (Object.keys(u.assets).length === 1 ? 0 : 1);
  return [...utxos].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const la = a.assets["lovelace"] ?? 0n;
    const lb = b.assets["lovelace"] ?? 0n;
    if (la !== lb) return lb > la ? 1 : -1;
    if (a.txHash !== b.txHash) return a.txHash < b.txHash ? -1 : 1;
    return a.outputIndex - b.outputIndex;
  })[0];
}

function formatSummary(o: {
  vaultType:        string;
  network:          Network;
  walletAddress:    string;
  vaultAddress:     string;
  vaultScriptHash:  string;
  ownerPkh:         string;
  profile:          string;
  lampDeposit:      bigint;
  currentEpoch:     bigint;
  vaultIdName:      string;
  seedRef:          string;
}): string {
  return [
    `═══ MagicLamp createVault ═══`,
    `Vault type:      ${o.vaultType}  (${o.network})`,
    `Owner pkh:       ${o.ownerPkh}`,
    `Profile:         ${o.profile}`,
    `LAMP deposit:    ${o.lampDeposit / 1_000_000n} LAMP (${o.lampDeposit} oildrop)`,
    `Current epoch:   ${o.currentEpoch}  (POSIX-derived)`,
    `Vault address:   ${o.vaultAddress}`,
    `Vault hash:      ${o.vaultScriptHash}`,
    `Seed UTxO:       ${o.seedRef}`,
    `Vault-ID NFT:    ${o.vaultScriptHash}.${o.vaultIdName}`,
    `Wallet (funder): ${o.walletAddress}`,
    ``,
    `✓  Unsigned tx ready. Caller must sign + submit (owner key must sign).`,
  ].join("\n");
}

// ── re-exports for convenience ────────────────────────────────
export { applyVaultValidator, applyShardValidator } from "./validatorScripts.js";
export { buildInitialVaultDatum } from "./vaultDatum.js";
export { VaultDatumSchema, VaultIdRedeemerSchema } from "./schemas.js";
export { vaultIdAssetName, vaultIdSeedCbor, type VaultIdSeed } from "./vaultId.js";
export type {
  Profile, VaultType, ProtocolParams, ValidatorBundle,
  InitialVaultConfig, CreateVaultParams, CreateVaultResult,
} from "./types.js";
