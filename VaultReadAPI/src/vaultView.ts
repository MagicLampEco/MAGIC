// VaultReadAPI/src/vaultView.ts — LÕI THUẦN: (UTxO thô, script hash vault, epoch) → số MAGIC.
//
// Hàm thuần, không mạng, không khoá, không I/O ⇒ phép kiểm chạy thẳng vào đây.
//
// ── HAI THỨ TỆP NÀY CỐ Ý KHÔNG TỰ LÀM ───────────────────────────────────────────
// 1. Giải mã datum. Dùng `decodeVaultDatumEitherShape` của MagicSDK, không khai lại
//    lược đồ và cũng không tự thử hai hình dạng. Chép lược đồ sang đây là dựng bản thứ
//    hai sẽ lệch ngay lượt đổi datum đầu tiên. (Gen v2.0 có HAI hình dạng: két Instant
//    20 trường, Schedule 19 — xem `MagicSDK/src/schemas.ts` đầu tệp. Datum đời trước
//    (18/17 trường) ⟹ NÉM `VAULT_DATUM_V1`, không đệm ô thiếu.)
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

import { Constr, Data } from "@lucid-evolution/lucid";
import {
  VAULT_DATUM_FIELD_COUNTS, decodeVaultDatumEitherShape, isBatchExpired,
  type VaultDatumEitherShape, type VaultDatumShapeKind,
} from "@magiclamp/sdk";
import { ownerRefOf, sameOwner, type OwnerRef } from "@magiclamp/protocol-utils";

import type { ChainUtxo } from "./chain.js";
import type { VaultKind } from "./config.js";
import { VaultDatumUndecodableError, VaultDatumV1Error, VaultIdentityDuplicateError } from "./errors.js";

/** Hai loại két Gen (Instant, Schedule) — đọc bằng tệp này. Két Prepaid có lược đồ datum
 *  KHÁC hẳn (8 trường, mang `did_commit` và dòng hạn mức) nên đi qua `prepaidView.ts`. */
export type GenVaultKind = Exclude<VaultKind, "Prepaid">;

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
  /** Gen v2.0, CHỈ két Schedule: `M_i` (nanogic mỗi epoch) chốt MỘT lần lúc ký, fire chỉ
   *  đọc trường này. `null` ở két Instant — `GenSchedule` của InstantGen KHÔNG có trường
   *  này, và `0n` ở đây sẽ đọc thành "lịch sinh 0 MAGIC mỗi epoch". */
  mPerEpochNanogic: bigint | null;
  /** Gen v2.0, CHỈ két Schedule: `usage_factor_q` lúc ký (Q = 10⁹), để kiểm toán. `null` ở
   *  két Instant, cùng lý do. */
  usageFactorLockedQ: bigint | null;
}

/** Một ô của `usage_window` (Gen v2.0, SPEC §6.1.2) — nanogic đã sinh / đã tiêu trong epoch. */
export interface EpochUsageView {
  generatedNanogic: bigint;
  consumedNanogic: bigint;
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
   *  mang 20 trường, Schedule 19 (Gen v2.0, `MagicSDK/src/schemas.ts` đầu tệp), nên SỐ
   *  TRƯỜNG phân biệt được hai loại — và giá trị suy ra đó nay được trả ở `datumKind`.
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
  vaultKind: GenVaultKind;
  /** Hình dạng datum ĐÃ ĐỌC ĐƯỢC — suy từ SỐ TRƯỜNG (Instant 20, Schedule 19), không từ
   *  scope. Đặt cạnh `vaultKind` để bên gọi đối chiếu được hai nguồn; hàm này CHƯA tự đối
   *  chiếu (xem docblock `vaultKind`). Các ô chỉ-Instant bên dưới lấy nullability theo
   *  trường NÀY, không theo `vaultKind`: ô vắng mặt trong datum thì không có gì để hiện. */
  datumKind: VaultDatumShapeKind;
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
  // ── Ô Gen v2.0 ──────────────────────────────────────────────────────────────────
  // Ba ô chỉ có ở két Instant (tái dụng ô 6/12/14 của datum): `null` ở két Schedule,
  // nơi ô đó KHÔNG TỒN TẠI (ở Schedule, ô 6/12/14 vẫn là `vacuum_orders`/
  // `delegation_cert`/`streak_state`). Không đệm `0n`/`""`: `0n` là giá trị hợp lệ của
  // một két Instant chưa làm mới checkpoint lần nào, `""` là "chưa nối két Wakeme".
  /** Ô 6 két Instant: `""` (chưa nối) hoặc owner_commit 32 byte hex. */
  wakemeLink: string | null;
  /** Ô 12 két Instant: epoch của lượt làm mới trần gần nhất. */
  capEpoch: bigint | null;
  /** Ô 14 két Instant: trần sinh của epoch `capEpoch`, nanogic. */
  capNanogic: bigint | null;
  /** Ô 17 két Instant: mốc POSIX ms LAMP dùng để sinh được rời két. */
  instantUnlockMs: bigint | null;
  /** Cửa sổ dùng — có ở CẢ HAI loại két từ v2.0. Ô 0 = epoch `usageWindowEpoch` (đang
   *  mở), ô 1..6 = 6 epoch liền trước. Trả NGUYÊN danh sách datum mang, không cắt không
   *  đệm: độ dài do validator ép, mặt tiền này chỉ hiện. */
  usageWindow: EpochUsageView[];
  usageWindowEpoch: bigint;
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
  vaultKind: GenVaultKind,
): ReadVaultsResult {
  return readGatedVaults(
    utxos, vaultScriptHash, owner,
    decodeVaultDatumV2,
    decoded => decoded.datum.owner,
    (decoded, utxoRef, vaultIdUnit, u) =>
      toVaultView(u, decoded, utxoRef, vaultAddress, vaultIdUnit, atEpoch, vaultKind),
  );
}

/**
 * Bốn cổng dùng chung cho MỌI loại két — NFT danh-tính, NFT không thấy hai lần, datum
 * inline, chủ khớp — cộng phép giải mã NÉM khi hỏng. Loại két chỉ khác nhau ở `decode`
 * (lược đồ nào) và `build` (dựng view nào). Xuất cho `prepaidView.ts`: két Prepaid đi qua
 * ĐÚNG bản cổng này, không qua một bản chép thứ hai.
 *
 * @param decode  NÉM khi datum không đúng lược đồ — không trả `null`, không đệm.
 * @param ownerOf Trường `owner` THÔ (dạng `Credential` của Lucid) trong datum đã giải mã.
 */
export function readGatedVaults<D, V extends { utxoRef: string }>(
  utxos: ChainUtxo[],
  vaultScriptHash: string,
  owner: OwnerRef | string,
  decode: (hex: string, utxoRef: string) => D,
  ownerOf: (decoded: D) => unknown,
  build: (decoded: D, utxoRef: string, vaultIdUnit: string, u: ChainUtxo) => V,
): { vaults: V[]; ignored: IgnoredUtxo[] } {
  const vaults: V[] = [];
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

    // NÉM, không `continue`. UTxO này mang NFT danh-tính vault ⇒ nó LÀ vault ⇒ không
    // giải mã được nghĩa là lược đồ của kho đã trôi khỏi chuỗi (hoặc scope trỏ két v1).
    const decoded = decode(u.inlineDatumHex, utxoRef);

    // Chủ là `Credential`: so CẢ tag lẫn hash — két chủ-script cùng 28 byte với một pkh là
    // chủ KHÁC, không lọt sang truy vấn nhánh khoá và ngược lại.
    if (!sameOwner(ownerRefOf(ownerOf(decoded)), wanted)) {
      ignored.push({ utxoRef, reason: "OWNER_MISMATCH" });
      continue;
    }

    vaults.push(build(decoded, utxoRef, vaultIdUnit, u));
  }

  // Thứ tự tất định — bên gọi so kết quả giữa hai lượt được.
  vaults.sort((a, b) => (a.utxoRef < b.utxoRef ? -1 : a.utxoRef > b.utxoRef ? 1 : 0));
  ignored.sort((a, b) => (a.utxoRef < b.utxoRef ? -1 : a.utxoRef > b.utxoRef ? 1 : 0));
  return { vaults, ignored };
}

/**
 * Giải mã datum két Gen v2.0, CẢ HAI hình dạng (Instant 20, Schedule 19) — mặt tiền này
 * phục vụ cả hai scope, nên ghim một hình dạng là biến mọi két loại kia thành 502.
 *
 * Phân loại ĐỜI trước khi giải mã, bằng số trường của `Constr` ngoài cùng so với
 * `VAULT_DATUM_FIELD_COUNTS` của SDK (không gõ tay 18/17): datum v1 ⟹ `VaultDatumV1Error`
 * (mã riêng — lỗi cấu hình scope, không phải lược đồ trôi). Mọi hỏng khác ⟹
 * `VaultDatumUndecodableError`. Không nhánh nào trả `null` hay đệm ô thiếu.
 */
function decodeVaultDatumV2(hex: string, utxoRef: string): VaultDatumEitherShape {
  let raw: unknown;
  try {
    raw = Data.from(hex);
  } catch (e) {
    throw new VaultDatumUndecodableError(utxoRef, (e as Error).message);
  }
  if (raw instanceof Constr && raw.index === 0) {
    const n = raw.fields.length;
    if (n === VAULT_DATUM_FIELD_COUNTS.Instant.v1) throw new VaultDatumV1Error(utxoRef, n, "Instant");
    if (n === VAULT_DATUM_FIELD_COUNTS.Schedule.v1) throw new VaultDatumV1Error(utxoRef, n, "Schedule");
  }
  try {
    return decodeVaultDatumEitherShape(hex);
  } catch (e) {
    throw new VaultDatumUndecodableError(utxoRef, (e as Error).message);
  }
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
  decoded: VaultDatumEitherShape,
  utxoRef: string,
  vaultAddress: string,
  vaultIdUnit: string,
  atEpoch: bigint,
  vaultKind: GenVaultKind,
): VaultView {
  // Gom trường theo TÊN, không theo chỉ số: hai hình dạng khác nhau cả ở giữa.
  const datum = decoded.datum as unknown as RawCommonDatum;
  const isSchedule = decoded.kind === "Schedule";
  const rawBatches = datum.magic_batches;

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

  const genSchedules: GenScheduleView[] = datum.gen_schedules
    .map(s => ({
      scheduleId: s.schedule_id,
      commitEpoch: s.commit_epoch,
      startFireEpoch: s.start_fire_epoch,
      endFireEpoch: s.end_fire_epoch,
      scheduleLength: s.schedule_length,
      lampPerEpochOildrop: s.lamp_per_epoch,
      rateLockedQ: s.rate_locked_q,
      firedCount: s.fired_count,
      mPerEpochNanogic: isSchedule ? requireInt(s.m_per_epoch, "gen_schedules[].m_per_epoch", utxoRef) : null,
      usageFactorLockedQ: isSchedule
        ? requireInt(s.usage_factor_locked_q, "gen_schedules[].usage_factor_locked_q", utxoRef)
        : null,
    }));

  const instant = decoded.kind === "Instant" ? decoded.datum : null;

  return {
    utxoRef,
    vaultKind,
    datumKind: decoded.kind,
    vaultAddress,
    vaultIdUnit,
    owner: ownerRefOf(datum.owner),
    ownerPkh: ownerRefOf(datum.owner).type === "key" ? ownerRefOf(datum.owner).hash : null,
    availableNanogic,
    accruedNanogic,
    expiredNanogic: accruedNanogic - availableNanogic,
    consumedCreditNanogic: datum.activity_state.consumed_credit,
    lampBalanceOildrop: datum.lamp_balance,
    lampLockedOildrop: datum.lamp_locked,
    profile: String(datum.profile),
    lastUpdatedEpoch: datum.last_updated_epoch,
    wakemeLink: instant === null ? null : instant.wakeme_link,
    capEpoch: instant === null ? null : instant.cap_epoch,
    capNanogic: instant === null ? null : instant.cap_nanogic,
    instantUnlockMs: decoded.instantUnlockMs,
    usageWindow: datum.usage_window.map(w => ({
      generatedNanogic: w.generated,
      consumedNanogic: w.consumed,
    })),
    usageWindowEpoch: datum.usage_window_epoch,
    batches,
    genSchedules,
    rateLockedQ: genSchedules.length === 1 ? genSchedules[0]!.rateLockedQ : null,
  };
}

/** Trường mà hình dạng đã đọc BẮT BUỘC có. Vắng ⟹ NÉM, không đệm `0n`. */
function requireInt(v: bigint | undefined, field: string, utxoRef: string): bigint {
  if (typeof v !== "bigint") {
    throw new VaultDatumUndecodableError(utxoRef, `${field} vắng hoặc không phải số nguyên`);
  }
  return v;
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
  /** Chỉ `GenSchedule` của ScheduleGen v2.0 có hai trường này. */
  m_per_epoch?: bigint;
  usage_factor_locked_q?: bigint;
}

/** Các trường CÙNG TÊN ở cả hai hình dạng — đọc theo tên. Ép kiểu vì `Data.from` khai
 *  kiểu lược đồ chứ không khai kiểu dữ liệu (xem `VaultTxAPI/src/vaultDatumShape.ts`). */
interface RawCommonDatum {
  owner: unknown;
  lamp_balance: bigint;
  lamp_locked: bigint;
  magic_batches: RawBatch[];
  gen_schedules: RawSchedule[];
  profile: unknown;
  last_updated_epoch: bigint;
  activity_state: { consumed_credit: bigint };
  usage_window: { generated: bigint; consumed: bigint }[];
  usage_window_epoch: bigint;
}
