// src/genV2Checkpoint.ts — kiểm phía két của một giao dịch consume dưới Gen v2.0 (gói d4, #128).
//
// Bộ dựng `buildConsumeTx` KHÔNG tự dựng datum két ra — người gọi truyền CBOR sẵn (xem
// `ConsumeParams.vaultOutDatumCbor`). Tệp này giữ khuôn đó và chỉ làm hai việc:
//   1. Quyết reference input nào PHẢI có mặt để nhánh `BurnBatch` của két qua được:
//      két InstantGen v2.0 tiêu lần đầu trong epoch mới phải làm mới checkpoint ⟹ cần
//      beacon ρ, và cần két Wakeme nếu `wakeme_link` khác "".
//   2. Đối chiếu các ô Gen v2.0 của datum ra với luật on-chain TRƯỚC khi gửi, để lỗi hiện
//      ở đây kèm tên ô thay vì chết phase-2 sau khi đã mất collateral.
//
// ═══ Nguồn luật (đọc theo TÊN HÀM, không theo số dòng) ═══════════════════════════
//   InstantGen/onchain/validators/vault.ak      ▸ `validate_burn_batch` (khối cuối: checkpoint `FollowVault`)
//   InstantGen/onchain/lib/magiclamp/protocol/checkpoint.ak ▸ `expected_checkpoint`, `resolve_link`,
//                                                  `refreshed`, `read_rho`, `checkpoint_written`
//   InstantGen/onchain/lib/magiclamp/protocol/wakeme_lent.ak ▸ `wakeme_read`, `read_one_vault`
//   ScheduleGen/onchain/validators/vault.ak     ▸ `validate_burn_batch` (khối "Gen v2.0 (SPEC §6.1.2)")
//
// ═══ Thứ tệp này KHÔNG kiểm ═══════════════════════════════════════════════════════
//   - GIÁ TRỊ `cap_nanogic` khi làm mới: đó là `amount_by_lamp(L_owned, L_lent, cửa sổ, ρ, H)`
//     (`gen_formula.ak`). Công thức có một bản TS trùng bit ở `InstantGen/offchain/src/genFormula.ts`;
//     gói này không phụ thuộc gói đó, và chép lại công thức là tạo nguồn thứ hai. Người gọi
//     tính ô này bằng `genFormula.ts`; ở đây chỉ ép nó là số nguyên không âm.
//   - Các ô A02 ngoài checkpoint (magic_batches, consumed_credit, attribution, …): không đổi so
//     với trước Gen v2.0, vẫn do người gọi dựng và validator kiểm.
//
// Mọi hình dạng lạ ⟹ NÉM. Không có nhánh nào trả giá trị đệm.

import { Constr, Data, paymentCredentialOf, type UTxO } from "@lucid-evolution/lucid";

// ── Hằng — BẢN CHÉP CÓ NHÃN ───────────────────────────────────────────────────
// BẢN CHÉP CÓ NHÃN — InstantGen/onchain/lib/magiclamp/protocol/constants.ak ▸ `usage_window_len`
// (MAGIC@939feb3e, 2026-09-30).
export const USAGE_WINDOW_LEN = 7;
// BẢN CHÉP CÓ NHÃN — InstantGen/onchain/lib/magiclamp/protocol/constants.ak ▸ `rho_max_q`
// (MAGIC@939feb3e, 2026-09-30); bản đó tự nó chép từ apply-param `rho_max_q` của GenBeacons.
export const RHO_MAX_Q = 4_000_000_000n;
// BẢN CHÉP CÓ NHÃN — InstantGen/onchain/lib/magiclamp/protocol/checkpoint.ak ▸ `rate_nft_name`
// ("RHO") (MAGIC@939feb3e, 2026-09-30).
export const RATE_NFT_NAME_HEX = "52484f";
// BẢN CHÉP CÓ NHÃN — InstantGen/onchain/lib/magiclamp/protocol/wakeme_lent.ak ▸ `wakeme_min_fields`,
// `owner_commit_len` (MAGIC@939feb3e, 2026-09-30).
export const WAKEME_MIN_FIELDS = 13;
export const OWNER_COMMIT_BYTES = 32;
// BẢN CHÉP CÓ NHÃN — chỉ số constructor `BurnBatch` trong `VaultRedeemer` của cả ba loại két:
// InstantGen/onchain/lib/magiclamp/protocol/types.ak (constr 2), ScheduleGen/.../types.ak
// (constr 2), PrepaidGen/.../types.ak ("BurnBatch PHẢI ở constr 2") (MAGIC@939feb3e, 2026-09-30).
export const BURN_BATCH_CONSTR = 2;

/** Loại két. `consume` được apply-param theo LOẠI két (một bản `consume` mỗi loại). */
export type VaultKind = "instant" | "schedule" | "prepaid";

// BẢN CHÉP CÓ NHÃN — chỉ số trường của `VaultDatum` (MAGIC@939feb3e, 2026-09-30):
//   InstantGen/onchain/lib/magiclamp/protocol/types.ak ▸ `VaultDatum` — 20 trường;
//   ScheduleGen/onchain/lib/magiclamp/protocol/types.ak ▸ `VaultDatum` — 19 trường;
//   PrepaidGen/onchain/lib/magiclamp/protocol/types.ak ▸ `PrepaidVaultDatum` — 8 trường.
// Hợp đồng nhị phân: nguồn chèn/đổi trường thì bảng này phải đổi cùng commit.
const INSTANT = {
  fieldCount: 20,
  wakemeLink: 6,
  capEpoch: 12,
  capNanogic: 14,
  usageWindow: 18,
  usageWindowEpoch: 19,
} as const;
const SCHEDULE = { fieldCount: 19, usageWindow: 17, usageWindowEpoch: 18 } as const;
const PREPAID = { fieldCount: 8 } as const;
const FIELD_COUNT: Record<VaultKind, number> = {
  instant: INSTANT.fieldCount,
  schedule: SCHEDULE.fieldCount,
  prepaid: PREPAID.fieldCount,
};
// Số trường của datum đời v1 (trước Gen v2.0). v2.0 là hash MỚI, không di trú UTxO v1.
const V1_FIELD_COUNTS: Record<number, string> = {
  18: "InstantGen v1 (18 trường)",
  17: "ScheduleGen v1 (17 trường)",
};

// ── Cửa sổ usage_window ───────────────────────────────────────────────────────

export interface EpochUsage {
  generated: bigint;
  consumed: bigint;
}

function assertWindow(window: readonly EpochUsage[], label: string): void {
  if (window.length !== USAGE_WINDOW_LEN) {
    throw new Error(`${label}: usage_window có ${window.length} ô, cần đúng ${USAGE_WINDOW_LEN}`);
  }
  for (const u of window) {
    if (u.generated < 0n || u.consumed < 0n) {
      throw new Error(`${label}: usage_window có ô âm (${u.generated}, ${u.consumed})`);
    }
  }
}

/**
 * BẢN CHÉP CÓ NHÃN — InstantGen/offchain/src/genFormula.ts ▸ `shiftWindow` (MAGIC@1e9a72d9,
 * gương trùng bit của `gen_formula.ak` ▸ `shift_window`). Dịch k = to − from ô: thêm
 * min(k, 7) ô 0 vào đầu, cắt còn 7. k < 0 ⟹ ném.
 */
export function shiftWindow(
  window: readonly EpochUsage[], fromEpoch: bigint, toEpoch: bigint,
): EpochUsage[] {
  assertWindow(window, "shiftWindow");
  const k = toEpoch - fromEpoch;
  if (k < 0n) throw new Error(`shiftWindow lùi thời gian: ${fromEpoch} → ${toEpoch}`);
  if (k === 0n) return window.map((u) => ({ ...u }));
  const n = Number(k < BigInt(USAGE_WINDOW_LEN) ? k : BigInt(USAGE_WINDOW_LEN));
  const zeros: EpochUsage[] = Array.from({ length: n }, () => ({ generated: 0n, consumed: 0n }));
  return [...zeros, ...window.map((u) => ({ ...u }))].slice(0, USAGE_WINDOW_LEN);
}

/**
 * BẢN CHÉP CÓ NHÃN — InstantGen/offchain/src/genFormula.ts ▸ `windowAdd` (MAGIC@1e9a72d9,
 * gương của `gen_formula.ak` ▸ `window_add`). Cộng vào ô 0 (epoch đang mở). Âm ⟹ ném.
 */
export function windowAdd(
  window: readonly EpochUsage[], generated: bigint, consumed: bigint,
): EpochUsage[] {
  assertWindow(window, "windowAdd");
  if (generated < 0n || consumed < 0n) {
    throw new Error(`windowAdd: lượng âm (generated=${generated}, consumed=${consumed})`);
  }
  const [open, ...closed] = window;
  if (open === undefined) throw new Error("windowAdd: usage_window rỗng");
  return [
    { generated: open.generated + generated, consumed: open.consumed + consumed },
    ...closed.map((u) => ({ ...u })),
  ];
}

// ── Đọc Plutus Data thô ───────────────────────────────────────────────────────

function decodeConstr(cbor: string, label: string): Constr<unknown> {
  let d: unknown;
  try {
    d = Data.from(cbor);
  } catch (e) {
    throw new Error(`${label}: không giải mã được Plutus Data: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!(d instanceof Constr)) throw new Error(`${label}: không phải Constr`);
  return d;
}

function asInt(x: unknown, label: string): bigint {
  if (typeof x !== "bigint") throw new Error(`${label}: cần số nguyên, nhận ${describe(x)}`);
  return x;
}

function asBytes(x: unknown, label: string): string {
  if (typeof x !== "string") throw new Error(`${label}: cần ByteArray, nhận ${describe(x)}`);
  return x.toLowerCase();
}

function describe(x: unknown): string {
  if (x instanceof Constr) return `Constr ${x.index} (${x.fields.length} trường)`;
  if (Array.isArray(x)) return `danh sách ${x.length} phần tử`;
  return typeof x;
}

function readWindow(x: unknown, label: string): EpochUsage[] {
  if (!Array.isArray(x)) throw new Error(`${label}: usage_window không phải danh sách`);
  const w = x.map((cell, i) => {
    if (!(cell instanceof Constr) || cell.index !== 0 || cell.fields.length !== 2) {
      throw new Error(`${label}: usage_window[${i}] không phải EpochUsage (Constr 0, 2 trường)`);
    }
    return {
      generated: asInt(cell.fields[0], `${label}: usage_window[${i}].generated`),
      consumed: asInt(cell.fields[1], `${label}: usage_window[${i}].consumed`),
    };
  });
  assertWindow(w, label);
  return w;
}

function sameWindow(a: readonly EpochUsage[], b: readonly EpochUsage[]): boolean {
  return a.length === b.length &&
    a.every((u, i) => u.generated === b[i]!.generated && u.consumed === b[i]!.consumed);
}

function showWindow(w: readonly EpochUsage[]): string {
  return "[" + w.map((u) => `(${u.generated},${u.consumed})`).join(" ") + "]";
}

// ── Redeemer BurnBatch ────────────────────────────────────────────────────────

/**
 * Σ burns của redeemer `BurnBatch { burns: List<(ByteArray, Int)> }` — gương `sum_burns`.
 * Tuple Aiken mã hoá thành danh sách Data hai phần tử `[bytes, int]`.
 *
 * @throws CONSUME-015 nếu redeemer không phải Constr `BURN_BATCH_CONSTR`, danh sách rỗng,
 *         hoặc một phần tử sai hình / lượng ≤ 0 (on-chain `expect amt > 0`).
 */
export function sumBurnsFromRedeemer(redeemerCbor: string): bigint {
  const r = decodeConstr(redeemerCbor, "CONSUME-015: redeemer BurnBatch");
  if (r.index !== BURN_BATCH_CONSTR || r.fields.length !== 1) {
    throw new Error(
      `CONSUME-015: redeemer BurnBatch phải là Constr ${BURN_BATCH_CONSTR} với 1 trường ` +
        `(burns), nhận Constr ${r.index} với ${r.fields.length} trường.`,
    );
  }
  const burns = r.fields[0];
  if (!Array.isArray(burns) || burns.length === 0) {
    throw new Error("CONSUME-015: burns phải là danh sách KHÔNG rỗng (on-chain `expect total_burned > 0`)");
  }
  let total = 0n;
  burns.forEach((b, i) => {
    if (!Array.isArray(b) || b.length !== 2) {
      throw new Error(`CONSUME-015: burns[${i}] không phải cặp (batch_id, amount)`);
    }
    asBytes(b[0], `CONSUME-015: burns[${i}].batch_id`);
    const amt = asInt(b[1], `CONSUME-015: burns[${i}].amount`);
    if (amt <= 0n) throw new Error(`CONSUME-015: burns[${i}].amount = ${amt}, phải > 0`);
    total += amt;
  });
  return total;
}

// ── Beacon ρ ──────────────────────────────────────────────────────────────────

/**
 * ρ hiệu lực ở epoch `e`, đọc từ UTxO beacon `RateParam` — gương `checkpoint.ak ▸ read_rho`.
 * Kiểm những gì kiểm được mà không biết apply-param của két: địa chỉ là SCRIPT, mang ĐÚNG
 * MỘT token tên "RHO" số lượng 1, datum inline `RateParam { rho_q, prev_rho_q,
 * effective_epoch }` (BẢN CHÉP CÓ NHÃN của `InstantGen/.../types.ak ▸ RateParam`,
 * MAGIC@939feb3e), ρ ∈ [0, RHO_MAX_Q]. Policy NFT và hash script beacon là apply-param của
 * két — sai hai thứ đó thì on-chain bác (`expect [beacon] = beacons`), ở đây không đo được.
 *
 * @throws CONSUME-012 ở mọi hình dạng lạ.
 */
export function readRhoFromBeacon(beacon: UTxO, e: bigint): bigint {
  const at = `${beacon.txHash}#${beacon.outputIndex}`;
  const cred = paymentCredentialOf(beacon.address);
  if (cred.type !== "Script") {
    throw new Error(`CONSUME-012: beacon ρ ${at} nằm ở địa chỉ khoá, không ở địa chỉ script quản trị beacon.`);
  }
  const rho = Object.entries(beacon.assets).filter(
    ([unit, q]) => unit.length === 56 + RATE_NFT_NAME_HEX.length &&
      unit.toLowerCase().endsWith(RATE_NFT_NAME_HEX) && q > 0n,
  );
  if (rho.length !== 1 || rho[0]![1] !== 1n) {
    throw new Error(
      `CONSUME-012: beacon ρ ${at} phải mang ĐÚNG MỘT NFT tên "RHO" (${RATE_NFT_NAME_HEX}) ` +
        `số lượng 1, thấy ${rho.length}.`,
    );
  }
  if (!beacon.datum) throw new Error(`CONSUME-012: beacon ρ ${at} thiếu inline datum RateParam.`);
  const d = decodeConstr(beacon.datum, `CONSUME-012: datum beacon ρ ${at}`);
  if (d.index !== 0 || d.fields.length !== 3) {
    throw new Error(
      `CONSUME-012: datum beacon ρ ${at} phải là RateParam (Constr 0, 3 trường), ` +
        `nhận Constr ${d.index} với ${d.fields.length} trường.`,
    );
  }
  const rhoQ = asInt(d.fields[0], "CONSUME-012: RateParam.rho_q");
  const prevRhoQ = asInt(d.fields[1], "CONSUME-012: RateParam.prev_rho_q");
  const effective = asInt(d.fields[2], "CONSUME-012: RateParam.effective_epoch");
  const r = e >= effective ? rhoQ : prevRhoQ;
  if (r < 0n || r > RHO_MAX_Q) {
    throw new Error(`CONSUME-012: ρ hiệu lực ở epoch ${e} = ${r}, ngoài [0, ${RHO_MAX_Q}].`);
  }
  return r;
}

// ── Két Wakeme ────────────────────────────────────────────────────────────────

/**
 * `owner_commit` của két Wakeme đưa vào reference input — gương các vế HỎNG-THÌ-FAIL của
 * `wakeme_lent.ak ▸ read_one_vault`: (a) datum inline Constr 0, ≥ 13 trường; (b) đúng một
 * token dưới policy = hash script của két, số lượng 1, tên == owner_commit (32 byte);
 * (c) trường 11 ghim ĐÚNG két đang tiêu: `Constr0[Constr0[vaultHash, vaultName]]`;
 * (e) trường 3 và 7 không âm. Vế (d)(f) chỉ làm `L_lent = 0`, không làm fail — không kiểm.
 *
 * Hash két Wakeme là apply-param `wakeme_vault_hash` của két IG; ở đây lấy từ địa chỉ UTxO.
 * Sai hash ⟹ on-chain không thấy két nào ⟹ nhánh `FollowVault` bác vì link đã đặt.
 *
 * @throws CONSUME-013 ở mọi hình dạng lạ.
 */
export function readWakemeOwnerCommit(wakeme: UTxO, vaultHash: string, vaultName: string): string {
  const at = `${wakeme.txHash}#${wakeme.outputIndex}`;
  const cred = paymentCredentialOf(wakeme.address);
  if (cred.type !== "Script") {
    throw new Error(`CONSUME-013: két Wakeme ${at} nằm ở địa chỉ khoá, không phải địa chỉ script.`);
  }
  const wakemeHash = cred.hash.toLowerCase();
  if (wakemeHash === vaultHash.toLowerCase()) {
    throw new Error(
      `CONSUME-013: "két Wakeme" ${at} nằm ở CHÍNH địa chỉ két IG đang tiêu — đó là một két IG, ` +
        `không phải két Wakeme.`,
    );
  }
  if (!wakeme.datum) throw new Error(`CONSUME-013: két Wakeme ${at} thiếu inline datum.`);
  const d = decodeConstr(wakeme.datum, `CONSUME-013: datum két Wakeme ${at}`);
  if (d.index !== 0 || d.fields.length < WAKEME_MIN_FIELDS) {
    throw new Error(
      `CONSUME-013: datum két Wakeme ${at} phải là Constr 0 với ≥ ${WAKEME_MIN_FIELDS} trường, ` +
        `nhận Constr ${d.index} với ${d.fields.length} trường.`,
    );
  }
  const ownerCommit = asBytes(d.fields[0], "CONSUME-013: WakemeDatum[0] owner_commit");
  if (ownerCommit.length !== OWNER_COMMIT_BYTES * 2) {
    throw new Error(`CONSUME-013: owner_commit của két Wakeme ${at} dài ${ownerCommit.length / 2} byte, cần ${OWNER_COMMIT_BYTES}.`);
  }
  const underPolicy = Object.entries(wakeme.assets).filter(
    ([unit, q]) => unit.toLowerCase().startsWith(wakemeHash) && q > 0n,
  );
  if (
    underPolicy.length !== 1 || underPolicy[0]![1] !== 1n ||
    underPolicy[0]![0].toLowerCase() !== wakemeHash + ownerCommit
  ) {
    throw new Error(
      `CONSUME-013: két Wakeme ${at} phải mang ĐÚNG MỘT NFT dưới policy ${wakemeHash}, số lượng 1, ` +
        `tên == owner_commit ${ownerCommit}.`,
    );
  }
  const conditional = asInt(d.fields[3], "CONSUME-013: WakemeDatum[3] conditional_lamp");
  const owned = asInt(d.fields[7], "CONSUME-013: WakemeDatum[7] owned_lamp");
  if (conditional < 0n || owned < 0n) {
    throw new Error(`CONSUME-013: két Wakeme ${at} khai lượng LAMP âm (${conditional}, ${owned}).`);
  }
  asInt(d.fields[12], "CONSUME-013: WakemeDatum[12] gen_pin_period");
  const pin = d.fields[11];
  const inner = pin instanceof Constr && pin.index === 0 && pin.fields.length === 1 ? pin.fields[0] : undefined;
  const pinOk =
    inner instanceof Constr && inner.index === 0 && inner.fields.length === 2 &&
    typeof inner.fields[0] === "string" && typeof inner.fields[1] === "string" &&
    inner.fields[0].toLowerCase() === vaultHash.toLowerCase() &&
    inner.fields[1].toLowerCase() === vaultName.toLowerCase();
  if (!pinOk) {
    throw new Error(
      `CONSUME-013: két Wakeme ${at} KHÔNG ghim két IG đang tiêu (trường 11 phải là ` +
        `GenPin(Some(${vaultHash}, ${vaultName}))). Két IG chỉ đọc được két Wakeme đã ghim nó.`,
    );
  }
  return ownerCommit;
}

// ── Kiểm chính ────────────────────────────────────────────────────────────────

export interface GenV2BurnCheckArgs {
  vaultUtxo: UTxO;
  /** Hash script của két (= policy NFT vault-id của két IG). */
  vaultScriptHash: string;
  vaultOutDatumCbor: string;
  vaultBurnRedeemerCbor: string;
  /** `required` mà `consume.ak` ép `Σburns ==`. */
  requiredNanogic: bigint;
  /** Epoch mà KÉT thấy: `cận dưới validity / ms_per_epoch` (`get_current_epoch`). */
  vaultEpoch: bigint;
  vaultKind?: VaultKind;
  rateBeaconUtxo?: UTxO;
  wakemeVaultUtxo?: UTxO;
}

export interface GenV2BurnCheck {
  kind: VaultKind;
  /** Lượt này làm mới checkpoint (két IG, `cap_epoch < e`). */
  refreshed: boolean;
  /** Reference input két cần — bộ dựng `readFrom` đúng danh sách này, không hơn. */
  refInputs: UTxO[];
}

function inferKind(n: number, at: string): VaultKind {
  for (const k of ["instant", "schedule", "prepaid"] as const) {
    if (FIELD_COUNT[k] === n) return k;
  }
  const v1 = V1_FIELD_COUNTS[n];
  if (v1 !== undefined) {
    throw new Error(
      `CONSUME-014: datum két ${at} có ${n} trường — hình dạng ${v1}, đời TRƯỚC Gen v2.0. ` +
        `Gen v2.0 là hash két MỚI và không di trú UTxO v1; bản consume này không tiêu được két đó.`,
    );
  }
  throw new Error(
    `CONSUME-014: datum két ${at} có ${n} trường, không khớp loại két nào ` +
      `(InstantGen 20 · ScheduleGen 19 · PrepaidGen 8).`,
  );
}

function expectEq(ok: boolean, what: string, want: string, got: string): void {
  if (!ok) {
    throw new Error(
      `CONSUME-016: datum két ra sai ô ${what} theo luật Gen v2.0 của nhánh BurnBatch.\n` +
        `  cần : ${want}\n  nhận: ${got}`,
    );
  }
}

/**
 * Kiểm phía két của giao dịch consume dưới Gen v2.0 và trả danh sách reference input cần.
 *
 * - InstantGen: `cap_epoch < e` ⟹ làm mới (`FollowVault`): cần beacon ρ (CONSUME-012); link
 *   đã đặt mà thiếu két Wakeme ⟹ CONSUME-013; có két Wakeme ⟹ link ra = `owner_commit` của nó.
 *   Datum ra: `cap_epoch = e`, `usage_window_epoch = e`, cửa sổ = dịch rồi cộng Σburns vào
 *   `consumed` ô 0. `cap_epoch == e` ⟹ năm ô ghim nguyên, chỉ cộng Σburns; không cần ref nào.
 * - ScheduleGen: không đọc beacon, không đọc két Wakeme; cửa sổ = dịch rồi cộng Σburns.
 * - PrepaidGen: Gen v2.0 không đổi két này; chỉ kiểm Σburns.
 *
 * Mọi loại: Σburns của redeemer == `requiredNanogic` (CONSUME-015).
 */
export function checkGenV2Burn(args: GenV2BurnCheckArgs): GenV2BurnCheck {
  const { vaultUtxo, vaultScriptHash, requiredNanogic, vaultEpoch: e } = args;
  const at = `${vaultUtxo.txHash}#${vaultUtxo.outputIndex}`;
  if (!vaultUtxo.datum) throw new Error(`CONSUME-014: két ${at} thiếu inline datum.`);
  const din = decodeConstr(vaultUtxo.datum, `CONSUME-014: datum két ${at}`);
  const n = din.fields.length;

  let kind: VaultKind;
  if (args.vaultKind !== undefined) {
    if (FIELD_COUNT[args.vaultKind] !== n) {
      throw new Error(
        `CONSUME-014: vaultKind="${args.vaultKind}" cần datum ${FIELD_COUNT[args.vaultKind]} trường, ` +
          `két ${at} có ${n}.`,
      );
    }
    kind = args.vaultKind;
  } else {
    kind = inferKind(n, at);
  }

  const burned = sumBurnsFromRedeemer(args.vaultBurnRedeemerCbor);
  if (burned !== requiredNanogic) {
    throw new Error(
      `CONSUME-015: Σburns của redeemer = ${burned} nanogic, khác required = ${requiredNanogic}. ` +
        `consume.ak ép DẤU BẰNG — lệch một nanogic là giao dịch bị từ chối.`,
    );
  }

  if (kind === "prepaid") return { kind, refreshed: false, refInputs: [] };

  const dout = decodeConstr(args.vaultOutDatumCbor, "CONSUME-016: datum két ra");
  if (dout.index !== din.index || dout.fields.length !== n) {
    throw new Error(
      `CONSUME-016: datum két ra phải cùng hình với datum vào (Constr ${din.index}, ${n} trường), ` +
        `nhận Constr ${dout.index} với ${dout.fields.length} trường.`,
    );
  }

  if (kind === "schedule") {
    const inWin = readWindow(din.fields[SCHEDULE.usageWindow], "CONSUME-014: datum két vào");
    const inWinEpoch = asInt(din.fields[SCHEDULE.usageWindowEpoch], "CONSUME-014: usage_window_epoch vào");
    if (e < inWinEpoch) {
      throw new Error(`CONSUME-014: két ${at} đã dịch cửa sổ tới epoch ${inWinEpoch}, giao dịch ở epoch ${e} — thời gian lùi.`);
    }
    const want = windowAdd(shiftWindow(inWin, inWinEpoch, e), 0n, burned);
    const gotWin = readWindow(dout.fields[SCHEDULE.usageWindow], "CONSUME-016: datum két ra");
    expectEq(sameWindow(gotWin, want), "usage_window (#17)", showWindow(want), showWindow(gotWin));
    const gotEpoch = asInt(dout.fields[SCHEDULE.usageWindowEpoch], "CONSUME-016: usage_window_epoch ra");
    expectEq(gotEpoch === e, "usage_window_epoch (#18)", String(e), String(gotEpoch));
    return { kind, refreshed: false, refInputs: [] };
  }

  // ── InstantGen ─────────────────────────────────────────────────────────────
  const inLink = asBytes(din.fields[INSTANT.wakemeLink], "CONSUME-014: wakeme_link vào");
  const inCapEpoch = asInt(din.fields[INSTANT.capEpoch], "CONSUME-014: cap_epoch vào");
  const inCapNanogic = asInt(din.fields[INSTANT.capNanogic], "CONSUME-014: cap_nanogic vào");
  const inWin = readWindow(din.fields[INSTANT.usageWindow], "CONSUME-014: datum két vào");
  const inWinEpoch = asInt(din.fields[INSTANT.usageWindowEpoch], "CONSUME-014: usage_window_epoch vào");
  if (e < inCapEpoch) {
    // `expected_checkpoint` ▸ `expect e >= d.cap_epoch`.
    throw new Error(`CONSUME-014: két ${at} có cap_epoch ${inCapEpoch} > epoch giao dịch ${e} — thời gian lùi.`);
  }

  const outLink = asBytes(dout.fields[INSTANT.wakemeLink], "CONSUME-016: wakeme_link ra");
  const outCapEpoch = asInt(dout.fields[INSTANT.capEpoch], "CONSUME-016: cap_epoch ra");
  const outCapNanogic = asInt(dout.fields[INSTANT.capNanogic], "CONSUME-016: cap_nanogic ra");
  const outWin = readWindow(dout.fields[INSTANT.usageWindow], "CONSUME-016: datum két ra");
  const outWinEpoch = asInt(dout.fields[INSTANT.usageWindowEpoch], "CONSUME-016: usage_window_epoch ra");

  const refresh = inCapEpoch < e;
  if (!refresh) {
    // `cap_epoch == e`: `current_checkpoint` — năm ô ghim nguyên, không đọc gì bên ngoài.
    const want = windowAdd(inWin, 0n, burned);
    expectEq(outLink === inLink, "wakeme_link (#6)", inLink || '""', outLink || '""');
    expectEq(outCapEpoch === inCapEpoch, "cap_epoch (#12)", String(inCapEpoch), String(outCapEpoch));
    expectEq(outCapNanogic === inCapNanogic, "cap_nanogic (#14)", String(inCapNanogic), String(outCapNanogic));
    expectEq(sameWindow(outWin, want), "usage_window (#18)", showWindow(want), showWindow(outWin));
    expectEq(outWinEpoch === inWinEpoch, "usage_window_epoch (#19)", String(inWinEpoch), String(outWinEpoch));
    return { kind, refreshed: false, refInputs: [] };
  }

  // ── Làm mới (`cap_epoch < e`, `FollowVault`) ───────────────────────────────
  const refInputs: UTxO[] = [];
  if (!args.rateBeaconUtxo) {
    throw new Error(
      `CONSUME-012: két InstantGen ${at} có cap_epoch ${inCapEpoch} < epoch ${e}: lượt BurnBatch này ` +
        `là lượt tiêu ĐẦU TIÊN của két trong epoch ${e}, validator buộc làm mới checkpoint và ` +
        `đọc ρ từ beacon RateParam ("RHO") ở reference input. Truyền \`rateBeaconUtxo\`.`,
    );
  }
  readRhoFromBeacon(args.rateBeaconUtxo, e);
  refInputs.push(args.rateBeaconUtxo);

  let wantLink: string;
  if (args.wakemeVaultUtxo) {
    const vaultName = vaultIdName(vaultUtxo, vaultScriptHash);
    wantLink = readWakemeOwnerCommit(args.wakemeVaultUtxo, vaultScriptHash, vaultName);
    refInputs.push(args.wakemeVaultUtxo);
  } else if (inLink !== "") {
    throw new Error(
      `CONSUME-013: két InstantGen ${at} đã nối két Wakeme (wakeme_link = ${inLink}) và lượt này làm ` +
        `mới checkpoint (cap_epoch ${inCapEpoch} < epoch ${e}): validator BẮT BUỘC đọc két Wakeme ` +
        `ở reference input (luật 2 — chặn đòn bỏ két để hạ cap). Truyền \`wakemeVaultUtxo\`. ` +
        `Két Wakeme chỉ được ĐỌC, không bao giờ vào inputs.`,
    );
  } else {
    wantLink = "";
  }

  const want = windowAdd(shiftWindow(inWin, inWinEpoch, e), 0n, burned);
  expectEq(outLink === wantLink, "wakeme_link (#6)", wantLink || '""', outLink || '""');
  expectEq(outCapEpoch === e, "cap_epoch (#12)", String(e), String(outCapEpoch));
  // Giá trị cap_nanogic = amount_by_lamp(..) — KHÔNG kiểm ở đây (xem đầu tệp).
  expectEq(outCapNanogic >= 0n, "cap_nanogic (#14)", "số nguyên ≥ 0", String(outCapNanogic));
  expectEq(sameWindow(outWin, want), "usage_window (#18)", showWindow(want), showWindow(outWin));
  expectEq(outWinEpoch === e, "usage_window_epoch (#19)", String(e), String(outWinEpoch));
  return { kind, refreshed: true, refInputs };
}

/** Tên NFT vault-id của két — gương `own_vault_identity` ▸ `single_nft_name`. */
function vaultIdName(vaultUtxo: UTxO, vaultScriptHash: string): string {
  const h = vaultScriptHash.toLowerCase();
  const under = Object.entries(vaultUtxo.assets).filter(([u, q]) => u.toLowerCase().startsWith(h) && q > 0n);
  if (under.length !== 1 || under[0]![1] !== 1n) {
    throw new Error(
      `CONSUME-014: két ${vaultUtxo.txHash}#${vaultUtxo.outputIndex} phải mang ĐÚNG MỘT NFT vault-id ` +
        `dưới policy ${h} (số lượng 1), thấy ${under.length}.`,
    );
  }
  return under[0]![0].toLowerCase().slice(h.length);
}
