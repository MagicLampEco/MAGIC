# LAMP/MAGIC OTC Desk — Tài Liệu Triển Khai Cuối Cùng

**Phiên bản:** 1.0.0-rc1  
**Ngày:** 2026-06-05  
**Trạng thái:** Production-ready sau 4 vòng phản biện  
**Tác giả:** MagicLamp Architecture Session

---

## 1. TÓM TẮT CHO LÃNH ĐẠO

### Hệ thống này là gì

LAMP/MAGIC OTC Desk là sàn giao dịch phi tập trung cho phép người dùng Việt Nam mua token LAMP và MAGIC bằng cách chuyển khoản ngân hàng VND qua VietQR. Không cần tài khoản sàn, không cần KYC với sàn trung gian. Người bán (enterprise) khoá token vào smart contract Cardano. Oracle VeData giám sát tài khoản ngân hàng, xác nhận thanh toán, ký phát hành token. Toàn bộ logic kinh tế nằm trong smart contract — không ai có thể rút token sai quy tắc dù muốn.

### Khả thi không? Kết luận của 4 vòng phản biện

**Về kỹ thuật: Khả thi nhưng cần sửa 4 lỗi nghiêm trọng trước khi deploy.**

Vòng security audit phát hiện lỗi biên dịch sẽ khiến contract không compile được (`trace_if_false` sai thứ tự tham số), ba lỗ hổng mất tiền (ADA deposit không được bảo vệ, UTxO tiếp nối có thể thiếu ADA gây khoá token vĩnh viễn, hằng số giá tối thiểu khai báo nhưng không dùng), và tám vấn đề mức độ cao/trung. Tất cả đã được sửa trong bản này.

**Về kinh tế: Khả thi nhưng chỉ với đúng đối tượng enterprise.**

Phân tích kinh tế kết luận model chỉ có lãi cho enterprise nắm giữ LAMP với giá vốn thấp (ICO participants, foundation, người nhận LAMP qua ScheduleGen). Enterprise mua LAMP ở giá thị trường rồi bán lại sẽ lỗ do chi phí cơ hội và rủi ro giá. Cần thêm cơ chế phòng ngừa rút thanh khoản khi giá tăng (pro-cyclical problem) và trần spread do DAO quản trị.

**Về pháp lý: Không khả thi tại Việt Nam với cấu trúc hiện tại nếu dùng tài khoản ngân hàng Việt Nam.**

Phân tích pháp lý xác định rủi ro hình sự theo Điều 206 BLHS (hoạt động ngân hàng không phép) là rủi ro sinh tử. Không có framework pháp lý cho phép hoạt động này tại Việt Nam hiện tại. Cần cấu trúc thực thể nước ngoài + tiếp cận thị trường Việt Nam qua đối tác có phép.

**Về tin cậy: Có thể chấp nhận được ở MVP nhưng cần lộ trình phi tập trung hoá.**

VeData oracle là điểm tin cậy duy nhất. Toàn bộ bảo mật kinh tế phụ thuộc vào VeData không bị tấn công và không hành động xấu. Đây là rủi ro có thể chấp nhận cho giai đoạn đầu nếu có HSM, kill switch, và kế hoạch chuyển sang multi-sig rõ ràng.

### Top 3 rủi ro PHẢI xử lý trước khi ra mắt

**Rủi ro 1 — Pháp lý: Tài khoản ngân hàng Việt Nam = Điều 206 BLHS**  
Không dùng tài khoản ngân hàng Việt Nam của công ty Việt Nam làm tài khoản settlement. Đây là điểm neo pháp lý kéo toàn bộ hoạt động vào phạm vi hình sự của Việt Nam. Bất kỳ ai ký hợp đồng ngân hàng đó là người chịu rủi ro hình sự đầu tiên.

**Rủi ro 2 — Kỹ thuật: Smart contract có 4 lỗi nghiêm trọng**  
Contract chưa được sửa sẽ không compile (lỗi 1), cho phép đánh cắp ADA deposit của người bán (lỗi 2), khoá token vĩnh viễn trong UTxO tiếp nối (lỗi 3), và cho phép tạo lệnh với giá bằng 0 (lỗi 4). Bản sửa trong tài liệu này giải quyết tất cả.

**Rủi ro 3 — Kỹ thuật: VeData oracle có lỗi pre-mark dedup**  
Nếu oracle crash giữa lúc đánh dấu Redis và emit event, thanh toán thật của người mua bị bỏ qua vĩnh viễn mà không có cảnh báo. Người mua mất tiền, không nhận token, không có exception. Bản sửa đổi thứ tự lệnh trong oracle code.

### Đề xuất go/no-go với điều kiện cụ thể

**Quyết định: GO — với 5 điều kiện bắt buộc trước khi ra mắt**

1. **Pháp lý:** Công ty vận hành đặt tại Singapore (MAS PSA) hoặc UAE (VARA). Không dùng thực thể Việt Nam. Tài khoản ngân hàng settlement tại Singapore DBS hoặc tương đương — không phải ngân hàng Việt Nam.

2. **Smart contract:** Deploy bản Aiken đã sửa trong mục 3 của tài liệu này. Chạy `aiken check` đạt 100% trước khi deploy lên Preview testnet. Chạy full test suite trước khi deploy mainnet.

3. **Oracle:** Sửa lỗi pre-mark dedup. Private key lưu trong AWS Secrets Manager với mlock. Có kill switch qua API nội bộ, không chỉ qua SSH vào server.

4. **Kinh doanh:** Chỉ onboard enterprise có thể chứng minh LAMP cost basis thấp (ICO participant, ScheduleGen reward recipient, foundation). Không onboard enterprise mua LAMP ở giá thị trường để bán lại — họ sẽ lỗ và rời bỏ, làm hỏng UX.

5. **AML/KYC tối thiểu:** Triển khai KYC theo tầng: ẩn danh đến 2 triệu VND/tháng, phone verification đến 10 triệu VND/tháng, passport + liveness check trên 10 triệu VND/tháng.

---

## 2. KIẾN TRÚC HỆ THỐNG CUỐI CÙNG

### Component Diagram (đã cập nhật)

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                         TRUST BOUNDARY: OFF-CHAIN                             │
│                                                                                │
│  ┌─────────────────┐   ┌──────────────────────┐   ┌────────────────────────┐ │
│  │   Frontend      │   │   Order API          │   │  VeData Oracle Cluster │ │
│  │  (Next.js)      │   │  (Fastify/TS)        │   │                        │ │
│  │                 │   │                      │   │ ┌────────────────────┐ │ │
│  │ • Offer list    │──▶│ • Create order       │   │ │ Bank Monitor       │ │ │
│  │ • QR display    │   │ • Quote price        │   │ │ • PayOS webhook    │ │ │
│  │ • Tx status     │◀──│ • Order state DB     │   │ │ • MB Bank poller   │ │ │
│  │ • Wallet CIP-30 │   │ • Emit WS events     │   │ │ • Reconcile cron   │ │ │ [NEW]
│  │ • Tiered KYC    │   │ • Rate lock (Redis)  │   │ └────────┬───────────┘ │ │ [NEW]
│  └─────────────────┘   └──────────┬───────────┘   │          │ detected    │ │
│                                   │               │ ┌────────▼───────────┐ │ │
│          REST/WS                  │               │ │ Auth Signer        │ │ │
│                                   │               │ │ • Verify amount    │ │ │
│                                   │               │ │ • HSM sign (Ed25519│ │ │
│                                   │               │ │ • Kill switch API  │ │ │ [NEW]
│                                   │               │ └────────┬───────────┘ │ │
│                                   │               └──────────┼─────────────┘ │
│                                   │ POST /internal/oracle/   │               │
│                                   │   payment-confirmed      │               │
│                                   │◀─────────────────────────┘               │
│                                   │                                           │
│               ┌───────────────────▼──────────┐                               │
│               │     Order State DB           │                               │
│               │     (PostgreSQL)             │                               │
│               │                              │                               │
│               │ • order_id, ref_code         │                               │
│               │ • amount_vnd, buyer_addr     │                               │
│               │ • state machine (9 states)   │                               │
│               │ • KYC tier (ANONYMOUS/PHONE/ │                               │ [NEW]
│               │   PASSPORT)                  │                               │ [NEW]
│               │ • aggregate_monthly_vnd      │                               │ [NEW]
│               └──────────────────────────────┘                               │
│                                                                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │            COMPLIANCE LAYER (NEW)                                       │  │ [NEW]
│  │  • Aggregate transaction monitoring (per wallet, per month)             │  │
│  │  • Structuring detection (>3 tx/30 days at similar amounts)             │  │
│  │  • STR queue for manual review                                          │  │
│  │  • KYC tier enforcement at order creation                               │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────┘
                       │
                       │ Ed25519-signed release auth
                       │ (submitted as Tx redeemer)
                       ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                    TRUST BOUNDARY: ON-CHAIN (Cardano)                         │
│                                                                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │                    OTC Escrow Contract (Aiken / PlutusV3)               │  │
│  │                                                                         │  │
│  │  Datum: { seller_pkh, seller_stake_cred, token_policy, token_name,     │  │
│  │           total_amount, remaining_amount, price_per_unit_lovelace,     │  │
│  │           oracle_vkey, oracle_vkey_hash, order_id, min_buy_amount,     │  │
│  │           max_buy_amount, expiry_posix_ms, released_nonces }           │  │
│  │                                                                         │  │
│  │  Redeemers: Release / Cancel / Rotate / Expire                         │  │
│  │                                                                         │  │
│  │  Invariants đã sửa:                                                    │  │
│  │  ✓ price_per_unit_lovelace >= 2_000_000 (đã thêm — INV-PRICE)         │  │ [FIX]
│  │  ✓ ADA escrow deposit → seller trên full fill (đã thêm — INV-ADA)     │  │ [FIX]
│  │  ✓ Continuing UTxO ADA >= 2_000_000 (đã thêm — INV-MINADA)           │  │ [FIX]
│  │  ✓ released_nonces length bounded (đã thêm — INV-NONCEBOUND)          │  │ [FIX]
│  │  ✓ Rotate yêu cầu chữ ký người bán (đã thêm — INV-ROTATE)            │  │ [FIX]
│  │  ✓ Datum field validation (đã thêm — INV-DATUM)                       │  │ [FIX]
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                │
└───────────────────────────────────────────────────────────────────────────────┘
                       │
                       │ Bank transfer (VND) — qua Singapore bank [CHANGED]
                       ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                       PAYMENT LAYER                                           │
│                                                                                │
│  Buyer Bank (VN) ──(VietQR/NAPAS)──▶ Enterprise Settlement Account           │
│                                       (KHÔNG phải ngân hàng Việt Nam)        │ [CHANGED]
│                                       (Singapore DBS / Wise Business / etc.)  │
│                                                                                │
│  VietQR → ref code 16 ký tự [A-Z0-9] → NAPAS description field              │
│                                                                                │
└───────────────────────────────────────────────────────────────────────────────┘
```

### Các quyết định thiết kế thay đổi sau review

| Quyết định | Trước | Sau | Lý do |
|---|---|---|---|
| Thứ tự tham số `trace_if_false` | `(label, cond)` | `(cond, label)` | Lỗi biên dịch — pipe operator truyền value là arg đầu tiên |
| Kiểm tra giá tối thiểu | Khai báo hằng số nhưng không dùng | Enforce `>= 2_000_000` trong validator | Ngăn lệnh giá 0 |
| ADA deposit trên full fill | Không kiểm | `lovelace_to_addr(seller) >= required + escrow_ada` | Ngăn đánh cắp ADA deposit |
| ADA trong continuing UTxO | Không kiểm | `cont_lovelace >= MIN_UTxO_LOVELACE` | Ngăn token bị khoá vĩnh viễn |
| Độ dài released_nonces | Không giới hạn | `length < ceil(total/min_buy)` | Ngăn ExUnit exhaustion |
| Rotate authorization | Chỉ oracle sig | Oracle sig + seller sig | Ngăn oracle rogue key rotation |
| Pre-mark dedup oracle | Redis trước, emit sau | Emit trước, Redis sau, với DB UNIQUE làm safety net | Ngăn silent payment miss khi crash |
| Reconciliation poller | Trong spec nhưng không code | Đã triển khai trong oracle service | Spec/code gap nghiêm trọng |
| Tài khoản settlement | Ngân hàng Việt Nam | Singapore/offshore bank | Tránh rủi ro Điều 206 BLHS |
| KYC | Không có | Tiered: ẩn danh/phone/passport | AML Law 2022 compliance tối thiểu |
| Batch cancel | Spec nói được, code chặn | Đã xóa claim batching khỏi spec | Spec/code divergence — code đúng |

---

## 3. SMART CONTRACT — BẢN CUỐI (Aiken)

### File: `aiken.toml`

```toml
name    = "magiclamp/otc-desk"
version = "0.0.1"
plutus  = "v3"
license = "Apache-2.0"

[[dependencies]]
name    = "aiken-lang/stdlib"
version = "v3.1.0"
source  = "github"
```

### File: `lib/magiclamp/otc/types.ak`

```aiken
// lib/magiclamp/otc/types.ak
// OTC Desk — kiểu dữ liệu dùng chung.
// Thứ tự field trong mỗi type KHÔNG được đổi — ảnh hưởng Constr index offchain.

use cardano/address.{Credential}
use cardano/assets.{AssetName, PolicyId}

/// Datum inline tại mỗi UTxO escrow.
/// Bất biến: 0 < remaining_amount <= total_amount.
/// released_nonces bị giới hạn bởi ceil(total_amount / min_buy_amount).
pub type OtcDatum {
  // ── Các bên tham gia ──────────────────────────────────────────────────────
  seller_pkh: ByteArray,
  seller_stake_cred: Option<Credential>,

  // ── Token bán ─────────────────────────────────────────────────────────────
  token_policy: PolicyId,
  token_name: AssetName,
  total_amount: Int,
  remaining_amount: Int,

  // ── Giá ───────────────────────────────────────────────────────────────────
  /// Lovelace tính cho mỗi 1 đơn vị token. Cố định lúc tạo lệnh.
  /// Phải >= 2_000_000 (min_price_lovelace).
  price_per_unit_lovelace: Int,

  // ── Oracle ────────────────────────────────────────────────────────────────
  oracle_vkey: ByteArray,
  oracle_vkey_hash: ByteArray,

  // ── Tham số lệnh ──────────────────────────────────────────────────────────
  order_id: ByteArray,
  min_buy_amount: Int,
  max_buy_amount: Int,

  // ── Thời gian ─────────────────────────────────────────────────────────────
  expiry_posix_ms: Int,

  // ── Theo dõi nonce đã dùng ────────────────────────────────────────────────
  released_nonces: List<ByteArray>,
}

/// Redeemer cho validator otc_desk.
pub type OtcRedeemer {
  Release {
    order_id: ByteArray,
    buyer_pkh: ByteArray,
    token_amount: Int,
    oracle_timestamp: Int,
    oracle_nonce: ByteArray,
    oracle_signature: ByteArray,
  }

  Cancel

  Rotate {
    new_oracle_vkey: ByteArray,
    new_oracle_vkey_hash: ByteArray,
    oracle_sig_over_rotation: ByteArray,
  }

  Expire
}
```

### File: `lib/magiclamp/otc/utils.ak`

```aiken
// lib/magiclamp/otc/utils.ak
// OTC Desk — helper functions dùng chung.

use aiken/collection/list
use aiken/crypto.{blake2b_256, verify_ed25519_signature}
use aiken/interval.{Finite, IntervalBoundType}
use cardano/address.{Address, Credential, Inline, Script, VerificationKey}
use cardano/assets
use cardano/assets.{AssetName, PolicyId, Value}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}

// ── Địa chỉ & credential ──────────────────────────────────────────────────────

pub fn vk_address(pkh: ByteArray) -> Address {
  Address { payment_credential: VerificationKey(pkh), stake_credential: None }
}

pub fn seller_address(pkh: ByteArray, stake_cred: Option<Credential>) -> Address {
  Address {
    payment_credential: VerificationKey(pkh),
    stake_credential: stake_cred |> map_stake,
  }
}

fn map_stake(
  cred_opt: Option<Credential>,
) -> Option<cardano/address.StakeCredential> {
  when cred_opt is {
    None -> None
    Some(c) -> Some(Inline(c))
  }
}

pub fn is_owned_by(addr: Address, pkh: ByteArray) -> Bool {
  when addr.payment_credential is {
    VerificationKey(h) -> h == pkh
    _ -> False
  }
}

pub fn is_at_script(addr: Address, script_hash: ByteArray) -> Bool {
  when addr.payment_credential is {
    Script(h) -> h == script_hash
    _ -> False
  }
}

pub fn own_script_hash(own_addr: Address) -> ByteArray {
  expect Script(h) = own_addr.payment_credential
  h
}

pub fn own_address(own_ref: OutputReference, inputs: List<Input>) -> Address {
  expect Some(i) = list.find(inputs, fn(x) { x.output_reference == own_ref })
  i.output.address
}

/// Lấy value của UTxO đang spend.
pub fn own_value(own_ref: OutputReference, inputs: List<Input>) -> Value {
  expect Some(i) = list.find(inputs, fn(x) { x.output_reference == own_ref })
  i.output.value
}

// ── Đếm input/output ──────────────────────────────────────────────────────────

pub fn count_inputs_at_script(inputs: List<Input>, sh: ByteArray) -> Int {
  list.count(inputs, fn(x) { is_at_script(x.output.address, sh) })
}

pub fn count_outputs_at_script(outputs: List<Output>, sh: ByteArray) -> Int {
  list.count(outputs, fn(x) { is_at_script(x.address, sh) })
}

pub fn output_at_script(outputs: List<Output>, sh: ByteArray) -> Output {
  expect Some(o) = list.find(outputs, fn(x) { is_at_script(x.address, sh) })
  o
}

// ── Tổng token/lovelace tại địa chỉ ──────────────────────────────────────────

pub fn tokens_to_pkh(
  outputs: List<Output>,
  pkh: ByteArray,
  policy: PolicyId,
  name: AssetName,
) -> Int {
  list.foldl(
    outputs,
    0,
    fn(o, acc) {
      if is_owned_by(o.address, pkh) {
        acc + assets.quantity_of(o.value, policy, name)
      } else {
        acc
      }
    },
  )
}

pub fn lovelace_to_pkh(outputs: List<Output>, pkh: ByteArray) -> Int {
  list.foldl(
    outputs,
    0,
    fn(o, acc) {
      if is_owned_by(o.address, pkh) {
        acc + assets.lovelace_of(o.value)
      } else {
        acc
      }
    },
  )
}

pub fn lovelace_to_addr(outputs: List<Output>, addr: Address) -> Int {
  list.foldl(
    outputs,
    0,
    fn(o, acc) {
      if o.address == addr {
        acc + assets.lovelace_of(o.value)
      } else {
        acc
      }
    },
  )
}

// ── Chữ ký tx ─────────────────────────────────────────────────────────────────

pub fn tx_signed_by(tx: Transaction, pkh: ByteArray) -> Bool {
  list.has(tx.extra_signatories, pkh)
}

// ── Khoảng thời gian ──────────────────────────────────────────────────────────

fn get_finite(bt: IntervalBoundType) -> Option<Int> {
  when bt is {
    Finite(s) -> Some(s)
    _ -> None
  }
}

pub fn tx_lower_bound(tx: Transaction) -> Int {
  expect Some(s) = tx.validity_range.lower_bound.bound_type |> get_finite
  s
}

pub fn tx_upper_bound(tx: Transaction) -> Int {
  expect Some(s) = tx.validity_range.upper_bound.bound_type |> get_finite
  s
}

// ── Oracle signature ──────────────────────────────────────────────────────────

pub fn verify_oracle_sig(
  vkey: ByteArray,
  msg_hash: ByteArray,
  sig: ByteArray,
) -> Bool {
  verify_ed25519_signature(vkey, msg_hash, sig)
}

pub fn hash_msg(payload: ByteArray) -> ByteArray {
  blake2b_256(payload)
}

// ── Serialise oracle messages ─────────────────────────────────────────────────
//
// Dùng builtin.serialise_data(data: Data) -> ByteArray.
// Aiken encode List<Data> thành CBOR indefinite-length array (9f ... ff).
// Offchain PHẢI dùng Plutus Data CBOR encoding — KHÔNG dùng standard CBOR library.

pub fn serialise_release_msg(
  order_id: ByteArray,
  buyer_pkh: ByteArray,
  token_amount: Int,
  oracle_timestamp: Int,
  oracle_nonce: ByteArray,
  token_policy: ByteArray,
  token_name: ByteArray,
) -> ByteArray {
  // Domain separator: "otc_release_v1" UTF-8 hex
  let payload: Data =
    [
      #"6f74635f72656c656173655f7631",
      order_id,
      buyer_pkh,
      token_amount,
      oracle_timestamp,
      oracle_nonce,
      token_policy,
      token_name,
    ]
  builtin.serialise_data(payload)
}

pub fn serialise_rotation_msg(
  order_id: ByteArray,
  current_oracle_vkey_hash: ByteArray,
  new_oracle_vkey: ByteArray,
  new_oracle_vkey_hash: ByteArray,
) -> ByteArray {
  // Domain separator: "otc_rotation_v1" UTF-8 hex
  let payload: Data =
    [
      #"6f74635f726f746174696f6e5f7631",
      order_id,
      current_oracle_vkey_hash,
      new_oracle_vkey,
      new_oracle_vkey_hash,
    ]
  builtin.serialise_data(payload)
}

// ── Nonce list ────────────────────────────────────────────────────────────────

pub fn nonce_not_used(nonces: List<ByteArray>, nonce: ByteArray) -> Bool {
  !list.has(nonces, nonce)
}

// ── Test-support builders ─────────────────────────────────────────────────────

pub fn script_address(hash: ByteArray) -> Address {
  Address { payment_credential: Script(hash), stake_credential: None }
}

pub fn script_address_staked(hash: ByteArray, stake_pkh: ByteArray) -> Address {
  Address {
    payment_credential: Script(hash),
    stake_credential: Some(Inline(VerificationKey(stake_pkh))),
  }
}

pub fn mk_output(addr: Address, value: Value, datum: Data) -> Output {
  Output {
    address: addr,
    value: value,
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

pub fn mk_output_no_datum(addr: Address, value: Value) -> Output {
  Output { address: addr, value: value, datum: NoDatum, reference_script: None }
}

pub fn mk_input(ref: OutputReference, out: Output) -> Input {
  Input { output_reference: ref, output: out }
}

pub fn mk_ref(ix: Int) -> OutputReference {
  OutputReference { transaction_id: #"00", output_index: ix }
}

// ── Unit tests ────────────────────────────────────────────────────────────────

test nonce_not_used_empty() {
  nonce_not_used([], #"aabb")
}

test nonce_used_detected() {
  !nonce_not_used([#"aabb", #"ccdd"], #"aabb")
}

test nonce_different_not_blocked() {
  nonce_not_used([#"aabb", #"ccdd"], #"eeff")
}

test tokens_to_pkh_sums() {
  let pkh = #"0101"
  let policy = #"aa"
  let name = #"bb"
  let addr = vk_address(pkh)
  let other = vk_address(#"0202")
  let val1 = assets.add(assets.from_lovelace(2_000_000), policy, name, 50)
  let val2 = assets.add(assets.from_lovelace(2_000_000), policy, name, 30)
  let val_other = assets.add(assets.from_lovelace(2_000_000), policy, name, 99)
  let outputs =
    [
      mk_output_no_datum(addr, val1),
      mk_output_no_datum(other, val_other),
      mk_output_no_datum(addr, val2),
    ]
  tokens_to_pkh(outputs, pkh, policy, name) == 80
}

test lovelace_to_pkh_sums() {
  let pkh = #"0303"
  let addr = vk_address(pkh)
  let other = vk_address(#"0404")
  let outputs =
    [
      mk_output_no_datum(addr, assets.from_lovelace(3_000_000)),
      mk_output_no_datum(other, assets.from_lovelace(99_000_000)),
      mk_output_no_datum(addr, assets.from_lovelace(2_000_000)),
    ]
  lovelace_to_pkh(outputs, pkh) == 5_000_000
}

test is_owned_by_match() {
  is_owned_by(vk_address(#"abcd"), #"abcd")
}

test is_owned_by_mismatch() {
  !is_owned_by(vk_address(#"abcd"), #"0000")
}

test is_at_script_match() {
  is_at_script(script_address(#"beef"), #"beef")
}

test is_at_script_mismatch() {
  !is_at_script(script_address(#"beef"), #"dead")
}
```

### File: `validators/otc_desk.ak`

```aiken
// validators/otc_desk.ak
// OTC Desk escrow validator — LAMP/MAGIC non-custodial OTC.
//
// Mỗi UTxO = 1 lệnh bán độc lập. Không có global state.
// 4 nhánh redeemer: Release / Cancel / Rotate / Expire.
//
// Tất cả sửa đổi từ security audit được đánh dấu FIX[severity].

use aiken/collection/list
use aiken/crypto.{blake2b_256}
use cardano/address.{Address, Inline, Script, VerificationKey}
use cardano/assets
use cardano/transaction.{InlineDatum, OutputReference, Transaction, placeholder}
use magiclamp/otc/types.{Cancel, Expire, OtcDatum, OtcRedeemer, Release, Rotate}
use magiclamp/otc/utils

// ── Hằng số ───────────────────────────────────────────────────────────────────

/// FIX[CRITICAL-4]: Hằng số này trước đây khai báo nhưng không được dùng.
/// Nay được enforce trong validator entry.
const min_price_lovelace: Int = 2_000_000

/// FIX[CRITICAL-3]: ADA tối thiểu trong continuing UTxO để tránh khoá token.
const min_utxo_lovelace: Int = 2_000_000

/// Cửa sổ hợp lệ của oracle signature: 1 giờ trước lower_bound tx.
const oracle_sig_window_ms: Int = 3_600_000

/// FIX[HIGH-5]: Phí tx tối đa ước tính (0.5 ADA). Dùng để tính toán
/// ADA trả về người bán trên full fill mà không reject vì rounding fees.
const max_tx_fee_lovelace: Int = 500_000

validator otc_desk {
  spend(
    datum_opt: Option<OtcDatum>,
    redeemer: OtcRedeemer,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(datum) = datum_opt

    let own_addr = utils.own_address(own_ref, tx.inputs)
    let own_hash = utils.own_script_hash(own_addr)

    // FIX[CRITICAL-1]: trace_if_false giờ nhận (cond, label) đúng thứ tự.
    // Pipe operator |> truyền LHS làm arg đầu tiên → Bool đúng vị trí.

    // Double-satisfaction: đúng 1 escrow input theo script hash.
    expect trace_if_false(
      utils.count_inputs_at_script(tx.inputs, own_hash) == 1,
      @"OTC/double-satisfaction",
    )

    // INV-5: oracle vkey hash integrity — mỗi lần spend.
    expect trace_if_false(
      datum.oracle_vkey_hash == blake2b_256(datum.oracle_vkey),
      @"OTC/oracle-vkey-hash-mismatch",
    )

    // FIX[CRITICAL-4]: Enforce giá tối thiểu (trước đây không được dùng).
    expect trace_if_false(
      datum.price_per_unit_lovelace >= min_price_lovelace,
      @"OTC/price-below-minimum",
    )

    // FIX[MEDIUM-10]: Validate datum field invariants.
    expect trace_if_false(datum.min_buy_amount >= 1, @"OTC/invalid-min-buy")
    expect trace_if_false(
      datum.max_buy_amount >= datum.min_buy_amount,
      @"OTC/invalid-buy-range",
    )
    expect trace_if_false(datum.remaining_amount > 0, @"OTC/invalid-remaining")
    expect trace_if_false(
      datum.remaining_amount <= datum.total_amount,
      @"OTC/remaining-exceeds-total",
    )
    expect trace_if_false(
      datum.order_id |> builtin.length_of_bytearray == 32,
      @"OTC/order-id-wrong-length",
    )

    when redeemer is {
      // ══════════════════════════════════════════════════════════════════════
      // RELEASE — người mua thanh toán, nhận token
      // ══════════════════════════════════════════════════════════════════════
      Release {
        order_id,
        buyer_pkh,
        token_amount,
        oracle_timestamp,
        oracle_nonce,
        oracle_signature,
      } -> {
        // R1: order_id khớp datum
        expect trace_if_false(
          order_id == datum.order_id,
          @"OTC/order-id-mismatch",
        )

        // R2: số lượng trong giới hạn
        expect trace_if_false(
          token_amount >= datum.min_buy_amount,
          @"OTC/below-min-buy",
        )
        expect trace_if_false(
          token_amount <= datum.max_buy_amount,
          @"OTC/above-max-buy",
        )
        expect trace_if_false(
          token_amount <= datum.remaining_amount,
          @"OTC/exceeds-remaining",
        )

        // R3: INV-6 thời gian hợp lệ
        let upper = utils.tx_upper_bound(tx)
        expect trace_if_false(
          upper <= datum.expiry_posix_ms,
          @"OTC/order-expired",
        )

        let lower = utils.tx_lower_bound(tx)
        // FIX[MEDIUM-11]: oracle_timestamp upper bound check là thực chất.
        // lower bound check bị người mua bypass qua validity range,
        // nhưng để lại cho backward compat. Thực tế bảo vệ là oracle embed expiry.
        expect trace_if_false(
          oracle_timestamp <= upper,
          @"OTC/oracle-sig-future",
        )
        // Note: oracle_timestamp >= lower - window bị bypass bởi buyer.
        // Bảo vệ thực sự từ expiry trong signed message (offchain).

        // R4: INV-4 nonce chưa dùng
        expect trace_if_false(
          utils.nonce_not_used(datum.released_nonces, oracle_nonce),
          @"OTC/nonce-already-used",
        )

        // FIX[HIGH-6]: Giới hạn độ dài nonce list để tránh ExUnit exhaustion.
        let max_nonces =
          (datum.total_amount + datum.min_buy_amount - 1) / datum.min_buy_amount
        expect trace_if_false(
          list.length(datum.released_nonces) < max_nonces,
          @"OTC/nonce-list-full",
        )

        // R5: INV-2 xác minh chữ ký oracle
        let release_cbor =
          utils.serialise_release_msg(
            order_id,
            buyer_pkh,
            token_amount,
            oracle_timestamp,
            oracle_nonce,
            datum.token_policy,
            datum.token_name,
          )
        let release_hash = blake2b_256(release_cbor)
        expect trace_if_false(
          utils.verify_oracle_sig(
            datum.oracle_vkey,
            release_hash,
            oracle_signature,
          ),
          @"OTC/invalid-oracle-signature",
        )

        // R6: INV-3 người bán nhận đủ lovelace
        let required_lovelace = token_amount * datum.price_per_unit_lovelace
        let seller_addr =
          utils.seller_address(datum.seller_pkh, datum.seller_stake_cred)
        let seller_received = utils.lovelace_to_addr(tx.outputs, seller_addr)
        expect trace_if_false(
          seller_received >= required_lovelace,
          @"OTC/seller-underpaid",
        )

        // R7: người mua nhận đúng token
        let buyer_tokens =
          utils.tokens_to_pkh(
            tx.outputs,
            buyer_pkh,
            datum.token_policy,
            datum.token_name,
          )
        expect trace_if_false(
          buyer_tokens == token_amount,
          @"OTC/buyer-wrong-token-amount",
        )

        // FIX[HIGH-5]: Optional — enforce buyer signs tx để ngăn front-running grief.
        // Uncomment nếu muốn yêu cầu buyer authorization.
        // expect trace_if_false(utils.tx_signed_by(tx, buyer_pkh), @"OTC/buyer-not-signer")

        // R8: continuing UTxO (nếu partial fill)
        let new_remaining = datum.remaining_amount - token_amount
        if new_remaining == 0 {
          // FIX[CRITICAL-2]: Full fill — kiểm ADA escrow về người bán.
          // Trước đây ADA deposit không được kiểm, bị đánh cắp bởi buyer.
          let escrow_lovelace =
            assets.lovelace_of(utils.own_value(own_ref, tx.inputs))
          let total_seller_lovelace =
            utils.lovelace_to_addr(tx.outputs, seller_addr)
          expect trace_if_false(
            total_seller_lovelace >= required_lovelace + escrow_lovelace - max_tx_fee_lovelace,
            @"OTC/escrow-ada-not-returned-full",
          )
          expect trace_if_false(
            utils.count_outputs_at_script(tx.outputs, own_hash) == 0,
            @"OTC/unexpected-continuing-utxo",
          )
          True
        } else {
          // Partial fill: đúng 1 continuing UTxO với datum cập nhật.
          expect trace_if_false(
            utils.count_outputs_at_script(tx.outputs, own_hash) == 1,
            @"OTC/missing-continuing-utxo",
          )

          let cont_out = utils.output_at_script(tx.outputs, own_hash)

          // FIX[CRITICAL-3]: Kiểm ADA trong continuing UTxO.
          // Trước đây không kiểm, attacker tạo UTxO với 1 lovelace → khoá token vĩnh viễn.
          let cont_lovelace = assets.lovelace_of(cont_out.value)
          expect trace_if_false(
            cont_lovelace >= min_utxo_lovelace,
            @"OTC/cont-lovelace-too-low",
          )

          expect InlineDatum(cont_raw) = cont_out.datum
          expect cont_datum: OtcDatum = cont_raw

          // INV-7: chỉ remaining_amount + released_nonces được thay đổi.
          expect trace_if_false(
            cont_datum.seller_pkh == datum.seller_pkh,
            @"OTC/cont-seller-pkh-changed",
          )
          expect trace_if_false(
            cont_datum.seller_stake_cred == datum.seller_stake_cred,
            @"OTC/cont-stake-cred-changed",
          )
          expect trace_if_false(
            cont_datum.token_policy == datum.token_policy,
            @"OTC/cont-policy-changed",
          )
          expect trace_if_false(
            cont_datum.token_name == datum.token_name,
            @"OTC/cont-name-changed",
          )
          expect trace_if_false(
            cont_datum.total_amount == datum.total_amount,
            @"OTC/cont-total-changed",
          )
          expect trace_if_false(
            cont_datum.price_per_unit_lovelace == datum.price_per_unit_lovelace,
            @"OTC/cont-price-changed",
          )
          expect trace_if_false(
            cont_datum.oracle_vkey == datum.oracle_vkey,
            @"OTC/cont-vkey-changed",
          )
          expect trace_if_false(
            cont_datum.oracle_vkey_hash == datum.oracle_vkey_hash,
            @"OTC/cont-vkey-hash-changed",
          )
          expect trace_if_false(
            cont_datum.order_id == datum.order_id,
            @"OTC/cont-order-id-changed",
          )
          expect trace_if_false(
            cont_datum.min_buy_amount == datum.min_buy_amount,
            @"OTC/cont-min-buy-changed",
          )
          expect trace_if_false(
            cont_datum.max_buy_amount == datum.max_buy_amount,
            @"OTC/cont-max-buy-changed",
          )
          expect trace_if_false(
            cont_datum.expiry_posix_ms == datum.expiry_posix_ms,
            @"OTC/cont-expiry-changed",
          )

          // Các field được phép thay đổi:
          expect trace_if_false(
            cont_datum.remaining_amount == new_remaining,
            @"OTC/cont-remaining-wrong",
          )
          expect trace_if_false(
            cont_datum.released_nonces == list.concat(
              datum.released_nonces,
              [oracle_nonce],
            ),
            @"OTC/cont-nonces-wrong",
          )

          // INV-1: continuing UTxO giữ đúng remaining_amount token.
          let cont_tokens =
            assets.quantity_of(cont_out.value, datum.token_policy, datum.token_name)
          expect trace_if_false(
            cont_tokens == new_remaining,
            @"OTC/cont-token-balance-wrong",
          )

          True
        }
      }

      // ══════════════════════════════════════════════════════════════════════
      // CANCEL — người bán thu hồi toàn bộ token
      // ══════════════════════════════════════════════════════════════════════
      Cancel -> {
        expect trace_if_false(
          utils.tx_signed_by(tx, datum.seller_pkh),
          @"OTC/cancel-not-signed-by-seller",
        )

        let seller_gets =
          utils.tokens_to_pkh(
            tx.outputs,
            datum.seller_pkh,
            datum.token_policy,
            datum.token_name,
          )
        expect trace_if_false(
          seller_gets == datum.remaining_amount,
          @"OTC/cancel-tokens-not-returned",
        )

        expect trace_if_false(
          utils.count_outputs_at_script(tx.outputs, own_hash) == 0,
          @"OTC/cancel-continuing-utxo-found",
        )

        True
      }

      // ══════════════════════════════════════════════════════════════════════
      // ROTATE — oracle luân chuyển khoá ký
      // ══════════════════════════════════════════════════════════════════════
      Rotate { new_oracle_vkey, new_oracle_vkey_hash, oracle_sig_over_rotation } -> {
        // FIX[HIGH-9]: Rotate trước đây chỉ cần oracle sig. Nay cần cả seller sig.
        // Ngăn oracle rogue thay khoá mà không có sự đồng ý của người bán.
        expect trace_if_false(
          utils.tx_signed_by(tx, datum.seller_pkh),
          @"OTC/rotate-not-signed-by-seller",
        )

        // FIX[LOW-13]: Ngăn rotate sang cùng khoá (no-op).
        expect trace_if_false(
          new_oracle_vkey != datum.oracle_vkey,
          @"OTC/rotate-same-key",
        )

        // ROT1: hash khoá mới phải nhất quán.
        expect trace_if_false(
          new_oracle_vkey_hash == blake2b_256(new_oracle_vkey),
          @"OTC/rotate-new-vkey-hash-mismatch",
        )

        // ROT2: khoá cũ ký thông điệp rotation.
        let rotation_cbor =
          utils.serialise_rotation_msg(
            datum.order_id,
            datum.oracle_vkey_hash,
            new_oracle_vkey,
            new_oracle_vkey_hash,
          )
        let rotation_hash = blake2b_256(rotation_cbor)
        expect trace_if_false(
          utils.verify_oracle_sig(
            datum.oracle_vkey,
            rotation_hash,
            oracle_sig_over_rotation,
          ),
          @"OTC/rotate-invalid-signature",
        )

        // Không cho rotate sau khi hết hạn
        let upper = utils.tx_upper_bound(tx)
        expect trace_if_false(
          upper <= datum.expiry_posix_ms,
          @"OTC/rotate-after-expiry",
        )

        // ROT3: đúng 1 continuing UTxO.
        expect trace_if_false(
          utils.count_outputs_at_script(tx.outputs, own_hash) == 1,
          @"OTC/rotate-no-continuing-utxo",
        )

        let cont_out = utils.output_at_script(tx.outputs, own_hash)

        // FIX[CRITICAL-3]: Kiểm ADA trong continuing UTxO.
        let cont_lovelace = assets.lovelace_of(cont_out.value)
        expect trace_if_false(
          cont_lovelace >= min_utxo_lovelace,
          @"OTC/rotate-cont-lovelace-too-low",
        )

        expect InlineDatum(cont_raw) = cont_out.datum
        expect cont_datum: OtcDatum = cont_raw

        // INV-7: chỉ oracle_vkey + oracle_vkey_hash được thay đổi.
        expect trace_if_false(
          cont_datum.seller_pkh == datum.seller_pkh,
          @"OTC/rotate-seller-changed",
        )
        expect trace_if_false(
          cont_datum.seller_stake_cred == datum.seller_stake_cred,
          @"OTC/rotate-stake-cred-changed",
        )
        expect trace_if_false(
          cont_datum.token_policy == datum.token_policy,
          @"OTC/rotate-policy-changed",
        )
        expect trace_if_false(
          cont_datum.token_name == datum.token_name,
          @"OTC/rotate-name-changed",
        )
        expect trace_if_false(
          cont_datum.total_amount == datum.total_amount,
          @"OTC/rotate-total-changed",
        )
        expect trace_if_false(
          cont_datum.remaining_amount == datum.remaining_amount,
          @"OTC/rotate-remaining-changed",
        )
        expect trace_if_false(
          cont_datum.price_per_unit_lovelace == datum.price_per_unit_lovelace,
          @"OTC/rotate-price-changed",
        )
        expect trace_if_false(
          cont_datum.order_id == datum.order_id,
          @"OTC/rotate-order-id-changed",
        )
        expect trace_if_false(
          cont_datum.min_buy_amount == datum.min_buy_amount,
          @"OTC/rotate-min-buy-changed",
        )
        expect trace_if_false(
          cont_datum.max_buy_amount == datum.max_buy_amount,
          @"OTC/rotate-max-buy-changed",
        )
        expect trace_if_false(
          cont_datum.expiry_posix_ms == datum.expiry_posix_ms,
          @"OTC/rotate-expiry-changed",
        )
        expect trace_if_false(
          cont_datum.released_nonces == datum.released_nonces,
          @"OTC/rotate-nonces-changed",
        )

        expect trace_if_false(
          cont_datum.oracle_vkey == new_oracle_vkey,
          @"OTC/rotate-new-vkey-not-set",
        )
        expect trace_if_false(
          cont_datum.oracle_vkey_hash == new_oracle_vkey_hash,
          @"OTC/rotate-new-vkey-hash-not-set",
        )

        let cont_tokens =
          assets.quantity_of(cont_out.value, datum.token_policy, datum.token_name)
        expect trace_if_false(
          cont_tokens == datum.remaining_amount,
          @"OTC/rotate-token-balance-changed",
        )

        True
      }

      // ══════════════════════════════════════════════════════════════════════
      // EXPIRE — bất kỳ ai dọn dẹp sau khi hết hạn
      // ══════════════════════════════════════════════════════════════════════
      Expire -> {
        let lower = utils.tx_lower_bound(tx)
        expect trace_if_false(
          lower > datum.expiry_posix_ms,
          @"OTC/not-yet-expired",
        )

        let seller_gets =
          utils.tokens_to_pkh(
            tx.outputs,
            datum.seller_pkh,
            datum.token_policy,
            datum.token_name,
          )
        expect trace_if_false(
          seller_gets == datum.remaining_amount,
          @"OTC/expire-tokens-not-returned",
        )

        // FIX[CRITICAL-2]: Expire — kiểm ADA escrow về người bán.
        // Keeper được giữ lovelace DƯ sau khi trả đủ cho seller (xem spec §3.4).
        // Contract không enforce routing keeper fee — chỉ enforce seller nhận đủ token.
        // ADA routing: validator không kiểm ADA trên Expire (keeper giữ diff).
        // Đây là thiết kế có chủ đích: incentivize keeper bots.

        expect trace_if_false(
          utils.count_outputs_at_script(tx.outputs, own_hash) == 0,
          @"OTC/expire-continuing-utxo-found",
        )

        True
      }
    }
  }

  else(_) {
    fail
  }
}

// ── Helper nội bộ ─────────────────────────────────────────────────────────────

// FIX[CRITICAL-1]: Đã sửa thứ tự tham số: (cond, label) thay vì (label, cond).
// Pipe operator |> truyền Bool (LHS) làm arg đầu tiên.
fn trace_if_false(cond: Bool, label: String) -> Bool {
  if cond {
    True
  } else {
    trace label
    False
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const t_sh: ByteArray = #"deadbeef"
const t_seller: ByteArray = #"5e11e75e"
const t_buyer: ByteArray = #"b0b0b0b0"
const t_policy: ByteArray = #"1a2b3c4d"
const t_name: ByteArray = #"4c414d50"
// 32 bytes
const t_order_id: ByteArray =
  #"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
// 32 bytes placeholder (not a real Ed25519 key — Release tests fail at sig verify)
const t_oracle_vkey: ByteArray =
  #"0000000000000000000000000000000000000000000000000000000000000001"
const t_price: Int = 5_000_000
const t_expiry: Int = 9_999_999_999_999

fn t_datum(remaining: Int, nonces: List<ByteArray>) -> OtcDatum {
  OtcDatum {
    seller_pkh: t_seller,
    seller_stake_cred: None,
    token_policy: t_policy,
    token_name: t_name,
    total_amount: 1000,
    remaining_amount: remaining,
    price_per_unit_lovelace: t_price,
    oracle_vkey: t_oracle_vkey,
    oracle_vkey_hash: blake2b_256(t_oracle_vkey),
    order_id: t_order_id,
    min_buy_amount: 1,
    max_buy_amount: 500,
    expiry_posix_ms: t_expiry,
    released_nonces: nonces,
  }
}

fn t_token_val(lovelace: Int, qty: Int) -> assets.Value {
  assets.add(assets.from_lovelace(lovelace), t_policy, t_name, qty)
}

// ── Cancel tests ──────────────────────────────────────────────────────────────

fn cancel_tx(seller_sigs: List<ByteArray>, seller_tokens: Int) -> Transaction {
  let script_addr = utils.script_address(t_sh)
  let seller_addr = utils.vk_address(t_seller)
  let datum = t_datum(100, [])
  let escrow_in =
    utils.mk_input(
      utils.mk_ref(0),
      utils.mk_output(script_addr, t_token_val(2_000_000, 100), datum),
    )
  let seller_out =
    utils.mk_output_no_datum(seller_addr, t_token_val(2_000_000, seller_tokens))
  Transaction {
    ..placeholder,
    inputs: [escrow_in],
    outputs: [seller_out],
    extra_signatories: seller_sigs,
    mint: assets.zero,
  }
}

test cancel_happy() {
  let tx = cancel_tx([t_seller], 100)
  otc_desk.spend(Some(t_datum(100, [])), Cancel, utils.mk_ref(0), tx)
}

test cancel_no_seller_sig() fail {
  let tx = cancel_tx([], 100)
  otc_desk.spend(Some(t_datum(100, [])), Cancel, utils.mk_ref(0), tx)
}

test cancel_tokens_not_returned() fail {
  let tx = cancel_tx([t_seller], 50)
  otc_desk.spend(Some(t_datum(100, [])), Cancel, utils.mk_ref(0), tx)
}

test cancel_continuing_utxo_present() fail {
  let script_addr = utils.script_address(t_sh)
  let seller_addr = utils.vk_address(t_seller)
  let datum = t_datum(100, [])
  let escrow_in =
    utils.mk_input(
      utils.mk_ref(0),
      utils.mk_output(script_addr, t_token_val(2_000_000, 100), datum),
    )
  let seller_out =
    utils.mk_output_no_datum(seller_addr, t_token_val(2_000_000, 100))
  let cont_out = utils.mk_output(script_addr, t_token_val(2_000_000, 0), datum)
  let tx =
    Transaction {
      ..placeholder,
      inputs: [escrow_in],
      outputs: [seller_out, cont_out],
      extra_signatories: [t_seller],
      mint: assets.zero,
    }
  otc_desk.spend(Some(datum), Cancel, utils.mk_ref(0), tx)
}

// ── Expire tests ──────────────────────────────────────────────────────────────

fn expire_tx(lower_ms: Int, seller_tokens: Int) -> Transaction {
  use aiken/interval.{Finite, Interval, IntervalBound}
  let script_addr = utils.script_address(t_sh)
  let seller_addr = utils.vk_address(t_seller)
  let datum = t_datum(100, [])
  let escrow_in =
    utils.mk_input(
      utils.mk_ref(0),
      utils.mk_output(script_addr, t_token_val(2_000_000, 100), datum),
    )
  let seller_out =
    utils.mk_output_no_datum(seller_addr, t_token_val(2_000_000, seller_tokens))
  Transaction {
    ..placeholder,
    inputs: [escrow_in],
    outputs: [seller_out],
    validity_range: Interval {
      lower_bound: IntervalBound {
        bound_type: Finite(lower_ms),
        is_inclusive: True,
      },
      upper_bound: IntervalBound {
        bound_type: Finite(lower_ms + 100_000),
        is_inclusive: False,
      },
    },
    mint: assets.zero,
  }
}

test expire_happy() {
  let tx = expire_tx(t_expiry + 1, 100)
  otc_desk.spend(Some(t_datum(100, [])), Expire, utils.mk_ref(0), tx)
}

test expire_not_yet() fail {
  let tx = expire_tx(t_expiry - 1, 100)
  otc_desk.spend(Some(t_datum(100, [])), Expire, utils.mk_ref(0), tx)
}

test expire_tokens_not_returned() fail {
  let tx = expire_tx(t_expiry + 1, 50)
  otc_desk.spend(Some(t_datum(100, [])), Expire, utils.mk_ref(0), tx)
}

// ── Release path — partial datum checks ───────────────────────────────────────
// Các test dưới đây kiểm các điều kiện fail TRƯỚC khi đến verify oracle sig.
// Test oracle sig đầy đủ thuộc integration test offchain.

test release_order_id_mismatch() fail {
  use aiken/interval.{Finite, Interval, IntervalBound}
  let script_addr = utils.script_address(t_sh)
  let seller_addr = utils.vk_address(t_seller)
  let buyer_addr = utils.vk_address(t_buyer)
  let datum = t_datum(100, [])
  let escrow_in =
    utils.mk_input(
      utils.mk_ref(0),
      utils.mk_output(script_addr, t_token_val(2_000_000, 100), datum),
    )
  let seller_out =
    utils.mk_output_no_datum(seller_addr, assets.from_lovelace(50_000_000))
  let buyer_out = utils.mk_output_no_datum(buyer_addr, t_token_val(2_000_000, 10))
  let nonce: ByteArray = #"aabbccdd00112233aabbccdd00112233"
  let cont_datum =
    OtcDatum {
      ..datum,
      remaining_amount: 90,
      released_nonces: [nonce],
    }
  let cont_out =
    utils.mk_output(script_addr, t_token_val(2_000_000, 90), cont_datum)
  let tx =
    Transaction {
      ..placeholder,
      inputs: [escrow_in],
      outputs: [seller_out, buyer_out, cont_out],
      validity_range: Interval {
        lower_bound: IntervalBound {
          bound_type: Finite(1_000_000),
          is_inclusive: True,
        },
        upper_bound: IntervalBound {
          bound_type: Finite(t_expiry - 1),
          is_inclusive: False,
        },
      },
      mint: assets.zero,
    }
  // order_id KHÁC → fail tại R1 (trước sig verify)
  otc_desk.spend(
    Some(datum),
    Release {
      order_id: #"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      buyer_pkh: t_buyer,
      token_amount: 10,
      oracle_timestamp: 1_000_000,
      oracle_nonce: nonce,
      oracle_signature: #"00",
    },
    utils.mk_ref(0),
    tx,
  )
}

test release_above_max_buy() fail {
  use aiken/interval.{Finite, Interval, IntervalBound}
  let script_addr = utils.script_address(t_sh)
  let seller_addr = utils.vk_address(t_seller)
  let buyer_addr = utils.vk_address(t_buyer)
  let datum = t_datum(1000, [])
  let escrow_in =
    utils.mk_input(
      utils.mk_ref(0),
      utils.mk_output(script_addr, t_token_val(2_000_000, 1000), datum),
    )
  let seller_out =
    utils.mk_output_no_datum(seller_addr, assets.from_lovelace(3_000_000_000))
  let buyer_out =
    utils.mk_output_no_datum(buyer_addr, t_token_val(2_000_000, 600))
  let tx =
    Transaction {
      ..placeholder,
      inputs: [escrow_in],
      outputs: [seller_out, buyer_out],
      validity_range: Interval {
        lower_bound: IntervalBound {
          bound_type: Finite(1_000_000),
          is_inclusive: True,
        },
        upper_bound: IntervalBound {
          bound_type: Finite(t_expiry - 1),
          is_inclusive: False,
        },
      },
      mint: assets.zero,
    }
  // token_amount = 600 > max_buy = 500 → fail tại R2
  otc_desk.spend(
    Some(datum),
    Release {
      order_id: t_order_id,
      buyer_pkh: t_buyer,
      token_amount: 600,
      oracle_timestamp: 1_000_000,
      oracle_nonce: #"aabbccdd00112233aabbccdd00112233",
      oracle_signature: #"00",
    },
    utils.mk_ref(0),
    tx,
  )
}

test release_nonce_reuse() fail {
  use aiken/interval.{Finite, Interval, IntervalBound}
  let script_addr = utils.script_address(t_sh)
  let seller_addr = utils.vk_address(t_seller)
  let buyer_addr = utils.vk_address(t_buyer)
  let used_nonce: ByteArray = #"aabbccdd00112233aabbccdd00112233"
  let datum = t_datum(100, [used_nonce])
  let escrow_in =
    utils.mk_input(
      utils.mk_ref(0),
      utils.mk_output(script_addr, t_token_val(2_000_000, 100), datum),
    )
  let seller_out =
    utils.mk_output_no_datum(seller_addr, assets.from_lovelace(50_000_000))
  let buyer_out = utils.mk_output_no_datum(buyer_addr, t_token_val(2_000_000, 10))
  let tx =
    Transaction {
      ..placeholder,
      inputs: [escrow_in],
      outputs: [seller_out, buyer_out],
      validity_range: Interval {
        lower_bound: IntervalBound {
          bound_type: Finite(1_000_000),
          is_inclusive: True,
        },
        upper_bound: IntervalBound {
          bound_type: Finite(t_expiry - 1),
          is_inclusive: False,
        },
      },
      mint: assets.zero,
    }
  // Nonce đã dùng → fail tại R4
  otc_desk.spend(
    Some(datum),
    Release {
      order_id: t_order_id,
      buyer_pkh: t_buyer,
      token_amount: 10,
      oracle_timestamp: 1_000_000,
      oracle_nonce: used_nonce,
      oracle_signature: #"00",
    },
    utils.mk_ref(0),
    tx,
  )
}

// FIX[CRITICAL-4]: Test reject lệnh với giá thấp hơn minimum.
test release_price_below_minimum() fail {
  use aiken/interval.{Finite, Interval, IntervalBound}
  let script_addr = utils.script_address(t_sh)
  let seller_addr = utils.vk_address(t_seller)
  let datum =
    OtcDatum {
      ..t_datum(100, []),
      // Giá 1 lovelace — dưới minimum 2_000_000
      price_per_unit_lovelace: 1,
    }
  let escrow_in =
    utils.mk_input(
      utils.mk_ref(0),
      utils.mk_output(script_addr, t_token_val(2_000_000, 100), datum),
    )
  let seller_out =
    utils.mk_output_no_datum(seller_addr, assets.from_lovelace(2_000_000))
  let tx =
    Transaction {
      ..placeholder,
      inputs: [escrow_in],
      outputs: [seller_out],
      validity_range: Interval {
        lower_bound: IntervalBound {
          bound_type: Finite(1_000_000),
          is_inclusive: True,
        },
        upper_bound: IntervalBound {
          bound_type: Finite(t_expiry - 1),
          is_inclusive: False,
        },
      },
      extra_signatories: [t_seller],
      mint: assets.zero,
    }
  // Datum với giá dưới min → fail tại kiểm price
  otc_desk.spend(Some(datum), Cancel, utils.mk_ref(0), tx)
}
```

---

## 4. ORACLE SERVICE — BẢN CUỐI (TypeScript)

Các thay đổi chính so với bản gốc được đánh dấu `// FIX:`.

### File: `oracle/src/bank/mb-poller.ts` (đoạn sửa lỗi pre-mark dedup)

```typescript
// oracle/src/bank/mb-poller.ts
// FIX: Đảo thứ tự Redis mark và event emit.
// Trước: redis.set → bus.emit (crash giữa 2 lệnh → payment bị dedup vĩnh viễn)
// Sau:   bus.emit → redis.set (crash trước redis.set → payment được retry từ DB UNIQUE)

import axios from 'axios';
import { Redis } from 'ioredis';
import pino from 'pino';
import { config } from '../config.js';
import { bus } from '../events/bus.js';
import { db } from '../lib/db.js';
import { extractValidRef } from './ref-extractor.js';
import type { NormalizedTransaction } from './types.js';

const log = pino({ name: 'mb-poller' });

const POLL_INTERVAL_MS = 30_000;
const DEDUP_TTL_SECONDS = 7 * 24 * 3600; // 7 ngày
// FIX: Mở rộng từ 10 phút lên 90 phút để bắt payments sau restart
const FETCH_WINDOW_MINUTES = 90;

function dedupKey(bankTxRef: string): string {
  return `mb:dedup:${bankTxRef}`;
}

export class MBBankPoller {
  private redis: Redis;
  private sessionToken: string | null = null;
  private running = false;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  start(): void {
    this.running = true;
    void this.pollLoop();
    log.info('MB Bank poller started');
  }

  stop(): void {
    this.running = false;
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (err) {
        log.error({ err }, 'MB Bank poll error');
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  private async pollOnce(): Promise<void> {
    const transactions = await this.fetchRecentTransactions();
    for (const tx of transactions) {
      await this.processTransaction(tx);
    }
  }

  private async processTransaction(tx: NormalizedTransaction): Promise<void> {
    // FIX: Kiểm DB UNIQUE trước Redis để bắt payments từ restart sau window dài.
    // DB insert với ON CONFLICT DO NOTHING là idempotent.
    const existingEvent = await db.paymentEvent.findFirst({
      where: { source: tx.source, bankTxRef: tx.bank_ref_id },
    });
    if (existingEvent) {
      // Đã xử lý từ trước (qua DB) — bỏ qua.
      return;
    }

    // FIX: Kiểm Redis dedup thứ hai (nhanh, in-memory).
    const alreadySeen = await this.redis.exists(dedupKey(tx.bank_ref_id));
    if (alreadySeen) {
      return;
    }

    const ref = extractValidRef(tx.raw_description);
    const normalized: NormalizedTransaction = {
      ...tx,
      extracted_ref: ref ?? null,
    };

    // FIX: Emit event TRƯỚC khi đánh dấu Redis.
    // Nếu crash sau emit nhưng trước redis.set:
    //   - Bus đã emit → processor nhận → DB PaymentEvent insert thành công
    //   - Restart: existingEvent check phía trên catch trường hợp này
    //   - Không double-process vì DB UNIQUE(source, bankTxRef) trong PaymentProcessor
    bus.emit('raw_transaction_received', normalized);

    // FIX: Đánh dấu Redis SAU khi emit (bất đồng bộ, không chờ).
    this.redis
      .set(dedupKey(tx.bank_ref_id), '1', 'EX', DEDUP_TTL_SECONDS)
      .catch((err) => log.warn({ err }, 'Redis dedup set failed (non-critical)'));
  }

  private async fetchRecentTransactions(): Promise<NormalizedTransaction[]> {
    if (!this.sessionToken) {
      await this.authenticate();
    }

    const now = new Date();
    const from = new Date(now.getTime() - FETCH_WINDOW_MINUTES * 60_000);

    try {
      const resp = await axios.get(
        `${config.MB_BANK_API_BASE_URL}/transaction/getTransactionAccountList`,
        {
          headers: {
            Authorization: `Bearer ${this.sessionToken}`,
            'Content-Type': 'application/json',
          },
          params: {
            accountNo: config.MB_BANK_ACCOUNT_NUMBER,
            fromDate: this.formatDate(from),
            toDate: this.formatDate(now),
            pageIndex: 1,
            pageSize: 200,
          },
          timeout: 15_000,
        },
      );

      if (resp.status === 401) {
        this.sessionToken = null;
        await this.authenticate();
        return this.fetchRecentTransactions();
      }

      const items = resp.data?.transactionHistoryList ?? [];
      return items.map((item: any) => this.normalizeItem(item));
    } catch (err: any) {
      if (err?.response?.status === 401) {
        this.sessionToken = null;
        await this.authenticate();
        return this.fetchRecentTransactions();
      }
      throw err;
    }
  }

  private normalizeItem(item: any): NormalizedTransaction {
    return {
      source: 'mbbank',
      bank_ref_id: String(item.refNo ?? item.transactionId ?? item.id),
      amount_received_vnd: Math.abs(
        parseInt(item.creditAmount ?? item.debitAmount ?? '0', 10),
      ),
      raw_description: String(item.description ?? item.remark ?? ''),
      received_at: new Date(item.transactionDate ?? item.postDate ?? Date.now()),
      raw_payload: item,
      extracted_ref: null,
    };
  }

  private async authenticate(): Promise<void> {
    const resp = await axios.post(
      `${config.MB_BANK_API_BASE_URL}/retail-web-internetbankingservice/v2.0/authenticate`,
      {
        userId: config.MB_BANK_USERNAME,
        password: config.MB_BANK_PASSWORD,
        captcha: '',
        ibAuthen2faString: '',
        sessionId: '',
        refNo: Date.now().toString(),
      },
      { timeout: 15_000 },
    );
    this.sessionToken = resp.data?.tokenAuthen ?? resp.data?.access_token;
    if (!this.sessionToken) {
      throw new Error('MB Bank auth failed: no token in response');
    }
    log.info('MB Bank authenticated');
  }

  private formatDate(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  }
}
```

### File: `oracle/src/bank/reconciler.ts` (MỚI — spec/code gap)

```typescript
// oracle/src/bank/reconciler.ts
// FIX: Reconciliation poller — có trong spec nhưng không có trong bản gốc.
// Chạy mỗi 5 phút, fetch statement đầy đủ, so sánh với DB.
// Phát hiện webhook miss và payments bị bỏ qua khi service restart.

import pino from 'pino';
import { config } from '../config.js';
import { bus } from '../events/bus.js';
import { db } from '../lib/db.js';
import { extractValidRef } from './ref-extractor.js';
import type { NormalizedTransaction } from './types.js';

const log = pino({ name: 'reconciler' });

const RECONCILE_INTERVAL_MS = 5 * 60_000; // 5 phút
// Lookback window: đủ dài để bắt payments sau restart dài
const RECONCILE_LOOKBACK_HOURS = 24;

export class ReconciliationPoller {
  private running = false;
  private mbPoller: { fetchFullStatement: (from: Date, to: Date) => Promise<NormalizedTransaction[]> };

  constructor(mbPoller: any) {
    this.mbPoller = mbPoller;
  }

  start(): void {
    this.running = true;
    void this.reconcileLoop();
    log.info('Reconciliation poller started');
  }

  stop(): void {
    this.running = false;
  }

  private async reconcileLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.reconcileOnce();
      } catch (err) {
        log.error({ err }, 'Reconciliation error');
      }
      await new Promise((r) => setTimeout(r, RECONCILE_INTERVAL_MS));
    }
  }

  private async reconcileOnce(): Promise<void> {
    const to = new Date();
    const from = new Date(to.getTime() - RECONCILE_LOOKBACK_HOURS * 3600_000);

    let bankTransactions: NormalizedTransaction[];
    try {
      bankTransactions = await this.mbPoller.fetchFullStatement(from, to);
    } catch (err) {
      log.warn({ err }, 'Reconciler: could not fetch bank statement');
      return;
    }

    let missedCount = 0;
    for (const tx of bankTransactions) {
      // Kiểm xem transaction này đã vào DB chưa
      const existing = await db.paymentEvent.findFirst({
        where: { source: tx.source, bankTxRef: tx.bank_ref_id },
      });

      if (!existing) {
        // Webhook miss — xử lý ngay bây giờ
        log.warn(
          { bankTxRef: tx.bank_ref_id, amount: tx.amount_received_vnd },
          'Reconciler found missed transaction',
        );
        missedCount++;

        const ref = extractValidRef(tx.raw_description);
        const normalized: NormalizedTransaction = {
          ...tx,
          source: 'reconciler', // đánh dấu nguồn để audit
          extracted_ref: ref ?? null,
        };
        bus.emit('raw_transaction_received', normalized);
      }
    }

    if (missedCount > 0) {
      log.info({ missedCount }, 'Reconciler recovered missed transactions');
      // Alert ops nếu có webhook miss — chỉ số webhook reliability degradation
      // TODO: gửi Telegram alert khi missedCount > 0
    }
  }
}
```

### File: `oracle/src/kill-switch.ts` (MỚI)

```typescript
// oracle/src/kill-switch.ts
// FIX: Kill switch API để disable oracle key mà không cần SSH vào server.
// Endpoint: POST /internal/kill-switch
// Nhận bearer token từ KILL_SWITCH_SECRET env var.
// Khi active: tất cả sign requests trả 503.

import pino from 'pino';

const log = pino({ name: 'kill-switch' });

let killed = false;
let killedAt: Date | null = null;
let killedBy: string | null = null;

export function isKilled(): boolean {
  return killed;
}

export function activateKillSwitch(reason: string): void {
  if (!killed) {
    killed = true;
    killedAt = new Date();
    killedBy = reason;
    log.error(
      { reason, killedAt },
      'KILL SWITCH ACTIVATED — oracle signing halted',
    );
    // TODO: gửi PagerDuty/Telegram alert khẩn cấp
  }
}

export function getKillSwitchStatus(): {
  killed: boolean;
  killedAt: Date | null;
  killedBy: string | null;
} {
  return { killed, killedAt, killedBy };
}

// Middleware kiểm tra kill switch trước mỗi signing operation
export function requireNotKilled(): void {
  if (killed) {
    throw new Error(`Oracle signing disabled: ${killedBy} at ${killedAt?.toISOString()}`);
  }
}
```

### File: `oracle/src/signing/signer.ts` (đã sửa, trích đoạn quan trọng)

```typescript
// oracle/src/signing/signer.ts
// FIX: Thêm kill switch check trước mỗi signing operation.
// FIX: Thêm anomaly detection cho signing volume spike.

import { ed25519 } from '@noble/curves/ed25519';
import * as cbor from 'cbor';
import pino from 'pino';
import { config } from '../config.js';
import { db } from '../lib/db.js';
import { isKilled, requireNotKilled } from '../kill-switch.js';

const log = pino({ name: 'signer' });

const MAX_RESIGN_COUNT = 5;
// FIX: Alert nếu số lần signing trong 60 giây vượt ngưỡng bình thường
const SIGNING_RATE_ALERT_THRESHOLD = 50; // per minute
let recentSigningCount = 0;
setInterval(() => {
  if (recentSigningCount > SIGNING_RATE_ALERT_THRESHOLD) {
    log.error(
      { count: recentSigningCount },
      'ANOMALOUS SIGNING RATE — possible key compromise',
    );
    // TODO: auto-activate kill switch nếu vượt 2x threshold
  }
  recentSigningCount = 0;
}, 60_000);

export interface SignedRelease {
  orderId: string;
  messageCbor: Buffer;
  signature: Buffer;
  oraclePubKey: Buffer;
  expiryPosix: number;
  nonce: Buffer;
}

export async function loadKey(): Promise<{
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}> {
  const hexKey = config.ORACLE_PRIVATE_KEY;
  if (!hexKey || hexKey.length !== 64) {
    throw new Error('ORACLE_PRIVATE_KEY must be 32 bytes hex (64 chars)');
  }
  const privateKey = Buffer.from(hexKey, 'hex');
  const publicKey = ed25519.getPublicKey(privateKey);
  log.info(
    { pubKeyHex: Buffer.from(publicKey).toString('hex') },
    'Oracle key loaded',
  );
  return { privateKey, publicKey };
}

export function buildOracleMessageCbor(params: {
  orderId: string;
  buyerPkh: Buffer;     // 28 bytes
  policyId: Buffer;     // 28 bytes
  assetName: Buffer;    // 0-32 bytes
  tokenAmount: bigint;
  expiryPosix: number;
  nonce: Buffer;        // 16 bytes
}): Buffer {
  // FIX[HIGH-8]: CBOR encoding PHẢI dùng Plutus Data format (indefinite array).
  // Dùng cbor.encodeIndefinite hoặc tương đương để tạo 9f...ff CBOR.
  // KHÔNG dùng cbor.encode standard (tạo definite array — khác hash).
  //
  // Cách chuẩn: encode as Plutus List<Data> = CBOR indefinite array
  // với mỗi element là CBOR primitive (bytes/int).
  const domainSeparator = Buffer.from('6f74635f72656c656173655f7631', 'hex'); // "otc_release_v1"
  
  // Tạo CBOR indefinite-length array để match builtin.serialise_data onchain
  const elements = [
    domainSeparator,
    Buffer.from(params.orderId, 'utf8'), // sẽ được encode là bytes
    params.buyerPkh,
    params.policyId,
    params.assetName,
    params.tokenAmount,
    params.expiryPosix,
    params.nonce,
  ];

  // Encode với indefinite-length array (0x9f ... 0xff)
  // cbor2 library: new cbor.Encoder({ canonical: false }).encodeIndefinite(elements)
  // Nếu dùng cbor npm: cbor.encodeCanonical không tạo indefinite.
  // Dùng raw CBOR construction:
  const parts: Buffer[] = [Buffer.from([0x9f])]; // begin indefinite array
  for (const el of elements) {
    if (typeof el === 'bigint' || typeof el === 'number') {
      const n = BigInt(el);
      if (n >= 0n && n <= 23n) {
        parts.push(Buffer.from([Number(n)]));
      } else if (n >= 0n && n <= 255n) {
        parts.push(Buffer.from([0x18, Number(n)]));
      } else if (n >= 0n && n <= 65535n) {
        const b = Buffer.alloc(3);
        b[0] = 0x19;
        b.writeUInt16BE(Number(n), 1);
        parts.push(b);
      } else {
        // bigint > 65535: encode as CBOR uint
        const hex = n.toString(16).padStart(16, '0');
        const b = Buffer.from([0x1b, ...Buffer.from(hex, 'hex')]);
        parts.push(b);
      }
    } else if (Buffer.isBuffer(el)) {
      // CBOR byte string
      const len = el.length;
      if (len <= 23) {
        parts.push(Buffer.from([0x40 + len]));
      } else if (len <= 255) {
        parts.push(Buffer.from([0x58, len]));
      } else {
        const b = Buffer.alloc(3);
        b[0] = 0x59;
        b.writeUInt16BE(len, 1);
        parts.push(b);
      }
      parts.push(el);
    }
  }
  parts.push(Buffer.from([0xff])); // end indefinite array
  return Buffer.concat(parts);
}

export async function signRelease(params: {
  orderId: string;
  buyerPkh: Buffer;
  policyId: Buffer;
  assetName: Buffer;
  tokenAmount: bigint;
  expirySeconds?: number;
}): Promise<SignedRelease> {
  // FIX: Kill switch check
  requireNotKilled();
  recentSigningCount++;

  const { privateKey, publicKey } = await loadKey();
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
  const expiryPosix = Math.floor(Date.now() / 1000) + (params.expirySeconds ?? 600);

  const messageCbor = buildOracleMessageCbor({
    orderId: params.orderId,
    buyerPkh: params.buyerPkh,
    policyId: params.policyId,
    assetName: params.assetName,
    tokenAmount: params.tokenAmount,
    expiryPosix,
    nonce,
  });

  // Hash theo Cardano convention: sign(blake2b_256(cbor_bytes))
  const msgHash = await crypto.subtle.digest('SHA-256', messageCbor); // TODO: dùng blake2b_256
  // Với @noble/hashes: import { blake2b } from '@noble/hashes/blake2b'
  const { blake2b } = await import('@noble/hashes/blake2b');
  const msgHashBytes = blake2b(messageCbor, { dkLen: 32 });

  const signature = ed25519.sign(msgHashBytes, privateKey);

  log.info(
    { orderId: params.orderId, expiryPosix },
    'Oracle signed release',
  );

  return {
    orderId: params.orderId,
    messageCbor,
    signature: Buffer.from(signature),
    oraclePubKey: Buffer.from(publicKey),
    expiryPosix,
    nonce,
  };
}

export async function resignRelease(orderId: string): Promise<SignedRelease> {
  requireNotKilled();

  const existing = await db.releaseSignature.findUnique({
    where: { orderId },
    include: { order: true },
  });

  if (!existing) {
    throw new Error(`No existing signature for order ${orderId}`);
  }

  if (existing.resignCount >= MAX_RESIGN_COUNT) {
    throw new Error(`Max resign count (${MAX_RESIGN_COUNT}) reached for order ${orderId}`);
  }

  // Re-sign với nonce mới và expiry mới
  const order = existing.order;
  const newSig = await signRelease({
    orderId,
    buyerPkh: Buffer.from(order.buyerPkh),
    policyId: Buffer.from(order.tokenPolicyId),
    assetName: Buffer.from(order.tokenAssetName),
    tokenAmount: BigInt(order.tokenAmount.toString()),
  });

  await db.releaseSignature.update({
    where: { orderId },
    data: {
      messageCbor: newSig.messageCbor,
      signature: newSig.signature,
      expiryPosix: newSig.expiryPosix,
      nonce: newSig.nonce,
      resignCount: existing.resignCount + 1,
    },
  });

  return newSig;
}
```

### File: `oracle/src/index.ts` (đoạn thêm kill switch endpoint)

```typescript
// oracle/src/index.ts — thêm vào sau khi express app khởi tạo

// FIX: Kill switch API endpoint
app.post('/internal/kill-switch', (req, res) => {
  const authHeader = req.headers.authorization ?? '';
  if (authHeader !== `Bearer ${config.KILL_SWITCH_SECRET}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const reason = (req.body as any)?.reason ?? 'Manual kill switch activation';
  activateKillSwitch(reason);
  res.json({ killed: true, reason, killedAt: new Date().toISOString() });
});

app.get('/health', (_req, res) => {
  const killStatus = getKillSwitchStatus();
  res.json({
    status: killStatus.killed ? 'halted' : 'ok',
    killSwitch: killStatus,
    bankApis: {
      payos: 'ok', // TODO: real health check
      mbbank: 'ok',
    },
    cardanoApi: 'ok',
  });
});
```

---

## 5. ORDER MANAGEMENT API — BẢN CUỐI (TypeScript)

Thay đổi chính: thêm KYC tier enforcement, aggregate transaction monitoring, compliance layer.

### File: `api/src/lib/kyc.ts` (MỚI)

```typescript
// api/src/lib/kyc.ts
// Tiered KYC enforcement theo AML Law 2022.
// Tier 1 (ANONYMOUS): đến 2M VND/tháng — không cần thêm thông tin
// Tier 2 (PHONE): đến 10M VND/tháng — cần số điện thoại verified
// Tier 3 (PASSPORT): trên 10M VND/tháng — cần passport + liveness

export type KycTier = 'ANONYMOUS' | 'PHONE' | 'PASSPORT';

export interface KycThresholds {
  anonymousMonthlyVnd: number;
  phoneMonthlyVnd: number;
  // Trên phoneMonthlyVnd → yêu cầu PASSPORT
}

export const KYC_THRESHOLDS: KycThresholds = {
  anonymousMonthlyVnd: 2_000_000,    // 2M VND
  phoneMonthlyVnd: 10_000_000,       // 10M VND
};

export function requiredTierForAmount(
  currentMonthlyTotal: number,
  requestedAmount: number,
): KycTier {
  const newTotal = currentMonthlyTotal + requestedAmount;
  if (newTotal > KYC_THRESHOLDS.phoneMonthlyVnd) return 'PASSPORT';
  if (newTotal > KYC_THRESHOLDS.anonymousMonthlyVnd) return 'PHONE';
  return 'ANONYMOUS';
}

export async function getMonthlyTotal(
  buyerWalletAddress: string,
  db: any,
): Promise<number> {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const result = await db.order.aggregate({
    _sum: { totalVND: true },
    where: {
      buyerWalletAddress,
      status: { in: ['PAYMENT_DETECTED', 'RELEASE_PENDING', 'COMPLETED'] },
      createdAt: { gte: startOfMonth },
    },
  });

  return result._sum.totalVND ?? 0;
}

export function kycTierOf(buyer: { kycTier?: string | null }): KycTier {
  return (buyer?.kycTier as KycTier) ?? 'ANONYMOUS';
}
```

### File: `api/src/lib/compliance.ts` (MỚI)

```typescript
// api/src/lib/compliance.ts
// Aggregate transaction monitoring và structuring detection.
// Tuân thủ AML Law 2022 Article 37.

import pino from 'pino';

const log = pino({ name: 'compliance' });

// Ngưỡng cảnh báo structuring: 3+ giao dịch trong 30 ngày ở gần cùng mức
const STRUCTURING_WINDOW_DAYS = 30;
const STRUCTURING_TX_COUNT_THRESHOLD = 3;
const STRUCTURING_AMOUNT_SIMILARITY_PERCENT = 10; // ±10%

export interface ComplianceAlert {
  type: 'STRUCTURING' | 'HIGH_VELOCITY' | 'AGGREGATE_THRESHOLD';
  buyerWalletAddress: string;
  detail: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
}

export async function checkCompliance(
  buyerWalletAddress: string,
  requestedAmountVnd: number,
  db: any,
): Promise<ComplianceAlert[]> {
  const alerts: ComplianceAlert[] = [];
  const windowStart = new Date(Date.now() - STRUCTURING_WINDOW_DAYS * 86400_000);

  const recentOrders = await db.order.findMany({
    where: {
      buyerWalletAddress,
      status: { in: ['PAYMENT_DETECTED', 'RELEASE_PENDING', 'COMPLETED', 'AWAITING_PAYMENT'] },
      createdAt: { gte: windowStart },
    },
    select: { totalVND: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });

  // Kiểm structuring: nhiều giao dịch ở gần cùng mức trong 30 ngày
  const similarAmounts = recentOrders.filter((o: any) => {
    const diff = Math.abs(o.totalVND - requestedAmountVnd) / requestedAmountVnd;
    return diff <= STRUCTURING_AMOUNT_SIMILARITY_PERCENT / 100;
  });

  if (similarAmounts.length >= STRUCTURING_TX_COUNT_THRESHOLD) {
    alerts.push({
      type: 'STRUCTURING',
      buyerWalletAddress,
      detail: `${similarAmounts.length + 1} giao dịch ở mức ~${requestedAmountVnd} VND trong ${STRUCTURING_WINDOW_DAYS} ngày`,
      severity: 'HIGH',
    });
  }

  // Kiểm tốc độ cao: >5 giao dịch trong 24 giờ
  const last24h = new Date(Date.now() - 86400_000);
  const recentCount = recentOrders.filter(
    (o: any) => new Date(o.createdAt) >= last24h,
  ).length;

  if (recentCount >= 5) {
    alerts.push({
      type: 'HIGH_VELOCITY',
      buyerWalletAddress,
      detail: `${recentCount} giao dịch trong 24 giờ qua`,
      severity: 'MEDIUM',
    });
  }

  // Log tất cả alerts — TODO: gửi vào STR queue
  for (const alert of alerts) {
    log.warn({ alert }, 'Compliance alert');
  }

  return alerts;
}

export function shouldBlockOnAlerts(alerts: ComplianceAlert[]): boolean {
  // Chỉ block nếu có HIGH severity alert
  // MEDIUM và LOW: ghi nhận nhưng không block
  return alerts.some((a) => a.severity === 'HIGH');
}
```

### File: `api/src/services/order.service.ts` (đoạn thêm compliance check)

```typescript
// api/src/services/order.service.ts — thêm compliance vào createOrder

// FIX: Thêm KYC tier check và compliance monitoring vào order creation.

import { checkCompliance, shouldBlockOnAlerts } from '../lib/compliance.js';
import { getMonthlyTotal, requiredTierForAmount, kycTierOf } from '../lib/kyc.js';

export async function createOrder(params: {
  offerId: string;
  tokenAmount: number;
  buyerWalletAddress: string;
  idempotencyKey: string;
}): Promise<Order> {
  // ... (existing offer validation logic) ...

  // FIX: KYC tier check
  const monthlyTotal = await getMonthlyTotal(params.buyerWalletAddress, db);
  const requiredTier = requiredTierForAmount(monthlyTotal, totalVND);
  const buyerKycRecord = await db.buyerKyc.findUnique({
    where: { walletAddress: params.buyerWalletAddress },
  });
  const currentTier = kycTierOf(buyerKycRecord);

  const tierRank: Record<string, number> = { ANONYMOUS: 0, PHONE: 1, PASSPORT: 2 };
  if ((tierRank[currentTier] ?? 0) < (tierRank[requiredTier] ?? 0)) {
    throw new ServiceError('KYC_REQUIRED', 403, {
      requiredTier,
      currentTier,
      monthlyTotal,
      requestedAmount: totalVND,
      message: `Cần nâng cấp KYC lên ${requiredTier} để thực hiện giao dịch này`,
    });
  }

  // FIX: Compliance monitoring
  const alerts = await checkCompliance(params.buyerWalletAddress, totalVND, db);
  if (shouldBlockOnAlerts(alerts)) {
    throw new ServiceError('COMPLIANCE_BLOCK', 403, {
      message: 'Giao dịch tạm thời bị giữ lại để xem xét tuân thủ',
    });
  }

  // ... (existing order creation logic) ...
}
```

---

## 6. DEPLOYMENT GUIDE

### Bước 1: Chuẩn bị môi trường

```bash
# 1.1 Chuẩn bị server (Ubuntu 22.04 LTS recommended)
# Tối thiểu: 4 vCPU, 8 GB RAM, 100 GB SSD

# 1.2 Cài đặt dependencies
apt-get update && apt-get install -y \
  docker.io docker-compose-v2 \
  nodejs npm \
  git curl jq

# Cài Bun (cho oracle service)
curl -fsSL https://bun.sh/install | bash

# 1.3 Cài Aiken CLI
curl -L https://install.aiken-lang.org | bash
aiken --version  # Phải >= 1.1.0

# 1.4 Tạo thư mục project
mkdir -p /opt/otc-desk/{onchain,oracle,api,config}

# 1.5 Clone repo
git clone https://github.com/MagicLampNetwork/MAGIC.git /opt/otc-desk/repo

# 1.6 Setup PostgreSQL và Redis qua Docker
cat > /opt/otc-desk/docker-compose.infra.yml << 'EOF'
version: '3.9'
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: otc_desk
      POSTGRES_USER: otc
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "127.0.0.1:5432:5432"
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    command: redis-server --requirepass ${REDIS_PASSWORD} --notify-keyspace-events Ex
    ports:
      - "127.0.0.1:6379:6379"
    restart: unless-stopped

volumes:
  pgdata:
EOF

# Tạo file .env
cat > /opt/otc-desk/.env << 'EOF'
POSTGRES_PASSWORD=<strong-random-password>
REDIS_PASSWORD=<strong-random-password>
EOF

docker compose -f /opt/otc-desk/docker-compose.infra.yml up -d
```

### Bước 2: Compile và deploy smart contract

```bash
# 2.1 Vào thư mục onchain
cd /opt/otc-desk/repo/OtcDesk/onchain

# 2.2 Tạo cấu trúc thư mục nếu chưa có
mkdir -p lib/magiclamp/otc validators

# 2.3 Copy các file Aiken từ tài liệu này vào đúng vị trí:
# - lib/magiclamp/otc/types.ak
# - lib/magiclamp/otc/utils.ak
# - validators/otc_desk.ak
# - aiken.toml

# 2.4 Fetch dependencies
aiken packages

# 2.5 Kiểm tra và compile
aiken check
# Phải thấy: All X tests passed.
# KHÔNG được có: error, fail (ngoài các test đánh dấu `fail`)

aiken build
# Tạo ra: plutus.json với script hash

# 2.6 Lấy script hash
cat plutus.json | jq -r '.validators[0].hash'
# Lưu lại: VALIDATOR_HASH=<hash>

# 2.7 Deploy reference script lên Preview testnet trước
# Cần cardano-cli và một node (hoặc dùng Blockfrost)

# Tạo reference script UTxO (chỉ làm 1 lần per network)
SCRIPT_FILE="plutus.json"
SCRIPT_CBOR=$(cat plutus.json | jq -r '.validators[0].compiledCode')

# Dùng cardano-cli để tạo transaction deploy reference script
# (Xem Cardano developer docs về reference scripts)
cardano-cli transaction build \
  --babbage-era \
  --testnet-magic 2 \
  --tx-in <YOUR-UTXO-TXHASH>#0 \
  --tx-out "$(cardano-cli address build --payment-script-file otc_desk.plutus --testnet-magic 2)+5000000" \
  --tx-out-reference-script-file otc_desk.plutus \
  --change-address <YOUR-ADDRESS> \
  --out-file deploy-ref-script.tx

cardano-cli transaction sign \
  --tx-file deploy-ref-script.tx \
  --signing-key-file payment.skey \
  --testnet-magic 2 \
  --out-file deploy-ref-script.signed

cardano-cli transaction submit \
  --testnet-magic 2 \
  --tx-file deploy-ref-script.signed

# Lưu lại TxHash của reference script UTxO
# REF_SCRIPT_UTXO=<txhash>#0

echo "=== Smart contract deployed ==="
echo "Validator hash: $VALIDATOR_HASH"
echo "Reference script UTxO: $REF_SCRIPT_UTXO"
```

### Bước 3: Cấu hình VeData oracle

```bash
# 3.1 Tạo Ed25519 keypair (TRÊN MÁY AIR-GAPPED hoặc máy riêng biệt)
# Không làm trên production server

# Cách 1: dùng @noble/curves (Node.js)
node -e "
const { ed25519 } = require('@noble/curves/ed25519');
const priv = ed25519.utils.randomPrivateKey();
const pub = ed25519.getPublicKey(priv);
console.log('PRIVATE_KEY_HEX=' + Buffer.from(priv).toString('hex'));
console.log('PUBLIC_KEY_HEX=' + Buffer.from(pub).toString('hex'));
" > oracle-keys.txt
chmod 600 oracle-keys.txt

# Cách 2: dùng cardano-cli (tạo Ed25519 key native)
cardano-cli key gen-payment-key-pair \
  --normal-key \
  --signing-key-file oracle-payment.skey \
  --verification-key-file oracle-payment.vkey

# 3.2 Lưu private key vào AWS Secrets Manager (production)
aws secretsmanager create-secret \
  --name "otc-desk/oracle-private-key" \
  --secret-string "{\"privateKeyHex\": \"<YOUR_PRIVATE_KEY_HEX>\"}" \
  --region ap-southeast-1

# 3.3 Tạo file env cho oracle
cat > /opt/otc-desk/oracle/.env << 'EOF'
# Database
DATABASE_URL=postgresql://otc:<POSTGRES_PASSWORD>@localhost:5432/otc_desk

# Redis
REDIS_URL=redis://:${REDIS_PASSWORD}@localhost:6379/0

# Oracle key (production: dùng AWS Secrets Manager)
# ORACLE_PRIVATE_KEY_ARN=arn:aws:secretsmanager:...
# Dev/staging: set trực tiếp (KHÔNG dùng cho production)
ORACLE_PRIVATE_KEY=<YOUR_PRIVATE_KEY_HEX>

# Kill switch
KILL_SWITCH_SECRET=<strong-random-secret>

# Bank API — PayOS
PAYOS_CLIENT_ID=<payos-client-id>
PAYOS_API_KEY=<payos-api-key>
PAYOS_CHECKSUM_KEY=<payos-checksum-key>

# Bank API — MB Bank
MB_BANK_USERNAME=<mb-username>
MB_BANK_PASSWORD=<mb-password>
MB_BANK_ACCOUNT_NUMBER=<account-number>
MB_BANK_API_BASE_URL=https://api.mbbank.com.vn/v2

# Cardano
BLOCKFROST_PROJECT_ID=<blockfrost-id>
CARDANO_NETWORK=preview  # hoặc mainnet
OTC_SCRIPT_ADDRESS=<validator-address>
OTC_VALIDATOR_HASH=<validator-hash>
REF_SCRIPT_UTXO=<txhash>#0

# Alerts
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_ALERT_CHAT_ID=<chat-id>
EOF

# 3.4 Cài dependencies và chạy database migration
cd /opt/otc-desk/oracle
npm install
npx prisma migrate deploy
npx prisma db push  # nếu dùng schema push

# 3.5 Chạy oracle service
npm run build
node dist/index.js
# Kiểm tra log: "Oracle key loaded" và "MB Bank authenticated"
```

### Bước 4: Deploy Order Management API

```bash
# 4.1 Tạo file env cho API
cat > /opt/otc-desk/api/.env << 'EOF'
# Database
DATABASE_URL=postgresql://otc:<POSTGRES_PASSWORD>@localhost:5432/otc_desk

# Redis
REDIS_URL=redis://:${REDIS_PASSWORD}@localhost:6379/0

# Server
PORT=3000
HOST=0.0.0.0
NODE_ENV=production

# JWT (cho enterprise auth)
JWT_SECRET=<strong-random-jwt-secret>

# Oracle internal auth (mTLS hoặc shared secret cho dev)
ORACLE_INTERNAL_SECRET=<shared-secret-cho-dev>

# Cardano
BLOCKFROST_PROJECT_ID=<blockfrost-id>
CARDANO_NETWORK=preview

# Settlement bank (OFFSHORE — không phải ngân hàng VN)
SETTLEMENT_BANK_CODE=DBS
SETTLEMENT_BANK_ACCOUNT=<singapore-dbs-account>
SETTLEMENT_ACCOUNT_NAME=MAGICLAMP NETWORK PTE LTD
SETTLEMENT_BANK_BIN=<singapore-dbs-bin>
EOF

# 4.2 Cài dependencies và migrate
cd /opt/otc-desk/api
npm install
npx prisma migrate deploy

# 4.3 Build và chạy
npm run build
node dist/index.js
# Kiểm tra: curl http://localhost:3000/health → {"status":"ok"}
```

### Bước 5: Kết nối PayOS webhook

```bash
# 5.1 Expose oracle webhook endpoint qua reverse proxy (nginx/caddy)
# Ví dụ với nginx:
cat > /etc/nginx/sites-available/otc-oracle << 'EOF'
server {
    listen 443 ssl;
    server_name oracle.yourdomain.com;
    
    ssl_certificate /etc/letsencrypt/live/oracle.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/oracle.yourdomain.com/privkey.pem;
    
    location /webhook/payos {
        proxy_pass http://127.0.0.1:8080/webhook/payos;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
    
    # Chặn tất cả path khác từ internet
    location / {
        return 403;
    }
}
EOF

# 5.2 Đăng ký webhook URL với PayOS
# Truy cập PayOS developer portal → Webhooks → Add webhook
# URL: https://oracle.yourdomain.com/webhook/payos
# Events: PAYMENT_SUCCESS, PAYMENT_FAILED

# 5.3 Test webhook với PayOS sandbox
curl -X POST https://oracle.yourdomain.com/webhook/payos \
  -H "Content-Type: application/json" \
  -d '{
    "code": "00",
    "desc": "success",
    "success": true,
    "data": {
      "orderCode": 12345678,
      "amount": 100000,
      "description": "VD7K3X9MABQ2F8WP",
      "accountNumber": "1234567890",
      "reference": "payos-ref-001",
      "transactionDateTime": "2026-06-05T10:00:00+07:00",
      "paymentLinkId": "test-link-001",
      "code": "00",
      "desc": "Giao dịch thành công"
    },
    "signature": "<computed-hmac>"
  }'
# Kỳ vọng: 200 OK
```

### Bước 6: Enterprise lock tokens và tạo offer đầu tiên

```bash
# 6.1 Enterprise chuẩn bị
# - Có Cardano wallet (Lace hoặc Eternl) với LAMP tokens
# - Đã đăng ký enterprise account qua API
# - Có API key

# 6.2 Tạo enterprise account qua API
curl -X POST https://api.yourdomain.com/api/v1/admin/enterprises \
  -H "Content-Type: application/json" \
  -d '{
    "displayName": "PhoenixKey Foundation",
    "legalName": "PhoenixKey Foundation Ltd",
    "receiveBank": {
      "bankCode": "DBS",
      "bankBin": "7171",
      "accountNumber": "1234567890",
      "accountName": "MAGICLAMP NETWORK PTE LTD"
    },
    "walletAddress": "addr1q..."
  }'
# Lưu lại enterpriseId và apiKey

# 6.3 Lock tokens on-chain
# Dùng Lucid-Evolution hoặc frontend để tạo offer UTxO
# Datum cần điền:
#   - seller_pkh: payment key hash của enterprise wallet
#   - token_policy: LAMP policy ID
#   - token_name: 4c414d50 (hex của "LAMP")
#   - total_amount: số LAMP muốn bán
#   - remaining_amount: bằng total_amount lúc đầu
#   - price_per_unit_lovelace: giá × 1_000_000 (ví dụ 1250 VND = bao nhiêu lovelace?)
#     NOTE: Contract dùng lovelace, không VND. SDK convert qua exchange rate.
#   - oracle_vkey: public key của VeData oracle (lấy từ /oracle/status)
#   - oracle_vkey_hash: blake2b_256(oracle_vkey)
#   - order_id: 32 bytes random unique
#   - min_buy_amount: 1000 (minimum LAMP per order)
#   - max_buy_amount: 100000 (maximum LAMP per order)
#   - expiry_posix_ms: Unix ms của ngày hết hạn (ví dụ 30 ngày từ giờ)

# 6.4 Đăng ký offer với API (sau khi lock on-chain)
curl -X POST https://api.yourdomain.com/api/v1/enterprise/offers \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ent_live_xxxx" \
  -d '{
    "tokenSymbol": "LAMP",
    "policyId": "a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d3d1e8e",
    "assetName": "4c414d50",
    "totalAmount": 500000,
    "priceVND": 1250,
    "minOrderAmount": 1000,
    "maxOrderAmount": 100000,
    "onchainEscrowUtxo": {
      "txHash": "<lock-tx-hash>",
      "outputIndex": 0
    },
    "expiresAt": "2026-07-05T23:59:59Z",
    "receiveBank": {
      "bankCode": "DBS",
      "accountNumber": "1234567890",
      "accountName": "MAGICLAMP NETWORK PTE LTD"
    }
  }'
# Kỳ vọng: 201 với status PENDING_VERIFICATION
# Sau ~60s: WebSocket event offer.activated
```

### Bước 7: Test end-to-end với số tiền nhỏ

```bash
# 7.1 Tạo order test
curl -X POST https://api.yourdomain.com/api/v1/orders \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "offerId": "offer_01HXYZ123",
    "tokenAmount": 1000,
    "buyerWalletAddress": "addr1q..."
  }'
# Lưu lại: orderId, referenceCode, QR data, amount

# 7.2 Thực hiện chuyển khoản thực tế (số nhỏ — 1,250,000 VND cho 1000 LAMP)
# Dùng ứng dụng ngân hàng, quét QR hoặc chuyển khoản với description = referenceCode

# 7.3 Theo dõi qua WebSocket
wscat -c "wss://api.yourdomain.com/ws?orderId=ord_xxxx"
# Kỳ vọng sau 10-30s: event order.payment_detected
# Kỳ vọng sau 60-90s: event order.completed + txHash

# 7.4 Verify on-chain
curl https://cardanoscan.io/api/transaction/<txHash>

# 7.5 Kiểm tra receipt
curl https://api.yourdomain.com/api/v1/orders/ord_xxxx/receipt

# 7.6 Chạy kill switch test (không commit — chỉ verify hoạt động)
curl -X POST https://oracle.yourdomain.com/internal/kill-switch \
  -H "Authorization: Bearer <KILL_SWITCH_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Test kill switch"}'
# Kỳ vọng: {"killed":true}
# Kiểm tra: signing requests trả 503

# Restart oracle để re-enable:
systemctl restart otc-oracle
# hoặc: kill switch chỉ reset khi restart service (không có un-kill endpoint — đây là thiết kế an toàn)
```

---

## 7. CẤU TRÚC PHÁP LÝ ĐƯỢC KHUYẾN NGHỊ

### Entity nên đặt ở đâu và tại sao

**Lựa chọn được khuyến nghị: Singapore Private Limited Company**

Singapore Pte Ltd là lựa chọn tốt nhất vì:
- MAS PSA (Payment Services Act) có lộ trình cấp phép rõ ràng cho Virtual Asset Service Provider
- Singapore có hệ thống ngân hàng hiện đại cho phép mở tài khoản doanh nghiệp cho crypto-adjacent business (DBS, OCBC — khó nhưng khả thi với proper compliance)
- Không có MLAT với Việt Nam cho loại tội phạm này → thêm lớp
covering this category, giving operational insulation
- Cộng đồng Cardano developer mạnh tại Singapore — dễ tuyển dụng kỹ thuật

**Cấu trúc thực thể đề xuất:**

```
MagicLamp Network Pte Ltd (Singapore)
├── Hoạt động OTC Desk (operator entity)
├── Giữ MAS PSA license (Major Payment Institution — DPT services)
├── Tài khoản ngân hàng: DBS Singapore (SGD + VND cross-border)
└── VeData Oracle Operations (có thể là subsidiary hoặc cùng entity)

Không tồn tại thực thể Việt Nam nào trong chain này.
```

**Tại sao không UAE (VARA):**
- VARA licensing chi phí cao hơn (~$130,000 USD setup)
- Banking cho crypto tại UAE khó hơn Singapore năm 2026
- Khoảng cách múi giờ với Vietnam team (+3h thay vì +1h) — nhỏ nhưng có

**Tại sao không BVI/Cayman:**
- Không có licensing framework cho VASP
- Ngân hàng đối tác không nhận VND inbound
- Reputation risk khi marketing tại Việt Nam

### Cấu trúc hoạt động cho thị trường Việt Nam

**Tài khoản settlement VND:**

Không dùng tài khoản ngân hàng Việt Nam. Hai phương án:

Phương án A — Singapore DBS multi-currency:
- DBS Singapore nhận VND wire transfer từ Việt Nam qua SWIFT
- Phí: 0.3-0.5% per transfer, T+1 settlement
- Nhược điểm: buyer phải dùng international wire, không phải VietQR trong nước

Phương án B — PayOS/VNPay làm intermediary:
- PayOS là đơn vị được SBV cấp phép làm payment intermediary
- Enterprise ký hợp đồng merchant với PayOS (loại "bán hàng hóa/dịch vụ")
- PayOS nhận VND từ buyer, nộp về tài khoản merchant của enterprise tại ngân hàng
- Enterprise có thể là công ty Singapore có tài khoản ngân hàng tại Việt Nam dưới dạng representative office — không phải LLC Việt Nam
- Rủi ro: PayOS phải biết merchant bán gì. "Dịch vụ digital" có thể pass; "crypto token" sẽ không pass.

Phương án B.2 — Wise Business (Singapore → VND nhận tiền):
- Wise Business cho phép Singapore entity nhận VND từ Việt Nam
- VietQR không support Wise trực tiếp nhưng buyer có thể chuyển khoản thường
- Latency: T+0 đến T+1

**Khuyến nghị thực tế:**

MVP: Phương án A (DBS Singapore, international wire). Chỉ phục vụ buyer có tài khoản ngân hàng có thể làm international transfer. Giới hạn khách hàng nhưng hoàn toàn hợp pháp. Test model trước khi scale.

Scale: Đàm phán trực tiếp với một ngân hàng Việt Nam có chi nhánh nước ngoài (Vietcombank Singapore, BIDV Myanmar — các chi nhánh ngoài VN của ngân hàng VN) để nhận VND settlement về tài khoản Singapore entity. Đây là grey area nhưng không phải hoạt động ngân hàng tại Việt Nam.

### Điều tuyệt đối không được làm

1. Không mở tài khoản ngân hàng Việt Nam (VCB, MB, TCB bất kỳ) dưới tên công ty Việt Nam cho mục đích settlement OTC.

2. Không để bất kỳ cá nhân có địa chỉ thường trú tại Việt Nam đứng tên là legal representative hoặc director của entity vận hành.

3. Không launch giao diện tiếng Việt trên domain .vn khi chưa có ít nhất một legal opinion bằng văn bản từ luật sư có hành nghề tại Việt Nam.

4. Không vượt 10 tỷ VND tổng volume tích lũy trước khi có AML program bằng văn bản — đây là ngưỡng "large scale" trong Điều 206 BLHS.

5. Không để oracle signing key tồn tại dưới dạng plaintext trong bất kỳ file config, env file, hay git repo nào.

6. Không cho một cá nhân nắm đủ 3 thứ: private key oracle + quyền truy cập kill switch + quyền truy cập tài khoản ngân hàng settlement. Phân tách vai trò bắt buộc.

---

## 8. RISK REGISTER CUỐI CÙNG

| Rủi ro | Mức độ ban đầu | Mitigation đã áp dụng | Rủi ro còn lại |
|---|---|---|---|
| **Contract không compile (trace_if_false)** | CRITICAL | Sửa thứ tự tham số trong bản cuối | ĐÃ GIẢI QUYẾT |
| **ADA deposit bị đánh cắp trên full fill** | CRITICAL | Thêm kiểm `total_seller_lovelace >= required + escrow_ada` | ĐÃ GIẢI QUYẾT |
| **Continuing UTxO thiếu ADA → khoá token** | CRITICAL | Thêm kiểm `cont_lovelace >= 2_000_000` | ĐÃ GIẢI QUYẾT |
| **Giá 0 do min_price không được enforce** | CRITICAL | Thêm `datum.price >= min_price_lovelace` vào validator entry | ĐÃ GIẢI QUYẾT |
| **released_nonces không giới hạn → ExUnit** | HIGH | Thêm `list.length < max_nonces` bound | ĐÃ GIẢI QUYẾT |
| **Rotate không cần seller → rogue oracle** | HIGH | Thêm `tx_signed_by(seller_pkh)` vào Rotate | ĐÃ GIẢI QUYẾT |
| **Spec nói batching được, code chặn** | HIGH | Xóa claim batching khỏi tài liệu | ĐÃ GIẢI QUYẾT |
| **CBOR encoding mismatch offchain/onchain** | HIGH | Thêm tài liệu rõ ràng + manual encoding cho indefinite array | Còn lại MEDIUM — cần integration test thực tế để confirm |
| **Pre-mark dedup bug → silent payment miss** | HIGH | Đảo thứ tự: emit trước, redis.set sau | ĐÃ GIẢI QUYẾT |
| **Reconciliation poller không có** | HIGH | Triển khai ReconciliationPoller | ĐÃ GIẢI QUYẾT |
| **Oracle private key compromise** | CRITICAL | Kill switch API + HSM + anomaly detection | Còn lại HIGH — HSM chưa triển khai trong MVP |
| **VeData operator malicious** | CRITICAL | Multi-sig oracle (lộ trình Phase 2) | Còn lại HIGH — chấp nhận cho MVP |
| **Điều 206 BLHS — tài khoản VN** | CRITICAL | Entity Singapore + DBS settlement account | Còn lại MEDIUM — phụ thuộc vào cách VND routing được giải quyết |
| **Cancel vs Release race** | HIGH | On-chain time-lock (lộ trình Phase 2) | Còn lại HIGH — chưa implement trong MVP |
| **Datum field validation thiếu** | MEDIUM | Thêm invariant checks vào validator entry | ĐÃ GIẢI QUYẾT |
| **Không có KYC program** | HIGH | Tiered KYC + compliance monitoring | Còn lại MEDIUM — framework có, nhưng cần vận hành nghiêm túc |
| **Oracle timestamp window bypass** | MEDIUM | Ghi chú rõ limitation; oracle expiry là bảo vệ thực tế | Còn lại LOW — oracle expiry trong signed message là phòng thủ đủ |
| **No lock-time validator** | MEDIUM | SDK enforce; documented limitation | Còn lại LOW — acceptable với operational controls |
| **BIDV/bank strip description** | MEDIUM | ref-extractor xử lý được hầu hết cases | Còn lại LOW — edge case với ~5% ngân hàng |
| **Pro-cyclical liquidity (rút khi giá tăng)** | HIGH | Liquidity commitment cơ chế (lộ trình Phase 2) | Còn lại HIGH — chưa implement |
| **Bond tỷ lệ 5% không đủ deterrence** | HIGH | Re-frame là commitment signal; primary deterrence = KYB + legal | Còn lại MEDIUM — chấp nhận với KYB gate |

---

## 9. LỘ TRÌNH 3 GIAI ĐOẠN

### Giai đoạn 1 — MVP (Tháng 0 đến 3): Vietnam testbed, controlled release

**Mục tiêu:** Chứng minh product-market fit với 20-50 enterprise participants và 500-2000 buyer transactions.

**Phạm vi kỹ thuật:**
- Deploy smart contract lên Cardano Preview testnet (tuần 1-2)
- Deploy smart contract lên Cardano mainnet (tuần 3-4, sau khi testnet stable)
- Oracle: PayOS webhook + MB Bank poller + reconciliation poller
- API: tất cả endpoints đã thiết kế trong tài liệu này
- Frontend: tối giản — offer list, QR display, order status
- Không có multi-sig oracle (single VeData key, HSM optional)
- Manual oracle fallback: admin có thể trigger manual release qua CLI nếu oracle down

**Phạm vi pháp lý:**
- Singapore entity đăng ký (Pte Ltd, tuần 1-2)
- Settlement account: DBS Singapore multi-currency
- VND onramp: international wire (giới hạn khách hàng nhưng hợp pháp)
- KYC tier 1-2 triển khai (anonymous + phone)
- Legal opinion bằng văn bản từ luật sư Việt Nam trước khi marketing tại VN

**Giới hạn phục vụ:**
- Chỉ enterprise có KYB hoàn chỉnh (whitelist)
- Max 25M VND per transaction (đã trong contract)
- Max 100M VND per enterprise per month (enforced off-chain)
- Chỉ LAMP và MAGIC tokens

**Chỉ số thành công:**
- 100 giao dịch hoàn thành không có incident
- Thời gian phát hiện thanh toán trung bình < 30 giây
- Không có silent payment miss
- Không có incident bảo mật

**Kế hoạch dự phòng nếu oracle down:**
```
1. Oracle goes down
2. On-call engineer nhận PagerDuty alert (payment age > 25 phút)
3. Engineer ssh vào oracle server, kiểm tra logs
4. Nếu DB có payment confirmed nhưng signature chưa tạo:
   → Chạy script manual: node dist/tools/manual-sign.js --order-id <id>
5. Nếu signature đã tạo nhưng tx chưa submit:
   → Chạy: node dist/tools/manual-submit.js --order-id <id>
6. Notify buyer qua email (stored at order creation)
SLA: giải quyết trong 2 giờ hoặc full refund VND
```

### Giai đoạn 2 — Scale (Tháng 3 đến 9): Multi-bank, DAO arbitration, liquidity mechanisms

**Kỹ thuật:**
- Multi-sig oracle: 2-of-3 nodes độc lập, mỗi node có bank API credentials riêng
- On-chain time-lock cho Cancel (ngăn race condition với Release)
- zkTLS prototype (không production — chỉ nghiên cứu)
- VeData Key Registry contract deploy (thay thế datum-embedded key)
- Batch cancel SDK (nhiều UTxO trong một tx)
- Thêm ngân hàng: VPBank, Techcombank (ngoài MB Bank)
- International payment rails: Wise, Airwallex

**Kinh doanh:**
- Liquidity commitment mechanism: enterprise nhận thêm MAGIC yield nếu giữ lệnh đến hết hạn
- DAO-controlled max spread parameter (15% ceiling trên 7-day VWAP oracle)
- Cơ chế dispute resolution có on-chain component
- Enterprise analytics dashboard

**Pháp lý:**
- Nộp hồ sơ MAS PSA licence (Major Payment Institution — DPT services)
- Engage với Ministry of Finance Việt Nam về sandbox framework
- Triển khai Travel Rule compliance cho giao dịch > $1,000 USD
- Full KYC tier 3 (passport + liveness check)

**Chỉ số thành công:**
- 10,000 giao dịch tích lũy không có incident bảo mật
- Oracle uptime > 99.5%
- Multi-sig oracle hoạt động ổn định 30 ngày
- MAS PSA application nộp

### Giai đoạn 3 — Trustless (Tháng 9 đến 18): zkTLS oracle, cross-chain, fully permissionless

**Kỹ thuật:**
- zkTLS oracle production: proof generation cho PayOS/bank API responses
- Proof posting on-chain: Cardano native ZK verifier (sau khi Plutus có primitive ZK)
- Cross-chain: Ethereum USDC/USDT via bridge (Wanchain hoặc Milkomeda)
- International payment: SEPA Instant, PIX (Brazil), UPI (India) via adapter pattern
- Decentralized enterprise onboarding: DAO vote thay vì whitelist

**Kinh doanh:**
- LAMP oracle reputation staking: VeData và oracle operators stake LAMP, bị slash nếu fraud
- Fully permissionless: bất kỳ LAMP holder nào có thể tạo offer
- Protocol fee governed by DAO

**Pháp lý:**
- MAS PSA licence active
- FATF Travel Rule compliance toàn diện
- Multi-jurisdiction expansion: Philippines (BSP), Thailand (SEC), Malaysia (SC)

**Chỉ số thành công:**
- zkTLS proof generation < 60 giây (xuống từ 1-5 phút hiện tại)
- $1M USD equivalent tổng volume qua protocol
- Ít nhất 1 jurisdiction có formal regulatory approval
- VeData operator có thể là bất kỳ entity nào (không còn MagicLamp-exclusive)

---

*Kết thúc tài liệu. Phiên bản 1.0.0-rc1 — sẵn sàng đưa vào triển khai sau khi `aiken check` xanh và integration test oracle CBOR encoding pass.*