// MagicSDK/src/burnBatch.ts — dựng BÊN VAULT của một lần tiêu MAGIC.
//
// `buildConsumeTx` (ConsumeMAGIC) lo bên Engage và bên định giá, nhưng nó KHÔNG tự dựng
// được hai thứ thuộc về vault, vì vault là module khác và schema datum của nó không nằm
// trong tầm ConsumeMAGIC:
//
//     vaultBurnRedeemerCbor   — redeemer `BurnBatch { burns }`
//     vaultOutDatumCbor       — datum output tiếp-nối (A02), 17 trường
//
// Trước tệp này, chỗ DUY NHẤT trong kho biết dựng hai thứ đó là một kịch bản test
// (`scripts/test/consume_only.ts`). Nghĩa là mọi app muốn tiêu MAGIC phải tự đọc
// `VaultDatum` 17 trường, tự prune batch chết, tự cộng `consumed_credit`, tự tăng
// `attribution` — và sai một trường là vault từ chối tx mà không nói trường nào.
//
// ── P8: đây là GƯƠNG của Aiken, không phải một cách tính độc lập ──────────────────
// `planBurnBatch` phản chiếu ĐÚNG `validate_burn_batch` + `apply_burns` + `prune_expired`
// ở `ScheduleGen/onchain/validators/vault.ak:512-638` (InstantGen giống từng dòng ở
// `InstantGen/onchain/validators/vault.ak`). Sửa một bên PHẢI sửa bên kia trong CÙNG
// commit. Neo cụ thể ghi ở từng khối bên dưới.

import { Constr, Data, type UTxO } from "@lucid-evolution/lucid";

import { VaultDatumSchema, type VaultDatum } from "./schemas.js";
import { resolveConstrIndex, type PlutusJson } from "./redeemerIndex.js";

/** Nhãn biến thể trong `pub type VaultRedeemer`. */
const BURN_BATCH_TAG = "BurnBatch";

/** Nhan đề validator trong plutus.json — giống nhau ở mọi module vault. */
const VAULT_VALIDATOR_TITLE = "vault.vault.spend";

/** `max_batches_per_vault` — cưỡng chế on-chain ở `constants.ak:42` của mọi module vault.
 *  BOUNDARIES §2 liệt hằng này vào nhóm "phải giữ đồng bộ hai bên". */
const MAX_BATCHES_PER_VAULT = 32;

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
  /** Datum output tiếp-nối, đã áp burn + prune + kế toán. */
  newDatum:   VaultDatum;
  /** Các batch bị bỏ vì đã chết ở epoch này — chúng mất trắng dù có tiêu hay không
   *  (§4.2 dùng-hết-hoặc-mất). Trả ra để app cảnh báo được người dùng. */
  expiredDropped: MagicBatchLike[];
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
 */
export function planBurnBatch(
  datum:        VaultDatum,
  required:     bigint,
  currentEpoch: bigint,
): BurnBatchPlan {
  if (required <= 0n) {
    throw new Error(`[burnBatch] required=${required} — phải > 0 (vault.ak:552 expect total_burned > 0).`);
  }

  const batches = datum.magic_batches as unknown as MagicBatchLike[];

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
  const order = [...live].sort((a, b) => {
    const da = a.created_epoch + a.decay_window;
    const db = b.created_epoch + b.decay_window;
    if (da !== db) return da < db ? -1 : 1;
    return a.created_epoch < b.created_epoch ? -1 : a.created_epoch > b.created_epoch ? 1 : 0;
  });

  const burns:  BurnEntry[] = [];
  const burnBy = new Map<string, bigint>();
  let remain = required;
  for (const b of order) {
    if (remain === 0n) break;
    const take = b.current_amount < remain ? b.current_amount : remain;
    burns.push([b.batch_id, take]);          // take > 0 luôn — vault.ak:600 expect amt > 0
    burnBy.set(b.batch_id, take);
    remain -= take;
  }
  // Bất khả theo `liveTotal >= required` ở trên; giữ lại vì nó là bất biến nội bộ, và im
  // lặng ở đây nghĩa là đốt thiếu → `Σburns == required` vỡ → tx bị từ chối không rõ lý do.
  if (remain !== 0n) {
    throw new Error(`[burnBatch] BUG nội bộ: còn thiếu ${remain} nanogic sau khi duyệt hết batch sống.`);
  }

  // Gương của `apply_burns` + `prune_expired` (vault.ak:545-546): trừ theo từng batch,
  // bỏ batch về 0, rồi bỏ mọi batch đã chết — kể cả batch không ai đụng tới.
  const expectedBatches = batches
    .map(b => {
      const take = burnBy.get(b.batch_id);
      return take === undefined ? b : { ...b, current_amount: b.current_amount - take };
    })
    .filter(b => b.current_amount > 0n)
    .filter(b => !isBatchExpired(b, currentEpoch));

  if (expectedBatches.length > MAX_BATCHES_PER_VAULT) {
    throw new Error(
      `[burnBatch] output còn ${expectedBatches.length} batch > trần ${MAX_BATCHES_PER_VAULT} ` +
      `(vault.ak:583). Vault này đã vượt trần từ trước lần tiêu.`,
    );
  }

  // ── A02: 17 trường, chỉ 5 chỗ được đổi ──────────────────────────────────────────
  // vault.ak:556-578 kiểm TỪNG trường. Mọi trường không nêu ở đây phải đi qua nguyên
  // vẹn — kể cả `pending_profile`: `BurnBatch` KHÔNG lazy-apply profile (`:566` chép y
  // nguyên), nên vault có `pending_profile` khác null vẫn tiêu được bình thường.
  const newDatum = {
    ...datum,
    magic_batches:  expectedBatches,
    activity_state: {
      ...datum.activity_state,
      consumed_credit: datum.activity_state.consumed_credit + required,   // :571
    },
    last_updated_epoch: currentEpoch,                                     // :575
    attribution: {
      ...datum.attribution,
      total_events:     datum.attribution.total_events + 1n,              // :577 — +1 mỗi TX,
      last_event_epoch: currentEpoch,                                     //       không theo op_count
    },
  } as unknown as VaultDatum;

  return { burns, newDatum, expiredDropped: expired };
}

export interface BuildVaultBurnBatchParams {
  /** UTxO vault đang tiêu — cần `datum` (inline). */
  vaultUtxo:       UTxO;
  /** Σ nanogic phải đốt. Lấy từ `requiredFromBeacon` để có thẩm quyền, không tự tính. */
  required:        bigint;
  /** Epoch của tx. Phải trùng epoch mà validity range của tx phủ, nếu không
   *  `current_epoch` on-chain khác con số này và mọi kiểm epoch lệch theo. */
  currentEpoch:    bigint;
  /** plutus.json của module vault — chỉ số constructor `BurnBatch` suy lúc chạy, nên SDK
   *  không lệch được với thứ tự enum on-chain. */
  vaultPlutusJson: PlutusJson;
}

export interface BuildVaultBurnBatchResult {
  /** Truyền thẳng vào `buildConsumeTx({ vaultBurnRedeemerCbor })`. */
  vaultBurnRedeemerCbor: string;
  /** Truyền thẳng vào `buildConsumeTx({ vaultOutDatumCbor })`. */
  vaultOutDatumCbor:     string;
  burns:                 BurnEntry[];
  newDatum:              VaultDatum;
  /** Batch đã chết và bị bỏ trong lần này — MAGIC trong đó mất trắng (§4.2). App nên
   *  hiện cho người dùng thấy, vì đây là mất mát thật và không hoàn được. */
  expiredDropped:        MagicBatchLike[];
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

  const datum = Data.from(p.vaultUtxo.datum, VaultDatumSchema);

  if (datum.last_updated_epoch > p.currentEpoch) {
    throw new Error(
      `[burnBatch] datum.last_updated_epoch=${datum.last_updated_epoch} > currentEpoch=${p.currentEpoch}. ` +
      `Hoặc epoch truyền vào sai, hoặc đang đọc một UTxO vault đã bị tiêu và thay bằng bản mới.`,
    );
  }

  const plan = planBurnBatch(datum, p.required, p.currentEpoch);

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
    vaultOutDatumCbor:     Data.to(plan.newDatum as never, VaultDatumSchema),
    burns:                 plan.burns,
    newDatum:              plan.newDatum,
    expiredDropped:        plan.expiredDropped,
  };
}
