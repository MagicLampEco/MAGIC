// VaultReadAPI/src/service.ts — nối cổng-ra-chuỗi với lõi thuần, rồi dựng thân bài JSON.
//
// ── VÌ SAO MỌI SỐ NGUYÊN ĐI RA DƯỚI DẠNG CHUỖI ─────────────────────────────────
// Số trong JSON là số dấu-phẩy-động IEEE-754 ở phần lớn trình phân tích. `long` của
// Java đọc qua Jackson từ một literal số JSON vẫn đúng tới 2^53, nhưng oildrop thì
// vượt: trần LAMP là 36×10^15 oildrop, còn 2^53 ≈ 9,007×10^15. Nghĩa là một trường
// oildrop CÓ THẬT vượt được ngưỡng ấy, và lúc vượt thì nó không lỗi — nó làm tròn.
// Đề bài đã dặn: "Đơn vị là nanogic, SỐ NGUYÊN. Không trả số thực." Cách duy nhất
// nói được điều đó qua JSON là gửi chữ số dưới dạng chuỗi, và bên Java đọc bằng
// `new BigInteger(s)`.
//
// ── EPOCH ─────────────────────────────────────────────────────────────────────
// `at_epoch` là epoch GIAO THỨC `(posix_ms − window_origin_ms) / ms_per_epoch`
// (`ProtocolUtils/src/index.ts`, hàm `posixMsToEpoch`; gốc theo LAMP
// `Specs/Window/CONTRACT.md` v1.0). Trên Preprod/Mainnet số này BẰNG epoch Cardano;
// Preview chưa có gốc ⟹ hàm NÉM `WIN-PREVIEW` (fail-closed), tầng HTTP trả 501
// `WINDOW_ORIGIN_UNAVAILABLE`. Bản trước không trừ gốc nên hai số không bao giờ gặp nhau
// (đo 2026-09-11 trên Preview: epoch Cardano 1417, epoch giao thức ≈ 20706).
// Thân bài vẫn LUÔN in cả `at_epoch` lẫn `chain_tip`, và in cả nguồn của `at_epoch`.

import { posixMsToEpoch, type Network } from "@magiclamp/protocol-utils";

import type { ChainReader } from "./chain.js";
import type { VaultScope } from "./config.js";
import { sameOwner, type OwnerRef } from "@magiclamp/protocol-utils";
import { OwnerAliasMismatchError, BadRequestError, ChainUnavailableError, UnknownVaultScopeError } from "./errors.js";
import { readPrepaidVaultsFromUtxos, type PrepaidVaultView } from "./prepaidView.js";
import { readVaultsFromUtxos, type IgnoredUtxo, type VaultView } from "./vaultView.js";

/** Mọi loại két, phân biệt bằng `vaultKind` (`"Prepaid"` ⟹ `PrepaidVaultView`). */
export type AnyVaultView = VaultView | PrepaidVaultView;

const PKH_HEX = /^[0-9a-f]{56}$/;

/**
 * Chủ từ yêu cầu: `owner` hoặc bí danh `ownerPkh`, hash 56 hex THƯỜNG. Cả hai cùng có mà
 * khác chủ ⟹ 400 `OWNER_ALIAS_MISMATCH` — chọn một bên là đoán ý người gọi.
 */
export function resolveReadOwner(req: { owner?: OwnerRef; ownerPkh?: string }): OwnerRef {
  let alias: OwnerRef | undefined;
  if (req.ownerPkh !== undefined) {
    if (typeof req.ownerPkh !== "string" || !PKH_HEX.test(req.ownerPkh)) {
      throw new BadRequestError(
        "owner_pkh phải là 56 ký tự hex thường (khoá băm 28 byte).",
        { owner_pkh_length: String(req.ownerPkh).length },
      );
    }
    alias = { type: "key", hash: req.ownerPkh };
  }
  let o: OwnerRef | undefined;
  if (req.owner !== undefined) {
    const { type, hash } = (req.owner ?? {}) as { type?: unknown; hash?: unknown };
    if ((type !== "key" && type !== "script") || typeof hash !== "string" || !PKH_HEX.test(hash)) {
      throw new BadRequestError(
        "owner phải là { type: \"key\" | \"script\", hash: 56 ký tự hex thường }.",
        { owner_type: typeof type === "string" ? type : typeof type },
      );
    }
    o = { type, hash };
  }
  if (o && alias && !sameOwner(o, alias)) {
    throw new OwnerAliasMismatchError(o, alias);
  }
  const r = o ?? alias;
  if (r === undefined) throw new BadRequestError("Thiếu chủ (owner hoặc owner_pkh).");
  return r;
}

export interface ReadRequest {
  /** Chủ cần đọc. Truyền `owner` HOẶC bí danh `ownerPkh` (= `{ type: "key" }`). */
  owner?: OwnerRef;
  ownerPkh?: string;
  vaultType?: string;
  /** Ép epoch giao thức thay vì lấy từ đỉnh chuỗi. Chỉ để tra lại lịch sử / kiểm thử. */
  atEpoch?: bigint;
}

export interface ReadOutcome {
  network: Network;
  owner: OwnerRef;
  /** `owner.hash` khi chủ là khoá; `null` khi chủ là script. */
  ownerPkh: string | null;
  atEpoch: bigint;
  atEpochSource: "chain_tip" | "caller";
  chainTip: { blockHeight: number; blockHash: string; blockTimePosixMs: bigint };
  vaults: AnyVaultView[];
  ignored: IgnoredUtxo[];
  scopesRead: { vaultType: string; address: string }[];
}

export class VaultReadService {
  constructor(
    private readonly network: Network,
    private readonly scopes: VaultScope[],
    private readonly chain: ChainReader,
  ) {}

  scopesFor(vaultType?: string): VaultScope[] {
    if (vaultType === undefined) return this.scopes;
    const hit = this.scopes.filter(s => s.vaultType === vaultType);
    if (hit.length === 0) {
      throw new UnknownVaultScopeError(
        this.network, vaultType, this.scopes.map(s => `${this.network}/${s.vaultType}`),
      );
    }
    return hit;
  }

  async read(req: ReadRequest): Promise<ReadOutcome> {
    const owner = resolveReadOwner(req);
    const scopes = this.scopesFor(req.vaultType);

    // Đọc đỉnh chuỗi TRƯỚC. Hỏng ở đây ⇒ `CHAIN_UNAVAILABLE` ⇒ ta không trả một
    // danh sách rỗng trông như "chủ này chưa có vault".
    const tip = await this.chain.tip();
    const tipEpoch = posixMsToEpoch(tip.blockTimePosixMs, this.network);
    // Đỉnh chuỗi TRƯỚC gốc cửa sổ ⟹ thời gian khối vô lý (ca hay gặp: GIÂY đọc thành
    // mili-giây). Epoch âm không phải câu hỏi của người gọi, nên đừng để nó rơi xuống cổng
    // `at_epoch ≥ 0` và hiện thành lỗi của người gọi — chỗ hỏng là dữ liệu đỉnh chuỗi.
    if (tipEpoch < 0n) {
      throw new ChainUnavailableError(
        "Thời gian khối ở đỉnh chuỗi nằm trước gốc cửa sổ epoch — dữ liệu đỉnh chuỗi vô lý.",
        { block_time_posix_ms: tip.blockTimePosixMs.toString() },
      );
    }
    const atEpoch = req.atEpoch ?? tipEpoch;
    if (atEpoch < 0n) throw new BadRequestError("at_epoch phải ≥ 0.");

    const vaults: AnyVaultView[] = [];
    const ignored: IgnoredUtxo[] = [];
    for (const scope of scopes) {
      const utxos = await this.chain.utxosAt(scope.address);
      // `scope.vaultType` quyết định LƯỢC ĐỒ nào dùng để giải datum — nó đi theo ĐỊA CHỈ.
      // Datum sai lược đồ của scope (vd datum Instant ở địa chỉ khai Prepaid) ⟹ NÉM 502.
      const r = scope.vaultType === "Prepaid"
        ? readPrepaidVaultsFromUtxos(utxos, scope.scriptHash, scope.address, owner, atEpoch)
        : readVaultsFromUtxos(utxos, scope.scriptHash, scope.address, owner, atEpoch, scope.vaultType);
      vaults.push(...r.vaults);
      ignored.push(...r.ignored);
    }

    return {
      network: this.network,
      owner,
      ownerPkh: owner.type === "key" ? owner.hash : null,
      atEpoch,
      atEpochSource: req.atEpoch === undefined ? "chain_tip" : "caller",
      chainTip: tip,
      vaults,
      ignored,
      scopesRead: scopes.map(s => ({ vaultType: s.vaultType, address: s.address })),
    };
  }
}

// ── Thân bài JSON ───────────────────────────────────────────────────────────────

export function toJsonBody(o: ReadOutcome): Record<string, unknown> {
  return {
    network: o.network,
    owner: { type: o.owner.type, hash: o.owner.hash },
    owner_pkh: o.ownerPkh,
    at_epoch: Number(o.atEpoch),
    at_epoch_source: o.atEpochSource,
    chain_tip: {
      block_height: o.chainTip.blockHeight,
      block_hash: o.chainTip.blockHash,
      block_time_posix_ms: s(o.chainTip.blockTimePosixMs),
    },
    scopes_read: o.scopesRead.map(x => ({ vault_type: x.vaultType, address: x.address })),
    vaults: o.vaults.map(vaultJson),
    // `consumed_credit_nanogic` CỐ Ý không có ở đây, và đây là chỗ khai lý do — trước bản
    // này chỗ này im lặng, nên người đọc không phân biệt được "cố ý bỏ" với "chưa ai cần".
    // Ba lý do độc lập, mỗi lý do một mình đã đủ:
    //   1. Nó là SỐ DƯ, không phải luỹ kế — `validate_instant_gen` đặt nó về 0 mỗi lượt cấp
    //      (`InstantGen/onchain/validators/vault.ak` ▸ `INV-CASHBACK-BOUND`). Tổng của các
    //      số dư tại một thời điểm không nói gì về tổng đã tiêu.
    //   2. Mỗi vault InstantGen khởi đầu ở `wakeme_seed_credit`, KHÁC 0. Cộng N vault là
    //      cộng thêm N lần hạt giống — một con số chưa ai tiêu đồng nào.
    //   3. Cùng tên trường mang hai nghĩa ở hai loại vault (xem docblock ở `vaultView.ts`).
    //      Cộng một số dư với một bộ đếm ra một con số không có đơn vị.
    // Ba trường dưới đây thì cộng được vì chúng cùng là lượng MAGIC tại một thời điểm.
    totals: {
      available_nanogic: s(o.vaults.reduce((t, v) => t + v.availableNanogic, 0n)),
      accrued_nanogic: s(o.vaults.reduce((t, v) => t + v.accruedNanogic, 0n)),
      expired_nanogic: s(o.vaults.reduce((t, v) => t + v.expiredNanogic, 0n)),
      vault_count: o.vaults.length,
    },
    // Đếm, không nuốt: UTxO đậu ở địa chỉ vault mà ta cố ý không tính, kèm lý do.
    // Rỗng là bình thường; khác rỗng là thứ người vận hành nên nhìn.
    ignored: o.ignored.map(x => ({ utxo_ref: x.utxoRef, reason: x.reason })),
  };
}

/** Két Instant/Schedule. Khoá giữ ĐÚNG thứ tự cũ; `prepaid_credits: null` thêm ở cuối
 *  (khoá có mặt trên MỌI vault — xem docblock `vaultKind` ở `vaultView.ts`). */
function genVaultJson(v: VaultView): Record<string, unknown> {
  return {
    utxo_ref: v.utxoRef,
    // BẮT BUỘC có mặt trên mọi vault, giá trị từ tập ĐÓNG `VAULT_KINDS`. Bên gọi cần nó
    // để biết `consumed_credit_nanogic` đang mang nghĩa nào — xem docblock ở `vaultView.ts`.
    vault_kind: v.vaultKind,
    // Hình dạng datum suy từ số trường (Instant 20 / Schedule 19). Đặt cạnh `vault_kind`
    // (suy từ scope) để bên gọi đối chiếu được — xem docblock `datumKind` ở `vaultView.ts`.
    datum_kind: v.datumKind,
    vault_address: v.vaultAddress,
    vault_id_unit: v.vaultIdUnit,
    owner: { type: v.owner.type, hash: v.owner.hash },
    owner_pkh: v.ownerPkh,
    available_nanogic: s(v.availableNanogic),
    accrued_nanogic: s(v.accruedNanogic),
    expired_nanogic: s(v.expiredNanogic),
    consumed_credit_nanogic: s(v.consumedCreditNanogic),
    lamp_balance_oildrop: s(v.lampBalanceOildrop),
    lamp_locked_oildrop: s(v.lampLockedOildrop),
    profile: v.profile,
    last_updated_epoch: Number(v.lastUpdatedEpoch),
    rate_locked_q: v.rateLockedQ === null ? null : s(v.rateLockedQ),
    // ── Ô Gen v2.0. Ba ô chỉ-Instant là `null` ở két Schedule (ô KHÔNG TỒN TẠI), không
    // phải 0: `cap_nanogic: "0"` là trần 0 thật của một két Instant.
    wakeme_link: v.wakemeLink,
    cap_epoch: v.capEpoch === null ? null : Number(v.capEpoch),
    cap_nanogic: v.capNanogic === null ? null : s(v.capNanogic),
    instant_unlock_ms: v.instantUnlockMs === null ? null : s(v.instantUnlockMs),
    usage_window_epoch: Number(v.usageWindowEpoch),
    usage_window: v.usageWindow.map(w => ({
      generated_nanogic: s(w.generatedNanogic),
      consumed_nanogic: s(w.consumedNanogic),
    })),
    batches: v.batches.map(b => ({
      batch_id: b.batchId,
      source: b.source,
      created_epoch: Number(b.createdEpoch),
      decay_window: Number(b.decayWindow),
      expires_at_epoch: Number(b.expiresAtEpoch),
      initial_amount_nanogic: s(b.initialAmountNanogic),
      current_amount_nanogic: s(b.currentAmountNanogic),
      live: b.live,
      contract_id: b.contractId,
    })),
    gen_schedules: v.genSchedules.map(g => ({
      schedule_id: g.scheduleId,
      commit_epoch: Number(g.commitEpoch),
      start_fire_epoch: Number(g.startFireEpoch),
      end_fire_epoch: Number(g.endFireEpoch),
      schedule_length: Number(g.scheduleLength),
      lamp_per_epoch_oildrop: s(g.lampPerEpochOildrop),
      rate_locked_q: s(g.rateLockedQ),
      fired_count: Number(g.firedCount),
      // Chỉ lịch của két Schedule v2.0 có hai trường này; két Instant ⟹ `null`.
      m_per_epoch_nanogic: g.mPerEpochNanogic === null ? null : s(g.mPerEpochNanogic),
      usage_factor_locked_q: g.usageFactorLockedQ === null ? null : s(g.usageFactorLockedQ),
    })),
    // Chỉ két Prepaid có dòng hạn mức; két Gen KHÔNG có trường này trong datum.
    prepaid_credits: null,
  };
}

/**
 * Két Prepaid. CÙNG bộ khoá với `genVaultJson` (bài kiểm `prepaidView.test.ts` so hai bộ
 * khoá). Ô không tồn tại trong datum Prepaid ⟹ `null`, KHÔNG `"0"`/`[]` — lý do từng ô:
 *   consumed_credit_nanogic  datum Prepaid không có `activity_state`; MAGIC đã đốt từ két
 *                            nằm ở `prepaid_credits[].consumed_unsettled_nanogic`.
 *   lamp_balance/locked      két Prepaid không giữ LAMP (nguồn là CARP của quỹ); `"0"` đọc
 *                            thành "chủ có 0 LAMP trong két" — một khẳng định datum không nói.
 *   profile                  PrepaidGen không dùng tư-cách (`PREPAID_PROFILE` = 0 ghim cứng).
 *   rate_locked_q, gen_schedules  không có lịch sinh — `[]` đọc thành "chưa ký lịch nào".
 *   wakeme_link, cap_*, instant_unlock_ms, usage_window*  ô của két Gen v2.0, không có ở đây.
 *   batches[].initial_amount_nanogic  `MagicBatch` Prepaid 7 trường, không có `initial_amount`.
 */
function prepaidVaultJson(v: PrepaidVaultView): Record<string, unknown> {
  return {
    utxo_ref: v.utxoRef,
    vault_kind: v.vaultKind,
    datum_kind: v.datumKind,
    vault_address: v.vaultAddress,
    vault_id_unit: v.vaultIdUnit,
    owner: { type: v.owner.type, hash: v.owner.hash },
    owner_pkh: v.ownerPkh,
    available_nanogic: s(v.availableNanogic),
    accrued_nanogic: s(v.accruedNanogic),
    expired_nanogic: s(v.expiredNanogic),
    consumed_credit_nanogic: null,
    lamp_balance_oildrop: null,
    lamp_locked_oildrop: null,
    profile: null,
    last_updated_epoch: Number(v.lastUpdatedEpoch),
    rate_locked_q: null,
    wakeme_link: null,
    cap_epoch: null,
    cap_nanogic: null,
    instant_unlock_ms: null,
    usage_window_epoch: null,
    usage_window: null,
    batches: v.batches.map(b => ({
      batch_id: b.batchId,
      source: b.source,
      created_epoch: Number(b.createdEpoch),
      decay_window: Number(b.decayWindow),
      expires_at_epoch: Number(b.expiresAtEpoch),
      initial_amount_nanogic: null,
      current_amount_nanogic: s(b.currentAmountNanogic),
      live: b.live,
      contract_id: b.contractId,
    })),
    gen_schedules: null,
    prepaid_credits: v.prepaidCredits.map(c => ({
      fund_id: c.fundId,
      remaining_carpdrop: s(c.remainingCarpdrop),
      issued_epoch: Number(c.issuedEpoch),
      last_draw_epoch: Number(c.lastDrawEpoch),
      consumed_unsettled_nanogic: s(c.consumedUnsettledNanogic),
    })),
  };
}

function vaultJson(v: AnyVaultView): Record<string, unknown> {
  return v.vaultKind === "Prepaid" ? prepaidVaultJson(v) : genVaultJson(v);
}

/** BigInt → chuỗi thập phân. Đơn vị nằm ở TÊN TRƯỜNG, không nằm ở giá trị. */
function s(v: bigint): string {
  return v.toString(10);
}
