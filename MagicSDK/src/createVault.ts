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
//   //    Hai loại vault còn sống: ScheduleGen và InstantGen.
//   const schedulePlutus = JSON.parse(await readFile("path/to/ScheduleGen/onchain/plutus.json", "utf8"));
//   const vaultUnappliedCbor = schedulePlutus.validators.find(
//     v => v.title === "vault.vault.spend"
//   ).compiledCode;
//
//   // 2. Build the unsigned tx.
//   const { tx, vaultAddress, summary } = await createVault({
//     lucid,                  // Lucid Evolution with wallet selected
//     vaultType: "Schedule",
//     protocol: {
//       network: "Preview",
//       lampPolicyId: "...",
//       shardPolicyId: "...",   // Schedule-only; Instant cần um*/backing* thay vào
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

import {
  Data, toUnit, validatorToScriptHash, credentialToAddress, scriptHashToCredential,
  type UTxO, type Validator,
} from "@lucid-evolution/lucid";
import {
  msPerEpoch, lampAssetName, applyOwnerAuth, resolveOwnerAuth, ownerRefToString,
  assertDidPaymentAddress, planDidPaymentFunding, FundingError,
  DID_PAYMENT_SPEND_REDEEMER, FUNDING_MAX_VALIDITY_MS, collateralCompleteOptions,
  type Network, type OwnerAuth, type DidPaymentPlan,
} from "@magiclamp/protocol-utils";
import { resolveOwnerInput } from "./ownerInput.js";
import { didPaymentLucidPorts, type DidPaymentFundingInput } from "./didPaymentLucid.js";

import type { CreateVaultParams, CreateVaultResult } from "./types.js";
import { InstantVaultDatumSchema, VaultDatumSchema, VaultIdRedeemerSchema } from "./schemas.js";
import { applyVaultValidator } from "./validatorScripts.js";
import { assertLampPolicyId } from "./lampPolicy.js";
import { buildInitialVaultDatum } from "./vaultDatum.js";
import { vaultIdAssetName } from "./vaultId.js";
import { minAdaForVaultWithMargin } from "./minAdaVault.js";

// 🪦 `DEFAULT_VAULT_LOVELACE = 2_000_000n` đã GỠ. Nó là một hằng đứng ở chỗ
// một phép tính phải đứng — xem `minAdaVault.ts`. Đừng dựng lại nó.
const DEFAULT_PROFILE         = "Flame" as const;

export async function createVault(params: CreateVaultParams): Promise<CreateVaultResult> {
  const { lucid, vaultType, protocol, validators, vault } = params;

  // ── Defaults ─────────────────────────────────────────────────
  // Network-derived, not a tLAMP literal — must match what buildParamsList
  // bakes into the validator, or the vault UTxO carries an asset the script
  // cannot see.
  const assetName = protocol.lampAssetName ?? lampAssetName(protocol.network);
  const profile       = vault.profile ?? DEFAULT_PROFILE;

  // ── Sanity checks ────────────────────────────────────────────
  // Cổng THẬT ở `buildParamsList` (policy id nướng vào script hash ở đó). Gọi lại ở
  // đây để câu lỗi mang tên đường người ngoài thật sự đi, và để chỗ này không còn là
  // một phép kiểm-rỗng trông như đã kiểm: bản trước chỉ hỏi chuỗi có rỗng không, nên
  // một policy nhái 56-hex đi qua không tiếng động.
  assertLampPolicyId(protocol.lampPolicyId, "createVault");
  if (typeof vault.lampDeposit !== "bigint" || vault.lampDeposit <= 0n) {
    throw new Error(`vault.lampDeposit must be > 0 oildrop (got ${vault.lampDeposit})`);
  }
  // Chủ + cách chứng minh quyền chủ — kiểm TRƯỚC khi chạm ví hay chuỗi. Genesis ép
  // `owner_authorized(tx, vd.owner)`, nên chủ script mà thiếu nhân chứng thì không có
  // giao dịch tạo nào qua được: ném ngay ở đây, không dựng một tx chết.
  const owner = resolveOwnerInput(vault, "createVault");
  const ownerAuth = resolveOwnerAuth(owner, params.ownerAuth);

  // ── Validator vault: tự apply, HOẶC nhận bản đã apply kèm hash chờ đợi ──
  const { vaultScript, vaultScriptHash, vaultAddress } = resolveVaultScript(params);

  // ── Current PROTOCOL epoch ────────────────────────────────────
  // Validator computes epoch = posix_ms / ms_per_epoch. Initial datum's
  // `last_updated_epoch` should match the current epoch so that generation
  // can fire from the NEXT epoch boundary.
  const tipPosixMs   = params.tipPosixMs ?? BigInt(Date.now());
  const msPer        = protocol.msPerEpoch ?? msPerEpoch(protocol.network);
  const currentEpoch = tipPosixMs / msPer;

  // ── Verify caller's wallet has enough LAMP ───────────────────
  const lampUnit = toUnit(protocol.lampPolicyId, assetName);
  const walletAddress = await lucid.wallet().address();
  const walletUtxos   = await lucid.wallet().getUtxos();
  const funding       = params.funding;
  // Có `funding` ⟹ LAMP đến từ ví Phoenix, ví đang chọn chỉ trả phí: kiểm hash và nhân
  // chứng của chủ ngay đây, TRƯỚC khi dựng gì. Số dư LAMP của ví Phoenix kiểm ở bước chọn
  // UTxO bên dưới (cần min-ADA của vault, mà min-ADA cần datum).
  const fundingPorts = funding === undefined ? undefined : fundingPortsOf(lucid, funding);
  const lampBalance   = funding !== undefined ? vault.lampDeposit : walletUtxos.reduce(
    (s, u) => s + (u.assets[lampUnit] ?? 0n), 0n,
  );
  if (funding !== undefined) assertFundingWitness(funding, ownerAuth);
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
      `vault.personalDelegate không dùng được: datum khởi sinh bắt buộc ` +
      `personal_delegate == None, và nhánh uỷ nhiệm đã bị bỏ khỏi mô hình ngày ` +
      `2026-09-16 (Nợ #14) — SetDelegate nay chỉ XOÁ được, không đặt được.`,
    );
  }
  const initialVault = buildInitialVaultDatum({
    owner,
    lampBalanceOildrop:   vault.lampDeposit,
    profile,
    currentEpoch,
    vaultType,
  });

  // Lucid Evolution's Data.to expects a TObject-typed value; the
  // plain-bigint shape from buildInitialVaultDatum() is structurally
  // compatible at runtime but the inferred TS type doesn't match the
  // schema's TUnsafe<...> wrappers. Cast — same workaround used by
  // every other vault SDK in this repo (instant.ts, schedule.ts).
  //
  // Lược đồ đi theo `vaultType`, không phải một lược đồ chung: két Instant mang
  // 18 trường, két Schedule 17 (`schemas.ts` đầu tệp). Hai vế phải khớp nhau —
  // lệch thì `Data.to` ném ngay tại đây, trước khi có giao dịch nào.
  const datumSchema = vaultType === "Instant" ? InstantVaultDatumSchema : VaultDatumSchema;
  const vaultDatumCbor = Data.to(initialVault as never, datumSchema);

  // ── min-ADA: TÍNH từ chính datum, không gõ cứng (Nợ #43, vế còn lại) ───────
  // Bản trước mặc định một hằng 2 ADA cho một UTxO mà datum phình theo số batch
  // và số holding. Hằng ấy đúng ở két rỗng và sai ngay từ batch đầu tiên — và
  // sổ cái từ chối ở lúc GỬI, sau khi người dùng đã ký. Xem `minAdaVault.ts`.
  //
  // Người gọi truyền tay thì phải LỚN HƠN mức tính được, không nhỏ hơn: một
  // giá trị tay quá thấp là đúng cái hỏng đang vá, nên nó bị NÉM chứ không bị
  // âm thầm nâng lên. Lời gọi tay hợp lệ duy nhất là nâng thêm.
  const minVaultLovelace = minAdaForVaultWithMargin(vaultDatumCbor);
  if (vault.vaultLovelace !== undefined && vault.vaultLovelace < minVaultLovelace) {
    throw new Error(
      `vault.vaultLovelace = ${vault.vaultLovelace} lovelace THẤP HƠN min-ADA tính được ` +
      `${minVaultLovelace} cho datum ${vaultDatumCbor.length / 2} byte. Sổ cái sẽ từ chối ` +
      `giao dịch ở lúc GỬI, sau khi đã ký. Bỏ trống trường này để SDK tự tính, hoặc truyền ` +
      `một giá trị LỚN HƠN.`,
    );
  }
  const vaultLovelace = vault.vaultLovelace ?? minVaultLovelace;

  // ── Nạp từ did_payment: chọn tối thiểu đủ LAMP + min-ADA vault + min-ADA phần thối ──
  // Mục rút `did_stake` (chủ script) là tiền của CHỦ DID vào giao dịch: nó thối về ví
  // Phoenix cùng phần thối, không để bộ cân bằng dồn sang ví trả phí.
  let fundingPlan: DidPaymentPlan<UTxO> | undefined;
  if (funding !== undefined) {
    fundingPlan = planDidPaymentFunding({
      utxos: funding.utxos,
      need: { lovelace: vaultLovelace, [lampUnit]: vault.lampDeposit },
      primaryUnit: lampUnit,
      returnAddress: funding.address,
      extraLovelace: withdrawLovelaceOf(ownerAuth),
    }, fundingPorts!);
    const seedTaken = fundingPlan.selected.some(
      u => u.txHash === seedUtxo.txHash && u.outputIndex === seedUtxo.outputIndex,
    );
    if (seedTaken) {
      throw new FundingError("FUNDING_SHAPE",
        `seed UTxO trùng một UTxO did_payment — seed phải là UTxO của ví trả phí.`);
    }
  }

  // ── Build tx ─────────────────────────────────────────────────
  // 4 mảnh BẮT BUỘC khớp nhau, thiếu một là validator từ chối:
  //   (1) seed UTxO nằm trong inputs                → one-shot uniqueness
  //   (2) mint đúng 1 NFT (policy = vault hash)     → dict.size(own_tokens) == 1
  //   (3) NFT nằm trong output tại địa chỉ vault    → carriers == [vault_out]
  //   (4) quyền chủ                                  → owner_authorized(tx, vd.owner):
  //       khoá ⟹ pkh ký; script ⟹ mục rút Script(h) (`applyOwnerAuth`)
  // Vault vừa là spending validator vừa là minting policy ⇒ CÙNG một CBOR đã
  // apply params; policy_id chính là vaultScriptHash.
  const txBody = lucid
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
    );
  // (5) chỉ khi nạp từ did_payment: chi UTxO đã chọn, mỗi cái một redeemer `Spend`, script
  //     đính inline; phần thối về CHÍNH ví Phoenix; hạn dùng ≤ 1 giờ (mô hình ví trả phí bên
  //     thứ ba). Anchor + controller + thiết bị: chủ script thì nhân chứng `did_stake` đã gắn
  //     đúng bộ đó (`assertFundingWitness` so), gắn lại là nhân đôi reference input và chữ ký.
  let fundedBody = txBody;
  if (funding !== undefined && fundingPlan !== undefined) {
    fundedBody = fundedBody
      .collectFrom(fundingPlan.selected, DID_PAYMENT_SPEND_REDEEMER)
      .attach.SpendingValidator({ type: "PlutusV3", script: funding.didPaymentScriptCbor.toLowerCase() });
    if (fundingPlan.returned !== null) fundedBody = fundedBody.pay.ToAddress(funding.address, fundingPlan.returned);
    if (ownerAuth.kind !== "script") {
      fundedBody = fundedBody
        .readFrom([funding.anchorRefUtxo])
        .addSignerKey(funding.controllerPkh)
        .addSignerKey(funding.deviceKeyHash);
    }
    fundedBody = fundedBody.validTo(Number(tipPosixMs + FUNDING_MAX_VALIDITY_MS));
  }
  const tx = await applyOwnerAuth(fundedBody, ownerAuth)
    .complete(collateralCompleteOptions(params.collateralLovelace));   // (4)

  const summary = formatSummary({
    vaultType,
    network: protocol.network,
    walletAddress,
    vaultAddress,
    vaultScriptHash,
    owner: ownerRefToString(owner),
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
    owner,
    summary,
    ...(fundingPlan === undefined ? {} : {
      funding: { selected: fundingPlan.selected, spent: fundingPlan.spent, returned: fundingPlan.returned },
    }),
  };
}

// ── nạp từ did_payment ────────────────────────────────────────

function fundingPortsOf(lucid: CreateVaultParams["lucid"], funding: DidPaymentFundingInput) {
  const cpub = (lucid as { config?: () => { protocolParameters?: { coinsPerUtxoByte?: unknown } } })
    .config?.().protocolParameters?.coinsPerUtxoByte;
  if (typeof cpub !== "bigint") {
    throw new FundingError("FUNDING_SHAPE",
      `lucid không có tham số giao thức coinsPerUtxoByte — không tính được min-ADA của phần thối.`);
  }
  const ports = didPaymentLucidPorts(cpub);
  assertDidPaymentAddress(funding.didPaymentScriptCbor, funding.address, ports);
  if (!Array.isArray(funding.utxos) || funding.anchorRefUtxo === null || typeof funding.anchorRefUtxo !== "object") {
    throw new FundingError("FUNDING_SHAPE", `funding.utxos phải là mảng và funding.anchorRefUtxo phải có.`);
  }
  return ports;
}

/**
 * Bộ ký của `did_payment` = controller + thiết bị. Chủ script thì nhân chứng `did_stake` đã
 * mang bộ ký của nó; hai bộ PHẢI trùng (cùng một DID), không nhận bộ khác. Nhân chứng không
 * khai `details.requiredSigners` ⟹ không so được ⟹ NÉM, không đoán.
 */
function assertFundingWitness(funding: DidPaymentFundingInput, ownerAuth: OwnerAuth<any>): void {
  const hex28 = /^[0-9a-f]{56}$/;
  if (!hex28.test(funding.controllerPkh) || !hex28.test(funding.deviceKeyHash)) {
    throw new FundingError("FUNDING_SHAPE", `controllerPkh / deviceKeyHash phải là 56 hex thường.`);
  }
  if (ownerAuth.kind !== "script") return;
  const signers = (ownerAuth as { details?: { requiredSigners?: unknown } }).details?.requiredSigners;
  if (!Array.isArray(signers) || signers.length !== 2 ||
      signers[0] !== funding.controllerPkh || signers[1] !== funding.deviceKeyHash) {
    throw new FundingError("FUNDING_WITNESS_MISMATCH",
      `bộ ký của did_payment (controller + thiết bị) phải TRÙNG bộ ký của nhân chứng did_stake.`,
      { owner_auth_signers: Array.isArray(signers) ? signers : null });
  }
}

/** Lượng rút `did_stake` đi vào giao dịch; chủ khoá ⟹ 0. Chủ script không khai ⟹ NÉM. */
function withdrawLovelaceOf(ownerAuth: OwnerAuth<any>): bigint {
  if (ownerAuth.kind !== "script") return 0n;
  const w = (ownerAuth as { details?: { withdrawLovelace?: unknown } }).details?.withdrawLovelace;
  if (typeof w !== "bigint" || w < 0n) {
    throw new FundingError("FUNDING_WITNESS_MISMATCH",
      `nhân chứng chủ script không khai details.withdrawLovelace — không biết phần rút phải thối về đâu.`);
  }
  return w;
}

/** Script vault từ ĐÚNG MỘT nguồn: blueprint chưa apply, hoặc bản đã apply + hash chờ đợi. */
function resolveVaultScript(params: CreateVaultParams): {
  vaultScript: Validator; vaultScriptHash: string; vaultAddress: string;
} {
  const { validators, appliedVault, vaultType, protocol } = params;
  if ((validators === undefined) === (appliedVault === undefined)) {
    throw new Error(
      `createVault: truyền ĐÚNG MỘT trong \`validators\` (blueprint chưa apply) và ` +
      `\`appliedVault\` (script đã apply + expectedScriptHash) — nhận ` +
      `${validators === undefined ? "cả hai trống" : "cả hai"}.`,
    );
  }
  if (validators !== undefined) {
    // Per-vault-type sanity is enforced inside applyVaultValidator.
    return applyVaultValidator(vaultType, validators, protocol);
  }
  const script = appliedVault!.script;
  const expected = appliedVault!.expectedScriptHash;
  if (script?.type !== "PlutusV3" || typeof script.script !== "string" || script.script === "") {
    throw new Error(`createVault: appliedVault.script phải là PlutusV3 CBOR khác rỗng.`);
  }
  const vaultScriptHash = validatorToScriptHash(script);
  if (typeof expected !== "string" || vaultScriptHash !== expected.toLowerCase()) {
    throw new Error(
      `createVault: appliedVault.script băm ra ${vaultScriptHash} nhưng expectedScriptHash = ` +
      `${String(expected)}. Tạo vault ở địa chỉ này là tạo nó NGOÀI lần deploy đang dùng.`,
    );
  }
  const vaultAddress = credentialToAddress(protocol.network, scriptHashToCredential(vaultScriptHash));
  return { vaultScript: script, vaultScriptHash, vaultAddress };
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
  owner:            string;
  profile:          string;
  lampDeposit:      bigint;
  currentEpoch:     bigint;
  vaultIdName:      string;
  seedRef:          string;
}): string {
  return [
    `═══ MagicLamp createVault ═══`,
    `Vault type:      ${o.vaultType}  (${o.network})`,
    `Owner:           ${o.owner}`,
    `Profile:         ${o.profile}`,
    `LAMP deposit:    ${o.lampDeposit / 1_000_000n} LAMP (${o.lampDeposit} oildrop)`,
    `Current epoch:   ${o.currentEpoch}  (POSIX-derived)`,
    `Vault address:   ${o.vaultAddress}`,
    `Vault hash:      ${o.vaultScriptHash}`,
    `Seed UTxO:       ${o.seedRef}`,
    `Vault-ID NFT:    ${o.vaultScriptHash}.${o.vaultIdName}`,
    `Wallet (funder): ${o.walletAddress}`,
    ``,
    `✓  Unsigned tx ready. Caller must sign + submit (owner witness: key signature or Script(h) withdrawal).`,
  ].join("\n");
}

// ── re-exports for convenience ────────────────────────────────
export { applyVaultValidator, applyShardValidator } from "./validatorScripts.js";
export { buildInitialVaultDatum } from "./vaultDatum.js";
export { InstantVaultDatumSchema, VaultDatumSchema, VaultIdRedeemerSchema } from "./schemas.js";
export { vaultIdAssetName, vaultIdSeedCbor, type VaultIdSeed } from "./vaultId.js";
export type {
  Profile, VaultType, ProtocolParams, ValidatorBundle,
  InitialVaultConfig, CreateVaultParams, CreateVaultResult,
} from "./types.js";
