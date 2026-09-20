// src/math.ts — Paymaster Q-format tỷ giá + meter-state helpers. Pure BigInt,
// KHÔNG Number. P8 mirror BYTE-IDENTICAL onchain/lib/magiclamp/paymaster/math.ak
// + util.ak (lookup_did, add_did, sum_burns, dedup). NORMATIVE: SPEC-Paymaster §4.3.
//
//   lamp_cap = ⌊ magic_consumed × lamp_per_magic_q / Q ⌋    (oildrop)
//   ada_cap  = ⌊ magic_consumed × ada_per_magic_q  / Q ⌋    (lovelace)
//
// magic_consumed = Σ BurnBatch.burns (nanogic). Single-step floor (1 nhân, 1 chia) —
// đại lượng tuyến tính, bound rounding 0 (math.ak:6-9).

import { Q } from "@magiclamp/protocol-utils";

/** Scale factor Q (1 MAGIC = 1e9 nanogic). Khớp ProtocolUtils.Q + math.ak:12. */
export const q: bigint = Q; // 1_000_000_000n

// ── `magicConsumed` ở đây KHÔNG phải tín hiệu cầu của mô hình sinh ────────────────
// Hai hàm dưới nhận `magicConsumed` làm THAM SỐ TÍNH TRẦN cho một lượt sponsor của
// Paymaster: bao nhiêu MAGIC đã tiêu thì app được bù tới bấy nhiêu LAMP/ADA. Nó là
// một đại lượng cục bộ của một giao dịch, không được lưu, không phơi ra ngoài.
//
// Tỷ lệ tiêu/sinh của mô hình sinh là thứ KHÁC: tên đặc tả của nó là `usage_ratio` —
// tỷ lệ MỖI VAULT trên cửa sổ 6 epoch, định nghĩa ở
// `SPEC/MagicLamp-Tripletoken-Feat-(Vi).md` v2.1 §6.1.1 và `INV-MAGIC-CITIZEN`.
//
// Phạm vi của câu "chưa có trong mã", đo 2026-09-20 — một lượng từ toàn xưng không kèm
// phép đếm thì già đi lặng lẽ, nên đây là phép đếm kèm ngày và kèm phần bị loại:
//
//     $ grep -rn 'usage_ratio' --include='*.ak' --include='*.ts' --include='*.rs' . \
//         | grep -v '/Legacy/' | grep -v node_modules \
//         | grep -v 'Paymaster/offchain/src/math.ts'
//     → 0 dòng
//     $ grep -rn 'usage_ratio' SPEC/     → 35 dòng / 1 tệp
//     $ grep -rn 'usage_ratio' Legacy/   → 0 dòng / 0 tệp
//
// Tức: khái niệm này sống ĐÚNG MỘT CHỖ trong mã-và-đặc-tả, và chỗ đó là đặc tả.
//
// 🔴 Vế `grep -v` cuối là BẮT BUỘC, không phải cho gọn. Tệp này là `.ts`, nằm trong
// vùng quét, và chính khối chú thích này chứa chuỗi `usage_ratio` — nên câu lệnh
// KHÔNG có vế đó trả về một số dòng KHÁC 0, và mọi dòng nó trả về đều ở ngay đây.
// Bản trước của khối này viết đúng câu lệnh thiếu vế ấy rồi ghi kết quả là "0 dòng";
// đo lại thì nó ra **5**. Ai làm theo hướng dẫn của chú thích sẽ đo ra điều NGƯỢC
// LẠI với điều chú thích tồn tại để ngăn. Một phép đo tự đếm cả chỗ ghi nó thì nó
// đang đếm tiếng vọng của mình.
//
// Cố ý KHÔNG ghi số dòng hiện tại của chính khối này: nó đổi mỗi lần ai đó sửa văn
// xuôi ở đây (bản vá này đẩy 5 → 6 chỉ vì thêm mấy dòng giải thích), nên một con số
// ở đó sẽ sai mà không gì báo. Số đáng ghim là số SAU khi loại, và nó là 0.
//
// Phần bị loại khỏi phép đếm, khai đủ: `Legacy/` (đếm được: 0 dòng) · `node_modules`
// · chính tệp này (toàn văn xuôi, không dòng mã nào) · mọi đuôi tệp ngoài ba đuôi mã
// trên. Ai đọc lại sau một đợt hiện thực hoá thì chạy lại chính các lệnh đó, đừng
// tin con số.
//
// Dòng này có vì hai tên đó đủ giống để một lượt `grep "magicConsumed"` dừng đúng ở
// đây và kết luận "có nguồn tín hiệu cầu" — kết luận ngược, từ một kết quả tìm kiếm
// hợp lệ. Nhà OriLife gặp đúng bẫy này theo chiều ngược lại 2026-09-20: họ quét
// `ConsumeMAGIC/` + `AppEconomics/`, không thấy `usage_ratio`, và kết luận khái niệm
// đó không tồn tại — trong khi nó nằm ở `SPEC/`, ngoài vùng quét.

/**
 * Trần LAMP (oildrop) app được sponsor cho magic_consumed (nanogic) tại tỷ giá Q-format.
 * Floor division BigInt. magic_consumed ≥ 0, rate ≥ 0 → kết quả ≥ 0. Mirror math.ak:16-18.
 */
export function lampCap(magicConsumed: bigint, lampPerMagicQ: bigint): bigint {
  return (magicConsumed * lampPerMagicQ) / q;
}

/** Trần ADA (lovelace) app được sponsor cho magic_consumed (nanogic). Mirror math.ak:21-23. */
export function adaCap(magicConsumed: bigint, adaPerMagicQ: bigint): bigint {
  return (magicConsumed * adaPerMagicQ) / q;
}

// ── BurnBatch reader helpers (mirror util.ak sum_burns / dedup) ────────────────

export type Burn = readonly [string, bigint]; // (asset_name_hex, amount_nanogic)

/** Σ amount trong burns. Mirror util.ak:93-95. */
export function sumBurns(burns: readonly Burn[]): bigint {
  return burns.reduce((acc, b) => acc + b[1], 0n);
}

// ── did_lamp_map helpers (mirror util.ak:138-165) ─────────────────────────────

export type DidLampEntry = readonly [string, bigint]; // (did_key_hex, lamp_sponsored_oildrop)

/** Lượng oildrop đã sponsor cho did_key trong map (0 nếu chưa có). Mirror util.ak:138-143. */
export function lookupDid(map: readonly DidLampEntry[], didKey: string): bigint {
  const e = map.find((x) => x[0] === didKey);
  return e ? e[1] : 0n;
}

// ── global_magic_epoch helper (mirror paymaster.ak global_magic_epoch transition) ──

/**
 * Tích lũy global_magic_epoch: reset về 0 ở epoch mới, cộng dồn cùng epoch.
 * base_magic = 0 khi epoch_rollover, ngược lại = meter_in.global_magic_epoch.
 * Mirror Aiken: global_magic_epoch = base_magic + magic_consumed.
 */
export function updateGlobalMagic(
  base_magic: bigint,
  magic_consumed: bigint,
): bigint {
  return base_magic + magic_consumed;
}

/**
 * Cộng `add` vào entry did_key (tạo mới ở CUỐI nếu chưa có). Giữ thứ tự; tối đa 1
 * entry/key. Mirror util.ak:146-165 BYTE-PERFECT để meter_out_datum.did_lamp_map ==
 * expected_map (validator ép bằng nhau, paymaster.ak:142-143).
 */
export function addDid(
  map: readonly DidLampEntry[],
  didKey: string,
  add: bigint,
): DidLampEntry[] {
  if (map.some((e) => e[0] === didKey)) {
    return map.map((e) => (e[0] === didKey ? ([e[0], e[1] + add] as DidLampEntry) : e));
  }
  return [...map, [didKey, add] as DidLampEntry];
}
