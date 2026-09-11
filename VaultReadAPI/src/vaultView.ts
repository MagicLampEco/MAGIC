// VaultReadAPI/src/vaultView.ts — LÕI THUẦN: (UTxO thô, script hash vault, epoch) → số MAGIC.
//
// Hàm thuần, không mạng, không khoá, không I/O ⇒ phép kiểm chạy thẳng vào đây.
//
// ── HAI THỨ TỆP NÀY CỐ Ý KHÔNG TỰ LÀM ───────────────────────────────────────────
// 1. Giải mã datum. Dùng `VaultDatumSchema` của MagicSDK, không khai lại lược đồ.
//    Chép lược đồ sang đây là dựng bản thứ hai sẽ lệch ngay lượt đổi datum đầu tiên.
// 2. Luật hết hạn. Dùng `isBatchExpired` của MagicSDK (`MagicSDK/src/burnBatch.ts`),
//    vốn là gương của `is_expired` ở `ScheduleGen/onchain/validators/vault.ak:630-632`.
//    Viết lại `current_epoch - created >= decay_window` ở đây là tạo bản thứ ba của
//    cùng một luật.
//
// ── VÌ SAO CÓ HAI CON SỐ, KHÔNG PHẢI MỘT ────────────────────────────────────────
// MAGIC là dùng-hết-hoặc-mất theo epoch (§4.2), và với ScheduleGen thì
// `decay_window = 1` (`ScheduleGen/onchain/lib/magiclamp/protocol/constants.ak:35`)
// — batch chỉ sống đúng epoch sinh ra nó. Nên một vault có thể vừa "đã sinh ra 64
// triệu nanogic" vừa "tiêu được 0 nanogic hôm nay", và cả hai câu đều ĐÚNG.
//
//   available_nanogic  Σ current_amount của batch CÒN SỐNG tại `atEpoch` — tiêu được.
//   accrued_nanogic    Σ current_amount của MỌI batch còn ghi trong datum — trên sổ.
//   expired_nanogic    accrued − available — đã chết, sẽ bị dọn ở lần tiêu kế tiếp.
//
// Trả MỘT con số là buộc bên gọi đoán nó là con số nào. Một màn hình hiện 0 vì hết
// hạn và một màn hình hiện 0 vì đường đọc gãy trông giống hệt nhau — đó đúng là thứ
// gói này sinh ra để tách.

import { Data } from "@lucid-evolution/lucid";
import { VaultDatumSchema, isBatchExpired, type VaultDatum } from "@magiclamp/sdk";

import type { ChainUtxo } from "./chain.js";
import { VaultDatumUndecodableError, VaultIdentityDuplicateError } from "./errors.js";

/** Độ dài hex của một policy id / script hash (28 byte). */
const POLICY_HEX_LEN = 56;

export interface BatchView {
  batchId: string;
  source: string;
  createdEpoch: bigint;
  /** Epoch ĐẦU TIÊN mà batch đã chết: `created_epoch + decay_window`. */
  expiresAtEpoch: bigint;
  decayWindow: bigint;
  initialAmountNanogic: bigint;
  currentAmountNanogic: bigint;
  live: boolean;
  contractId: string | null;
}

export interface GenScheduleView {
  scheduleId: string;
  commitEpoch: bigint;
  startFireEpoch: bigint;
  endFireEpoch: bigint;
  scheduleLength: bigint;
  lampPerEpochOildrop: bigint;
  rateLockedQ: bigint;
  firedCount: bigint;
}

export interface VaultView {
  utxoRef: string;
  vaultAddress: string;
  /** `policyId + assetNameHex` của NFT danh-tính vault. Policy == script hash của vault. */
  vaultIdUnit: string;
  ownerPkh: string;
  availableNanogic: bigint;
  accruedNanogic: bigint;
  expiredNanogic: bigint;
  consumedCreditNanogic: bigint;
  lampBalanceOildrop: bigint;
  lampLockedOildrop: bigint;
  profile: string;
  lastUpdatedEpoch: bigint;
  batches: BatchView[];
  genSchedules: GenScheduleView[];
  /** `rate_locked_q` ở mức vault CHỈ có nghĩa khi vault có đúng MỘT lịch. Nhiều lịch
   *  (hoặc không lịch nào) ⇒ `null`, và bên gọi đọc `genSchedules`. Bịa một giá trị
   *  gộp ở đây là trả một con số không ai neo được về đâu. */
  rateLockedQ: bigint | null;
}

/** Một UTxO ở địa chỉ vault mà ta cố ý KHÔNG tính — kèm lý do, và được ĐẾM. */
export interface IgnoredUtxo {
  utxoRef: string;
  reason: "NO_VAULT_ID_NFT" | "NO_INLINE_DATUM" | "OWNER_MISMATCH";
}

export interface ReadVaultsResult {
  vaults: VaultView[];
  ignored: IgnoredUtxo[];
}

/**
 * Lọc + giải mã + cộng dồn. KHÔNG mạng.
 *
 * @param utxos           Mọi UTxO chưa tiêu tại địa chỉ vault.
 * @param vaultScriptHash Script hash của vault (28 byte hex) — CŨNG LÀ policy id của
 *                        NFT danh-tính, vì vault là validator đa-mục-đích và handler
 *                        `mint` chạy dưới chính script hash đó
 *                        (`ScheduleGen/onchain/validators/vault.ak:100`).
 * @param vaultAddress    Địa chỉ bech32, chỉ để đưa vào kết quả.
 * @param ownerPkh        28 byte hex. Chỉ vault có `datum.owner` khớp mới được trả.
 * @param atEpoch         Epoch GIAO THỨC dùng để phán batch sống/chết. KHÔNG phải epoch
 *                        Cardano — xem `ProtocolUtils/src/index.ts` §"HAI ĐỒNG HỒ".
 */
export function readVaultsFromUtxos(
  utxos: ChainUtxo[],
  vaultScriptHash: string,
  vaultAddress: string,
  ownerPkh: string,
  atEpoch: bigint,
): ReadVaultsResult {
  const vaults: VaultView[] = [];
  const ignored: IgnoredUtxo[] = [];
  const seenVaultId = new Map<string, string>();   // vaultIdUnit → utxoRef đã thấy

  for (const u of utxos) {
    const utxoRef = `${u.txHash}#${u.outputIndex}`;

    // ── Cổng 1: PHẢI mang NFT danh-tính vault ───────────────────────────────────
    // Lọc theo `datum.owner` KHÔNG ĐỦ. Địa chỉ script là công cộng: ai cũng đặt được
    // một UTxO ở đó với datum tự soạn, khai `owner` là PKH của người khác và khai bao
    // nhiêu MAGIC tuỳ thích. Validator từ chối những UTxO ấy
    // (`ScheduleGen/onchain/validators/vault.ak:266`, `:867-869` đòi đúng một NFT dưới
    // policy == script hash của chính vault) — mặt tiền đọc phải từ chối y hệt, nếu
    // không nó báo một số dư mà không giao dịch nào chi ra được.
    const vaultIdUnit = findVaultIdUnit(u.assets, vaultScriptHash);
    if (vaultIdUnit === null) {
      ignored.push({ utxoRef, reason: "NO_VAULT_ID_NFT" });
      continue;
    }

    // ── Cổng 2: NFT one-shot ⇒ không được thấy hai lần ──────────────────────────
    const prior = seenVaultId.get(vaultIdUnit);
    if (prior !== undefined) {
      throw new VaultIdentityDuplicateError(vaultIdUnit, [prior, utxoRef]);
    }
    seenVaultId.set(vaultIdUnit, utxoRef);

    if (u.inlineDatumHex === null) {
      // Mang NFT mà không có datum inline: không phải rác của người lạ, mà là một vault
      // ta không đọc nổi. Đếm và khai, đừng nuốt.
      ignored.push({ utxoRef, reason: "NO_INLINE_DATUM" });
      continue;
    }

    let datum: VaultDatum;
    try {
      datum = Data.from(u.inlineDatumHex, VaultDatumSchema);
    } catch (e) {
      // NÉM, không `continue`. UTxO này mang NFT danh-tính vault ⇒ nó LÀ vault ⇒
      // không giải mã được nghĩa là lược đồ của kho đã trôi khỏi chuỗi.
      throw new VaultDatumUndecodableError(utxoRef, (e as Error).message);
    }

    if (datum.owner !== ownerPkh) {
      ignored.push({ utxoRef, reason: "OWNER_MISMATCH" });
      continue;
    }

    vaults.push(toVaultView(u, datum, utxoRef, vaultAddress, vaultIdUnit, atEpoch));
  }

  // Thứ tự tất định — bên gọi so kết quả giữa hai lượt được.
  vaults.sort((a, b) => (a.utxoRef < b.utxoRef ? -1 : a.utxoRef > b.utxoRef ? 1 : 0));
  ignored.sort((a, b) => (a.utxoRef < b.utxoRef ? -1 : a.utxoRef > b.utxoRef ? 1 : 0));
  return { vaults, ignored };
}

/** Đúng một asset dưới `policy`, số lượng đúng 1 ⇒ trả unit của nó. Ngược lại null. */
function findVaultIdUnit(assets: Record<string, bigint>, policy: string): string | null {
  let found: string | null = null;
  for (const [unit, qty] of Object.entries(assets)) {
    if (unit.length <= POLICY_HEX_LEN) continue;             // "lovelace" và policy trơ
    if (unit.slice(0, POLICY_HEX_LEN) !== policy) continue;
    if (qty !== 1n) return null;                              // không phải NFT
    if (found !== null) return null;                          // hai token cùng policy
    found = unit;
  }
  return found;
}

function toVaultView(
  u: ChainUtxo,
  datum: VaultDatum,
  utxoRef: string,
  vaultAddress: string,
  vaultIdUnit: string,
  atEpoch: bigint,
): VaultView {
  const rawBatches = datum.magic_batches as unknown as RawBatch[];

  const batches: BatchView[] = rawBatches.map(b => ({
    batchId: b.batch_id,
    source: String(b.source),
    createdEpoch: b.created_epoch,
    decayWindow: b.decay_window,
    expiresAtEpoch: b.created_epoch + b.decay_window,
    initialAmountNanogic: b.initial_amount,
    currentAmountNanogic: b.current_amount,
    // `isBatchExpired` của MagicSDK — gương của `is_expired` on-chain. Không viết lại.
    live: !isBatchExpired(b as never, atEpoch),
    contractId: typeof b.contract_id === "string" ? b.contract_id : null,
  }));

  // ── PHÉP CỘNG DỒN — đây là con số mà cả mặt tiền này tồn tại để trả ─────────────
  // Cộng ĐÚNG các batch còn sống. Gỡ bộ lọc `live` ra thì `available` biến thành
  // `accrued`; gỡ phép cộng ra thì nó biến thành 0 hoặc thành số lượng batch. Cả ba
  // biến thể đều bị `tests/vaultView.test.ts` bắt, bằng một mẫu mà ba giá trị ấy đôi
  // một khác nhau.
  const availableNanogic = batches
    .filter(b => b.live)
    .reduce((sum, b) => sum + b.currentAmountNanogic, 0n);

  const accruedNanogic = batches
    .reduce((sum, b) => sum + b.currentAmountNanogic, 0n);

  const genSchedules: GenScheduleView[] = (datum.gen_schedules as unknown as RawSchedule[])
    .map(s => ({
      scheduleId: s.schedule_id,
      commitEpoch: s.commit_epoch,
      startFireEpoch: s.start_fire_epoch,
      endFireEpoch: s.end_fire_epoch,
      scheduleLength: s.schedule_length,
      lampPerEpochOildrop: s.lamp_per_epoch,
      rateLockedQ: s.rate_locked_q,
      firedCount: s.fired_count,
    }));

  return {
    utxoRef,
    vaultAddress,
    vaultIdUnit,
    ownerPkh: datum.owner,
    availableNanogic,
    accruedNanogic,
    expiredNanogic: accruedNanogic - availableNanogic,
    consumedCreditNanogic: (datum.activity_state as unknown as { consumed_credit: bigint }).consumed_credit,
    lampBalanceOildrop: datum.lamp_balance,
    lampLockedOildrop: datum.lamp_locked,
    profile: String(datum.profile),
    lastUpdatedEpoch: datum.last_updated_epoch,
    batches,
    genSchedules,
    rateLockedQ: genSchedules.length === 1 ? genSchedules[0]!.rateLockedQ : null,
  };
}

interface RawBatch {
  batch_id: string;
  source: unknown;
  created_epoch: bigint;
  initial_amount: bigint;
  current_amount: bigint;
  decay_window: bigint;
  contract_id: string | null;
}

interface RawSchedule {
  schedule_id: string;
  commit_epoch: bigint;
  start_fire_epoch: bigint;
  end_fire_epoch: bigint;
  schedule_length: bigint;
  lamp_per_epoch: bigint;
  rate_locked_q: bigint;
  fired_count: bigint;
}
