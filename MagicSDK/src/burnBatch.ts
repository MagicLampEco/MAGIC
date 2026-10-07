// MagicSDK/src/burnBatch.ts — dựng BÊN VAULT của một lần tiêu MAGIC.
//
// `buildConsumeTx` (ConsumeMAGIC) lo bên Engage và bên định giá, nhưng nó KHÔNG tự dựng
// được hai thứ thuộc về vault, vì vault là module khác và schema datum của nó không nằm
// trong tầm ConsumeMAGIC:
//
//     vaultBurnRedeemerCbor   — redeemer `BurnBatch { burns }`
//     vaultOutDatumCbor       — datum output tiếp-nối (A02); Gen v2.0: 19 trường với
//                               ScheduleGen, 20 với InstantGen (`schemas.ts` đầu tệp).
//                               Lược đồ chọn theo `vaultModule`.
//
// ── Gen v2.0: checkpoint ─────────────────────────────────────────────────────────
// Datum ra còn mang cửa sổ `usage_window` (Σburns cộng vào vế `consumed` của ô 0 SAU khi
// dịch tới epoch hiện tại). Két InstantGen tiêu LẦN ĐẦU trong epoch (`cap_epoch < e`) còn
// phải làm mới `wakeme_link`/`cap_epoch`/`cap_nanogic` — đọc beacon ρ (và két Wakeme nếu
// đã ghim) ở reference input. SDK tính các ô đó bằng `@magiclamp/instantgen-sdk` ▸
// `expectedCheckpoint` (gương `checkpoint.ak`), rồi trả lại đúng UTxO ref cần để truyền
// thẳng vào `buildConsumeTx({ rateBeaconUtxo, wakemeVaultUtxo, vaultKind })` — bộ dựng đó
// đối chiếu datum ra rồi NÉM `CONSUME-012/013/016` khi lệch.
//
// Trước tệp này, chỗ DUY NHẤT trong kho biết dựng hai thứ đó là một kịch bản test
// (`scripts/test/consume_only.ts`). Nghĩa là mọi app muốn tiêu MAGIC phải tự đọc
// `VaultDatum` 17 trường, tự prune batch chết, tự cộng `consumed_credit`, tự tăng
// `attribution` — và sai một trường là vault từ chối tx mà không nói trường nào.
//
// ── P8: đây là GƯƠNG của Aiken, không phải một cách tính độc lập ──────────────────
// `planBurnBatch` phản chiếu ĐÚNG `validate_burn_batch` + `apply_burns` + `prune_expired`
// ở `ScheduleGen/onchain/validators/vault.ak:512-638`. Sửa một bên PHẢI sửa bên kia
// trong CÙNG commit. Neo cụ thể ghi ở từng khối bên dưới.
//
// ⚠ HAI MODULE KHÔNG GIỐNG NHAU — phải khai `vaultModule`.
// Bản trước của khối này viết "InstantGen giống từng dòng" và câu đó SAI ở đúng một
// chỗ, nhưng chỗ đó đủ để chuỗi từ chối tx: InstantGen chạy `apply_pending_profile`
// trước khi kiểm A02 (`InstantGen/onchain/validators/vault.ak:913`, kiểm so với
// `applied` ở `:940-942`), ScheduleGen thì KHÔNG (`ScheduleGen/.../vault.ak:564-566`
// chép y nguyên `input_datum`, và cả tệp không có hàm đó).
// Hệ quả nếu dựng theo bản ScheduleGen cho vault Instant: vault đã gọi `updateProfile`
// và tới epoch `effective_epoch` mà chưa tx nào flush ⟹ on-chain thấy
// `applied.profile = new`, `applied.pending_profile = None`, còn datum ta xuất mang
// profile CŨ ⟹ `expect output_datum.profile == applied.profile` vỡ ⟹ tx bị từ chối,
// đúng loại lỗi "không nói trường nào" mà tệp này sinh ra để gỡ.

import { Constr, Data, type TxBuilder, type UTxO } from "@lucid-evolution/lucid";
import { ownerRefOf, resolveOwnerAuth, type OwnerAuth } from "@magiclamp/protocol-utils";

import {
  InstantVaultDatumSchema, VaultDatumSchema, decodeVaultDatumOfKind,
  type InstantVaultDatum, type VaultDatum,
} from "./schemas.js";
import { resolveConstrIndex, type PlutusJson } from "./redeemerIndex.js";
import {
  applyPendingProfile as applyPendingProfileInstant,
  expectedCheckpoint,
  windowAdd as windowAddInstant,
} from "@magiclamp/instantgen-sdk";
import {
  shiftWindow as shiftWindowSchedule,
  windowAdd as windowAddSchedule,
} from "@magiclamp/schedulegen-sdk";
import { readCheckpointRefs, type CheckpointRefsRead, type InstantRefParams } from "./genV2Refs.js";

/** Nhãn biến thể trong `pub type VaultRedeemer`. */
const BURN_BATCH_TAG = "BurnBatch";

/** Nhan đề validator trong plutus.json — giống nhau ở mọi module vault. */
const VAULT_VALIDATOR_TITLE = "vault.vault.spend";

/** `max_batches_per_vault` — cưỡng chế on-chain ở `constants.ak:42` của mọi module vault.
 *  BOUNDARIES §2 liệt hằng này vào nhóm "phải giữ đồng bộ hai bên". */
const MAX_BATCHES_PER_VAULT = 32;

/**
 * Trần SỐ MỤC trong redeemer `BurnBatch { burns }` của MỘT tx tiêu — hằng của BỘ DỰNG, không phải
 * hằng on-chain (validator không đếm số mục; nó chỉ hết ngân sách ExUnit).
 *
 * `apply_burns` (`InstantGen/onchain/validators/vault.ak` ▸ `apply_burns`) duyệt TOÀN BỘ danh sách
 * lô cho MỖI mục đốt (`list.count` + `list.filter_map`) ⟹ chi phí ~ O(số lô × số mục). Phép đo
 * (`aiken check` cấp hàm, két InstantGen đốt N lô, MAGIC @ `56deb5c2`, trần Preprod epoch 317
 * mem 17.500.000): N=28 → 13,43M mem; 30 → 15,09M; 31 → 15,96M; 32 → 16,85M — cộng phần consume
 * (8 cặp `ConsumeMany` ≈ 3,85M) thì 28 là số lô lớn nhất còn dưới trần. Nguồn: thư MAGIC → LAMP
 * `mg1006lamp-a` (2026-10-06, "Số op tối đa một tx ConsumeMAGIC"), mục "ƯỚC LƯỢNG": ~30 lô với 1 op,
 * ~28 lô với 8 cặp. Lấy số NHỎ hơn để một hằng đúng cho cả `Consume` lẫn `ConsumeMany`.
 *
 * CHƯA ĐO: một tx két InstantGen nhiều lô dựng trọn trên Emulator; và ca két có NHIỀU lô hơn số mục
 * đốt (vd 32 lô, đốt 28) — chi phí đi theo tích hai số, phép đo trên chỉ có ca bằng nhau.
 */
export const MAX_BURN_ENTRIES_PER_TX = 28;

/**
 * Lượt tiêu phải đốt nhiều lô hơn một tx chở được (`MAX_BURN_ENTRIES_PER_TX`), KỂ CẢ khi đã chọn
 * cách đốt ít lô nhất. Ném trước khi dựng tx: không có nó, `complete()` của lucid trượt ở bước đánh
 * giá script với một lỗi ExUnit không nói được người dùng phải làm gì.
 */
export class BurnEntriesOverCapError extends Error {
  readonly code = "CONSUME_TOO_MANY_BATCHES" as const;
  constructor(readonly needed: number, readonly cap: number, readonly liveBatches: number) {
    super(
      `Lượt tiêu này phải đốt MAGIC từ ${needed} lô, mà một giao dịch chỉ đốt được tối đa ${cap} lô. ` +
      `Hãy tiêu một lượng nhỏ hơn (chia thành nhiều lượt), mỗi lượt cần ít lô hơn.`,
    );
    this.name = "BurnEntriesOverCapError";
  }
}

/** Thứ tự đốt mặc định: epoch CHẾT tăng dần (xem `planBurnBatch`), hoà thì epoch tạo tăng dần. */
function byDeathEpoch(a: MagicBatchLike, b: MagicBatchLike): number {
  const da = a.created_epoch + a.decay_window;
  const db = b.created_epoch + b.decay_window;
  if (da !== db) return da < db ? -1 : 1;
  return a.created_epoch < b.created_epoch ? -1 : a.created_epoch > b.created_epoch ? 1 : 0;
}

/** Thứ tự ÍT MỤC NHẤT: lô lớn trước — k lô lớn nhất là tập nhỏ nhất phủ được `required`.
 *  Hoà số dư thì về thứ tự chết để vẫn ưu tiên lô sắp mất. */
function byAmountDesc(a: MagicBatchLike, b: MagicBatchLike): number {
  if (a.current_amount !== b.current_amount) return a.current_amount > b.current_amount ? -1 : 1;
  return byDeathEpoch(a, b);
}

/** Đốt tham lam theo `order` tới khi đủ `required`. Mỗi lô một mục, mục cuối có thể đốt một phần. */
function takeInOrder(order: readonly MagicBatchLike[], required: bigint): BurnEntry[] {
  const burns: BurnEntry[] = [];
  let remain = required;
  for (const b of order) {
    if (remain === 0n) break;
    const take = b.current_amount < remain ? b.current_amount : remain;
    if (take === 0n) continue;               // lô InstantGen đã đốt sạch ở lại với 0 — không mục 0
    burns.push([b.batch_id, take]);          // take > 0 luôn — vault.ak ▸ apply_burns `expect amt > 0`
    remain -= take;
  }
  // Bất khả theo `liveTotal >= required` ở nơi gọi; giữ lại vì nó là bất biến nội bộ, và im lặng ở
  // đây nghĩa là đốt thiếu → `Σburns == required` vỡ → tx bị từ chối không rõ lý do.
  if (remain !== 0n) {
    throw new Error(`[burnBatch] BUG nội bộ: còn thiếu ${remain} nanogic sau khi duyệt hết batch sống.`);
  }
  return burns;
}

/** Một MagicBatch như nó nằm trong datum. Chỉ khai các trường mã này ĐỌC — phần còn lại
 *  đi qua nguyên vẹn bằng spread, đúng ràng buộc "mọi trường khác bất biến" của
 *  `apply_burns`. */
export interface MagicBatchLike {
  batch_id:       string;
  created_epoch:  bigint;
  current_amount: bigint;
  decay_window:   bigint;
  [k: string]: unknown;
}

/** Một dòng của redeemer `BurnBatch`: (batch_id, số nanogic đốt từ batch đó). */
export type BurnEntry = [batchId: string, amount: bigint];

export interface BurnBatchPlan {
  /** Các dòng burn, Σ == `required`. Mỗi `batch_id` xuất hiện NHIỀU NHẤT một lần. */
  burns:      BurnEntry[];
  /** Datum output tiếp-nối, đã áp burn + prune + kế toán + checkpoint Gen v2.0.
   *  InstantGen: `InstantVaultDatum` (20 trường); ScheduleGen: `VaultDatum` (19). */
  newDatum:   VaultDatum | InstantVaultDatum;
  /** Két InstantGen làm mới checkpoint ở lượt này (`cap_epoch < e`). ScheduleGen luôn `false`. */
  checkpointRefreshed: boolean;
  /** Các batch bị bỏ vì đã chết ở epoch này — chúng mất trắng dù có tiêu hay không
   *  (§4.2 dùng-hết-hoặc-mất). Trả ra để app cảnh báo được người dùng. */
  expiredDropped: MagicBatchLike[];
}

/** Module vault đang tiêu. Không có mặc định: mặc định nào cũng tái tạo bug cho module
 *  kia, và triệu chứng là tx bị từ chối không kèm tên trường. */
export type VaultModule = "InstantGen" | "ScheduleGen";

/**
 * Gương của `apply_pending_profile`
 * (`InstantGen/onchain/lib/magiclamp/protocol/profile.ak:19-35`).
 *
 * CHỈ InstantGen chạy hàm này. Áp nhầm cho ScheduleGen cũng sai y như bỏ sót nó ở
 * InstantGen — ScheduleGen kiểm A02 so với `input_datum` thô, nên một datum đã áp
 * pending sẽ vỡ `expect output_datum.pending_profile == input_datum.pending_profile`.
 */
export function applyPendingProfile<T extends VaultDatum | InstantVaultDatum>(datum: T, currentEpoch: bigint): T {
  // Một nguồn: bộ dựng sinh MAGIC (`buildInstantGenTx`) dùng cùng hàm này.
  return applyPendingProfileInstant(datum as never, currentEpoch) as T;
}

/**
 * §4.2 vách đứng: batch chết khi `current_epoch − created_epoch >= decay_window`.
 * Gương của `is_expired`, `ScheduleGen/onchain/validators/vault.ak:630-632`.
 */
export function isBatchExpired(b: MagicBatchLike, currentEpoch: bigint): boolean {
  return currentEpoch - b.created_epoch >= b.decay_window;
}

/**
 * Chọn batch để đốt và dựng datum output — HÀM THUẦN, không cần lucid, test được thẳng.
 *
 * ── VÌ SAO ĐỐT BATCH SẮP CHẾT TRƯỚC ──────────────────────────────────────────────
 * MAGIC là dùng-hết-hoặc-mất theo epoch (§4.2). Batch sắp hết hạn thì hoặc tiêu bây giờ,
 * hoặc mất trắng; batch còn hạn dài vẫn tiêu được ở lần sau. Nên xếp theo epoch chết
 * TĂNG DẦN là chọn duy nhất không bao giờ làm người dùng thiệt. Đốt batch tươi trước là
 * tự vứt phần MAGIC sắp hết hạn.
 *
 * ── VÌ SAO ĐA-BATCH ──────────────────────────────────────────────────────────────
 * `burns` on-chain là `List<(ByteArray, Int)>` và `sum_burns` cộng cả danh sách
 * (`vault.ak:620-624`) — đa-batch là hợp lệ từ đầu. Bản mẫu duy nhất trước đây
 * (`scripts/test/consume_only.ts:309`) dùng `find(b => b.current_amount >= required)`,
 * tức đòi MỘT batch gánh trọn; người dùng có 3 batch 0,5 MAGIC và cần 1,0 MAGIC bị từ
 * chối dù thừa MAGIC. Đó là giới hạn của kịch bản đó, không phải của chuỗi.
 *
 * @param datum        VaultDatum đã giải mã từ UTxO vault.
 * @param required     Σ nanogic phải đốt. `consume.ak` đòi `Σburns == required` — DẤU BẰNG.
 * @param currentEpoch Epoch của tx (phải trùng epoch mà validity range phủ).
 * @param vaultModule  Module của vault. BẮT BUỘC — hai module kiểm A02 khác nhau ở
 *                     `pending_profile`; xem khối ⚠ đầu tệp.
 * @param refs         (InstantGen) beacon ρ + két Wakeme ĐÃ giải mã (`genV2Refs.ts`).
 *                     Chỉ đọc khi `cap_epoch < currentEpoch`; thiếu ρ lúc đó ⟹
 *                     `expectedCheckpoint` NÉM `GEN-INST-011`. ScheduleGen bỏ qua.
 */
export function planBurnBatch(
  datum:        VaultDatum | InstantVaultDatum,
  required:     bigint,
  currentEpoch: bigint,
  vaultModule:  VaultModule,
  refs:         CheckpointRefsRead = { rate: null, wakeme: null },
): BurnBatchPlan {
  if (required <= 0n) {
    throw new Error(`[burnBatch] required=${required} — phải > 0 (vault.ak:552 expect total_burned > 0).`);
  }

  // InstantGen lazy-apply profile TRƯỚC khi kiểm A02; ScheduleGen thì không. Mọi trường
  // dưới đây phải lấy từ `applied`, không phải `datum` thô — nếu không, vault Instant có
  // `pending_profile` tới hạn sẽ bị từ chối ở `:940-942`.
  const applied = vaultModule === "InstantGen"
    ? applyPendingProfile(datum, currentEpoch)
    : datum;

  const batches = applied.magic_batches as unknown as MagicBatchLike[];

  // `apply_burns` đòi `list.count(batches, b.batch_id == bid) == 1` (vault.ak:602). Hai
  // batch trùng id là vault KHÔNG BAO GIỜ đốt được nữa — kể cả burn nhắm vào batch khác
  // vẫn đi qua cùng vòng lặp đó. Bắt ở đây để lỗi chỉ đúng nguyên nhân, thay vì để chuỗi
  // trả về một "script failed" không tên.
  const seen = new Set<string>();
  for (const b of batches) {
    if (seen.has(b.batch_id)) {
      throw new Error(
        `[burnBatch] vault có HAI batch cùng batch_id ${b.batch_id.slice(0, 16)}… — ` +
        `apply_burns (vault.ak:602) đòi count == 1 nên mọi BurnBatch sẽ bị từ chối. ` +
        `Vault này hỏng dữ liệu, không phải lỗi tham số.`,
      );
    }
    seen.add(b.batch_id);
  }

  const live    = batches.filter(b => !isBatchExpired(b, currentEpoch));
  const expired = batches.filter(b =>  isBatchExpired(b, currentEpoch));

  const liveTotal = live.reduce((s, b) => s + b.current_amount, 0n);
  if (liveTotal < required) {
    throw new Error(
      `[burnBatch] MAGIC còn sống ${liveTotal} nanogic < required ${required} tại epoch ${currentEpoch}. ` +
      `Batch sống: ${live.length}, batch đã chết (mất trắng): ${expired.length}. ` +
      `MAGIC là dùng-hết-hoặc-mất theo epoch — không cộng dồn qua epoch.`,
    );
  }

  // Sắp theo epoch CHẾT tăng dần. Bản sao — thứ tự gốc của `magic_batches` phải giữ
  // nguyên ở output (`apply_burns` giữ thứ tự các batch không đụng tới).
  //
  // ── TRẦN SỐ MỤC MỖI TX (`MAX_BURN_ENTRIES_PER_TX`) ─────────────────────────────
  // Validator KHÔNG ép thứ tự mục đốt hay lô nào phải đốt trước: `apply_burns` chỉ đòi mỗi
  // `batch_id` khớp đúng một lô, `0 < amt <= current_amount`, lô chưa chết; `sum_burns` cộng cả
  // danh sách. Nên chọn lại lô là hợp lệ. Thứ tự chết vẫn là lựa chọn đầu (không bao giờ làm người
  // dùng thiệt); chỉ khi nó cần quá trần mới đổi sang cách ÍT MỤC NHẤT (lô lớn trước). Cách ít mục
  // nhất mà vẫn quá trần ⟹ không tx nào chở nổi lượt tiêu này ⟹ NÉM có kiểu.
  let burns = takeInOrder([...live].sort(byDeathEpoch), required);
  if (burns.length > MAX_BURN_ENTRIES_PER_TX) {
    burns = takeInOrder([...live].sort(byAmountDesc), required);
    if (burns.length > MAX_BURN_ENTRIES_PER_TX) {
      throw new BurnEntriesOverCapError(burns.length, MAX_BURN_ENTRIES_PER_TX, live.length);
    }
  }
  const burnBy = new Map<string, bigint>(burns);

  // Gương của `apply_burns` + `prune_expired`: trừ theo từng batch, rồi bỏ mọi batch đã
  // chết — kể cả batch không ai đụng tới.
  //
  // ⚠ Batch đốt trọn về 0: HAI MODULE XỬ NGƯỢC NHAU.
  // - ScheduleGen ▸ `apply_burns`: `if na == 0 { None }` ⟹ batch 0 bị BỎ.
  // - InstantGen ▸ `apply_burns`: luôn `Some(..)` ⟹ batch 0 Ở LẠI. Nó phải ở lại vì
  //   `instant_gen_in_epoch` cộng `initial_amount` của batch còn trong danh sách — xoá nó
  //   là xoá bộ đếm trần C-INST-8. Validator so `magic_batches` bằng tuyệt đối, nên bỏ
  //   batch 0 ở đây là mọi lượt tiêu đốt trọn một batch InstantGen bị từ chối.
  const expectedBatches = batches
    .map(b => {
      const take = burnBy.get(b.batch_id);
      return take === undefined ? b : { ...b, current_amount: b.current_amount - take };
    })
    .filter(b => vaultModule === "InstantGen" || b.current_amount > 0n)
    .filter(b => !isBatchExpired(b, currentEpoch));

  if (expectedBatches.length > MAX_BATCHES_PER_VAULT) {
    throw new Error(
      `[burnBatch] output còn ${expectedBatches.length} batch > trần ${MAX_BATCHES_PER_VAULT} ` +
      `(vault.ak:583). Vault này đã vượt trần từ trước lần tiêu.`,
    );
  }

  // ── A02: chỉ 5 chỗ được đổi, mọi trường còn lại đi qua nguyên vẹn ───────────────
  // `instant_unlock_ms` (chỉ két InstantGen) nằm trong "mọi trường còn lại": nó đi theo
  // phép trải `...applied` và ĐỨNG YÊN, đúng thứ `validate_burn_batch` ép
  // (`expect output_datum.instant_unlock_ms == applied.instant_unlock_ms`).
  // vault.ak:556-578 kiểm TỪNG trường. Mọi trường không nêu ở đây đi qua nguyên vẹn TỪ
  // `applied` — với ScheduleGen `applied === datum`; với InstantGen `applied` đã nuốt
  // `pending_profile` tới hạn, đúng như `:913` làm trước khi kiểm `:940-942`.
  const base = {
    ...applied,
    magic_batches:  expectedBatches,
    activity_state: {
      ...applied.activity_state,
      consumed_credit: applied.activity_state.consumed_credit + required, // :571
    },
    last_updated_epoch: currentEpoch,                                     // :575
    attribution: {
      ...applied.attribution,
      total_events:     applied.attribution.total_events + 1n,            // :577 — +1 mỗi TX,
      last_event_epoch: currentEpoch,                                     //       không theo op_count
    },
  };

  // ── Gen v2.0 checkpoint ─────────────────────────────────────────────────────────
  if (vaultModule === "InstantGen") {
    // Gương `validate_burn_batch` (InstantGen): `expected_checkpoint(applied, …, FollowVault,
    // False, …)` TRƯỚC, rồi `window_add(cp.usage_window, 0, total_burned)`. Làm mới hay không
    // do `cap_epoch` quyết, không do người gọi.
    const a = applied as InstantVaultDatum;
    const cp = expectedCheckpoint(a, currentEpoch, "FollowVault", false, refs.wakeme, refs.rate);
    const newDatum: InstantVaultDatum = {
      ...(base as InstantVaultDatum),
      wakeme_link:        cp.wakeme_link,
      cap_epoch:          cp.cap_epoch,
      cap_nanogic:        cp.cap_nanogic,
      usage_window:       windowAddInstant(cp.usage_window, 0n, required),
      usage_window_epoch: cp.usage_window_epoch,
    };
    return { burns, newDatum, expiredDropped: expired, checkpointRefreshed: a.cap_epoch < currentEpoch };
  }

  // ScheduleGen: `window_add(shift_window(w, w_epoch, e), 0, total_burned)`, epoch := e.
  // Không đọc beacon, không đọc két Wakeme.
  const s = applied as VaultDatum;
  const newDatum: VaultDatum = {
    ...(base as VaultDatum),
    usage_window: windowAddSchedule(
      shiftWindowSchedule(s.usage_window, s.usage_window_epoch, currentEpoch), 0n, required,
    ),
    usage_window_epoch: currentEpoch,
  };
  return { burns, newDatum, expiredDropped: expired, checkpointRefreshed: false };
}

export interface BuildVaultBurnBatchParams {
  /** UTxO vault đang tiêu — cần `datum` (inline). */
  vaultUtxo:       UTxO;
  /** Σ nanogic phải đốt. Lấy từ `requiredFromBeacon` để có thẩm quyền, không tự tính. */
  required:        bigint;
  /** Epoch của tx. Phải trùng epoch mà validity range của tx phủ, nếu không
   *  `current_epoch` on-chain khác con số này và mọi kiểm epoch lệch theo. */
  currentEpoch:    bigint;
  /** Module của vault đang tiêu. BẮT BUỘC — InstantGen lazy-apply `pending_profile`
   *  trước khi kiểm A02, ScheduleGen thì không; xem khối ⚠ đầu tệp. */
  vaultModule:     VaultModule;
  /** plutus.json của module vault — chỉ số constructor `BurnBatch` suy lúc chạy, nên SDK
   *  không lệch được với thứ tự enum on-chain. */
  vaultPlutusJson: PlutusJson;
  /** Chứng minh quyền chủ vault. Hàm này KHÔNG dựng giao dịch nên không gắn gì; nó chỉ
   *  ĐỐI CHIẾU với chủ trong datum và trả lại ở `ownerAuth` để truyền nguyên vào
   *  `buildConsumeTx({ ownerAuth })`. Bỏ trống: chủ khoá ⟹ nhánh key từ datum; chủ script
   *  ⟹ NÉM `OWNER_SCRIPT_WITNESS_UNAVAILABLE` — ném ở đây rẻ hơn ném sau khi đã tra giá. */
  ownerAuth?:      OwnerAuth<TxBuilder>;
  // ── Gen v2.0, CHỈ InstantGen — lượt tiêu đầu tiên trong epoch làm mới checkpoint ──
  /** Beacon ρ (NFT "RHO"). BẮT BUỘC khi `cap_epoch < currentEpoch`; thiếu ⟹ NÉM `GEN-INST-011`. */
  rateBeaconUtxo?:  UTxO;
  /** Két Wakeme đang ghim két này (chỉ ĐỌC). BẮT BUỘC khi làm mới mà `wakeme_link != ""`. */
  wakemeVaultUtxo?: UTxO;
  /** Apply-param của két Instant để soát hai UTxO trên (truyền trọn `InstantVaultParams`
   *  cũng được — `instantVaultParamsFromProtocol`). Bắt buộc khi có một trong hai UTxO. */
  instantVaultParams?: InstantRefParams;
}

export interface BuildVaultBurnBatchResult {
  /** Truyền thẳng vào `buildConsumeTx({ vaultBurnRedeemerCbor })`. */
  vaultBurnRedeemerCbor: string;
  /** Truyền thẳng vào `buildConsumeTx({ vaultOutDatumCbor })`. */
  vaultOutDatumCbor:     string;
  burns:                 BurnEntry[];
  newDatum:              VaultDatum | InstantVaultDatum;
  /** Truyền thẳng vào `buildConsumeTx({ vaultKind })`. */
  vaultKind:             "instant" | "schedule";
  /** Két InstantGen làm mới checkpoint ở lượt này. */
  checkpointRefreshed:   boolean;
  /** Chỉ có khi `checkpointRefreshed` — truyền thẳng vào `buildConsumeTx({ rateBeaconUtxo })`. */
  rateBeaconUtxo?:       UTxO;
  /** Chỉ có khi `checkpointRefreshed` và có két Wakeme — `buildConsumeTx({ wakemeVaultUtxo })`. */
  wakemeVaultUtxo?:      UTxO;
  /** Batch đã chết và bị bỏ trong lần này — MAGIC trong đó mất trắng (§4.2). App nên
   *  hiện cho người dùng thấy, vì đây là mất mát thật và không hoàn được. */
  expiredDropped:        MagicBatchLike[];
  /** Đã đối chiếu với `datum.owner` — truyền thẳng vào `buildConsumeTx({ ownerAuth })`. */
  ownerAuth:             OwnerAuth<TxBuilder>;
}

/**
 * Dựng trọn bên vault của một lần tiêu MAGIC, ra đúng hai chuỗi CBOR mà
 * `buildConsumeTx` đang đòi caller tự lo.
 *
 * @example
 *   const required = await requiredFromBeacon({ ...  });
 *   const vaultSide = buildVaultBurnBatch({
 *     vaultUtxo, required, currentEpoch, vaultPlutusJson,
 *   });
 *   const tx = await buildConsumeTx({
 *     ...,
 *     vaultBurnRedeemerCbor: vaultSide.vaultBurnRedeemerCbor,
 *     vaultOutDatumCbor:     vaultSide.vaultOutDatumCbor,
 *   });
 */
export function buildVaultBurnBatch(
  p: BuildVaultBurnBatchParams,
): BuildVaultBurnBatchResult {
  if (!p.vaultUtxo.datum) {
    throw new Error(
      `[burnBatch] vault UTxO ${p.vaultUtxo.txHash.slice(0, 12)}#${p.vaultUtxo.outputIndex} ` +
      `không có inline datum. Vault luôn mang datum inline — UTxO này không phải vault, ` +
      `hoặc đang trỏ nhầm địa chỉ.`,
    );
  }

  // Lược đồ đi theo `vaultModule`, tham số đã BẮT BUỘC từ trước: InstantGen 20 trường,
  // ScheduleGen 19 (`schemas.ts`). Không thử-hai-hình-dạng vì loại két đã biết: một datum
  // ScheduleGen ở đường InstantGen là lượt truyền nhầm cần kêu. Datum v1 ⟹ NÉM.
  const isInstant = p.vaultModule === "InstantGen";
  const datumSchema = isInstant ? InstantVaultDatumSchema : VaultDatumSchema;
  const datum = decodeVaultDatumOfKind(isInstant ? "Instant" : "Schedule", p.vaultUtxo.datum);

  if (!isInstant && (p.rateBeaconUtxo || p.wakemeVaultUtxo || p.instantVaultParams)) {
    throw new Error(
      `[burnBatch] vaultModule="ScheduleGen" không đọc beacon ρ hay két Wakeme ở nhánh BurnBatch — ` +
      `truyền chúng vào đây là nhầm két. Bỏ rateBeaconUtxo / wakemeVaultUtxo / instantVaultParams.`,
    );
  }

  if (datum.last_updated_epoch > p.currentEpoch) {
    throw new Error(
      `[burnBatch] datum.last_updated_epoch=${datum.last_updated_epoch} > currentEpoch=${p.currentEpoch}. ` +
      `Hoặc epoch truyền vào sai, hoặc đang đọc một UTxO vault đã bị tiêu và thay bằng bản mới.`,
    );
  }

  const ownerAuth = resolveOwnerAuth(ownerRefOf(datum.owner), p.ownerAuth);

  const refs = readCheckpointRefs({
    vaultUtxo: p.vaultUtxo, e: p.currentEpoch, params: p.instantVaultParams,
    rateBeaconUtxo: p.rateBeaconUtxo, wakemeVaultUtxo: p.wakemeVaultUtxo,
  });
  const plan = planBurnBatch(datum, p.required, p.currentEpoch, p.vaultModule, refs);

  const burnIx = resolveConstrIndex(p.vaultPlutusJson, VAULT_VALIDATOR_TITLE, BURN_BATCH_TAG);

  // 🔴 Tuple Aiken `(ByteArray, Int)` mã hoá thành **PlutusData List**, KHÔNG phải Constr.
  // Đo trên @lucid-evolution/lucid 0.4.30, đối chiếu với bản dựng-bằng-schema đang chạy
  // thật ở `scripts/test/consume_only.ts:364`:
  //   [[bid, amt]]                    → d87b9f9f 9f42aabb1904d2ff … ✓ trùng schema
  //   [new Constr(0, [bid, amt])]     → d87b9f9f d8799f42aabb1904d2ff … ✗ thừa d8799f
  // Nguồn: `@lucid-evolution/plutus/dist/index.js:161` — "Tuple is by default a
  // PlutusData List". Bọc nhầm là tx bị từ chối mà không nói trường nào sai.
  const redeemer = new Constr(burnIx, [
    plan.burns.map(([bid, amt]) => [bid, amt] as [string, bigint]),
  ]);

  return {
    vaultBurnRedeemerCbor: Data.to(redeemer),
    vaultOutDatumCbor:     Data.to(plan.newDatum as never, datumSchema),
    burns:                 plan.burns,
    newDatum:              plan.newDatum,
    vaultKind:             isInstant ? "instant" : "schedule",
    checkpointRefreshed:   plan.checkpointRefreshed,
    // Chỉ trả ref khi validator sẽ ĐỌC chúng: cùng epoch thì `current_checkpoint` không
    // nhìn reference input nào, và `buildConsumeTx` cũng không đưa chúng vào tx.
    ...(plan.checkpointRefreshed && p.rateBeaconUtxo ? { rateBeaconUtxo: p.rateBeaconUtxo } : {}),
    ...(plan.checkpointRefreshed && p.wakemeVaultUtxo ? { wakemeVaultUtxo: p.wakemeVaultUtxo } : {}),
    expiredDropped:        plan.expiredDropped,
    ownerAuth,
  };
}
