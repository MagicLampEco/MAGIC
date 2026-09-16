// lib/lock.ak — LAMP lock/unlock helpers (§6.8, §A.9)
// Identical logic to VacuumGen lock.ak — youngest-first lock (T5).
// For ScheduleGen: lock L×λ at commit; remove fires_in_tx×λ at each fire.

use aiken/collection/list
use aiken/primitive/int
use magiclamp/protocol/types.{LoyaltyHolding}

// Youngest-first lock (T5 — maximizes LF of free holdings)
pub fn select_lamp_for_lock(
  holdings : List<LoyaltyHolding>,
  amount   : Int,
) -> List<LoyaltyHolding> {
  let sorted = list.sort(holdings, fn(a, b) { int.compare(b.acquired_epoch, a.acquired_epoch) })
  lock_youngest(sorted, amount, [])
}

/// `acc` giữ NGƯỢC thứ tự kết quả, và được lật lại đúng MỘT lần ở nhánh dừng.
///
/// Bản trước cộng dồn bằng `list.concat(acc, […])` ở mỗi bước đệ quy. `list.concat`
/// phải đi hết vế TRÁI để dựng lại nó, nên cộng dồn n lần là O(n²) — và nó là O(n²)
/// ngay cả khi danh sách vào đã sắp sẵn, tức không mẹo nào ở chỗ gọi gỡ được.
/// Nối đầu (`[x, ..acc]`) là O(1); một lần `list.reverse` cuối là O(n). Tổng: O(n).
///
/// KẾT QUẢ TRÙNG TỪNG BIT với bản cũ — `list.reverse` của dãy nối-đầu đúng bằng dãy
/// nối-đuôi. Đây là điều kiện bắt buộc, không phải điều mong muốn: `validators/vault.ak`
/// so danh sách BẰNG NHAU TUYỆT ĐỐI, và phía TypeScript phải dựng lại được y hệt (P8).
/// Vì kết quả không đổi, phía TypeScript KHÔNG cần sửa theo.
fn lock_youngest(
  holdings  : List<LoyaltyHolding>,
  remaining : Int,
  acc       : List<LoyaltyHolding>,
) -> List<LoyaltyHolding> {
  when holdings is {
    [] -> {
      expect remaining == 0
      list.reverse(acc)
    }
    [h, ..rest] ->
      if remaining <= 0 { list.concat(list.reverse(acc), [h, ..rest]) }
      else if remaining >= h.amount {
        lock_youngest(rest, remaining - h.amount,
          [LoyaltyHolding { ..h, is_locked: True }, ..acc])
      } else {
        list.concat(list.reverse(acc), [
          LoyaltyHolding { amount: remaining, acquired_epoch: h.acquired_epoch, is_locked: True },
          LoyaltyHolding { amount: h.amount - remaining, acquired_epoch: h.acquired_epoch, is_locked: False },
          ..rest
        ])
      }
  }
}

// ══════════════════════════════════════════════════════════════
// unlock_locked_amount — RELEASE a lock without moving any LAMP
// ══════════════════════════════════════════════════════════════
//
// I-ACT-7: a ScheduleGen fire generates MAGIC but must NOT displace LAMP. The
// fire therefore RELEASES `amount` oildrop from the locked pool instead of
// removing it: the holdings keep their amount and acquired_epoch, only
// `is_locked` flips to False. Σholdings — and hence lamp_balance and the real
// LAMP in the UTxO — are unchanged.
//
// Selection is oldest-locked-first, mirroring `remove_locked_amount`, so the
// off-chain builder can reproduce it byte-for-byte (P8).
//
// Result order: [unlocked-before] ++ [newly freed] ++ [still locked], then
// coalesced (see `coalesce_holdings` — the count MUST NOT grow per fire).
pub fn unlock_locked_amount(
  holdings : List<LoyaltyHolding>,
  amount   : Int,
) -> List<LoyaltyHolding> {
  let locked   = list.filter(holdings, fn(h) {  h.is_locked })
  let unlocked = list.filter(holdings, fn(h) { !h.is_locked })
  let sorted   = list.sort(locked, fn(a, b) { int.compare(a.acquired_epoch, b.acquired_epoch) })
  let (freed, still_locked) = unlock_oldest(sorted, amount, [])
  // Gộp theo HAI ĐOẠN, không gộp cả dãy. `unlocked` và `freed` mang is_locked=False,
  // `still_locked` mang is_locked=True; `same_bucket` đòi trùng CẢ `is_locked`, nên
  // không phần tử nào của đoạn sau gộp được với đoạn trước. Phép gộp là foldl giữ
  // thứ tự lần-xuất-hiện-đầu, nên tách ra cho ĐÚNG kết quả cũ từng bit, mà đổi
  // n² thành n₁² + n₂².
  list.concat(
    coalesce_holdings(list.concat(unlocked, freed)),
    coalesce_holdings(still_locked),
  )
}

/// Merge holdings sharing (acquired_epoch, is_locked). Lossless: that pair is the
/// only thing that distinguishes two holdings, and `amount` is additive.
///
/// WHY THIS IS NOT OPTIONAL. `unlock_oldest` splits one holding on every partial
/// release, and unlike the old `remove_locked_amount` it never drops an entry —
/// so the list grew by +1 PER FIRE. `max_loyalty_holdings` (40 kể từ 2026-09-14) and
/// `validate_fire` enforces it, so a long schedule would leave the vault unable
/// to fire OR withdraw at all: LAMP frozen, which is worse than the erosion
/// I-ACT-7 set out to fix. Every split carries the ORIGINAL acquired_epoch, so
/// coalescing collapses them back exactly.
///
/// Ai tìm ra trước: `bf9b1725` (tuanzoro2k, 2026-08-12) — sớm hơn `5e2fd76b`
/// (DucTiger, 2026-08-17) năm ngày. Quét mọi ref bằng `git log --all -S'coalesce_holdings'`
/// cho đúng hai commit đó, theo thứ tự đó.
///   (Bản trước của ba dòng này ghi "ported from origin/main, where this bug was found
///    and fixed first" — sai thứ tự, và nó nằm trong mã nguồn nên người sau đọc sẽ tin.)
/// Hai bản giữ byte-identical có chủ ý — đừng "cải tiến" một bên (P8).
///
/// ExUnits ĐÃ cắn — số đo ở `validators/vault.ak` mục "Chi phí ExUnit theo TRỤC `loyalty_holdings`". Bản dưới đây giữ
/// nguyên O(n²) trên GIẤY nhưng hạ hằng số xuống nhiều lần, bằng cách để bộ tích luỹ
/// nằm NGƯỢC suốt vòng lặp và chỉ lật một lần ở cuối:
///
///   - nhánh KHÔNG gộp được (nhánh thường gặp, chính nó làm danh sách dài ra) từ
///     `list.concat(acc, [h])` — O(|acc|), dựng lại cả danh sách — thành `[h, ..acc]`,
///     O(1).
///   - nhánh gộp được vẫn quét `acc` để tìm rồi quét để cộng, nhưng không còn phải
///     dựng lại danh sách ở bước nối.
///
/// `list.map` giữ nguyên vị trí, nên lật-rồi-map và map-rồi-lật cho cùng một dãy:
/// kết quả TRÙNG TỪNG BIT với bản cũ. Không đụng gì phía TypeScript (P8).
///
/// Cách sắp xếp-rồi-quét O(n log n) vẫn để ngỏ, nhưng nó đòi một thứ tự toàn phần trên
/// cặp `(acquired_epoch, is_locked)` và `list.sort` của Aiken ĐẢO phần tử hoà trong khi
/// JS thì không — tức nó là một thay đổi CÓ THỂ đổi kết quả, phải qua bài kiểm ca hoà
/// trước. Hai bản vá ở đây thì không.
pub fn coalesce_holdings(holdings: List<LoyaltyHolding>) -> List<LoyaltyHolding> {
  list.reverse(list.foldl(holdings, [], fn(h, acc_rev) { merge_into_rev(acc_rev, h) }))
}

fn same_bucket(a: LoyaltyHolding, b: LoyaltyHolding) -> Bool {
  a.acquired_epoch == b.acquired_epoch && a.is_locked == b.is_locked
}

/// `acc_rev` NGƯỢC thứ tự kết quả — nên "nối vào đuôi" ở đây là nối vào ĐẦU.
fn merge_into_rev(
  acc_rev : List<LoyaltyHolding>,
  h       : LoyaltyHolding,
) -> List<LoyaltyHolding> {
  if list.any(acc_rev, fn(x) { same_bucket(x, h) }) {
    // First occurrence keeps its position — order stays deterministic (P8).
    list.map(acc_rev, fn(x) {
      if same_bucket(x, h) { LoyaltyHolding { ..x, amount: x.amount + h.amount } } else { x }
    })
  } else {
    [h, ..acc_rev]
  }
}

fn unlock_oldest(
  holdings  : List<LoyaltyHolding>,
  remaining : Int,
  freed     : List<LoyaltyHolding>,
) -> (List<LoyaltyHolding>, List<LoyaltyHolding>) {
  // `freed` giữ NGƯỢC thứ tự, lật một lần ở mỗi nhánh dừng — cùng lý do và cùng
  // bảo đảm trùng-bit như `lock_youngest`.
  when holdings is {
    [] -> {
      expect remaining == 0
      (list.reverse(freed), [])
    }
    [h, ..rest] ->
      if remaining <= 0 {
        (list.reverse(freed), [h, ..rest])
      } else if remaining >= h.amount {
        unlock_oldest(
          rest,
          remaining - h.amount,
          [LoyaltyHolding { ..h, is_locked: False }, ..freed],
        )
      } else {
        (
          list.reverse([
            LoyaltyHolding {
              amount: remaining, acquired_epoch: h.acquired_epoch, is_locked: False,
            },
            ..freed
          ]),
          [
            LoyaltyHolding {
              amount: h.amount - remaining, acquired_epoch: h.acquired_epoch, is_locked: True,
            },
            ..rest
          ],
        )
      }
  }
}

// Oldest-locked-first removal — LEGACY. No handler calls this any more: under
// I-ACT-7 a fire releases the lock (unlock_locked_amount) instead of removing
// LAMP. Kept for reference/tests only.
pub fn remove_locked_amount(
  holdings : List<LoyaltyHolding>,
  amount   : Int,
) -> List<LoyaltyHolding> {
  let locked   = list.filter(holdings, fn(h) {  h.is_locked })
  let unlocked = list.filter(holdings, fn(h) { !h.is_locked })
  let sorted   = list.sort(locked, fn(a, b) { int.compare(a.acquired_epoch, b.acquired_epoch) })
  list.concat(unlocked, remove_oldest(sorted, amount))
}

fn remove_oldest(
  holdings  : List<LoyaltyHolding>,
  remaining : Int,
) -> List<LoyaltyHolding> {
  when holdings is {
    [] -> {
      expect remaining == 0
      []
    }
    [h, ..rest] ->
      if remaining <= 0 { holdings }
      else if remaining >= h.amount { remove_oldest(rest, remaining - h.amount) }
      else { [LoyaltyHolding { ..h, amount: h.amount - remaining }, ..rest] }
  }
}

pub fn sum_holdings(h: List<LoyaltyHolding>) -> Int {
  list.foldl(h, 0, fn(x, acc) { acc + x.amount })
}

pub fn l_avail(lamp_balance: Int, lamp_locked: Int) -> Int {
  lamp_balance - lamp_locked
}

// ══════════════════════════════════════════════════════════════
// remove_newest_first — WithdrawLamp selection (SPEC_V1 §1)
// ══════════════════════════════════════════════════════════════
//
// Pick NEWEST unlocked holdings first → preserve loyalty of older
// holdings (LF-favorable). Locked holdings never touched.
//
// Algorithm mirrors MagicSDK/src/withdrawLamp.ts:206 byte-for-byte
// (P8 invariant). Distinct from `select_lamp_for_lock` (youngest-first
// at lock time) and `remove_locked_amount` (oldest-locked-first at fire).
pub fn remove_newest_first(
  holdings : List<LoyaltyHolding>,
  amount   : Int,
) -> List<LoyaltyHolding> {
  let locked   = list.filter(holdings, fn(h) {  h.is_locked })
  let unlocked = list.filter(holdings, fn(h) { !h.is_locked })
  let sorted   = list.sort(unlocked, fn(a, b) { int.compare(b.acquired_epoch, a.acquired_epoch) })
  let remaining_unlocked = consume_newest(sorted, amount)
  list.concat(locked, remaining_unlocked)
}

fn consume_newest(
  holdings  : List<LoyaltyHolding>,
  remaining : Int,
) -> List<LoyaltyHolding> {
  when holdings is {
    [] -> {
      expect remaining == 0
      []
    }
    [h, ..rest] ->
      if remaining <= 0 { holdings }
      else if remaining >= h.amount {
        consume_newest(rest, remaining - h.amount)
      } else {
        [LoyaltyHolding { ..h, amount: h.amount - remaining }, ..rest]
      }
  }
}

// ══════════════════════════════════════════════════════════════
// P8 — vector cho ca HOÀ (`acquired_epoch` trùng nhau)
// ══════════════════════════════════════════════════════════════
//
// `list.sort` của stdlib Aiken ĐẢO phần tử hoà; `Array.prototype.sort` của JS thì GIỮ
// nguyên thứ tự (ổn định từ ES2019). Trước ngày 2026-09-05 không vector nào trong kho có
// hai holding cùng `acquired_epoch`, nên hai bản hiện thực lệch nhau ở đúng ca đó mà mọi
// bộ test hai phía đều xanh — và validator so danh sách BẰNG NHAU TUYỆT ĐỐI
// (`validators/vault.ak:353`), nên mỗi lệch là một tx bị chuỗi từ chối.
//
// Ca hoà không hiếm: `select_lamp_for_lock` khi khoá MỘT PHẦN tách một holding thành HAI
// holding cùng `acquired_epoch` (:34-38). Lần khoá đầu tự tạo ra thế hoà.
//
// Bốn test dưới đây là bản gốc; `ProtocolUtils/tests/utils.test.ts` mục "sortAiken — P8,
// phần tử hoà" ghim CÙNG những giá trị này ở phía TypeScript. Đổi một bên mà không đổi
// bên kia thì một trong hai bộ đỏ — đó là điều trước đây không xảy ra.

fn p8_tie_two() -> List<LoyaltyHolding> {
  [ LoyaltyHolding { amount: 100, acquired_epoch: 10, is_locked: False },
    LoyaltyHolding { amount:  50, acquired_epoch: 10, is_locked: False } ]
}

test p8_tie_sort_reverses_equal_elements() {
  let s = list.sort(p8_tie_two(), fn(a, b) { int.compare(b.acquired_epoch, a.acquired_epoch) })
  when s is {
    [h, ..] -> h.amount == 50      // ĐẢO. JS ổn định sẽ cho 100 ở đây.
    [] -> False
  }
}

test p8_tie_select_lamp_for_lock() {
  select_lamp_for_lock(p8_tie_two(), 20) == [
    LoyaltyHolding { amount:  20, acquired_epoch: 10, is_locked: True  },
    LoyaltyHolding { amount:  30, acquired_epoch: 10, is_locked: False },
    LoyaltyHolding { amount: 100, acquired_epoch: 10, is_locked: False } ]
}

test p8_tie_remove_newest_first() {
  remove_newest_first(p8_tie_two(), 30) == [
    LoyaltyHolding { amount:  20, acquired_epoch: 10, is_locked: False },
    LoyaltyHolding { amount: 100, acquired_epoch: 10, is_locked: False } ]
}

test p8_tie_conserves_total() {
  sum_holdings(select_lamp_for_lock(p8_tie_two(), 20)) == 150 && sum_holdings(
    remove_newest_first(p8_tie_two(), 30),
  ) == 120
}
