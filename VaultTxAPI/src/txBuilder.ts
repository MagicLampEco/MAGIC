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
  Blockfrost, Lucid, credentialToAddress, keyHashToCredential, validatorToScriptHash,
  type LucidEvolution, type Script, type UTxO,
} from "@lucid-evolution/lucid";
import {
  buildConsumeTx, buildScheduleCommitTx, buildScheduleFireTx, buildVaultBurnBatch,
  decodePriceParam, requiredFromBeacon,
  type PlutusJson, type VaultModule,
} from "@magiclamp/sdk";
import { posixMsToEpoch, type Network } from "@magiclamp/protocol-utils";

import type { ChainReader, ChainTip } from "./chain.js";
import type { Deployment } from "./config.js";
import { ChainUnavailableError, TxBuildRejectedError } from "./errors.js";
import type { FoundVault } from "./vaultLookup.js";

export interface BuildContext {
  ownerPkh: string;
  vault: FoundVault;
  tip: ChainTip;
  /** Địa chỉ nhận tiền thừa + nguồn UTxO trả phí. Suy theo chiến lược khai trong cấu
   *  hình — xem `ChangeAddressStrategy` ở `config.ts` cho khẳng định đi kèm. */
  changeAddress: string;
}

export interface BuiltTx {
  /** Giao dịch CHƯA KÝ, CBOR hex. */
  txCbor: string;
}

export interface TxBuilderPort {
  scheduleCommit(ctx: BuildContext, p: { scheduleLength: bigint; lampPerEpoch: bigint }): Promise<BuiltTx>;
  scheduleFire(ctx: BuildContext, p: { scheduleId: string }): Promise<BuiltTx>;
  consume(ctx: BuildContext, p: { opType: number; opCount: bigint }): Promise<BuiltTx>;
}

/** `VaultType` của cấu hình → `VaultModule` của `buildVaultBurnBatch`. Hai module kiểm
 *  A02 KHÁC NHAU ở `pending_profile`, nên không có mặc định: mặc định nào cũng tái tạo
 *  lỗi cho module kia, và triệu chứng là tx bị từ chối không kèm tên trường. */
export function vaultModuleOf(vaultType: string): VaultModule {
  switch (vaultType) {
    case "Schedule": return "ScheduleGen";
    case "Instant": return "InstantGen";
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

  async scheduleCommit(ctx: BuildContext, p: { scheduleLength: bigint; lampPerEpoch: bigint }): Promise<BuiltTx> {
    const lucid = await this.lucidFor(ctx);
    const { vaultScript, shardScript, refScriptUtxos } = await this.scheduleScripts(ctx.vault.scope.scriptHash);
    const shardUtxos = await this.deps.chain.utxosAt(this.deps.deployment.shardAddress);
    assertShardsPresent(shardUtxos, this.deps.deployment.shardAddress);

    const r = await rejectAsProtocol(() => buildScheduleCommitTx({
      lucid,
      vaultUtxo: ctx.vault.utxo,
      shardUtxos,
      scheduleLength: p.scheduleLength,
      lampPerEpoch: p.lampPerEpoch,
      userAddress: ctx.changeAddress,
      vaultScript,
      shardScript,
      lampPolicyId: this.deps.deployment.lampPolicyId,
      lampAssetName: this.deps.deployment.lampAssetNameHex,
      network: this.deps.network,
      tipPosixMs: ctx.tip.blockTimePosixMs,
      refScriptUtxos,
    }));
    return { txCbor: r.tx.toCBOR() };
  }

  async scheduleFire(ctx: BuildContext, p: { scheduleId: string }): Promise<BuiltTx> {
    const lucid = await this.lucidFor(ctx);
    const { vaultScript, shardScript, refScriptUtxos } = await this.scheduleScripts(ctx.vault.scope.scriptHash);
    const shardUtxos = await this.deps.chain.utxosAt(this.deps.deployment.shardAddress);
    assertShardsPresent(shardUtxos, this.deps.deployment.shardAddress);

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
    }));
    return { txCbor: r.tx.toCBOR() };
  }

  async consume(ctx: BuildContext, p: { opType: number; opCount: bigint }): Promise<BuiltTx> {
    const lucid = await this.lucidFor(ctx);
    const d = this.deps.deployment;

    const [vaultRef, consumeRef] = await this.deps.chain.utxosByOutRef([
      d.refScriptUtxos.vault, d.refScriptUtxos.consume,
    ]);
    const vaultScript = scriptOfRef(vaultRef, "vault");
    assertScriptHash(vaultScript, ctx.vault.scope.scriptHash, "vault");
    const consumeScript = scriptOfRef(consumeRef, "consume");

    const engageUtxo = pickByNft(
      await this.deps.chain.utxosAt(d.consume.engageAddress), d.consume.engageNftUnit, "thread Engage",
    );
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
    const priceParam = decodePriceParam(priceBeaconUtxo.datum);
    const required = rejectSyncAsProtocol(() => requiredFromBeacon(priceParam, p.opType, p.opCount));

    const currentEpoch = protocolEpoch(ctx.tip.blockTimePosixMs, this.deps.network);
    const vaultSide = rejectSyncAsProtocol(() => buildVaultBurnBatch({
      vaultUtxo: ctx.vault.utxo,
      required,
      currentEpoch,
      vaultModule: vaultModuleOf(ctx.vault.scope.vaultType),
      vaultPlutusJson: this.deps.vaultPlutusJson,
    }));

    const r = await rejectAsProtocol(() => buildConsumeTx({
      lucid,
      engageUtxo,
      vaultUtxo: ctx.vault.utxo,
      priceBeaconUtxo,
      consumeScript,
      vaultScript,
      opType: p.opType,
      opCount: p.opCount,
      vaultBurnRedeemerCbor: vaultSide.vaultBurnRedeemerCbor,
      vaultOutDatumCbor: vaultSide.vaultOutDatumCbor,
      ownerSignerKeyHash: ctx.ownerPkh,
      engageNftUnit: d.consume.engageNftUnit,
      consumeRefUtxo: consumeRef,
      vaultRefUtxo: vaultRef,
      network: this.deps.network,
      tipPosixMs: ctx.tip.blockTimePosixMs,
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
  private async lucidFor(ctx: BuildContext): Promise<LucidEvolution> {
    const provider = new Blockfrost(this.deps.blockfrostUrl, this.deps.blockfrostProjectId);
    const now = Date.now();
    if (this.protocolParams === null || now - this.protocolParamsAt > PROTOCOL_PARAMS_TTL_MS) {
      this.protocolParams = await provider.getProtocolParameters();
      this.protocolParamsAt = now;
    }
    const lucid = await Lucid(provider, this.deps.network, {
      presetProtocolParameters: this.protocolParams,
    });

    const walletUtxos = await this.deps.chain.utxosAt(ctx.changeAddress);
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
      d.refScriptUtxos.vault, d.refScriptUtxos.shard,
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

function pickByNft(utxos: UTxO[], nftUnit: string, what: string): UTxO {
  const hits = utxos.filter(u => (u.assets[nftUnit] ?? 0n) === 1n);
  if (hits.length === 0) {
    throw new ChainUnavailableError(
      `Không tìm thấy UTxO nào mang NFT của ${what} (${nftUnit.slice(0, 20)}…).`,
      { what, nft_unit: nftUnit },
    );
  }
  if (hits.length > 1) {
    throw new ChainUnavailableError(
      `Có ${hits.length} UTxO cùng mang NFT của ${what} — bất khả trên sổ cái đã lắng. ` +
      `Từ chối chọn đại một cái.`,
      { what, nft_unit: nftUnit, utxo_refs: hits.map(u => `${u.txHash}#${u.outputIndex}`) },
    );
  }
  return hits[0]!;
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
 * Epoch GIAO THỨC (`posix_ms / ms_per_epoch`, KHÔNG trừ genesis).
 *
 * 🪦 Bản trước hiện thực hàm này bằng một hằng chép cứng `86_400_000n` cho MỌI mạng,
 * kèm chú thích khai rằng "Preview/Preprod và Mainnet dùng chung hằng này". Câu đó
 * SAI, và nguồn bác nó nằm trong chính gói đã có ở `package.json`:
 * `ProtocolUtils/src/index.ts` ▸ `MS_PER_EPOCH_BY_NETWORK` cho Mainnet
 * `432_000_000n`. Tham số `network` nhận vào rồi bị bỏ đi.
 *
 * Vì sao không bài kiểm nào bắt được: Preview và Preprod **cùng** mang giá trị
 * `86_400_000n`, trùng đúng hằng chép cứng, và bộ kiểm chạy `network: "Preview"` ⟹ ca
 * kiểm xanh ở CẢ HAI cực đột biến. Đây là phép thử phải chạy cho mọi hằng-theo-mạng
 * mới: *hai mạng thử nghiệm có cùng giá trị không? cùng ⟹ bộ kiểm không phân biệt
 * được hai cực, và trục mạng chưa được đo.*
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
  lastCall: { route: string; params: unknown } | null = null;

  constructor(private readonly txCborByRoute: Record<string, string>) {}

  private async serve(route: string, params: unknown): Promise<BuiltTx> {
    this.lastCall = { route, params };
    const cbor = this.txCborByRoute[route];
    if (cbor === undefined) throw new Error(`[RecordedTxBuilder] không có CBOR ghi sẵn cho "${route}".`);
    return { txCbor: cbor };
  }

  scheduleCommit(_ctx: BuildContext, p: { scheduleLength: bigint; lampPerEpoch: bigint }): Promise<BuiltTx> {
    return this.serve("schedule_commit", p);
  }
  scheduleFire(_ctx: BuildContext, p: { scheduleId: string }): Promise<BuiltTx> {
    return this.serve("schedule_fire", p);
  }
  consume(_ctx: BuildContext, p: { opType: number; opCount: bigint }): Promise<BuiltTx> {
    return this.serve("consume", p);
  }
}
