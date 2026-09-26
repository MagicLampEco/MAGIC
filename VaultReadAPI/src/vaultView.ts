// VaultReadAPI/src/vaultView.ts — LÕI THUẦN: (UTxO thô, script hash vault, epoch) → số MAGIC.
//
// Hàm thuần, không mạng, không khoá, không I/O ⇒ phép kiểm chạy thẳng vào đây.
//
// ── HAI THỨ TỆP NÀY CỐ Ý KHÔNG TỰ LÀM ───────────────────────────────────────────
// 1. Giải mã datum. Dùng `decodeVaultDatumEitherShape` của MagicSDK, không khai lại
//    lược đồ và cũng không tự thử hai hình dạng. Chép lược đồ sang đây là dựng bản thứ
//    hai sẽ lệch ngay lượt đổi datum đầu tiên. (Có HAI hình dạng: két Instant 18
//    trường, Schedule 17 — xem `MagicSDK/src/schemas.ts` đầu tệp.)
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

import { decodeVaultDatumEitherShape, isBatchExpired, type VaultDatum } from "@magiclamp/sdk";
import { ownerRefOf, sameOwner, type OwnerRef } from "@magiclamp/protocol-utils";

import type { ChainUtxo } from "./chain.js";
import type { VaultKind } from "./config.js";
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
  /** Loại vault — tập ĐÓNG `VAULT_KINDS`. **BẮT BUỘC có mặt trên mọi vault.**
   *
   *  Nguồn là **địa chỉ**: mỗi `VaultScope` trong cấu hình gắn một địa chỉ với đúng một
   *  loại, nên loại đi theo scope chứ không đi theo UTxO. Đó vẫn là nguồn có thẩm quyền,
   *  vì địa chỉ là thứ quyết định validator nào sẽ chạy.
   *
   *  🔴 Bản trước của dòng này viết *"nó không suy được từ datum: `VaultDatumSchema` của
   *  Instant và của Schedule giải mã giống hệt nhau"*. Câu đó **nay SAI**: két Instant
   *  mang 18 trường, Schedule 17 (`MagicSDK/src/schemas.ts` đầu tệp), nên SỐ TRƯỜNG
   *  phân biệt được hai loại.
   *
   *  Hệ quả phải khai, vì nó là một lỗ ĐÃ BIẾT chứ không phải chỗ chưa nghĩ tới: hai
   *  nguồn (scope và số trường) nay đối chiếu được, và hàm này **CHƯA đối chiếu**. Một
   *  cấu hình trỏ scope `Instant` vào một địa chỉ két Schedule sẽ trả về mọi con số
   *  đúng kèm một nhãn `vaultKind` sai, và không gì kêu. Chưa vá ở đây vì phép đối
   *  chiếu đó lật một quyết định đang được ghim bằng bài kiểm
   *  (`tests/vaultView.test.ts` ▸ *"CÙNG một UTxO đọc dưới scope Instant ⇒ vaultKind =
   *  Instant"*), và lật một quyết định không phải việc của một lượt đổi lược đồ.
   *
   *  Vì sao bắt buộc chứ không tuỳ chọn: một trường có ở vault này và vắng ở vault kia thì
   *  bên gọi không phân biệt được *"vault loại lạ"* với *"máy chủ bản cũ"* — hai thứ cần
   *  hai cách xử. Vắng hẳn ở mọi vault thì ít ra nó nhất quán; vắng lỗ chỗ thì không. */
  vaultKind: VaultKind;
  vaultAddress: string;
  /** `policyId + assetNameHex` của NFT danh-tính vault. Policy == script hash của vault. */
  vaultIdUnit: string;
  /** Chủ trong datum — `Credential` dạng JSON. */
  owner: OwnerRef;
  /** Bí danh cũ: bằng `owner.hash` khi chủ là khoá, `null` khi chủ là script (một script
   *  hash KHÔNG phải khoá băm thanh toán — trả nó dưới tên `owner_pkh` là nói sai). */
  ownerPkh: string | null;
  availableNanogic: bigint;
  accruedNanogic: bigint;
  expiredNanogic: bigint;
  /** 🔴 **Đây KHÔNG phải "lượng MAGIC đã tiêu".** Nó là *tín dụng CÓ ĐƯỢC NHỜ tiêu* —
   *  một **số dư tiêu được**, không phải một bộ đếm luỹ kế. Cái tên đọc ngược với vật thật,
   *  nên đừng đặt nhãn cho người dùng từ cái tên này.
   *
   *  Vòng đời ở vault **InstantGen** (bốn vế, neo theo tên hàm trong
   *  `InstantGen/onchain/validators/vault.ak`):
   *    · `validate_mint_vault_id` — genesis ghim `= wakeme_seed_credit`, **khác 0**;
   *    · `validate_burn_batch`    — `+= Σburns`, chỗ TĂNG duy nhất;
   *    · `validate_instant_gen`   — đọc rồi **ĐẶT VỀ 0** (`INV-CASHBACK-BOUND`: tín dụng
   *      được TIÊU, không được dùng lại — nên cùng một lần tiêu không đòi được hai lần);
   *    · `validate_prune_expired` — **không đụng** (đụng là mở một đòn bẩy thưởng miễn phí).
   *
   *  ⟹ con số này **TỤT VỀ 0** sau mỗi lượt InstantGen cấp. Đó là bình thường, không phải
   *  mất dữ liệu.
   *
   *  🔴 Và CÙNG TÊN TRƯỜNG mang HAI NGHĨA, tuỳ vault thuộc validator nào:
   *    · vault **InstantGen**  — số dư tiêu được (vòng đời trên);
   *    · vault **ScheduleGen** — genesis ghim `0`, tăng ở `validate_burn_batch`, và
   *      **không nhánh nào đưa về 0** ⟹ ở đó nó là bộ đếm luỹ kế, và hiện **không ai đọc**
   *      (chú thích ngay tại cổng genesis của `ScheduleGen/onchain/validators/vault.ak`
   *      nói thẳng: *"accumulated by BurnBatch though unread today"*).
   *
   *  Hàm này đọc trường THÔ và **không phân biệt hai loại vault** — câu trả lời API vì thế
   *  chưa có trường nào nói cho bên gọi biết nó đang cầm nghĩa nào. Đó là nợ đã khai, không
   *  phải thiếu sót chưa biết; đề nghị thêm `vault_kind` đã gửi bên tiêu thụ.
   */
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
 * @param owner           Chủ cần lọc, so CẢ tag lẫn hash. Chuỗi 56 hex là bí danh nhánh khoá
 *                        (= `{ type: "key", hash }`). Chỉ vault có `datum.owner` khớp được trả.
 * @param atEpoch         Epoch GIAO THỨC dùng để phán batch sống/chết. KHÔNG phải epoch
 *                        Cardano — xem `ProtocolUtils/src/index.ts` §"HAI ĐỒNG HỒ".
 */
export function readVaultsFromUtxos(
  utxos: ChainUtxo[],
  vaultScriptHash: string,
  vaultAddress: string,
  owner: OwnerRef | string,
  atEpoch: bigint,
  vaultKind: VaultKind,
): ReadVaultsResult {
  const vaults: VaultView[] = [];
  const ignored: IgnoredUtxo[] = [];
  const seenVaultId = new Map<string, string>();   // vaultIdUnit → utxoRef đã thấy
  const wanted: OwnerRef = typeof owner === "string" ? { type: "key", hash: owner } : owner;

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
      // Thử CẢ HAI hình dạng: két Instant 18 trường, Schedule 17. Mặt tiền này phục vụ
      // cả hai scope, nên ghim một hình dạng là biến mọi két của loại kia thành
      // `VAULT_DATUM_UNDECODABLE` — một 502 cho một két hoàn toàn lành.
      datum = decodeVaultDatumEitherShape(u.inlineDatumHex).datum as VaultDatum;
    } catch (e) {
      // NÉM, không `continue`. UTxO này mang NFT danh-tính vault ⇒ nó LÀ vault ⇒
      // không giải mã được nghĩa là lược đồ của kho đã trôi khỏi chuỗi.
      throw new VaultDatumUndecodableError(utxoRef, (e as Error).message);
    }

    // Chủ là `Credential`: so CẢ tag lẫn hash — két chủ-script cùng 28 byte với một pkh là
    // chủ KHÁC, không lọt sang truy vấn nhánh khoá và ngược lại.
    if (!sameOwner(ownerRefOf(datum.owner), wanted)) {
      ignored.push({ utxoRef, reason: "OWNER_MISMATCH" });
      continue;
    }

    vaults.push(toVaultView(u, datum, utxoRef, vaultAddress, vaultIdUnit, atEpoch, vaultKind));
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
  vaultKind: VaultKind,
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
    vaultKind,
    vaultAddress,
    vaultIdUnit,
    owner: ownerRefOf(datum.owner),
    ownerPkh: ownerRefOf(datum.owner).type === "key" ? ownerRefOf(datum.owner).hash : null,
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
