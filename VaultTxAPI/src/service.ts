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
import { OwnerAuthError, sameOwner, type Network, type OwnerRef } from "@magiclamp/protocol-utils";
import type { Profile } from "@magiclamp/sdk";

import type { ChainReader } from "./chain.js";
import type { Deployment, VaultScope } from "./config.js";
import {
  BadRequestError, CodedApiError, ConfigMissingError, SubmitRejectedError, TxSummaryUndecodableError,
  ownerApiErrorOf,
} from "./errors.js";
import {
  ownerLockKey, type OwnerWitnessProvider, type ResolvedOwnerWitness, type ScriptOwnerWitness,
} from "./owner.js";
import { IssuedTxRegistry, OwnerLockTable } from "./locks.js";
import {
  summarizeCreateVaultTx, summarizeTx, txBodyHash,
  type CreateVaultSummary, type RequestedIntent, type TxSummary,
} from "./summary.js";
import { assertChangeAddress, enterpriseAddressOf, type BuildContext, type TxBuilderPort } from "./txBuilder.js";
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
  /** Khoá băm phải ký — đọc từ `required_signers` của CHÍNH CBOR vừa dựng. */
  requiredSigners: string[];
  /** Nhân chứng cần thêm ngoài chữ ký (chủ script: mục rút did_stake…). */
  witnessNotes: string[];
}

/** Phần chung của mọi yêu cầu có chủ. */
export interface OwnerRequest {
  owner: OwnerRef;
  /** Chỉ cho chủ script; chủ khoá mà gửi kèm ⟹ 400. */
  ownerWitness?: ScriptOwnerWitness;
  /** Địa chỉ đổi tiền thừa + nguồn UTxO trả phí. Vắng: chủ khoá ⟹ suy theo chiến lược cấu
   *  hình (README §7); chủ script ⟹ 400 `CHANGE_ADDRESS_REQUIRED` (không suy được). */
  changeAddress?: string;
}

export interface CreateVaultRequest extends OwnerRequest {
  kind: "instant" | "schedule";
  /** oildrop, > 0. */
  lampAmount: bigint;
  changeAddress: string;
  profile?: Profile;
}

export interface CreateVaultResponse {
  txCbor: string;
  txHash: string;
  vaultNft: string;
  vaultAddress: string;
  owner: OwnerRef;
  requiredSigners: string[];
  witnessNotes: string[];
  summary: CreateVaultSummary;
  expiresAt: string;
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
  /** Nhân chứng chủ script (did_stake). Vắng ⟹ chủ script nhận 501
   *  `OWNER_SCRIPT_WITNESS_UNAVAILABLE`; chủ khoá không bị ảnh hưởng. */
  ownerWitness?: OwnerWitnessProvider;
}

export class VaultTxService {
  private readonly now: () => number;

  constructor(private readonly deps: VaultTxServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  async scheduleCommit(req: OwnerRequest & { scheduleLength: bigint; lampPerEpoch: bigint }): Promise<BuildResponse> {
    return this.buildOne("Schedule", "schedule_commit", req, (ctx, b) =>
      b.scheduleCommit(ctx, { scheduleLength: req.scheduleLength, lampPerEpoch: req.lampPerEpoch }));
  }

  async scheduleFire(req: OwnerRequest & { scheduleId: string }): Promise<BuildResponse> {
    return this.buildOne("Schedule", "schedule_fire", req, (ctx, b) =>
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
  async instantGen(req: OwnerRequest): Promise<BuildResponse> {
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
    return this.buildOne("Instant", "instant_gen", req, (ctx, b) =>
      b.instantGen(ctx, {}));
  }

  async consume(req: OwnerRequest & { opType: number; opCount: bigint }): Promise<BuildResponse> {
    return this.buildOne(undefined, "consume", req, (ctx, b) =>
      b.consume(ctx, { opType: req.opType, opCount: req.opCount }));
  }

  private async buildOne(
    vaultType: string | undefined,
    intent: RequestedIntent,
    req: OwnerRequest,
    build: (ctx: BuildContext, b: TxBuilderPort) => Promise<{ txCbor: string }>,
  ): Promise<BuildResponse> {
    const owner = assertOwnerRef(req.owner);
    const ownerKey = ownerLockKey(owner);
    const scopes = this.scopesFor(vaultType);
    // 400 trước khi giữ khoá: một yêu cầu hỏng hình dạng không được chiếm chỗ của chủ.
    const changeAddress = this.changeAddressFor(req);
    this.assertWitnessShapeFor(req);
    const startedAt = this.now();
    this.deps.locks.acquire(ownerKey, startedAt);
    try {
      const tip = await this.deps.chain.tip();
      const witness = await this.witnessFor(req);

      const found: FoundVault[] = [];
      const ignored: IgnoredUtxo[] = [];
      for (const scope of scopes) {
        const utxos = await this.deps.chain.utxosAt(scope.address);
        const r = findVaultsAtScope(utxos, scope, owner);
        found.push(...r.vaults);
        ignored.push(...r.ignored);
      }
      const vault = pickSingleVault(found, ownerKey, vaultType ?? "bất kỳ", scopes.map(s => s.address));

      const ctx: BuildContext = {
        owner,
        ownerAuth: witness?.auth,
        vault,
        tip,
        changeAddress,
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
      this.deps.locks.bindTxHash(ownerKey, txHash);
      // Ghi vào sổ phát-hành TRƯỚC khi trả về: `/tx/submit` chỉ nộp thứ có trong sổ.
      this.deps.issued.record(txHash, this.now());

      return {
        txCbor: built.txCbor,
        txHash,
        summary,
        expiresAt: new Date(startedAt + this.deps.lockTtlMs).toISOString(),
        ignored,
        requiredSigners: requiredSignersOf(built.txCbor),
        witnessNotes: this.notesFor(owner, witness, changeAddress),
      };
    } catch (e) {
      this.deps.locks.release(ownerKey);
      throw asOwnerApiError(e);
    }
  }

  /**
   * Tạo vault — giao dịch CHƯA KÝ, đúc NFT danh-tính one-shot (INV-VAULT-IDENTITY), datum
   * khởi sinh sạch, chủ = `owner`. Bộ dựng là `@magiclamp/sdk` ▸ `createVault`, không phải
   * một bản thứ hai (`txBuilder.ts` ▸ `SdkTxBuilder.createVault`).
   *
   * Khác các đường còn lại ở hai chỗ, cả hai có chủ đích:
   *   · `change_address` BẮT BUỘC — LAMP nạp vào vault lấy từ UTxO ở đó; không có địa chỉ
   *     thì không có LAMP nào để khoá, và suy nó từ pkh là khẳng định điều dịch vụ không biết.
   *   · Không đọc vault đầu vào (chưa có), nên bản tóm tắt ĐỌC THẲNG output vault trong CBOR
   *     (`summarizeCreateVaultTx`) và đối chiếu chủ trong datum với chủ yêu cầu.
   */
  async createVault(req: CreateVaultRequest): Promise<CreateVaultResponse> {
    const owner = assertOwnerRef(req.owner);
    if (req.kind !== "instant" && req.kind !== "schedule") {
      throw new BadRequestError(`"kind" phải là "instant" hoặc "schedule".`);
    }
    if (typeof req.lampAmount !== "bigint" || req.lampAmount <= 0n) {
      throw new BadRequestError(`"lamp_amount" phải là số nguyên oildrop > 0.`);
    }
    const scopes = this.scopesFor(req.kind === "instant" ? "Instant" : "Schedule");
    if (scopes.length !== 1) {
      throw new BadRequestError(
        `Cấu hình có ${scopes.length} địa chỉ vault loại ${req.kind}; không chọn đại một cái để tạo vault.`,
        { addresses: scopes.map(s => s.address) },
      );
    }
    const scope = scopes[0]!;
    if (typeof req.changeAddress !== "string" || req.changeAddress === "") {
      throw new CodedApiError(400, "CHANGE_ADDRESS_REQUIRED", `"change_address" bắt buộc khi tạo vault.`);
    }
    const changeAddress = assertChangeAddress(this.deps.network, req.changeAddress);
    this.assertWitnessShapeFor(req);
    const ownerKey = ownerLockKey(owner);
    const startedAt = this.now();
    this.deps.locks.acquire(ownerKey, startedAt);
    try {
      const tip = await this.deps.chain.tip();
      const witness = await this.witnessFor(req);
      const built = await this.deps.builder.createVault(
        { owner, ownerAuth: witness?.auth, scope, tip, changeAddress },
        { lampAmount: req.lampAmount, profile: req.profile },
      );
      const summary = summarizeCreateVaultTx(built.txCbor, {
        vaultAddress: scope.address,
        vaultNftUnit: built.vaultNftUnit,
        lampUnit: this.deps.deployment.lampPolicyId + this.deps.deployment.lampAssetNameHex,
        network: this.deps.network,
      });
      if (!sameOwner(summary.vault.owner, owner)) {
        throw new TxSummaryUndecodableError(
          `datum vault vừa dựng mang chủ ${summary.vault.owner.type}:${summary.vault.owner.hash} ` +
          `khác chủ yêu cầu ${owner.type}:${owner.hash}`,
        );
      }
      if (summary.vault.lamp_deposit_oildrop !== req.lampAmount.toString()) {
        throw new TxSummaryUndecodableError(
          `vault vừa dựng mang ${summary.vault.lamp_deposit_oildrop} oildrop, yêu cầu ${req.lampAmount}`,
        );
      }
      const txHash = txBodyHash(built.txCbor);
      this.deps.locks.bindTxHash(ownerKey, txHash);
      this.deps.issued.record(txHash, this.now());
      return {
        txCbor: built.txCbor,
        txHash,
        vaultNft: built.vaultNftUnit,
        vaultAddress: scope.address,
        owner,
        requiredSigners: summary.required_signers,
        witnessNotes: this.notesFor(owner, witness, changeAddress),
        summary,
        expiresAt: new Date(startedAt + this.deps.lockTtlMs).toISOString(),
      };
    } catch (e) {
      this.deps.locks.release(ownerKey);
      throw asOwnerApiError(e);
    }
  }

  /** Địa chỉ đổi tiền thừa: app gửi thì kiểm; chủ khoá không gửi thì suy theo chiến lược. */
  private changeAddressFor(req: OwnerRequest): string {
    if (req.changeAddress !== undefined) return assertChangeAddress(this.deps.network, req.changeAddress);
    if (req.owner.type === "key") return enterpriseAddressOf(this.deps.network, req.owner.hash);
    throw new CodedApiError(400, "CHANGE_ADDRESS_REQUIRED",
      `Chủ script không có địa chỉ ví suy được — gửi "change_address" (ví trả phí + nhận tiền thừa).`);
  }

  /** Lỗi hình dạng của nhân chứng — kiểm TRƯỚC khi giữ khoá. */
  private assertWitnessShapeFor(req: OwnerRequest): void {
    if (req.owner.type === "key" && req.ownerWitness !== undefined) {
      throw new CodedApiError(400, "OWNER_WITNESS_UNEXPECTED",
        `"owner_witness" chỉ dành cho chủ script; chủ khoá chứng minh quyền bằng chữ ký.`);
    }
    if (req.owner.type === "script") {
      if (this.deps.ownerWitness === undefined) {
        throw new CodedApiError(501, "OWNER_SCRIPT_WITNESS_UNAVAILABLE",
          `Dịch vụ chưa được cấu hình nhân chứng chủ script (thiếu mục \`did_stake\` trong bản ` +
          `deploy). Không có nó thì không dựng được mục rút Script(h) mà validator đòi.`,
          { missing: "deployment.did_stake" });
      }
      if (req.ownerWitness === undefined) {
        throw new CodedApiError(400, "OWNER_SCRIPT_WITNESS_UNAVAILABLE",
          `Chủ là script: yêu cầu phải kèm "owner_witness" (did_stake_script_cbor, anchor_ref, ` +
          `controller_pkh, device_key_hash).`,
          { missing: "owner_witness" });
      }
    }
  }

  private async witnessFor(req: OwnerRequest): Promise<ResolvedOwnerWitness | undefined> {
    if (req.owner.type === "key") return undefined;
    return this.deps.ownerWitness!.resolve(req.owner, req.ownerWitness!);
  }

  private notesFor(owner: OwnerRef, w: ResolvedOwnerWitness | undefined, changeAddress: string): string[] {
    const fee = `Input trả phí + tài sản thế chấp lấy từ ${changeAddress}: khoá thanh toán của địa chỉ ` +
      `đó cũng phải ký.`;
    if (owner.type === "key") return [`Chủ khoá: ký bằng khoá ${owner.hash}.`, fee];
    return [...(w?.notes ?? []), fee];
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

/** `OwnerAuthError` (ném từ bộ dựng / nhân chứng) → lỗi API có mã; lỗi khác đi nguyên. */
function asOwnerApiError(e: unknown): unknown {
  if (e instanceof OwnerAuthError) return ownerApiErrorOf(e);
  return e;
}

/** Chủ phải là `{ type: "key" | "script", hash: 56 hex thường }` — dịch vụ gọi thẳng cũng bị kiểm. */
function assertOwnerRef(o: OwnerRef): OwnerRef {
  if (o === null || typeof o !== "object" || (o.type !== "key" && o.type !== "script")) {
    throw new CodedApiError(400, "OWNER_CREDENTIAL_SHAPE", `"owner.type" phải là "key" hoặc "script".`);
  }
  if (typeof o.hash !== "string" || !PKH_HEX.test(o.hash)) {
    throw new CodedApiError(400, "OWNER_HASH_INVALID", `"owner.hash" phải là 56 ký tự hex thường.`);
  }
  return { type: o.type, hash: o.hash };
}

/** `required_signers` của thân tx, theo thứ tự. Không trường ⟹ mảng rỗng (đó là câu trả lời thật). */
function requiredSignersOf(txCbor: string): string[] {
  const rs = CML.Transaction.from_cbor_hex(txCbor).body().required_signers();
  const out: string[] = [];
  for (let i = 0; rs !== undefined && i < rs.len(); i++) out.push(rs.get(i).to_hex());
  return out;
}

export function toCreateVaultBody(r: CreateVaultResponse): Record<string, unknown> {
  return {
    tx_cbor: r.txCbor,
    tx_hash: r.txHash,
    vault_nft: r.vaultNft,
    vault_address: r.vaultAddress,
    owner: { type: r.owner.type, hash: r.owner.hash },
    required_signers: r.requiredSigners,
    witness_notes: r.witnessNotes,
    summary: r.summary,
    expires_at: r.expiresAt,
  };
}

export function toBuildBody(r: BuildResponse): Record<string, unknown> {
  return {
    tx_cbor: r.txCbor,
    tx_hash: r.txHash,
    summary: r.summary,
    expires_at: r.expiresAt,
    ignored: r.ignored.map(x => ({ utxo_ref: x.utxoRef, reason: x.reason })),
    required_signers: r.requiredSigners,
    witness_notes: r.witnessNotes,
  };
}

export function toSubmitBody(r: SubmitResponse): Record<string, unknown> {
  return { tx_hash: r.txHash, lock_released_for: r.lockReleasedFor };
}
