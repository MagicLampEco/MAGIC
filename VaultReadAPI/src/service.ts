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
// `at_epoch` là epoch GIAO THỨC (`posix_ms / ms_per_epoch`), KHÔNG phải epoch Cardano.
// Hai số này không bao giờ gặp nhau — phép chia không trừ genesis
// (`ProtocolUtils/src/index.ts`, hàm `posixMsToEpoch`). Đo 2026-09-11 trên Preview:
// epoch Cardano 1417, epoch giao thức ≈ 20706. Đem so hai số đó là đọc nhầm đồng hồ.
// Nên thân bài LUÔN in cả `at_epoch` lẫn `chain_tip`, và in cả nguồn của `at_epoch`.

import { posixMsToEpoch, type Network } from "@magiclamp/protocol-utils";

import type { ChainReader } from "./chain.js";
import type { VaultScope } from "./config.js";
import { BadRequestError, UnknownVaultScopeError } from "./errors.js";
import { readVaultsFromUtxos, type IgnoredUtxo, type VaultView } from "./vaultView.js";

const PKH_HEX = /^[0-9a-f]{56}$/;

export interface ReadRequest {
  ownerPkh: string;
  vaultType?: string;
  /** Ép epoch giao thức thay vì lấy từ đỉnh chuỗi. Chỉ để tra lại lịch sử / kiểm thử. */
  atEpoch?: bigint;
}

export interface ReadOutcome {
  network: Network;
  ownerPkh: string;
  atEpoch: bigint;
  atEpochSource: "chain_tip" | "caller";
  chainTip: { blockHeight: number; blockHash: string; blockTimePosixMs: bigint };
  vaults: VaultView[];
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
    if (!PKH_HEX.test(req.ownerPkh)) {
      throw new BadRequestError(
        "owner_pkh phải là 56 ký tự hex thường (khoá băm 28 byte).",
        { owner_pkh_length: req.ownerPkh.length },
      );
    }
    const scopes = this.scopesFor(req.vaultType);

    // Đọc đỉnh chuỗi TRƯỚC. Hỏng ở đây ⇒ `CHAIN_UNAVAILABLE` ⇒ ta không trả một
    // danh sách rỗng trông như "chủ này chưa có vault".
    const tip = await this.chain.tip();
    const tipEpoch = posixMsToEpoch(tip.blockTimePosixMs, this.network);
    const atEpoch = req.atEpoch ?? tipEpoch;
    if (atEpoch < 0n) throw new BadRequestError("at_epoch phải ≥ 0.");

    const vaults: VaultView[] = [];
    const ignored: IgnoredUtxo[] = [];
    for (const scope of scopes) {
      const utxos = await this.chain.utxosAt(scope.address);
      const r = readVaultsFromUtxos(
        utxos, scope.scriptHash, scope.address, req.ownerPkh, atEpoch,
      );
      vaults.push(...r.vaults);
      ignored.push(...r.ignored);
    }

    return {
      network: this.network,
      ownerPkh: req.ownerPkh,
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
    owner_pkh: o.ownerPkh,
    at_epoch: Number(o.atEpoch),
    at_epoch_source: o.atEpochSource,
    chain_tip: {
      block_height: o.chainTip.blockHeight,
      block_hash: o.chainTip.blockHash,
      block_time_posix_ms: s(o.chainTip.blockTimePosixMs),
    },
    scopes_read: o.scopesRead.map(x => ({ vault_type: x.vaultType, address: x.address })),
    vaults: o.vaults.map(v => ({
      utxo_ref: v.utxoRef,
      vault_address: v.vaultAddress,
      vault_id_unit: v.vaultIdUnit,
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
      })),
    })),
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

/** BigInt → chuỗi thập phân. Đơn vị nằm ở TÊN TRƯỜNG, không nằm ở giá trị. */
function s(v: bigint): string {
  return v.toString(10);
}
