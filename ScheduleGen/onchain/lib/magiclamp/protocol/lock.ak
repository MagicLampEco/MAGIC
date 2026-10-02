// lib/lock.ak — LAMP lock/unlock helpers (§6.8, §A.9)
// Identical logic to VacuumGen lock.ak — youngest-first lock (T5).
// For ScheduleGen: lock L×λ at commit; remove fires_in_tx×λ at each fire.

use aiken/collection/list
use aiken/primitive/int
use magiclamp/protocol/types.{LoyaltyHolding}

// Youngest-first lock (T5 — maximizes LF of free holdings), CHỈ trong holding ĐANG MỞ.
//
// #132 (2026-10-02): bản trước sắp và duyệt MỌI holding, kể cả holding đã khoá. Gặp
// holding đã khoá thì nó đếm lại lượng đó (khoá thêm 0) hoặc cắt nó và trả một mảnh về
// trạng thái mở, trong khi `validate_commit` cộng ĐỦ `amount` vào `lamp_locked` ⟹
// `lamp_locked > Σ khoá` ⟹ lượt nhả cuối chết ở `unlock_oldest` ⟹ phần lệch kẹt vĩnh
// viễn. Genesis không ghim `acquired_epoch`, nên commit lần hai trên két có holding trẻ
// nhất đang khoá là tới được.
//
// Thứ tự kết quả: [đang khoá, giữ thứ tự vào] ++ [phần đang mở sau khi khoá]. Cùng
// hình dạng với `remove_newest_first` (khoá trước, mở sau). `unlock_locked_amount` tự lọc
// và tự sắp lại nên không phụ thuộc thứ tự này; nhưng validator so danh sách BẰNG NHAU
// TUYỆT ĐỐI nên phía TypeScript phải dựng đúng thứ tự này
// (`ProtocolUtils/src/index.ts` ▸ `selectLampForLock`, P8). Két chưa có holding
// khoá (lần commit đầu) cho kết quả TRÙNG TỪNG BIT với bản cũ.
pub fn select_lamp_for_lock(
  holdings : List<LoyaltyHolding>,
  amount   : Int,
) -> List<LoyaltyHolding> {
  let locked   = list.filter(holdings, fn(h) {  h.is_locked })
  let unlocked = list.filter(holdings, fn(h) { !h.is_locked })
  let sorted = list.sort(unlocked, fn(a, b) { int.compare(b.acquired_epoch, a.acquired_epoch) })
  list.concat(locked, lock_youngest(sorted, amount, []))
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

/// Tổng LAMP của các holding đang KHOÁ. Bất biến của két (issue #132):
/// `sum_locked(loyalty_holdings) == lamp_locked` — ép trên output ở commit, fire và
/// withdraw (`validators/vault.ak` ▸ C-SCH-LOCKSUM); bài tính chất ở mục "#132" cuối tệp.
pub fn sum_locked(h: List<LoyaltyHolding>) -> Int {
  list.foldl(h, 0, fn(x, acc) { if x.is_locked { acc + x.amount } else { acc } })
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

// ══════════════════════════════════════════════════════════════
// #132 — kiểm TÍNH CHẤT: lượng LAMP đổi trạng thái khoá == lượng yêu cầu
// ══════════════════════════════════════════════════════════════
//
// `lamp_locked == sum_locked(loyalty_holdings)` được ép tuyệt đối ở commit/fire/withdraw
// (C-SCH-LOCKSUM), nhưng cổng chỉ TỪ CHỐI; muốn két đi tiếp được thì hai hàm dưới phải
// tự giữ đẳng thức. Kiểm trên nhiều danh sách sinh giả ngẫu nhiên TẤT ĐỊNH (bộ sinh đồng
// dư tuyến tính, hạt giống cố định) — không dùng thư viện fuzz vì kho này chưa phụ thuộc
// nó, và kết quả phải lặp lại được từng bit.
//
// Bộ sinh cố ý dồn `acquired_epoch` vào 0..5 ⟹ phần lớn danh sách có phần tử HOÀ, đúng
// ca `list.sort` đảo thứ tự (xem mục P8 bên trên).
//
// MIỀN: mọi danh sách, khoá và mở trộn lẫn (`mixed = True`), cộng miền toàn-mở.
//  · `select_lamp_for_lock`: lượng 0..sum(phần đang mở).
//  · `unlock_locked_amount`: lượng 0..sum_locked.

const prop_cases: Int = 300

const prop_max_len: Int = 12

fn prop_next(s: Int) -> Int {
  ( s * 1_103_515_245 + 12_345 ) % 2_147_483_648
}

/// Sinh `n` holding: amount 1..1000, acquired_epoch 0..5, khoá với xác suất 1/2 khi
/// `mixed`. Trả về hạt giống kế tiếp.
fn prop_holdings(
  s: Int,
  n: Int,
  mixed: Bool,
  acc: List<LoyaltyHolding>,
) -> (List<LoyaltyHolding>, Int) {
  if n <= 0 {
    (acc, s)
  } else {
    let s1 = prop_next(s)
    let s2 = prop_next(s1)
    let s3 = prop_next(s2)
    let h =
      LoyaltyHolding {
        amount: 1 + s1 / 7 % 1000,
        acquired_epoch: s2 / 7 % 6,
        is_locked: mixed && s3 / 7 % 2 == 0,
      }
    prop_holdings(s3, n - 1, mixed, [h, ..acc])
  }
}

/// Lượng yêu cầu trong 0..cap, kèm hai biên (0 và cap) chiếm 1/4 số ca mỗi biên —
/// biên là chỗ `remaining >= h.amount` đổi nhánh.
fn prop_amount(s: Int, cap: Int) -> Int {
  when s / 7 % 4 is {
    0 -> 0
    1 -> cap
    _ -> s / 11 % ( cap + 1 )
  }
}

fn prop_all_positive(h: List<LoyaltyHolding>) -> Bool {
  list.all(h, fn(x) { x.amount > 0 })
}

fn sum_unlocked(h: List<LoyaltyHolding>) -> Int {
  sum_holdings(h) - sum_locked(h)
}

/// Chạy `check` trên `k` ca, dừng ở ca đầu tiên sai (trả False).
fn prop_run(
  k: Int,
  s: Int,
  mixed: Bool,
  check: fn(List<LoyaltyHolding>, Int) -> Bool,
) -> Bool {
  if k <= 0 {
    True
  } else {
    let s0 = prop_next(s)
    let n = s0 / 7 % prop_max_len + 1
    let (hs, s1) = prop_holdings(s0, n, mixed, [])
    if check(hs, s1) {
      prop_run(k - 1, s1, mixed, check)
    } else {
      False
    }
  }
}

fn prop_select_ok(hs: List<LoyaltyHolding>, s: Int) -> Bool {
  let amount = prop_amount(prop_next(s), sum_unlocked(hs))
  let out = select_lamp_for_lock(hs, amount)
  and {
    sum_locked(out) - sum_locked(hs) == amount,
    sum_holdings(out) == sum_holdings(hs),
    prop_all_positive(out),
    // Holding đang khoá đi qua NGUYÊN VẸN, đứng đầu, đúng thứ tự vào.
    list.take(out, list.length(list.filter(hs, fn(h) { h.is_locked })))
      == list.filter(hs, fn(h) { h.is_locked }),
  }
}

fn prop_unlock_ok(hs: List<LoyaltyHolding>, s: Int) -> Bool {
  let amount = prop_amount(prop_next(s), sum_locked(hs))
  let out = unlock_locked_amount(hs, amount)
  and {
    sum_locked(hs) - sum_locked(out) == amount,
    sum_holdings(out) == sum_holdings(hs),
    prop_all_positive(out),
  }
}

test prop_132_select_locks_exactly_requested() {
  and {
    prop_run(prop_cases, 132, True, prop_select_ok),
    prop_run(prop_cases, 132, False, prop_select_ok),
  }
}

test prop_132_unlock_releases_exactly_requested() {
  prop_run(prop_cases, 1_320, True, prop_unlock_ok)
}

// Bộ sinh phải THẬT SỰ phủ cả hai nhánh của mỗi hàm, không thì hai bài trên xanh vì
// rỗng: đếm số ca có cắt holding, số ca có holding khoá ĐỨNG TRẺ NHẤT (đúng ca #132), và
// số ca có phần tử hoà.
fn prop_count(
  k: Int,
  s: Int,
  mixed: Bool,
  hit: fn(List<LoyaltyHolding>, Int) -> Bool,
  acc: Int,
) -> Int {
  if k <= 0 {
    acc
  } else {
    let s0 = prop_next(s)
    let n = s0 / 7 % prop_max_len + 1
    let (hs, s1) = prop_holdings(s0, n, mixed, [])
    prop_count(
      k - 1,
      s1,
      mixed,
      hit,
      if hit(hs, s1) {
        acc + 1
      } else {
        acc
      },
    )
  }
}

fn prop_select_splits(hs: List<LoyaltyHolding>, s: Int) -> Bool {
  let amount = prop_amount(prop_next(s), sum_unlocked(hs))
  list.length(select_lamp_for_lock(hs, amount)) > list.length(hs)
}

fn prop_locked_is_youngest(hs: List<LoyaltyHolding>, _s: Int) -> Bool {
  list.any(
    hs,
    fn(a) {
      a.is_locked && list.any(hs, fn(b) { !b.is_locked }) && list.all(
        hs,
        fn(b) { b.is_locked || b.acquired_epoch < a.acquired_epoch },
      )
    },
  )
}

fn prop_unlock_splits(hs: List<LoyaltyHolding>, s: Int) -> Bool {
  let amount = prop_amount(prop_next(s), sum_locked(hs))
  // Cắt ⟹ trong kết quả có một epoch mang CẢ mảnh khoá lẫn mảnh mở mà đầu vào không có.
  let out = unlock_locked_amount(hs, amount)
  list.any(
    out,
    fn(a) {
      a.is_locked && list.any(
        out,
        fn(b) { !b.is_locked && b.acquired_epoch == a.acquired_epoch },
      ) && !list.any(
        hs,
        fn(b) { !b.is_locked && b.acquired_epoch == a.acquired_epoch },
      )
    },
  )
}

fn prop_has_tie(hs: List<LoyaltyHolding>, _s: Int) -> Bool {
  list.any(
    hs,
    fn(a) {
      list.length(list.filter(hs, fn(b) { b.acquired_epoch == a.acquired_epoch })) > 1
    },
  )
}

test prop_132_generator_covers_branches() {
  and {
    prop_count(prop_cases, 132, True, prop_select_splits, 0) >= 50,
    prop_count(prop_cases, 132, False, prop_select_splits, 0) >= 50,
    prop_count(prop_cases, 132, True, prop_locked_is_youngest, 0) >= 30,
    prop_count(prop_cases, 1_320, True, prop_unlock_splits, 0) >= 50,
    prop_count(prop_cases, 132, True, prop_has_tie, 0) >= 100,
  }
}

// ── VECTOR P8 CHUNG #132 — cùng đầu vào, cùng đầu ra ở `ScheduleGen/tests/lockSelect132.test.ts` ──
// Đổi một bên mà không đổi bên kia thì một trong hai bộ đỏ.

fn lh(amount: Int, epoch: Int, locked: Bool) -> LoyaltyHolding {
  LoyaltyHolding { amount, acquired_epoch: epoch, is_locked: locked }
}

// TV-LOCK-132-01 — holding đang khoá là holding TRẺ NHẤT (đúng ca của lỗi).
test tv_lock_132_01_locked_youngest() {
  and {
    select_lamp_for_lock([lh(100, 9, True), lh(100, 1, False)], 100)
      == [lh(100, 9, True), lh(100, 1, True)],
    select_lamp_for_lock([lh(100, 9, True), lh(100, 1, False)], 50)
      == [lh(100, 9, True), lh(50, 1, True), lh(50, 1, False)],
  }
}

// TV-LOCK-132-02 — HOÀ `acquired_epoch` giữa holding khoá và holding mở.
test tv_lock_132_02_tie_mixed() {
  select_lamp_for_lock([lh(30, 10, True), lh(100, 10, False), lh(50, 10, False)], 120)
    == [lh(30, 10, True), lh(50, 10, True), lh(70, 10, True), lh(30, 10, False)]
}

// TV-LOCK-132-03 — khoá xen giữa, nhiều epoch.
test tv_lock_132_03_interleaved() {
  select_lamp_for_lock(
    [lh(10, 3, False), lh(20, 7, True), lh(30, 5, False), lh(40, 9, False)],
    50,
  ) == [lh(20, 7, True), lh(40, 9, True), lh(10, 5, True), lh(20, 5, False), lh(10, 3, False)]
}

// TV-LOCK-132-04 — két chưa có holding khoá (lần commit đầu): thứ tự ra GIỮ đúng bản cũ.
test tv_lock_132_04_no_locked_holdings() {
  let hs = [lh(100, 10, False), lh(50, 10, False), lh(7, 3, False), lh(9, 12, False)]
  and {
    select_lamp_for_lock(hs, 0)
      == [lh(9, 12, False), lh(50, 10, False), lh(100, 10, False), lh(7, 3, False)],
    select_lamp_for_lock(hs, 57)
      == [lh(9, 12, True), lh(48, 10, True), lh(2, 10, False), lh(100, 10, False), lh(7, 3, False)],
    select_lamp_for_lock(hs, 166)
      == [lh(9, 12, True), lh(50, 10, True), lh(100, 10, True), lh(7, 3, True)],
  }
}

// Lượng vượt phần đang mở thì CHẾT, kể cả khi tổng (khoá + mở) đủ — không được khoá chồng.
test select_beyond_unlocked_halts() fail {
  sum_holdings(select_lamp_for_lock([lh(100, 9, True), lh(100, 1, False)], 101)) == 200
}

// Két lệch thì lượt nhả vượt phần đang khoá CHẾT ở `expect remaining == 0` — đây là
// đường mà lỗi #132 cũ dẫn tới (LAMP kẹt); C-SCH-LOCKSUM + bản vá trên chặn lối vào.
test unlock_beyond_locked_halts() fail {
  sum_holdings(unlock_locked_amount([lh(100, 9, True), lh(100, 1, False)], 101)) == 200
}

// ── CHUỖI vòng đời #132: genesis → commit → commit → fire … → nhả hết ──
//
// Theo dõi `lamp_locked` như validator cộng/trừ, và tại MỖI bước ép
// `sum_locked == lamp_locked`. Mỗi lịch nhả λ mỗi lượt fire; nhả cuối cùng phải xong với
// `remaining == 0` (không thì `unlock_oldest` đã chết). Hai kịch bản: genesis MỘT holding
// (mọi mảnh hoà cùng epoch — ca `list.sort` đảo phần tử hoà) và genesis hai epoch với
// holding trẻ nhất bị khoá ở commit 1 (đúng ca lỗi cũ).

fn chain_fire_all(
  hs: List<LoyaltyHolding>,
  lamp_locked: Int,
  lambda: Int,
  fires: Int,
) -> Bool {
  if fires <= 0 {
    lamp_locked == 0 && sum_locked(hs) == 0
  } else {
    let out = unlock_locked_amount(hs, lambda)
    let locked_out = lamp_locked - lambda
    and {
      sum_locked(out) == locked_out,
      sum_holdings(out) == sum_holdings(hs),
      chain_fire_all(out, locked_out, lambda, fires - 1),
    }
  }
}

fn chain_two_commits(
  genesis: List<LoyaltyHolding>,
  lambda: Int,
  l1: Int,
  l2: Int,
) -> Bool {
  let c1 = select_lamp_for_lock(genesis, l1 * lambda)
  let c2 = select_lamp_for_lock(c1, l2 * lambda)
  and {
    sum_locked(c1) == l1 * lambda,
    sum_locked(c2) == ( l1 + l2 ) * lambda,
    chain_fire_all(c2, ( l1 + l2 ) * lambda, lambda, l1 + l2),
  }
}

test chain_132_single_genesis_holding() {
  // 3 + 4 lượt, λ = 7, một holding 100 ⟹ còn 51 tự do; mọi mảnh cùng epoch 0.
  chain_two_commits([lh(100, 0, False)], 7, 3, 4)
}

test chain_132_locked_youngest_genesis() {
  // Commit 1 khoá TRỌN holding e9 (10 × 10), commit 2 phải lấy từ e1.
  chain_two_commits([lh(100, 9, False), lh(200, 1, False)], 10, 10, 10)
}
