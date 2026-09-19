// VaultTxAPI/src/service.ts — nối bốn mảnh: tìm vault → dựng → ĐỌC LẠI CBOR → trả về.
//
// Thứ tự trong `buildOne` không phải chuyện phong cách:
//
//   1. giành khoá mềm TRƯỚC khi đọc chuỗi — khe đua nằm giữa hai lần đọc UTxO, không
//      nằm sau lúc dựng (`locks.ts` nói vì sao khoá giữ tới lúc nộp)
//   2. đọc đỉnh chuỗi TRƯỚC — hỏng ở đây ⟹ `CHAIN_UNAVAILABLE`, không ⟹ "chưa có vault"
//   3. dựng
//   4. ĐỌC LẠI chính CBOR vừa dựng để ra `summary` — bước này KHÔNG nhận tham số yêu cầu
//   5. hỏng ở bất kỳ bước nào ⟹ NHẢ khoá, nếu không một lần lỗi khoá chủ đó suốt thời hạn
//
// Bước 4 là lý do gói này tồn tại ở dạng hiện tại. Xem `summary.ts`.

import { CML } from "@lucid-evolution/lucid";
import type { Network } from "@magiclamp/protocol-utils";

import type { ChainReader } from "./chain.js";
import type { Deployment, VaultScope } from "./config.js";
import { BadRequestError, ConfigMissingError, SubmitRejectedError, TxSummaryUndecodableError } from "./errors.js";
import { IssuedTxRegistry, OwnerLockTable } from "./locks.js";
import { summarizeTx, txBodyHash, type RequestedIntent, type TxSummary } from "./summary.js";
import { enterpriseAddressOf, type BuildContext, type TxBuilderPort } from "./txBuilder.js";
import { findVaultsAtScope, pickSingleVault, type FoundVault, type IgnoredUtxo } from "./vaultLookup.js";

const PKH_HEX = /^[0-9a-f]{56}$/;
const HEX = /^[0-9a-f]+$/;

export interface BuildResponse {
  /** Giao dịch CHƯA KÝ. */
  txCbor: string;
  /** Hash THÂN giao dịch — app đối chiếu lại sau khi ký. */
  txHash: string;
  summary: TxSummary;
  expiresAt: string;
  /** UTxO đậu ở địa chỉ vault mà ta cố ý không tính, kèm lý do. Đếm, không nuốt. */
  ignored: IgnoredUtxo[];
}

export interface SubmitResponse {
  txHash: string;
  /** `owner_pkh` vừa được nhả khoá, hoặc `null` khi không khoá nào mang hash đó. */
  lockReleasedFor: string | null;
}

export interface VaultTxServiceDeps {
  network: Network;
  deployment: Deployment;
  chain: ChainReader;
  builder: TxBuilderPort;
  locks: OwnerLockTable;
  /** Sổ hash thân của giao dịch do CHÍNH dịch vụ này phát ra — `/tx/submit` tra nó. */
  issued: IssuedTxRegistry;
  lockTtlMs: number;
  /** Đồng hồ, tiêm được để phép kiểm dựng ca hết hạn mà không phải chờ thật. */
  now?: () => number;
}

export class VaultTxService {
  private readonly now: () => number;

  constructor(private readonly deps: VaultTxServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  async scheduleCommit(req: { ownerPkh: string; scheduleLength: bigint; lampPerEpoch: bigint }): Promise<BuildResponse> {
    return this.buildOne("Schedule", "schedule_commit", req.ownerPkh, (ctx, b) =>
      b.scheduleCommit(ctx, { scheduleLength: req.scheduleLength, lampPerEpoch: req.lampPerEpoch }));
  }

  async scheduleFire(req: { ownerPkh: string; scheduleId: string }): Promise<BuildResponse> {
    return this.buildOne("Schedule", "schedule_fire", req.ownerPkh, (ctx, b) =>
      b.scheduleFire(ctx, { scheduleId: req.scheduleId }));
  }

  /**
   * Tiêu MAGIC.
   *
   * Không ghim `vault_type`: cả vault Instant lẫn vault Schedule đều tiêu MAGIC được.
   * Chủ nào có cả hai thì `pickSingleVault` ném `VAULT_AMBIGUOUS` — xem `errors.ts` cho
   * lý do không chọn đại.
   */
  /**
   * InstantGen — vault loại `Instant`. Không tham số: lượng cấp do validator quyết.
   *
   * 🔴 Cổng cấu hình nằm Ở ĐÂY, không ở tầng dựng. Đây là một quyết định, không phải
   * chỗ tiện tay: đặt nó trong `SdkTxBuilder` thì nó biến mất cùng lúc với `SdkTxBuilder`
   * — bất kỳ bản dựng nào khác được nối vào cũng làm đường này báo "mở" trong khi bốn
   * giá trị cấu hình vẫn vắng. Một cổng chỉ sống trong MỘT hiện thực của một cổng cắm
   * thì nó gác hiện thực đó, không gác khái niệm.
   */
  async instantGen(req: { ownerPkh: string }): Promise<BuildResponse> {
    if (this.deps.deployment.instant === undefined) {
      throw new ConfigMissingError(
        `Đường InstantGen chưa được cấu hình: bản deploy thiếu mục \`instant\` ` +
        `(\`um_datum_address\` · \`um_nft_unit\` · \`backing_beacon_address\` · ` +
        `\`backing_beacon_nft_unit\`).\n` +
        `  · InstantGen ĐỌC hai reference input lúc chạy, và \`validate_instant_gen\` ` +
        `fail-closed quanh chúng: thiếu beacon, beacon quá hạn, hoặc cờ \`depeg\` bật ` +
        `thì giao dịch bị TỪ CHỐI.\n` +
        `  · Nên mở đường này khi chưa có đủ bốn giá trị là dựng tx nào cũng chết trên ` +
        `chuỗi, với một câu không trỏ về cấu hình. Đóng là trạng thái đúng.`,
        { missing: "deployment.instant" },
      );
    }
    return this.buildOne("Instant", "instant_gen", req.ownerPkh, (ctx, b) =>
      b.instantGen(ctx, {}));
  }

  async consume(req: { ownerPkh: string; opType: number; opCount: bigint }): Promise<BuildResponse> {
    return this.buildOne(undefined, "consume", req.ownerPkh, (ctx, b) =>
      b.consume(ctx, { opType: req.opType, opCount: req.opCount }));
  }

  private async buildOne(
    vaultType: string | undefined,
    intent: RequestedIntent,
    ownerPkh: string,
    build: (ctx: BuildContext, b: TxBuilderPort) => Promise<{ txCbor: string }>,
  ): Promise<BuildResponse> {
    if (!PKH_HEX.test(ownerPkh)) {
      throw new BadRequestError(
        "owner_pkh phải là 56 ký tự hex thường (khoá băm thanh toán 28 byte).",
        { owner_pkh_length: ownerPkh.length },
      );
    }
    const scopes = this.scopesFor(vaultType);
    const startedAt = this.now();

    this.deps.locks.acquire(ownerPkh, startedAt);
    try {
      const tip = await this.deps.chain.tip();

      const found: FoundVault[] = [];
      const ignored: IgnoredUtxo[] = [];
      for (const scope of scopes) {
        const utxos = await this.deps.chain.utxosAt(scope.address);
        const r = findVaultsAtScope(utxos, scope, ownerPkh);
        found.push(...r.vaults);
        ignored.push(...r.ignored);
      }
      const vault = pickSingleVault(found, ownerPkh, vaultType ?? "bất kỳ", scopes.map(s => s.address));

      const ctx: BuildContext = {
        ownerPkh,
        vault,
        tip,
        changeAddress: enterpriseAddressOf(this.deps.network, ownerPkh),
      };
      const built = await build(ctx, this.deps.builder);

      // ── Bước KHÔNG được bỏ: đọc lại chính CBOR vừa dựng ─────────────────────
      // Không tham số nào của yêu cầu đi vào đây. `inputVaultDatumHex` là datum của
      // UTxO đang bị tiêu — một dữ kiện của CHUỖI, đọc ở trên, không phải thứ người
      // gọi khai.
      const inputDatum = vault.utxo.datum;
      if (typeof inputDatum !== "string" || inputDatum === "") {
        throw new TxSummaryUndecodableError(
          "UTxO vault đang bị tiêu không mang datum inline — không suy được phần THÊM/BỚT",
          { utxo_ref: `${vault.utxo.txHash}#${vault.utxo.outputIndex}` },
        );
      }
      const summary = summarizeTx(built.txCbor, {
        vaultAddress: vault.scope.address,
        inputVaultDatumHex: inputDatum,
        lampUnit: this.deps.deployment.lampPolicyId + this.deps.deployment.lampAssetNameHex,
        network: this.deps.network,
        requestedIntent: intent,
      });
      const txHash = txBodyHash(built.txCbor);
      this.deps.locks.bindTxHash(ownerPkh, txHash);
      // Ghi vào sổ phát-hành TRƯỚC khi trả về: `/tx/submit` chỉ nộp thứ có trong sổ.
      this.deps.issued.record(txHash, this.now());

      return {
        txCbor: built.txCbor,
        txHash,
        summary,
        expiresAt: new Date(startedAt + this.deps.lockTtlMs).toISOString(),
        ignored,
      };
    } catch (e) {
      this.deps.locks.release(ownerPkh);
      throw e;
    }
  }

  /**
   * Ghép chứng ký của app vào giao dịch rồi nộp.
   *
   * Dịch vụ KHÔNG ký gì ở đây: nó nhận một `TransactionWitnessSet` đã ký sẵn từ app và
   * ghép vào.
   *
   * 🔴 Phép so `bodyHashBefore`/`bodyHashAfter` dưới đây ĐỪNG đọc thành một cổng. Bản
   * trước của khối chú thích này viết *"hash trước và sau phải bằng nhau — và đó là thứ
   * được kiểm, chứ không phải được giả định"*; câu đó nói quá. `assembled` được dựng từ
   * **chính `tx.body()`**, nên hai vế băm cùng một vật: không có hình dạng đầu vào nào
   * làm nó đỏ, và không ca kiểm nào làm nó đỏ. Nó đo dư âm mã hoá CBOR khi CML tuần tự
   * hoá lại, không đo tính toàn vẹn của việc ghép chứng ký — việc ghép, theo cấu trúc,
   * không chạm thân. Giữ lại vì rẻ; đừng tính nó vào độ phủ.
   *
   * Cổng THẬT của đường này là phép tra sổ phát-hành ngay dưới.
   *
   * Còn một thứ nữa chưa vá và phải nói ra: phép so với hash của nút chuỗi chạy SAU
   * `chain.submitTx`, nên khi nó đỏ thì giao dịch đã lên chuỗi rồi — lời "từ chối" ấy
   * là một báo cáo, không phải một cái chặn.
   */
  async submit(req: { txCbor: string; witnessCbor: string }): Promise<SubmitResponse> {
    assertHex(req.txCbor, "tx_cbor");
    assertHex(req.witnessCbor, "witness_cbor");

    let tx: CML.Transaction;
    try {
      tx = CML.Transaction.from_cbor_hex(req.txCbor);
    } catch (e) {
      throw new BadRequestError(`tx_cbor không giải mã được thành một giao dịch: ${(e as Error).message}`);
    }
    let witnesses: CML.TransactionWitnessSet;
    try {
      witnesses = CML.TransactionWitnessSet.from_cbor_hex(req.witnessCbor);
    } catch (e) {
      throw new BadRequestError(
        `witness_cbor không giải mã được thành TransactionWitnessSet: ${(e as Error).message}. ` +
        `App phải gửi TRỌN bộ chứng ký, không phải riêng một chữ ký.`,
      );
    }
    const vkeys = witnesses.vkeywitnesses();
    if (vkeys === undefined || vkeys.len() === 0) {
      // Bộ chứng ký RỖNG không phải "chưa ký xong" — nó là một giao dịch chắc chắn bị
      // chuỗi từ chối, bằng một câu không nhắc gì tới chữ ký. Chặn ở đây, nói thẳng.
      throw new BadRequestError(
        "witness_cbor không chứa chữ ký vkey nào. Giao dịch này sẽ bị chuỗi từ chối; " +
        "app cần ký thân giao dịch rồi gửi bộ chứng ký thật.",
      );
    }

    const bodyHashBefore = CML.hash_transaction(tx.body()).to_hex();

    // ── XUẤT XỨ: chỉ nộp thứ CHÍNH dịch vụ này đã dựng ──────────────────────────
    // Cổng này phải đứng TRƯỚC `chain.submitTx`. Không có nó, đường này nhận một
    // `tx_cbor` bất kỳ — giao dịch của dapp khác, giao dịch rác, giao dịch hàng loạt —
    // và nộp bằng khoá nhà cung cấp của người vận hành. Điều kiện duy nhất là thẻ bài
    // chia sẻ, thứ nằm sẵn trong mọi bản app.
    //
    // Nó KHÔNG phải cổng uỷ quyền: nó không nói người gọi có quyền với `owner_pkh`
    // nào (Nợ #78). Nó chỉ chặn việc mượn đường nộp.
    if (!this.deps.issued.wasIssued(bodyHashBefore, this.now())) {
      throw new SubmitRejectedError(
        "Giao dịch này không do dịch vụ dựng ra, hoặc đã quá hạn nộp. Dịch vụ chỉ nộp " +
        "giao dịch chính nó vừa phát hành — hãy gọi lại một trong các đường /tx/* để " +
        "dựng bản mới rồi ký bản đó.",
        { body_hash: bodyHashBefore },
      );
    }

    const builder = CML.TransactionWitnessSetBuilder.new();
    builder.add_existing(tx.witness_set());
    builder.add_existing(witnesses);
    const assembled = CML.Transaction.new(tx.body(), builder.build(), tx.is_valid(), tx.auxiliary_data());

    const bodyHashAfter = CML.hash_transaction(assembled.body()).to_hex();
    if (bodyHashAfter !== bodyHashBefore) {
      throw new SubmitRejectedError(
        "Ghép chứng ký làm đổi hash thân giao dịch — chữ ký của người dùng sẽ không còn đúng. " +
        "Từ chối nộp.",
        { body_hash_before: bodyHashBefore, body_hash_after: bodyHashAfter },
      );
    }

    const chainHash = await this.deps.chain.submitTx(assembled.to_cbor_hex());
    if (chainHash !== bodyHashBefore) {
      throw new SubmitRejectedError(
        "Nút chuỗi báo một tx hash khác với hash thân giao dịch mà dịch vụ vừa nộp.",
        { submitted_hash: bodyHashBefore, node_hash: chainHash },
      );
    }
    const lockReleasedFor = this.deps.locks.releaseByTxHash(bodyHashBefore);
    return { txHash: bodyHashBefore, lockReleasedFor };
  }

  scopesFor(vaultType: string | undefined): VaultScope[] {
    if (vaultType === undefined) return this.deps.deployment.vaults;
    const hit = this.deps.deployment.vaults.filter(s => s.vaultType === vaultType);
    if (hit.length === 0) {
      throw new BadRequestError(
        `Không có địa chỉ vault nào được cấu hình cho loại "${vaultType}".`,
        { configured: this.deps.deployment.vaults.map(s => s.vaultType) },
      );
    }
    return hit;
  }
}

function assertHex(v: string, name: string): void {
  if (typeof v !== "string" || v === "" || !HEX.test(v) || v.length % 2 !== 0) {
    throw new BadRequestError(`${name} phải là chuỗi hex thường, số ký tự CHẴN, khác rỗng.`);
  }
}

// ── Thân bài JSON ───────────────────────────────────────────────────────────────
//
// Mọi số tiền là CHUỖI chữ số — xem `units.ts` cho lý do đo được, không phải sở thích.

export function toBuildBody(r: BuildResponse): Record<string, unknown> {
  return {
    tx_cbor: r.txCbor,
    tx_hash: r.txHash,
    summary: r.summary,
    expires_at: r.expiresAt,
    ignored: r.ignored.map(x => ({ utxo_ref: x.utxoRef, reason: x.reason })),
  };
}

export function toSubmitBody(r: SubmitResponse): Record<string, unknown> {
  return { tx_hash: r.txHash, lock_released_for: r.lockReleasedFor };
}
