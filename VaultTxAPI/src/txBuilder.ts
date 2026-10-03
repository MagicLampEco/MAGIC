// VaultTxAPI/src/txBuilder.ts — cổng DỰNG giao dịch: một giao diện, hai hiện thực.
//
// ══ BẤT BIẾN SỐ MỘT ═══════════════════════════════════════════════════════════
// Không hiện thực nào ở đây giữ, đọc, nhận hay chạm vào vật liệu ký. Ví của lucid
// được chọn bằng `selectWallet.fromAddress(...)` — một ví CHỈ-ĐỌC biết địa chỉ và
// biết các UTxO của địa chỉ đó, và KHÔNG ký được gì. Mọi đường ký của lucid (các
// nhánh ký trọn và ký một phần của TxSignBuilder) KHÔNG được gọi ở bất kỳ đâu trong
// gói này; `tests/noSigningMaterial.test.ts` quét mã nguồn để câu đó còn đúng sau
// mỗi lần sửa. Thứ đi ra từ đây là `toCBOR()` — byte của một giao dịch chưa ký.
//
// Kết quả trả ra là CBOR của một giao dịch CHƯA KÝ. App ký trong Secure Enclave rồi
// gọi `/tx/submit` với `witness_cbor`.
// ══════════════════════════════════════════════════════════════════════════════
//
// ── VÌ SAO CÓ MỘT GIAO DIỆN THAY VÌ GỌI THẲNG SDK ──────────────────────────────
// Vì `summary` phải suy TỪ CBOR. Một phép kiểm chứng minh được điều đó chỉ khi nó
// bơm vào một CBOR mà tham số yêu cầu KHÔNG sinh ra — tức là phải thay được tầng
// dựng. Giao diện này là chỗ thay; `RecordedTxBuilder` là bản dùng trong phép kiểm.

import {
  Blockfrost, Lucid, credentialToAddress, keyHashToCredential, validatorToScriptHash, getAddressDetails,
  type LucidEvolution, type Script, type TxBuilder, type UTxO,
} from "@lucid-evolution/lucid";
import {
  buildConsumeTx, buildConsumeManyTx, buildInstantGenTx, buildMintEngageTx, buildRefreshCheckpointTx, buildScheduleCommitTx,
  buildScheduleFireTx, buildVaultBurnBatch,
  createVault, decodePriceParam, requiredFromBeacon, requiredFromBeaconPairs,
  type DidPaymentFundingInput, type GenBeaconParams, type InstantVaultParams, type PlutusJson, type Profile,
  type VaultModule, type VaultType,
} from "@magiclamp/sdk";
import { buildBindDidTx } from "@magiclamp/consumemagic";
import { posixMsToEpoch, FundingError, OwnerAuthError, type Network, type OwnerAuth, type OwnerRef } from "@magiclamp/protocol-utils";

import type { ChainReader, ChainTip } from "./chain.js";
import { PREPAID_VAULT_TYPE, type Deployment, type OutRefConfig, type VaultScope } from "./config.js";
import { ChainUnavailableError, CodedApiError, ConfigMissingError, TxBuildRejectedError } from "./errors.js";
import type { FoundVault } from "./vaultLookup.js";
import { pickByNft, type InstantGenRefs } from "./genV2.js";

export interface BuildContext {
  /** Chủ vault (`Credential`). */
  owner: OwnerRef;
  /** Nhân chứng chủ script; vắng ⟹ chủ khoá, bộ dựng ký bằng pkh từ datum. */
  ownerAuth?: OwnerAuth<TxBuilder>;
  vault: FoundVault;
  tip: ChainTip;
  /** Địa chỉ nhận tiền thừa + nguồn UTxO trả phí. Suy theo chiến lược khai trong cấu
   *  hình — xem `ChangeAddressStrategy` ở `config.ts` cho khẳng định đi kèm. Có `feePayerUtxo`
   *  ⟹ = `fee_payer.address`. */
  changeAddress: string;
  /** Ví trả phí bên thứ ba (`fee_payer`). Có ⟹ ví của lucid mang ĐÚNG UTxO này (phí + thế
   *  chấp), không đọc thêm UTxO nào ở địa chỉ đó. Luật đầy đủ: `feePayer.ts`. */
  feePayerUtxo?: UTxO;
  /** Lượng thế chấp tường minh (lovelace) — đặt cùng `feePayerUtxo`. */
  collateralLovelace?: bigint;
}

/** Ngữ cảnh mở thread Engage — không có vault đầu vào, không có thread đầu vào. */
export interface OpenThreadContext {
  owner: OwnerRef;
  ownerAuth?: OwnerAuth<TxBuilder>;
  tip: ChainTip;
  /** Ví trả min-ADA của thread + phí + thế chấp, nhận tiền thối. Seed one-shot lấy từ đây. */
  changeAddress: string;
}

/** Ngữ cảnh gắn DID — không có vault đầu vào; thread đầu vào đi riêng trong tham số. */
export interface BindDidContext {
  owner: OwnerRef;
  ownerAuth?: OwnerAuth<TxBuilder>;
  tip: ChainTip;
  /** Ví trả phí + thế chấp, nhận tiền thối. Value của thread bảo toàn tuyệt đối, nên ví này chỉ mất phí. */
  changeAddress: string;
}

export interface BuiltOpenThread extends BuiltTx {
  /** `policyId + assetName` của NFT thread mà bộ dựng KHAI đã đúc — dịch vụ đọc lại CBOR để đối chiếu. */
  engageNftUnit: string;
}

export interface BuiltTx {
  /** Giao dịch CHƯA KÝ, CBOR hex. */
  txCbor: string;
}

/**
 * Gen v2.0 — mọi UTxO beacon/shard đã ĐỌC ở tầng dịch vụ (`genV2.ts`) và giao nguyên xuống
 * đây, để phép so trần `m` và bộ dựng nhìn CÙNG một ảnh chụp chuỗi.
 */
export interface InstantGenBuildParams {
  /** Lượng sinh (nanogic) chủ két chọn — đã so với `maxM` ở tầng dịch vụ. */
  m: bigint;
  /** Chín apply-param của két (`genV2.ts` ▸ `instantVaultParamsOf`). */
  vaultParams: InstantVaultParams;
  refs: InstantGenRefs;
  /** Lượt này làm mới checkpoint ⟹ beacon ρ đi vào tx; không ⟹ không đưa vào. */
  includeRateBeacon: boolean;
  vaultRegistryPolicy: string;
  gbShardCapNanogic: bigint;
  /** Két đã kiểm bởi `wakeme.ts` ▸ `resolveWakemeVault`; vắng ⟹ không két, L_lent = 0. */
  wakeme?: { utxo: UTxO; scriptHash: string };
}

export interface RefreshCheckpointBuildParams {
  vaultParams: InstantVaultParams;
  rateBeaconUtxo: UTxO;
  wakemeVaultUtxo?: UTxO;
}

export interface ScheduleCommitBuildParams {
  scheduleLength: bigint;
  lampPerEpoch: bigint;
  gen: {
    params: GenBeaconParams;
    rateBeaconUtxo: UTxO;
    gbBeaconUtxo: UTxO;
    vaultRegistryUtxo: UTxO;
    gbShardUtxos: UTxO[];
  };
}

/** Lượt tiêu giao cho bộ dựng: MỘT cặp (`Consume`) hoặc `pairs` ≥ 2 cặp (`ConsumeMany`) —
 *  `consumeLine.ts` ▸ `consumeLineOf` đã quyết và đã kiểm luật danh sách. */
export type ConsumeBuildParams = (
  | { opType: number; opCount: bigint; pairs?: undefined }
  | { pairs: ReadonlyArray<{ opType: number; opCount: bigint }>; opType?: undefined; opCount?: undefined }
) & ConsumeBuildCommon;

interface ConsumeBuildCommon {
  /** Thread của CHÍNH chủ, đã chọn bởi `engage.ts` ▸ `pickEngageThread`. */
  engageUtxo: UTxO;
  /** Chỉ két Instant v2.0 làm mới checkpoint ở lượt này (`cap_epoch < e`). SDK quyết lại
   *  từ datum và chỉ đưa các UTxO này vào tx khi lượt tiêu thật sự làm mới. */
  checkpoint?: { vaultParams: InstantVaultParams; rateBeaconUtxo: UTxO; wakemeVaultUtxo?: UTxO };
}

/** Tham số dựng tx tạo vault. `wakemeLink` (CHỈ két Instant): `owner_commit` 64 hex của DID chủ
 *  két ⟹ ô `wakeme_link` của datum genesis; vắng ⟹ "". Hình dạng kiểm ở `service.ts` + SDK. */
export interface CreateVaultBuildParams {
  lampAmount: bigint;
  profile?: Profile;
  wakemeLink?: string;
}

export interface TxBuilderPort {
  scheduleCommit(ctx: BuildContext, p: ScheduleCommitBuildParams): Promise<BuiltTx>;
  scheduleFire(ctx: BuildContext, p: { scheduleId: string }): Promise<BuiltTx>;
  consume(ctx: BuildContext, p: ConsumeBuildParams): Promise<BuiltTx>;
  instantGen(ctx: BuildContext, p: InstantGenBuildParams): Promise<BuiltTx>;
  /** RedeemerRefreshCheckpoint — chủ ký, làm mới năm ô checkpoint, không đổi LAMP/MAGIC. */
  refreshCheckpoint(ctx: BuildContext, p: RefreshCheckpointBuildParams): Promise<BuiltTx>;
  createVault(ctx: CreateVaultContext, p: CreateVaultBuildParams): Promise<BuiltCreateVault>;
  openThread(ctx: OpenThreadContext): Promise<BuiltOpenThread>;
  /** Gắn DID vào thread (redeemer `BindDID`). `engageUtxo`: thread của CHÍNH chủ, `did_commit` đang
   *  rỗng — đã kiểm ở `VaultTxService.bindDid`. */
  bindDid(ctx: BindDidContext, p: { engageUtxo: UTxO; didCommit: string }): Promise<BuiltTx>;
  /** Tham số giao thức `coinsPerUtxoByte` của CÙNG ảnh chụp bộ dựng dùng — báo giá tính min-ADA
   *  của UTxO trả phí từ đây (`feeQuote.ts`), không từ một hằng chép tay. */
  coinsPerUtxoByte(): Promise<bigint>;
}

/** Ngữ cảnh tạo vault — không có vault đầu vào, chỉ có địa chỉ đích. */
/**
 * UTxO DUY NHẤT mà ví của lucid mang khi tạo vault có `funding`. Chế độ ví trả phí: UTxO trả phí.
 * Chế độ ví Phoenix tự trả phí (`input.feeSource = "did_payment"`): UTxO thế chấp của ví khoá — nó
 * cũng phải là CÙNG UTxO mà SDK nhận qua `input.collateralUtxo`, nếu không ví của lucid và thế chấp
 * khai cho SDK là hai UTxO khác nhau. Thiếu/lệch ⟹ NÉM: đó là lỗi nối dây trong gói này.
 */
export function walletUtxoOfFunding(f: NonNullable<CreateVaultContext["funding"]>): UTxO {
  if (f.input.feeSource === "did_payment") {
    const c = f.collateralUtxo;
    const ic = f.input.collateralUtxo;
    if (c === undefined || ic === undefined || c.txHash !== ic.txHash || c.outputIndex !== ic.outputIndex) {
      throw new Error("[bất biến nội bộ] tạo vault tự trả phí: thiếu collateralUtxo hoặc lệch với funding.input.collateralUtxo.");
    }
    if (f.feePayerUtxo !== undefined) throw new Error("[bất biến nội bộ] tạo vault tự trả phí: không được mang feePayerUtxo.");
    return c;
  }
  if (f.feePayerUtxo === undefined) throw new Error("[bất biến nội bộ] tạo vault qua ví trả phí: thiếu feePayerUtxo.");
  return f.feePayerUtxo;
}

export interface CreateVaultContext {
  owner: OwnerRef;
  ownerAuth?: OwnerAuth<TxBuilder>;
  scope: VaultScope;
  tip: ChainTip;
  /** Ví trả phí + nhận tiền thối ADA. Có `funding` ⟹ = `funding.fee_payer.address`; chế độ
   *  `fee_source: "did_payment"` ⟹ = `funding.collateral.address` (chỉ nhận `collateral_return`). */
  changeAddress: string;
  /** Nạp từ ví Phoenix. Có mặt ⟹ ví của lucid chỉ mang ĐÚNG MỘT UTxO — `feePayerUtxo` (chế độ
   *  ví trả phí) hoặc `collateralUtxo` (chế độ ví Phoenix tự trả phí, `input.feeSource =
   *  "did_payment"`) — không đọc thêm UTxO nào ở địa chỉ đó, và LAMP đến từ `input.utxos`. */
  funding?: { input: DidPaymentFundingInput; feePayerUtxo?: UTxO; collateralUtxo?: UTxO };
  /** Lượng thế chấp tường minh (lovelace) — đặt cùng `funding` (ví trả phí bên thứ ba). */
  collateralLovelace?: bigint;
}

export interface BuiltCreateVault extends BuiltTx {
  /** `policyId + assetName` của NFT danh-tính vừa đúc. */
  vaultNftUnit: string;
}

/**
 * Địa chỉ đổi tiền thừa do app gửi: phải là bech32 của ĐÚNG mạng đang chạy và có phần thanh
 * toán là KHOÁ. Phần thanh toán là script thì không ký được phí, không làm được tài sản thế
 * chấp — giao dịch chết lúc nộp, sau khi người dùng đã ký.
 */
export function assertChangeAddress(network: Network, address: string): string {
  let d: ReturnType<typeof getAddressDetails>;
  try {
    d = getAddressDetails(address);
  } catch {
    throw new CodedApiError(400, "CHANGE_ADDRESS_INVALID", `"change_address" không phải địa chỉ Cardano hợp lệ.`);
  }
  const wantId = network === "Mainnet" ? 1 : 0;
  if (d.networkId !== wantId || d.paymentCredential?.type !== "Key" || !address.startsWith("addr")) {
    throw new CodedApiError(400, "CHANGE_ADDRESS_INVALID",
      `"change_address" phải là địa chỉ bech32 của mạng ${network} với phần thanh toán là KHOÁ.`,
      { network_id: d.networkId, payment_credential: d.paymentCredential?.type ?? null });
  }
  return address;
}

/** `VaultType` của cấu hình → `VaultModule` của `buildVaultBurnBatch`. Hai module kiểm
 *  A02 KHÁC NHAU ở `pending_profile`, nên không có mặc định: mặc định nào cũng tái tạo
 *  lỗi cho module kia, và triệu chứng là tx bị từ chối không kèm tên trường.
 *
 *  Két Prepaid được NHẬN DIỆN tường minh nhưng KHÔNG ánh xạ: `VaultModule` của SDK chỉ có hai
 *  giá trị (`MagicSDK/src/burnBatch.ts` ▸ `VaultModule`), và phía két của lượt tiêu Prepaid là
 *  `prepaidBurnFor` bên trong `buildSponsorT4FirstConsume` — `sponsor.ts` gọi thẳng nó, không qua
 *  hàm này. Nơi gọi duy nhất của hàm này là `SdkTxBuilder.consume` (`/tx/consume`), và đường đó đã
 *  bị `service.ts` ▸ `assertScopesSupported` chặn với scope Prepaid TRƯỚC khi đọc chuỗi. Tới được
 *  đây với "Prepaid" là cổng kia đã thủng ⟹ 501 cùng mã, kèm đường đúng, không phải 422 "không
 *  ánh xạ được" (câu đó bảo người gọi sửa cấu hình, trong khi cấu hình đúng). */
export function vaultModuleOf(vaultType: string): VaultModule {
  switch (vaultType) {
    case "Schedule": return "ScheduleGen";
    case "Instant": return "InstantGen";
    case PREPAID_VAULT_TYPE:
      throw new CodedApiError(501, "VAULT_KIND_UNSUPPORTED",
        `Két ${PREPAID_VAULT_TYPE} không tiêu MAGIC qua /tx/consume — lượt tiêu đầu của két này là ` +
        `POST /tx/sponsor/t4-first-consume.`,
        { vault_type: PREPAID_VAULT_TYPE, route: "/tx/consume", use_instead: "/tx/sponsor/t4-first-consume" });
    default:
      throw new TxBuildRejectedError(
        `vault_type "${vaultType}" không ánh xạ được sang module vault nào. ` +
        `Chỉ có "Schedule" (ScheduleGen) và "Instant" (InstantGen).`,
        { vault_type: vaultType },
      );
  }
}

/** Địa chỉ enterprise của một khoá băm thanh toán. Xem `ChangeAddressStrategy`. */
export function enterpriseAddressOf(network: Network, ownerPkh: string): string {
  return credentialToAddress(network, keyHashToCredential(ownerPkh));
}

/** Tham số giao thức mà `SdkTxBuilder.createVault` đưa vào `@magiclamp/sdk` ▸ `createVault`.
 *  Tách thành hàm để bộ kiểm ghim được đường `lamp.rehearsal_ack` → SDK: rơi trường ack ở
 *  đây thì dịch vụ khởi động XANH (`parseDeployment` đã cho qua) rồi mọi lượt tạo vault
 *  của cụm tập dượt bị SDK chặn — hỏng muộn, và hỏng ở người dùng. */
export function createVaultProtocol(
  d: Deployment,
  network: Network,
): Parameters<typeof createVault>[0]["protocol"] {
  return {
    network,
    lampPolicyId: d.lampPolicyId,
    lampAssetName: d.lampAssetNameHex,
    ...(d.lampRehearsalAck === undefined ? {} : { lampRehearsalAck: d.lampRehearsalAck }),
  };
}

export interface SdkTxBuilderDeps {
  network: Network;
  blockfrostUrl: string;
  blockfrostProjectId: string;
  deployment: Deployment;
  chain: ChainReader;
  /** Blueprint của module vault, đã đọc lúc khởi động. Dùng để SUY chỉ số constructor
   *  `BurnBatch` lúc chạy thay vì chép một con số phải khớp thứ tự enum on-chain. */
  vaultPlutusJson: PlutusJson;
}

/**
 * Hiện thực thật: bọc bốn hàm dựng của `@magiclamp/sdk`.
 *
 * 🔴 TRẠNG THÁI ĐO ĐƯỢC: lớp này ĐÃ qua `tsc --noEmit` và qua phép kiểm không-chạm-khoá,
 * NHƯNG CHƯA từng dựng một giao dịch thật trên chuỗi — làm thế đòi một lần deploy sống
 * (ref-script, shard, beacon giá, thread Engage) mà lượt dựng gói này không có. Đừng đọc
 * "biên dịch xanh" thành "chạy đúng". Xem README §"Còn thiếu".
 */
/** Hạn dùng của ảnh chụp tham số giao thức. Ngắn có chủ đích — xem `lucidFor`. */
const PROTOCOL_PARAMS_TTL_MS = 10 * 60 * 1000;

export class SdkTxBuilder implements TxBuilderPort {
  private protocolParams: Awaited<ReturnType<Blockfrost["getProtocolParameters"]>> | null = null;
  private protocolParamsAt = 0;

  constructor(private readonly deps: SdkTxBuilderDeps) {}

  async scheduleCommit(ctx: BuildContext, p: ScheduleCommitBuildParams): Promise<BuiltTx> {
    const d = this.deps.deployment;
    if (d.refScriptUtxos.commit === undefined || d.refScriptUtxos.gbShard === undefined) {
      throw new Error(
        "[bất biến nội bộ] SdkTxBuilder.scheduleCommit được gọi khi ref_script_utxos.commit/gb_shard vắng — " +
        "cổng cấu hình ở VaultTxService.scheduleCommit đã bị đi vòng.",
      );
    }
    const lucid = await this.lucidFor(ctx);
    const { vaultScript, shardScript, refScriptUtxos } = await this.scheduleScripts(ctx.vault.scope.scriptHash);
    const [commitRef, gbShardRef] = await this.deps.chain.utxosByOutRef([d.refScriptUtxos.commit, d.refScriptUtxos.gbShard]);
    const commitScript = scriptOfRef(commitRef, "commit");
    const gbShardScript = scriptOfRef(gbShardRef, "gb_shard");
    assertScriptHash(gbShardScript, p.gen.params.gbShardPolicyId, "gb_shard");
    const shardAddress = requireShard(d, "/tx/schedule-commit").address;
    const shardUtxos = await this.deps.chain.utxosAt(shardAddress);
    assertShardsPresent(shardUtxos, shardAddress);

    const r = await rejectAsProtocol(() => buildScheduleCommitTx({
      lucid,
      vaultUtxo: ctx.vault.utxo,
      shardUtxos,
      scheduleLength: p.scheduleLength,
      lampPerEpoch: p.lampPerEpoch,
      userAddress: ctx.changeAddress,
      vaultScript,
      shardScript,
      // Két uỷ luật ký cho validator withdraw-zero `commit`: tx mang mục rút 0 từ reward
      // address của nó. Stake credential phải ĐĂNG KÝ trước (`buildRegisterCommitStakeTx`).
      commitScript,
      commitRefScriptUtxo: commitRef,
      gen: p.gen.params,
      rateBeaconUtxo: p.gen.rateBeaconUtxo,
      gbBeaconUtxo: p.gen.gbBeaconUtxo,
      vaultRegistryUtxo: p.gen.vaultRegistryUtxo,
      gbShardUtxos: p.gen.gbShardUtxos,
      gbShardScript,
      lampPolicyId: d.lampPolicyId,
      lampAssetName: d.lampAssetNameHex,
      network: this.deps.network,
      tipPosixMs: ctx.tip.blockTimePosixMs,
      refScriptUtxos: [...refScriptUtxos, gbShardRef!],
      ownerAuth: ctx.ownerAuth,
      collateralLovelace: ctx.collateralLovelace,
    }));
    return { txCbor: r.tx.toCBOR() };
  }

  async scheduleFire(ctx: BuildContext, p: { scheduleId: string }): Promise<BuiltTx> {
    const lucid = await this.lucidFor(ctx);
    const { vaultScript, shardScript, refScriptUtxos } = await this.scheduleScripts(ctx.vault.scope.scriptHash);
    const shardAddress = requireShard(this.deps.deployment, "/tx/schedule-fire").address;
    const shardUtxos = await this.deps.chain.utxosAt(shardAddress);
    assertShardsPresent(shardUtxos, shardAddress);

    const r = await rejectAsProtocol(() => buildScheduleFireTx({
      lucid,
      vaultUtxo: ctx.vault.utxo,
      shardUtxos,
      scheduleId: p.scheduleId,
      vaultScript,
      shardScript,
      lampPolicyId: this.deps.deployment.lampPolicyId,
      lampAssetName: this.deps.deployment.lampAssetNameHex,
      network: this.deps.network,
      tipPosixMs: ctx.tip.blockTimePosixMs,
      refScriptUtxos,
      collateralLovelace: ctx.collateralLovelace,
    }));
    return { txCbor: r.tx.toCBOR() };
  }

  /**
   * InstantGen Gen v2.0 — `m` do CHỦ chọn (redeemer `InstantGen { claimed_amount = m }`), đã so
   * với `maxM` ở tầng dịch vụ trên CÙNG các UTxO giao xuống đây. Két + shard GB bị tiêu; beacon
   * GreenBack, sổ két (và beacon ρ khi làm mới checkpoint, két Wakeme khi có) là reference input.
   * Validator vẫn là trọng tài cuối: câu từ chối của gói nền đi thẳng về qua `rejectAsProtocol`.
   */
  async instantGen(ctx: BuildContext, p: InstantGenBuildParams): Promise<BuiltTx> {
    const d = this.deps.deployment;
    if (d.refScriptUtxos.gbShard === undefined) {
      throw new Error(
        "[bất biến nội bộ] SdkTxBuilder.instantGen được gọi khi ref_script_utxos.gb_shard vắng — " +
        "cổng cấu hình ở VaultTxService.instantGen đã bị đi vòng.",
      );
    }
    const lucid = await this.lucidFor(ctx);
    const [vaultRef, gbShardRef] = await this.deps.chain.utxosByOutRef([d.refScriptUtxos.vault, d.refScriptUtxos.gbShard]);
    const vaultScript = scriptOfRef(vaultRef, "vault");
    assertScriptHash(vaultScript, ctx.vault.scope.scriptHash, "vault");
    assertScriptHash(scriptOfRef(gbShardRef, "gb_shard"), p.vaultParams.gbShardPolicyId, "gb_shard");

    const r = await rejectAsProtocol(() => buildInstantGenTx({
      lucid,
      vaultUtxo: ctx.vault.utxo,
      vaultScript,
      vaultParams: p.vaultParams,
      vaultRefScriptUtxo: vaultRef,
      m: p.m,
      ...(p.includeRateBeacon ? { rateBeaconUtxo: p.refs.rateBeaconUtxo } : {}),
      greenbackBeaconUtxo: p.refs.greenbackBeaconUtxo,
      gbShardUtxo: p.refs.gbShardUtxo,
      gbShardRefScriptUtxo: gbShardRef,
      vaultRegistryUtxo: p.refs.vaultRegistryUtxo,
      vaultRegistryPolicy: p.vaultRegistryPolicy,
      gbShardCapNanogic: p.gbShardCapNanogic,
      network: this.deps.network,
      tipPosixMs: ctx.tip.blockTimePosixMs,
      ownerAuth: ctx.ownerAuth,
      collateralLovelace: ctx.collateralLovelace,
      // Két Wakeme vào REFERENCE INPUTS; bộ dựng đọc lại bằng `readWakemeVault` trên chính UTxO
      // này, cùng đỉnh chuỗi, nên L_lent khớp con số ở `summary.wakeme`.
      ...(p.wakeme === undefined ? {} : { wakemeVaultUtxo: p.wakeme.utxo }),
    }));
    return { txCbor: r.tx.toCBOR() };
  }

  /** RefreshCheckpoint (redeemer #6) — `@magiclamp/sdk` ▸ `buildRefreshCheckpointTx`. */
  async refreshCheckpoint(ctx: BuildContext, p: RefreshCheckpointBuildParams): Promise<BuiltTx> {
    const d = this.deps.deployment;
    const lucid = await this.lucidFor(ctx);
    const [vaultRef] = await this.deps.chain.utxosByOutRef([d.refScriptUtxos.vault]);
    const vaultScript = scriptOfRef(vaultRef, "vault");
    assertScriptHash(vaultScript, ctx.vault.scope.scriptHash, "vault");
    const r = await rejectAsProtocol(() => buildRefreshCheckpointTx({
      lucid,
      vaultUtxo: ctx.vault.utxo,
      vaultScript,
      vaultParams: p.vaultParams,
      vaultRefScriptUtxo: vaultRef,
      rateBeaconUtxo: p.rateBeaconUtxo,
      ...(p.wakemeVaultUtxo === undefined ? {} : { wakemeVaultUtxo: p.wakemeVaultUtxo }),
      network: this.deps.network,
      tipPosixMs: ctx.tip.blockTimePosixMs,
      ownerAuth: ctx.ownerAuth,
      collateralLovelace: ctx.collateralLovelace,
    }));
    return { txCbor: r.tx.toCBOR() };
  }

  async consume(ctx: BuildContext, p: ConsumeBuildParams): Promise<BuiltTx> {
    const lucid = await this.lucidFor(ctx);
    const d = this.deps.deployment;

    const [vaultRef, consumeRef] = await this.deps.chain.utxosByOutRef([
      d.refScriptUtxos.vault, d.refScriptUtxos.consume,
    ]);
    const vaultScript = scriptOfRef(vaultRef, "vault");
    assertScriptHash(vaultScript, ctx.vault.scope.scriptHash, "vault");
    const consumeScript = scriptOfRef(consumeRef, "consume");
    // Policy của NFT thread = script hash consume; `engageScriptHash` suy từ `engage_address`.
    // Script tham chiếu băm ra hash khác ⟹ thread đã chọn không thuộc script này.
    assertScriptHash(consumeScript, d.consume.engageScriptHash, "consume");
    const engageUtxo = p.engageUtxo;
    const priceBeaconUtxo = pickByNft(
      await this.deps.chain.utxosAt(d.consume.priceBeaconAddress), d.consume.priceBeaconNftUnit, "beacon PriceParam",
    );
    if (typeof priceBeaconUtxo.datum !== "string" || priceBeaconUtxo.datum === "") {
      throw new ChainUnavailableError(
        "Beacon PriceParam không mang datum inline — không đọc được giá có thẩm quyền.",
        { utxo_ref: `${priceBeaconUtxo.txHash}#${priceBeaconUtxo.outputIndex}` },
      );
    }

    // `required` LUÔN đến từ beacon, không bao giờ từ bảng giá dựng sẵn: `consume.ak`
    // đòi `Σburns == required` — DẤU BẰNG — nên một con số tính bằng đường khác chỉ
    // đúng chừng nào hai đường chưa lệch.
    // `pairs` (ConsumeMany) sàn TỪNG cặp rồi cộng (`requiredFromBeaconPairs`, gương on-chain
    // `required_for_pairs`) — KHÔNG gộp rồi sàn một lần như `Consume` đơn: cách đó lệch tới
    // (n−1) nanogic và validator đòi dấu bằng.
    const priceParam = decodePriceParam(priceBeaconUtxo.datum);
    const required = rejectSyncAsProtocol(() => p.pairs === undefined
      ? requiredFromBeacon(priceParam, p.opType, p.opCount)
      : requiredFromBeaconPairs(priceParam, p.pairs));

    const currentEpoch = protocolEpoch(ctx.tip.blockTimePosixMs, this.deps.network);
    const vaultSide = rejectSyncAsProtocol(() => buildVaultBurnBatch({
      vaultUtxo: ctx.vault.utxo,
      required,
      currentEpoch,
      vaultModule: vaultModuleOf(ctx.vault.scope.vaultType),
      vaultPlutusJson: this.deps.vaultPlutusJson,
      ...(ctx.ownerAuth === undefined ? {} : { ownerAuth: ctx.ownerAuth }),
      // Gen v2.0: két Instant sang epoch mới làm mới checkpoint ⟹ SDK cần beacon ρ (+ két
      // Wakeme khi `wakeme_link` khác ""). SDK tự quyết lại từ datum, và chỉ trả chúng ra
      // (`vaultSide.rateBeaconUtxo` …) khi lượt này thật sự làm mới.
      ...(p.checkpoint === undefined ? {} : {
        rateBeaconUtxo: p.checkpoint.rateBeaconUtxo,
        instantVaultParams: p.checkpoint.vaultParams,
        ...(p.checkpoint.wakemeVaultUtxo === undefined ? {} : { wakemeVaultUtxo: p.checkpoint.wakemeVaultUtxo }),
      }),
    }));

    const common = {
      lucid,
      engageUtxo,
      vaultUtxo: ctx.vault.utxo,
      priceBeaconUtxo,
      consumeScript,
      vaultScript,
      vaultBurnRedeemerCbor: vaultSide.vaultBurnRedeemerCbor,
      vaultOutDatumCbor: vaultSide.vaultOutDatumCbor,
      vaultKind: vaultSide.vaultKind,
      ...(vaultSide.rateBeaconUtxo === undefined ? {} : { rateBeaconUtxo: vaultSide.rateBeaconUtxo }),
      ...(vaultSide.wakemeVaultUtxo === undefined ? {} : { wakemeVaultUtxo: vaultSide.wakemeVaultUtxo }),
      // Chủ khoá: bí danh cũ vẫn đúng (chính chủ thread). Chủ script: KHÔNG có khoá nào để
      // khai ở đây — quyền chủ đi qua mục rút `Script(h)` của `ownerAuth`.
      ownerSignerKeyHash: ctx.owner.type === "key" ? ctx.owner.hash : undefined,
      ownerAuth: ctx.ownerAuth,
      consumeRefUtxo: consumeRef,
      vaultRefUtxo: vaultRef,
      network: this.deps.network,
      tipPosixMs: ctx.tip.blockTimePosixMs,
      collateralLovelace: ctx.collateralLovelace,
      // Vắng trong cấu hình ⟹ undefined ⟹ bộ dựng không kiểm, validator vẫn ép.
      maxPriceStale: d.consume.maxPriceStale,
    };
    const r = await rejectAsProtocol(() => p.pairs === undefined
      ? buildConsumeTx({ ...common, opType: p.opType, opCount: p.opCount })
      : buildConsumeManyTx({ ...common, pairs: p.pairs }));
    return { txCbor: r.tx.toCBOR() };
  }

  /**
   * Mở thread Engage (genesis) qua `@magiclamp/sdk` ▸ `buildMintEngageTx`. Seed one-shot là
   * một UTxO của ví `changeAddress` (ưu tiên thuần ADA, chọn tất định theo `txHash#idx`), nên
   * ví đó trả min-ADA của thread + phí. Script consume đọc qua ref CIP-33 và phải băm ra đúng
   * `engageScriptHash`.
   */
  async openThread(ctx: OpenThreadContext): Promise<BuiltOpenThread> {
    const d = this.deps.deployment;
    const walletUtxos = await this.deps.chain.utxosAt(ctx.changeAddress);
    const lucid = await this.lucidFor(ctx, walletUtxos);
    const [consumeRef] = await this.deps.chain.utxosByOutRef([d.refScriptUtxos.consume]);
    const consumeScript = scriptOfRef(consumeRef, "consume");
    assertScriptHash(consumeScript, d.consume.engageScriptHash, "consume");
    const sorted = [...walletUtxos].sort((a, b) =>
      a.txHash === b.txHash ? a.outputIndex - b.outputIndex : a.txHash < b.txHash ? -1 : 1);
    const seedUtxo = sorted.find(u => Object.keys(u.assets).every(k => k === "lovelace")) ?? sorted[0]!;
    const r = await rejectAsProtocol(() => buildMintEngageTx({
      lucid,
      consumeScript,
      seedUtxo,
      ownerAuth: ctx.ownerAuth ?? { kind: "key", pkh: ctx.owner.hash },
      network: this.deps.network,
      consumeRefUtxo: consumeRef,
    }));
    return { txCbor: r.tx.toCBOR(), engageNftUnit: r.engageNftUnit };
  }

  /**
   * Gắn DID qua `@magiclamp/consumemagic` ▸ `buildBindDidTx` (không qua `@magiclamp/sdk`: SDK chưa
   * xuất tên này). Script consume đọc qua ref CIP-33 của cấu hình, như `/tx/consume`, và phải băm
   * ra đúng `engageScriptHash`. Không vault, không beacon giá, không validity-range — nhánh
   * `BindDID` không tính giá và không đổi `last_epoch`.
   *
   * Ví của lucid = ví `changeAddress` (phí + thế chấp). Không có đường ví trả phí ở đây: bộ dựng
   * không đặt `validTo`, mà luật ví trả phí đòi hạn dùng ≤ 1 giờ — tầng dịch vụ trả 501 trước khi
   * tới được đây.
   */
  async bindDid(ctx: BindDidContext, p: { engageUtxo: UTxO; didCommit: string }): Promise<BuiltTx> {
    const d = this.deps.deployment;
    const lucid = await this.lucidFor(ctx);
    const [consumeRef] = await this.deps.chain.utxosByOutRef([d.refScriptUtxos.consume]);
    const consumeScript = scriptOfRef(consumeRef, "consume");
    assertScriptHash(consumeScript, d.consume.engageScriptHash, "consume");
    const r = await rejectAsProtocol(() => buildBindDidTx({
      lucid,
      engageUtxo: p.engageUtxo,
      consumeScript,
      didCommit: p.didCommit,
      consumeRefUtxo: consumeRef,
      // Vắng ⟹ chủ khoá: bộ dựng lấy pkh từ datum thread; chủ script: mục rút `Script(h)`.
      ownerAuth: ctx.ownerAuth,
    }));
    return { txCbor: r.tx.toCBOR() };
  }

  /** Lucid + ví CHỈ-ĐỌC. Ví không có khoá; nó chỉ cung cấp địa chỉ đổi tiền thừa và
   *  danh sách UTxO để chọn đầu vào trả phí. */
  /**
   * MỘT thực thể lucid cho MỘT lượt dựng. Không dùng lại giữa các yêu cầu.
   *
   * 🪦 Bản trước giữ một `lucidCache: LucidEvolution | null` sống suốt tiến trình rồi
   * gọi `selectWallet.fromAddress(...)` trên nó ở mỗi lượt. `selectWallet` GHI vào
   * thực thể dùng chung, và sau lúc chọn ví còn nhiều `await` nữa trước khi giao dịch
   * được dựng (đọc script tham chiếu, đọc UTxO shard, đọc beacon giá). `node:http`
   * phục vụ các yêu cầu xen kẽ nhau, nên hai người dùng bấm nút gần nhau là đủ để:
   *
   *   lượt A chọn ví A → A `await` → lượt B chọn ví B (ĐÈ) → A quay lại và dựng
   *
   * ⟹ giao dịch trả cho A mang UTxO trả phí, tài sản thế chấp và **địa chỉ nhận tiền
   * thừa** của B. Không cần kẻ tấn công: lưu lượng bình thường của một dịch vụ nhiều
   * người dùng tự làm hỏng. Và `userAddress` mà `scheduleCommit` truyền xuống KHÔNG
   * cứu được — SDK lấy địa chỉ đổi tiền thừa từ ví đã chọn của lucid, không từ tham số
   * đó. Nghĩa là mọi khẳng định về chiến lược địa chỉ ở README §7 neo vào một biến
   * TOÀN CỤC GHI ĐƯỢC, không neo vào một tham số.
   *
   * Tham số giao thức thì vẫn dùng lại được — chúng là ảnh chụp CHỈ-ĐỌC của mạng, không
   * phải trạng thái của một người gọi. Giữ chúng ở đây để việc dựng một thực thể mới
   * KHÔNG tốn thêm một lượt gọi nhà cung cấp; hạn dùng ngắn để một lần đổi tham số mạng
   * không sống mãi trong tiến trình.
   */
  /**
   * Tạo vault qua `@magiclamp/sdk` ▸ `createVault` — nguồn DUY NHẤT của bộ dựng genesis
   * (đúc NFT one-shot theo seed, datum khởi sinh sạch, min-ADA tính từ datum). Script vault
   * lấy từ UTxO script tham chiếu của lần deploy và phải băm ra đúng script hash của địa chỉ
   * đích; lệch ⟹ `CHAIN_UNAVAILABLE`, không tạo vault ở một địa chỉ ngoài cấu hình.
   */
  async createVault(ctx: CreateVaultContext, p: CreateVaultBuildParams): Promise<BuiltCreateVault> {
    const lucid = await this.lucidFor(ctx, ctx.funding === undefined ? undefined : [walletUtxoOfFunding(ctx.funding)]);
    const d = this.deps.deployment;
    const [vaultRef] = await this.deps.chain.utxosByOutRef([d.refScriptUtxos.vault]);
    const vaultScript = scriptOfRef(vaultRef, "vault");
    assertScriptHash(vaultScript, ctx.scope.scriptHash, "vault");
    const r = await rejectAsProtocol(() => createVault({
      lucid,
      vaultType: ctx.scope.vaultType as VaultType,
      protocol: createVaultProtocol(d, this.deps.network),
      appliedVault: { script: vaultScript, expectedScriptHash: ctx.scope.scriptHash },
      vault: {
        owner: ctx.owner, lampDeposit: p.lampAmount, profile: p.profile,
        ...(p.wakemeLink === undefined ? {} : { wakemeLink: p.wakemeLink }),
      },
      ownerAuth: ctx.ownerAuth,
      tipPosixMs: ctx.tip.blockTimePosixMs,
      funding: ctx.funding?.input,
      collateralLovelace: ctx.collateralLovelace,
    }));
    return { txCbor: r.tx.toCBOR(), vaultNftUnit: r.vaultIdUnit };
  }

  async coinsPerUtxoByte(): Promise<bigint> {
    const pp = await this.protocolParameters(new Blockfrost(this.deps.blockfrostUrl, this.deps.blockfrostProjectId));
    return BigInt(pp.coinsPerUtxoByte);
  }

  /**
   * Lucid với ví CHỈ-ĐỌC mang đúng `walletUtxos` của `walletAddress` — cho các route tài trợ
   * (`sponsor.ts`), cùng nhà cung cấp và cùng ảnh chụp tham số giao thức với mọi route khác.
   */
  async lucidForWallet(walletAddress: string, walletUtxos: UTxO[]): Promise<LucidEvolution> {
    return this.lucidFor({ changeAddress: walletAddress }, walletUtxos);
  }

  /** Ảnh chụp tham số giao thức, làm mới sau `PROTOCOL_PARAMS_TTL_MS`. */
  private async protocolParameters(provider: Blockfrost): Promise<NonNullable<SdkTxBuilder["protocolParams"]>> {
    const now = Date.now();
    if (this.protocolParams === null || now - this.protocolParamsAt > PROTOCOL_PARAMS_TTL_MS) {
      this.protocolParams = await provider.getProtocolParameters();
      this.protocolParamsAt = now;
    }
    return this.protocolParams;
  }

  private async lucidFor(ctx: { changeAddress: string; feePayerUtxo?: UTxO }, presetWalletUtxos?: UTxO[]): Promise<LucidEvolution> {
    const provider = new Blockfrost(this.deps.blockfrostUrl, this.deps.blockfrostProjectId);
    const lucid = await Lucid(provider, this.deps.network, {
      presetProtocolParameters: await this.protocolParameters(provider),
    });

    // Có ví trả phí ⟹ ví lucid mang ĐÚNG UTxO đó: bên trả phí chỉ cho tiêu một UTxO.
    const walletUtxos = presetWalletUtxos
      ?? (ctx.feePayerUtxo !== undefined ? [ctx.feePayerUtxo] : await this.deps.chain.utxosAt(ctx.changeAddress));
    if (walletUtxos.length === 0) {
      throw new TxBuildRejectedError(
        `Địa chỉ ${ctx.changeAddress.slice(0, 20)}… không có UTxO nào để trả phí và làm tài sản ` +
        `thế chấp. Giao dịch tiêu script cần cả hai.`,
        { change_address: ctx.changeAddress },
      );
    }
    lucid.selectWallet.fromAddress(ctx.changeAddress, walletUtxos);
    return lucid;
  }

  private async scheduleScripts(vaultScriptHash: string): Promise<{
    vaultScript: Script; shardScript: Script; refScriptUtxos: UTxO[];
  }> {
    const d = this.deps.deployment;
    const [vaultRef, shardRef] = await this.deps.chain.utxosByOutRef([
      d.refScriptUtxos.vault, requireShard(d, "schedule (ref-script shard)").ref,
    ]);
    const vaultScript = scriptOfRef(vaultRef, "vault");
    const shardScript = scriptOfRef(shardRef, "shard");
    assertScriptHash(vaultScript, vaultScriptHash, "vault");
    return { vaultScript, shardScript, refScriptUtxos: [vaultRef!, shardRef!] };
  }
}

// ── phụ trợ ────────────────────────────────────────────────────────────────────

function scriptOfRef(utxo: UTxO | undefined, what: string): Script {
  if (utxo === undefined || utxo.scriptRef === undefined || utxo.scriptRef === null) {
    throw new ChainUnavailableError(
      `UTxO script tham chiếu của ${what} không mang scriptRef.`,
      { what },
    );
  }
  return utxo.scriptRef;
}

/**
 * Script lấy từ chuỗi PHẢI băm ra đúng script hash của địa chỉ đang dùng.
 *
 * Không có phép kiểm này thì một dòng `ref_script_utxos.vault` trỏ nhầm sang một lần
 * deploy CŨ vẫn dựng ra tx trông bình thường: script đính kèm là bản cũ, địa chỉ vault
 * là bản mới, và chuỗi từ chối bằng một câu không nhắc gì tới cấu hình.
 */
function assertScriptHash(script: Script, expectedHash: string, what: string): void {
  const got = validatorToScriptHash(script);
  if (got !== expectedHash) {
    throw new ChainUnavailableError(
      `Script tham chiếu của ${what} băm ra ${got.slice(0, 16)}… nhưng địa chỉ đang dùng có script ` +
      `hash ${expectedHash.slice(0, 16)}…. Cấu hình ref_script_utxos đang trỏ vào một lần deploy khác.`,
      { what, script_hash_from_chain: got, script_hash_from_address: expectedHash },
    );
  }
}

/**
 * Shard của khối deploy — chỉ khối Instant/Schedule có (`config.ts` ▸ `parseDeployment` đòi
 * cả hai khoá với mọi loại khác Prepaid). Vắng ở đây nghĩa là một khối Prepaid đã đi tới một
 * đường ScheduleGen mà cổng `service.ts` ▸ `assertScopesSupported` lẽ ra phải chặn trước —
 * NÉM, đừng đọc `undefined` thành một địa chỉ.
 */
export function requireShard(d: Deployment, route: string): { address: string; ref: OutRefConfig } {
  if (d.shardAddress === undefined || d.refScriptUtxos.shard === undefined) {
    throw new ConfigMissingError(
      `Đường ${route} cần shard (\`shard_address\` + \`ref_script_utxos.shard\`) nhưng bản deploy ` +
      `không khai — khối két ${d.vaults.map(v => v.vaultType).join(", ")} không có shard.`,
      { missing: "deployment.shard_address", route },
    );
  }
  return { address: d.shardAddress, ref: d.refScriptUtxos.shard };
}

function assertShardsPresent(shardUtxos: UTxO[], address: string): void {
  if (shardUtxos.length === 0) {
    throw new ChainUnavailableError(
      `Địa chỉ shard ${address.slice(0, 20)}… không có UTxO nào. ScheduleGen đọc và cập nhật ` +
      `shard của chủ vault ở mỗi lần commit/fire — không có shard thì không dựng được gì.`,
      { shard_address: address },
    );
  }
}

/**
 * Epoch GIAO THỨC (`(posix_ms − window_origin_ms) / ms_per_epoch`, chia sàn — LAMP
 * `Specs/Window/CONTRACT.md` v1.0). Preview chưa có gốc ⟹ NÉM `WIN-PREVIEW`.
 *
 * 🪦 Bản trước hiện thực hàm này bằng một hằng chép cứng `86_400_000n` cho MỌI mạng,
 * kèm chú thích khai rằng "Preview/Preprod và Mainnet dùng chung hằng này". Câu đó
 * SAI, và nguồn bác nó nằm trong chính gói đã có ở `package.json`:
 * `ProtocolUtils/src/index.ts` ▸ `MS_PER_EPOCH_BY_NETWORK` cho Mainnet
 * `432_000_000n`. Tham số `network` nhận vào rồi bị bỏ đi.
 *
 * Vì sao không bài kiểm nào bắt được: lúc đó Preview và Preprod **cùng** mang giá trị
 * `86_400_000n`, trùng đúng hằng chép cứng, và bộ kiểm chạy `network: "Preview"` ⟹ ca
 * kiểm xanh ở CẢ HAI cực đột biến. Đây là phép thử phải chạy cho mọi hằng-theo-mạng
 * mới: *hai mạng thử nghiệm có cùng giá trị không? cùng ⟹ bộ kiểm không phân biệt
 * được hai cực, và trục mạng chưa được đo.*
 *
 * Sự trùng đó **hết từ 2026-09-20**: Preprod về `432_000_000n`, bằng mainnet. Phép thử
 * một dòng ngay trên thì KHÔNG đổi — nó vẫn là thứ phải chạy cho mọi hằng-theo-mạng
 * mới. Chỉ có kết quả của nó ở đây đổi: trục mạng nay đo được ngay trên hai mạng thử
 * nghiệm, không còn phải mượn Mainnet. Ghi ra vì câu trên viết ở thì hiện tại, và một
 * câu như thế thì già đi lặng lẽ — người đọc sau sẽ tra nó như một số đo đang đúng.
 *
 * Chiều hỏng nếu nó sống tới Mainnet: `currentEpoch` lệch ~5× ⟹ `planBurnBatch` coi
 * MỌI lô MAGIC là đã hết hạn ⟹ người dùng có đủ MAGIC nhận một câu từ chối của giao
 * thức nói sai về số dư của chính họ; và lô nào lọt qua thì datum output mang epoch
 * sai, bị validator từ chối **sau khi người dùng đã ký**.
 */
export function protocolEpoch(posixMs: bigint, network: Network): bigint {
  return posixMsToEpoch(posixMs, network);
}

/**
 * Lỗi mà SDK ném ra là lời từ chối của GIAO THỨC (L×λ > L_avail, MAGIC sống < required,
 * shard hết chỗ…), không phải sự cố hạ tầng. Nó phải đi ra dưới mã 422 kèm NGUYÊN VĂN
 * câu của SDK: câu đó nói được người dùng phải làm gì, còn "có lỗi xảy ra" thì không.
 *
 * Lỗi đã tự khai mã HTTP (`ChainUnavailableError`…) thì đi tiếp nguyên trạng.
 */
async function rejectAsProtocol<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw asProtocolError(e);
  }
}

function rejectSyncAsProtocol<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw asProtocolError(e);
  }
}

function asProtocolError(e: unknown): unknown {
  if (e instanceof ChainUnavailableError || e instanceof TxBuildRejectedError) return e;
  // Lỗi quyền chủ đi tiếp NGUYÊN MÃ — `http.ts` ánh xạ theo `code`, không gộp vào 422.
  if (e instanceof OwnerAuthError || e instanceof CodedApiError) return e;
  // `FundingError` (luật `funding` của SDK) cũng đi tiếp NGUYÊN MÃ: `service.ts` ▸ `asOwnerApiError`
  // ánh xạ nó sang mã `FUNDING_*`; gộp vào 422 `TX_BUILD_REJECTED` là mất mã người gọi rẽ nhánh theo.
  if (e instanceof FundingError) return e;
  if (e instanceof Error) return new TxBuildRejectedError(e.message, { thrown_by: e.name });
  return e;
}

/**
 * Hiện thực dùng trong phép kiểm: trả về một CBOR ĐÃ GHI SẴN, không ngó tới tham số.
 *
 * Đây chính là cái bẫy cho `summary`. Nếu `summary` được chép từ tham số yêu cầu thì
 * nó sẽ khớp yêu cầu và LỆCH với CBOR; phép kiểm dựng đúng ca đó và đòi `summary` đi
 * theo CBOR.
 */
export class RecordedTxBuilder implements TxBuilderPort {
  /** Tham số của lượt gọi gần nhất — để phép kiểm xác nhận nó ĐÃ bị bỏ qua. */
  lastCall: {
    route: string; params: unknown; ownerAuthKind?: "key" | "script"; changeAddress?: string;
    funding?: CreateVaultContext["funding"]; feePayerUtxo?: UTxO; collateralLovelace?: bigint; engageUtxo?: UTxO;
    wakeme?: InstantGenBuildParams["wakeme"];
    /** Tham số đầy đủ mà tầng dịch vụ giao xuống (Gen v2.0: UTxO beacon/shard, apply-param). */
    buildParams?: unknown;
  } | null = null;
  constructor(
    private readonly txCborByRoute: Record<string, string>,
    /** NFT danh-tính mà bản ghi `create_vault` khai đã đúc. */
    private readonly createVaultNftUnit?: string,
    /** NFT thread mà bản ghi `open_thread` khai đã đúc. */
    private readonly openThreadNftUnit?: string,
  ) {}
  private async serve(route: string, params: unknown, ctx?: { ownerAuth?: OwnerAuth<TxBuilder> }): Promise<BuiltTx> {
    this.lastCall = { route, params, ownerAuthKind: ctx?.ownerAuth?.kind };
    const b = ctx as Partial<BuildContext> | undefined;
    if (b?.feePayerUtxo !== undefined) this.lastCall.feePayerUtxo = b.feePayerUtxo;
    if (b?.collateralLovelace !== undefined) this.lastCall.collateralLovelace = b.collateralLovelace;
    const cbor = this.txCborByRoute[route];
    if (cbor === undefined) throw new Error(`[RecordedTxBuilder] không có CBOR ghi sẵn cho "${route}".`);
    return { txCbor: cbor };
  }

  async scheduleCommit(ctx: BuildContext, p: ScheduleCommitBuildParams): Promise<BuiltTx> {
    const b = await this.serve("schedule_commit", { scheduleLength: p.scheduleLength, lampPerEpoch: p.lampPerEpoch }, ctx);
    this.lastCall!.buildParams = p;
    return b;
  }
  scheduleFire(ctx: BuildContext, p: { scheduleId: string }): Promise<BuiltTx> {
    return this.serve("schedule_fire", p, ctx);
  }
  async consume(ctx: BuildContext, p: ConsumeBuildParams): Promise<BuiltTx> {
    const b = await this.serve("consume", p.pairs === undefined ? { opType: p.opType, opCount: p.opCount } : { pairs: p.pairs }, ctx);
    this.lastCall!.engageUtxo = p.engageUtxo;
    this.lastCall!.buildParams = p;
    return b;
  }
  async openThread(ctx: OpenThreadContext): Promise<BuiltOpenThread> {
    const b = await this.serve("open_thread", {}, ctx);
    this.lastCall = { ...this.lastCall!, changeAddress: ctx.changeAddress };
    if (this.openThreadNftUnit === undefined) throw new Error("[RecordedTxBuilder] không khai NFT cho open_thread.");
    return { ...b, engageNftUnit: this.openThreadNftUnit };
  }
  async bindDid(ctx: BindDidContext, p: { engageUtxo: UTxO; didCommit: string }): Promise<BuiltTx> {
    const b = await this.serve("bind_did", { didCommit: p.didCommit }, ctx);
    this.lastCall = { ...this.lastCall!, changeAddress: ctx.changeAddress, engageUtxo: p.engageUtxo };
    return b;
  }
  async instantGen(ctx: BuildContext, p: InstantGenBuildParams): Promise<BuiltTx> {
    // `params` giữ đúng `{ m }` — lượng DUY NHẤT người gọi chọn. Két + beacon đi riêng.
    const b = await this.serve("instant_gen", { m: p.m }, ctx);
    if (p.wakeme !== undefined) this.lastCall!.wakeme = p.wakeme;
    this.lastCall!.buildParams = p;
    return b;
  }
  async refreshCheckpoint(ctx: BuildContext, p: RefreshCheckpointBuildParams): Promise<BuiltTx> {
    const b = await this.serve("refresh_checkpoint", {}, ctx);
    this.lastCall!.buildParams = p;
    return b;
  }
  /** Tham số giao thức của bản ghi. Không khai ⟹ NÉM: một báo giá không được tính min-ADA
   *  trên một con số bộ dựng giả tự đoán. */
  coinsPerUtxoByteValue: bigint | undefined = undefined;
  async coinsPerUtxoByte(): Promise<bigint> {
    if (this.coinsPerUtxoByteValue === undefined) throw new Error("[RecordedTxBuilder] không khai coinsPerUtxoByte.");
    return this.coinsPerUtxoByteValue;
  }
  async createVault(ctx: CreateVaultContext, p: CreateVaultBuildParams): Promise<BuiltCreateVault> {
    const b = await this.serve("create_vault", p, ctx);
    this.lastCall = { ...this.lastCall!, changeAddress: ctx.changeAddress, funding: ctx.funding };
    if (this.createVaultNftUnit === undefined) throw new Error("[RecordedTxBuilder] không khai NFT cho create_vault.");
    return { ...b, vaultNftUnit: this.createVaultNftUnit };
  }
}
