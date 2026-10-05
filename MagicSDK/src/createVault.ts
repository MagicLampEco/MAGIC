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
  CML, Data, toUnit, validatorToScriptHash, credentialToAddress, scriptHashToCredential,
  type TxBuilder, type TxSignBuilder, type UTxO, type Validator,
} from "@lucid-evolution/lucid";
import {
  msPerEpoch, lampAssetName, applyOwnerAuth, resolveOwnerAuth, ownerRefToString,
  assertDidPaymentAddress, planDidPaymentFunding, FundingError,
  DID_PAYMENT_SPEND_REDEEMER, FUNDING_MAX_VALIDITY_MS, collateralCompleteOptions,
  windowOf, type Network, type OwnerAuth, type DidPaymentPlan,
} from "@magiclamp/protocol-utils";
import { resolveOwnerInput } from "./ownerInput.js";
import {
  didPaymentLucidPorts, DID_PAYMENT_FEE_HEADROOM_LOVELACE, type DidPaymentFundingInput,
} from "./didPaymentLucid.js";

import type { CreateVaultParams, CreateVaultResult } from "./types.js";
import { InstantVaultDatumSchema, VaultDatumSchema, VaultIdRedeemerSchema } from "./schemas.js";
import { applyVaultValidator, windowOriginOf } from "./validatorScripts.js";
import { assertLampPolicyId } from "./lampPolicy.js";
import { buildInitialVaultDatum, normalizeWakemeLink } from "./vaultDatum.js";
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
  assertLampPolicyId(
    protocol.lampPolicyId, "createVault", protocol.lampRehearsalAck, protocol.network,
  );
  // Két Instant mở được với 0 LAMP (người mới chỉ có LAMP mượn ở két Wakeme — genesis IG không
  // ép > 0); két Schedule vẫn > 0 (lý do: `vaultDatum.ts` ▸ `buildInitialVaultDatum`).
  if (typeof vault.lampDeposit !== "bigint" || vault.lampDeposit < 0n
      || (vault.lampDeposit === 0n && vaultType !== "Instant")) {
    throw new Error(
      `vault.lampDeposit must be > 0 oildrop for Schedule vaults, >= 0 for Instant (got ${vault.lampDeposit})`);
  }
  // `wakeme_link` khai sẵn lúc genesis — chỉ két Instant. Kiểm sớm, trước khi chạm ví.
  const wakemeLink = normalizeWakemeLink(vault.wakemeLink, "createVault");
  if (wakemeLink !== "" && vaultType !== "Instant") {
    throw new Error(`createVault: vault.wakemeLink chỉ có ở két Instant.`);
  }
  // Chủ + cách chứng minh quyền chủ — kiểm TRƯỚC khi chạm ví hay chuỗi. Genesis ép
  // `owner_authorized(tx, vd.owner)`, nên chủ script mà thiếu nhân chứng thì không có
  // giao dịch tạo nào qua được: ném ngay ở đây, không dựng một tx chết.
  const owner = resolveOwnerInput(vault, "createVault");
  const ownerAuth = resolveOwnerAuth(owner, params.ownerAuth);

  // ── Validator vault: tự apply, HOẶC nhận bản đã apply kèm hash chờ đợi ──
  const { vaultScript, vaultScriptHash, vaultAddress } = resolveVaultScript(params);

  // ── Current PROTOCOL epoch ────────────────────────────────────
  // Validator computes epoch = (posix_ms − window_origin_ms) / ms_per_epoch (chia sàn).
  // Gốc phải là ĐÚNG gốc đã apply vào két (`windowOriginOf`). Initial datum's
  // `last_updated_epoch` should match the current epoch so that generation
  // can fire from the NEXT epoch boundary.
  const tipPosixMs   = params.tipPosixMs ?? BigInt(Date.now());
  const msPer        = protocol.msPerEpoch ?? msPerEpoch(protocol.network);
  const currentEpoch = windowOf(tipPosixMs, msPer, windowOriginOf(protocol));

  // ── Verify caller's wallet has enough LAMP ───────────────────
  const lampUnit = toUnit(protocol.lampPolicyId, assetName);
  const walletAddress = await lucid.wallet().address();
  const walletUtxos   = await lucid.wallet().getUtxos();
  const funding       = params.funding;
  if (funding !== undefined && params.validToMs !== undefined) {
    throw new Error(
      "CREATE-VAULT-VALIDITY: `validToMs` chỉ dùng khi không có `funding` — đường nạp từ did_payment " +
      "tự đặt hạn dùng ≤ 1 giờ.",
    );
  }
  // Có `funding` ⟹ LAMP đến từ ví Phoenix, ví đang chọn trả phí và ứng min-ADA két (trừ chế độ
  // tự trả phí): kiểm hash và nhân chứng của chủ ngay đây, TRƯỚC khi dựng gì. Số dư LAMP của ví
  // Phoenix kiểm ở bước chọn UTxO bên dưới (chế độ tự trả phí cần min-ADA của vault, mà min-ADA
  // cần datum).
  const fundingPorts = funding === undefined ? undefined : fundingPortsOf(lucid, funding);
  const lampBalance   = funding !== undefined ? vault.lampDeposit : walletUtxos.reduce(
    (s, u) => s + (u.assets[lampUnit] ?? 0n), 0n,
  );
  if (funding !== undefined) assertFundingWitness(funding, ownerAuth);
  // Chế độ ví Phoenix tự trả phí: kiểm UTxO thế chấp + phần giữ chỗ phí TRƯỚC khi dựng gì.
  const selfFunded = funding === undefined
    ? undefined
    : selfFundedModeOf(funding, walletAddress, fundingPorts!);
  if (lampBalance < vault.lampDeposit) {
    throw new Error(
      `Wallet has ${lampBalance} oildrop LAMP (= ${lampBalance / 1_000_000n} LAMP); ` +
      `need ${vault.lampDeposit} oildrop (= ${vault.lampDeposit / 1_000_000n} LAMP).`,
    );
  }

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
    ...(wakemeLink === "" ? {} : { wakemeLink }),
  });

  // Lucid Evolution's Data.to expects a TObject-typed value; the
  // plain-bigint shape from buildInitialVaultDatum() is structurally
  // compatible at runtime but the inferred TS type doesn't match the
  // schema's TUnsafe<...> wrappers. Cast — same workaround used by
  // every other vault SDK in this repo (instant.ts, schedule.ts).
  //
  // Lược đồ đi theo `vaultType`, không phải một lược đồ chung: két Instant mang
  // 20 trường, két Schedule 19 (Gen v2.0, `schemas.ts` đầu tệp). Hai vế phải khớp nhau —
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

  // ── Nạp từ did_payment: chọn tối thiểu đủ phần did_payment phải góp + min-ADA phần thối ──
  // Mục rút `did_stake` (chủ script) là tiền của CHỦ DID vào giao dịch: nó thối về ví
  // Phoenix cùng phần thối, không để bộ cân bằng dồn sang ví trả phí.
  //
  // Hai chế độ góp KHÁC NHAU ở vế lovelace của output két:
  //   · ví trả phí bên thứ ba (`selfFunded === undefined`): did_payment chỉ góp tài sản của CHỦ
  //     (LAMP). Min-ADA của output két — một output MỚI, NFT đúc trong tx — do ví trả phí ỨNG: bộ
  //     cân bằng của lucid lấy phần lovelace thiếu từ ví đang chọn, mà ở chế độ này ví đó mang
  //     đúng UTxO trả phí. DID mới thường chỉ có LAMP + ~1,2 ADA ở did_payment; bắt nó trả cả
  //     ~2,1 ADA min-ADA két là đẩy người dùng đúng diện cần ví trả phí vào `FUNDING_INSUFFICIENT`.
  //     did_payment vẫn phải tự đủ min-ADA cho phần thối của CHÍNH nó (`planDidPaymentFunding`).
  //   · ví Phoenix tự trả phí: did_payment trả mọi thứ (LAMP + min-ADA két + phí) — giữ chỗ thêm
  //     `headroom` lovelace lúc CHỌN; phí thật đo sau khi dựng (`completeSelfFunded`).
  // 0 LAMP ⟹ KHÔNG ghi mục LAMP: một mục số lượng 0 trong value không phải "0 LAMP" mà là một
  // multiasset hỏng hình dạng, và `planDidPaymentFunding` đòi mọi mục `need` > 0.
  const lampPart: Record<string, bigint> = vault.lampDeposit === 0n ? {} : { [lampUnit]: vault.lampDeposit };
  const vaultNeed: Record<string, bigint> = { lovelace: vaultLovelace, ...lampPart };
  const extraLovelace = funding === undefined ? 0n : withdrawLovelaceOf(ownerAuth);
  let fundingPlan: DidPaymentPlan<UTxO> | undefined;
  if (funding !== undefined && selfFunded !== undefined) {
    fundingPlan = planDidPaymentFunding({
      utxos: funding.utxos,
      need: { ...vaultNeed, lovelace: vaultLovelace + selfFunded.headroom },
      primaryUnit: lampUnit,
      returnAddress: funding.address,
      extraLovelace,
    }, fundingPorts!);
  } else if (funding !== undefined) {
    // Ca biên: két Instant 0 LAMP + không mục rút ⟹ did_payment không có gì để góp, cũng không có
    // tiền của chủ nào phải thối về nó. KHÔNG chi UTxO did_payment nào: chi một UTxO chỉ để trả
    // nguyên nó về là bắt ví trả phí trả thêm phí chạy script cho một việc rỗng. Quyền chủ
    // (`applyOwnerAuth`) và hạn dùng ≤ 1 giờ vẫn giữ nguyên ở `assemble`. Có mục rút > 0 ⟹ vẫn
    // chọn (need rỗng ⟹ ít nhất một UTxO), để tiền thưởng của chủ thối về ví Phoenix chứ không bị
    // bộ cân bằng dồn sang ví trả phí.
    fundingPlan = Object.keys(lampPart).length === 0 && extraLovelace === 0n
      ? { selected: [], spent: {}, returned: null, skipped: [] }
      : planDidPaymentFunding({
        utxos: funding.utxos,
        need: lampPart,
        primaryUnit: lampUnit,
        returnAddress: funding.address,
        extraLovelace,
      }, fundingPorts!);
  }

  // ── Chọn seed UTxO → danh tính vault (INV-VAULT-IDENTITY) ────
  // NFT danh-tính là one-shot theo seed: seed phải là input THẬT của chính tx
  // này (`expect list.any(tx.inputs, ...)` trong validate_mint_vault_id), nên
  // nó được ép vào tx bằng .collectFrom([...]) chứ không để coin-selection
  // quyết định.
  //
  // Validator KHÔNG hỏi seed thuộc ví nào — chỉ hỏi nó có trong inputs. Nên ở chế độ ví Phoenix
  // tự trả phí, seed là một UTxO did_payment ĐÃ nằm trong tập chi (không thêm input nào); ở chế
  // độ ví trả phí, seed là UTxO của ví trả phí và KHÔNG được trùng UTxO did_payment.
  const seedUtxo = selfFunded !== undefined
    ? seedFromSelected(params.seedUtxo, fundingPlan!.selected)
    : params.seedUtxo ?? pickSeedUtxo(walletUtxos);
  if (selfFunded === undefined && fundingPlan !== undefined) {
    const seedTaken = fundingPlan.selected.some(
      u => u.txHash === seedUtxo.txHash && u.outputIndex === seedUtxo.outputIndex,
    );
    if (seedTaken) {
      throw new FundingError("FUNDING_SHAPE",
        `seed UTxO trùng một UTxO did_payment — seed phải là UTxO của ví trả phí ` +
        `(hoặc đặt funding.feeSource = "did_payment" để ví Phoenix tự trả phí và làm seed).`);
    }
  }
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

  // ── Build tx ─────────────────────────────────────────────────
  // 4 mảnh BẮT BUỘC khớp nhau, thiếu một là validator từ chối:
  //   (1) seed UTxO nằm trong inputs                → one-shot uniqueness
  //   (2) mint đúng 1 NFT (policy = vault hash)     → dict.size(own_tokens) == 1
  //   (3) NFT nằm trong output tại địa chỉ vault    → carriers == [vault_out]
  //   (4) quyền chủ                                  → owner_authorized(tx, vd.owner):
  //       khoá ⟹ pkh ký; script ⟹ mục rút Script(h) (`applyOwnerAuth`)
  // Vault vừa là spending validator vừa là minting policy ⇒ CÙNG một CBOR đã
  // apply params; policy_id chính là vaultScriptHash.
  //
  // Dựng thân qua một hàm vì chế độ ví Phoenix tự trả phí dựng HAI lần (đo phí rồi dựng thật);
  // mỗi lần một `newTx()` mới, cùng một thứ tự gọi.
  const assemble = (didPaymentReturn: Record<string, bigint> | null): TxBuilder => {
    let body = lucid.newTx();
    // (1) Seed là UTxO did_payment ⟹ nó đã nằm trong `collectFrom(selected, Spend)` dưới đây;
    //     thu thêm một lần nữa (không redeemer) là nhân đôi input.
    if (selfFunded === undefined) body = body.collectFrom([seedUtxo]);
    body = body
      .mintAssets({ [vaultIdUnit]: 1n }, mintRedeemer)  // (2)
      .attach.MintingPolicy(vaultScript)
      .pay.ToAddressWithData(                           // (3)
        vaultAddress,
        { kind: "inline", value: vaultDatumCbor },
        {
          lovelace:      vaultLovelace,
          ...lampPart,
          [vaultIdUnit]: 1n,
        },
      );
    // (5) chỉ khi nạp từ did_payment: chi UTxO đã chọn, mỗi cái một redeemer `Spend`, script
    //     đính inline; phần thối về CHÍNH ví Phoenix; hạn dùng ≤ 1 giờ (mô hình ví trả phí bên
    //     thứ ba). Anchor + controller + thiết bị: chủ script thì nhân chứng `did_stake` đã gắn
    //     đúng bộ đó (`assertFundingWitness` so), gắn lại là nhân đôi reference input và chữ ký.
    //     Tập chọn rỗng (ca biên 0 LAMP, không mục rút — khối chọn UTxO ở trên) ⟹ không chi, không
    //     đính script, không anchor/bộ ký của did_payment; chỉ còn hạn dùng.
    if (funding !== undefined && fundingPlan !== undefined) {
      if (fundingPlan.selected.length > 0) {
        body = body
          .collectFrom(fundingPlan.selected, DID_PAYMENT_SPEND_REDEEMER)
          .attach.SpendingValidator({ type: "PlutusV3", script: funding.didPaymentScriptCbor.toLowerCase() });
        if (didPaymentReturn !== null) body = body.pay.ToAddress(funding.address, didPaymentReturn);
        if (ownerAuth.kind !== "script") {
          body = body
            .readFrom([funding.anchorRefUtxo])
            .addSignerKey(funding.controllerPkh)
            .addSignerKey(funding.deviceKeyHash);
        }
      }
      body = body.validTo(Number(tipPosixMs + FUNDING_MAX_VALIDITY_MS));
    }
    // (6) không `funding` mà có ví trả phí bên thứ ba: hạn dùng do người gọi đặt (≤ 1 giờ).
    if (funding === undefined && params.validToMs !== undefined) body = body.validTo(Number(params.validToMs));
    return applyOwnerAuth(body, ownerAuth);                    // (4)
  };

  let tx: TxSignBuilder;
  let selfFundedResult: { fee: bigint; returned: Record<string, bigint> | null } | undefined;
  if (selfFunded !== undefined) {
    const r = await completeSelfFunded({
      lucid, assemble, walletAddress, funding: funding!, plan: fundingPlan!, ports: fundingPorts!,
      vaultNeed, extraLovelace, headroom: selfFunded.headroom, collateralUtxo: selfFunded.collateralUtxo,
      collateralLovelace: params.collateralLovelace,
    });
    tx = r.tx;
    selfFundedResult = { fee: r.fee, returned: r.returned };
  } else {
    tx = await assemble(fundingPlan?.returned ?? null)
      .complete(collateralCompleteOptions(params.collateralLovelace));
  }

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
    walletRole: selfFunded !== undefined ? "collateral only" : "funder",
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
      funding: selfFundedResult === undefined
        ? { selected: fundingPlan.selected, spent: fundingPlan.spent, returned: fundingPlan.returned }
        : {
          selected: fundingPlan.selected, spent: fundingPlan.spent,
          returned: selfFundedResult.returned, feeLovelace: selfFundedResult.fee,
        },
    }),
  };
}

// ── chế độ ví Phoenix tự trả phí (`funding.feeSource = "did_payment"`) ──────────

/**
 * Kiểm chế độ phí. Vắng/`"wallet"` ⟹ `undefined` (hành vi cũ) và CẤM kèm `collateralUtxo`: một
 * UTxO thế chấp khai ra mà không có vai là dấu người gọi tưởng mình đang ở chế độ khác.
 *
 * `"did_payment"` ⟹ `collateralUtxo` BẮT BUỘC: ở ĐÚNG địa chỉ ví đang chọn (địa chỉ đó nhận
 * `collateral_return`), payment credential là KHOÁ (ledger cấm thế chấp là UTxO script), thuần
 * ADA và không script tham chiếu (lucid loại UTxO mang script tham chiếu khỏi thế chấp).
 */
function selfFundedModeOf(
  funding: DidPaymentFundingInput, walletAddress: string, ports: ReturnType<typeof didPaymentLucidPorts>,
): { collateralUtxo: UTxO; headroom: bigint } | undefined {
  const mode = funding.feeSource;
  if (mode !== undefined && mode !== "wallet" && mode !== "did_payment") {
    throw new FundingError("FUNDING_SHAPE", `funding.feeSource phải là "wallet" hoặc "did_payment".`);
  }
  if (mode !== "did_payment") {
    if (funding.collateralUtxo !== undefined || funding.feeHeadroomLovelace !== undefined) {
      throw new FundingError("FUNDING_SHAPE",
        `funding.collateralUtxo / feeHeadroomLovelace chỉ dùng khi funding.feeSource = "did_payment".`);
    }
    return undefined;
  }
  const c = funding.collateralUtxo;
  if (c === undefined || c === null || typeof c !== "object") {
    throw new FundingError("FUNDING_SHAPE",
      `funding.feeSource = "did_payment" cần funding.collateralUtxo — UTxO thuần ADA của ví đang chọn, chỉ làm thế chấp.`);
  }
  if (c.address !== walletAddress) {
    throw new FundingError("FUNDING_SHAPE",
      `funding.collateralUtxo phải nằm ở địa chỉ ví đang chọn (${walletAddress.slice(0, 20)}…): ` +
      `collateral_return về địa chỉ đó.`, { collateral_address: c.address });
  }
  let credType: string;
  try { credType = ports.paymentCredentialOf(c.address).type; } catch { credType = "?"; }
  const units = Object.keys(c.assets ?? {}).filter(k => c.assets[k] !== 0n);
  if (credType !== "Key" || units.length !== 1 || units[0] !== "lovelace" || c.scriptRef != null) {
    throw new FundingError("FUNDING_SHAPE",
      `funding.collateralUtxo phải thuần ADA, không script tham chiếu, ở địa chỉ KHOÁ.`,
      { payment_credential: credType, units });
  }
  const headroom = funding.feeHeadroomLovelace ?? DID_PAYMENT_FEE_HEADROOM_LOVELACE;
  if (typeof headroom !== "bigint" || headroom <= 0n) {
    throw new FundingError("FUNDING_SHAPE", `funding.feeHeadroomLovelace phải là bigint > 0.`);
  }
  return { collateralUtxo: c, headroom };
}

/** Seed ở chế độ tự trả phí: UTxO did_payment TRONG tập đã chọn. Người gọi chỉ định mà nó nằm
 *  ngoài tập ⟹ NÉM (không lặng lẽ thêm input, không lặng lẽ đổi seed). */
function seedFromSelected(requested: UTxO | undefined, selected: UTxO[]): UTxO {
  if (requested === undefined) return pickSeedUtxo(selected);
  const hit = selected.find(u => u.txHash === requested.txHash && u.outputIndex === requested.outputIndex);
  if (hit === undefined) {
    throw new FundingError("FUNDING_SHAPE",
      `seedUtxo ${requested.txHash.slice(0, 12)}…#${requested.outputIndex} không nằm trong tập UTxO ` +
      `did_payment đã chọn — ở chế độ ví Phoenix tự trả phí, seed phải là một UTxO bị chi của ví đó.`,
      { selected: selected.map(u => `${u.txHash}#${u.outputIndex}`) });
  }
  return hit;
}

/** Số lần dựng lại tối đa khi phí đoán hụt vài byte (bề rộng CBOR của số lovelace đổi). */
const SELF_FUNDED_MAX_ATTEMPTS = 4;

function isBalanceInsufficient(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return m.includes("UTxO Balance Insufficient");
}

/**
 * Dựng giao dịch mà phí đến từ `did_payment` và ví đang chọn CHỈ làm thế chấp.
 *
 * ── GIỚI HẠN CỦA LUCID EVOLUTION 0.4.30 MÀ HÀM NÀY ĐI VÒNG ──────────────────────────────
 * `complete()` dùng MỘT địa chỉ cho cả tiền thối lẫn `collateral_return`
 * (`applyCollateral(totalCollateral, collateralInput, changeAddress)` trong
 * `@lucid-evolution/lucid/dist/index.js`). Đặt `changeAddress = did_payment` thì thối đúng chỗ
 * nhưng `collateral_return` rơi vào ví Phoenix; đặt `changeAddress = ví thế chấp` thì phần dư
 * ≥ min-ADA bị thối sang ví thế chấp. Không tuỳ chọn nào tách hai địa chỉ.
 *
 * Nên dựng hai lượt, cả hai `coinSelection: false` (không input nào của ví ngoài thế chấp) và
 * `presetWalletInputs: [collateralUtxo]` (thế chấp chỉ được chọn từ đúng UTxO đó):
 *   (a) ĐO: `changeAddress = did_payment`, không output thối tường minh ⟹ lucid tự tính phí
 *       `F_a` của hình dạng có tiền thối về did_payment.
 *   (b) THẬT: `changeAddress = ví thế chấp`, output thối TƯỜNG MINH về did_payment = phần dư −
 *       `g`, với `g = F_a + minFeeA × (byte địa chỉ ví thế chấp − byte địa chỉ did_payment)` — hai
 *       lượt chỉ khác nhau ở địa chỉ `collateral_return`. Còn dư 0 ⟹ không output nào về ví thế
 *       chấp. Hụt vài byte (bề rộng CBOR) ⟹ lucid ném "UTxO Balance Insufficient" ⟹ `g += minFeeA`
 *       rồi dựng lại, tối đa `SELF_FUNDED_MAX_ATTEMPTS` lượt.
 * Dư nhỏ hơn min-ADA thì CML đốt phần dư thành phí thay vì thối (đo 2026-09-27 trên 0.4.30), nên
 * `g` hơi cao chỉ làm phí cao hơn, không đẩy tiền sang ví thế chấp. Hình dạng cuối được ĐỌC LẠI
 * từ CBOR (`assertSelfFundedShape`) — không tin lập luận trên.
 */
async function completeSelfFunded(a: {
  lucid: CreateVaultParams["lucid"];
  assemble: (ret: Record<string, bigint> | null) => TxBuilder;
  walletAddress: string;
  funding: DidPaymentFundingInput;
  plan: DidPaymentPlan<UTxO>;
  ports: ReturnType<typeof didPaymentLucidPorts>;
  vaultNeed: Record<string, bigint>;
  extraLovelace: bigint;
  headroom: bigint;
  collateralUtxo: UTxO;
  collateralLovelace: bigint | undefined;
}): Promise<{ tx: TxSignBuilder; fee: bigint; returned: Record<string, bigint> | null }> {
  const base = {
    ...(collateralCompleteOptions(a.collateralLovelace) ?? {}),
    coinSelection: false,
    presetWalletInputs: [a.collateralUtxo],
  };
  const pp = (a.lucid as { config?: () => { protocolParameters?: { minFeeA?: unknown } } })
    .config?.().protocolParameters;
  const minFeeA = typeof pp?.minFeeA === "number" || typeof pp?.minFeeA === "bigint" ? BigInt(pp.minFeeA) : undefined;
  if (minFeeA === undefined || minFeeA <= 0n) {
    throw new FundingError("FUNDING_SHAPE", `lucid không có tham số giao thức minFeeA — không đo được phí.`);
  }

  // (a) lượt ĐO.
  const probe = await a.assemble(null).complete({ ...base, changeAddress: a.funding.address });
  const probeFee = CML.Transaction.from_cbor_hex(probe.toCBOR()).body().fee();
  const addrLen = (addr: string) => BigInt(CML.Address.from_bech32(addr).to_raw_bytes().length);
  let g = probeFee + minFeeA * (addrLen(a.walletAddress) - addrLen(a.funding.address));

  // Tổng vào từ did_payment (+ mục rút của chủ DID) trừ output vault (NFT vừa đúc không tính).
  const pool: Record<string, bigint> = { ...a.plan.spent };
  pool.lovelace = (pool.lovelace ?? 0n) + a.extraLovelace;
  for (const [k, v] of Object.entries(a.vaultNeed)) pool[k] = (pool[k] ?? 0n) - v;

  for (let attempt = 0; attempt < SELF_FUNDED_MAX_ATTEMPTS; attempt++, g += minFeeA) {
    if (g > a.headroom) {
      throw new FundingError("FUNDING_INSUFFICIENT",
        `phí đo được ${g} lovelace vượt phần giữ chỗ ${a.headroom} — nâng funding.feeHeadroomLovelace.`,
        { fee_lovelace: String(g), fee_headroom_lovelace: String(a.headroom) });
    }
    const tokens = Object.fromEntries(Object.entries(pool).filter(([k, v]) => k !== "lovelace" && v > 0n));
    const lovelace = (pool.lovelace ?? 0n) - g;
    const returned = Object.keys(tokens).length === 0 && lovelace === 0n ? null : { lovelace, ...tokens };
    if (returned !== null && lovelace < a.ports.minLovelaceFor(a.funding.address, tokens)) {
      throw new FundingError("FUNDING_INSUFFICIENT",
        `sau phí ${g} lovelace, phần thối về did_payment còn ${lovelace} lovelace — dưới min-ADA.`,
        { fee_lovelace: String(g), returned_lovelace: String(lovelace) });
    }
    let tx: TxSignBuilder;
    try {
      tx = await a.assemble(returned).complete({ ...base, changeAddress: a.walletAddress });
    } catch (e) {
      if (isBalanceInsufficient(e)) continue;
      throw e;
    }
    assertSelfFundedShape(tx.toCBOR(), a.plan.selected, a.collateralUtxo, a.walletAddress, g);
    return { tx, fee: g, returned };
  }
  throw new FundingError("FUNDING_SHAPE",
    `không dựng được giao dịch tự trả phí sau ${SELF_FUNDED_MAX_ATTEMPTS} lượt (phí cuối thử ${g - minFeeA}).`);
}

/**
 * Đọc lại CBOR của lượt THẬT: input đúng bằng tập did_payment đã chọn; thế chấp đúng
 * `collateralUtxo`; `collateral_return` (nếu có) về ví thế chấp; không output nào về ví thế chấp;
 * phí đúng `g` (không phần dư nào bị thối đi đâu khác). Lệch ⟹ NÉM, không trả tx.
 *
 * Xuất ra để bài kiểm gọi TRỰC TIẾP từng vế: với Lucid thật, bộ dựng đúng không bao giờ sinh
 * hình dạng sai, nên đi qua `createVault` thì không bài nào chạm được nhánh ném. Không re-export
 * ở `index.ts` — đây không phải API công khai.
 */
export function assertSelfFundedShape(
  txCbor: string, selected: UTxO[], collateralUtxo: UTxO, walletAddress: string, fee: bigint,
): void {
  const body = CML.Transaction.from_cbor_hex(txCbor).body();
  const key = (h: string, i: number | bigint) => `${h}#${Number(i)}`;
  const want = new Set(selected.map(u => key(u.txHash, u.outputIndex)));
  const got: string[] = [];
  for (let i = 0; i < body.inputs().len(); i++) {
    got.push(key(body.inputs().get(i).transaction_id().to_hex(), body.inputs().get(i).index()));
  }
  const bad = (m: string) => new FundingError("FUNDING_SHAPE", `giao dịch tự trả phí lệch hình dạng: ${m}`);
  if (got.length !== want.size || got.some(k => !want.has(k))) throw bad(`input ${got.join(", ")} khác tập did_payment đã chọn`);
  const cl = body.collateral_inputs();
  const collKey = key(collateralUtxo.txHash, collateralUtxo.outputIndex);
  if (cl === undefined || cl.len() !== 1 || key(cl.get(0).transaction_id().to_hex(), cl.get(0).index()) !== collKey) {
    throw bad(`thế chấp phải đúng một UTxO ${collKey}`);
  }
  const cr = body.collateral_return();
  if (cr !== undefined && cr.address().to_bech32(undefined) !== walletAddress) throw bad(`collateral_return không về ví thế chấp`);
  const outs = body.outputs();
  for (let i = 0; i < outs.len(); i++) {
    if (outs.get(i).address().to_bech32(undefined) === walletAddress) throw bad(`output #${i} về ví thế chấp`);
  }
  if (body.fee() !== fee) throw bad(`phí ${body.fee()} khác phí đã tính ${fee}`);
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
  walletRole:       "funder" | "collateral only";
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
    `Wallet (${o.walletRole}): ${o.walletAddress}`,
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
