# Eligibility — số liệu để chốt hằng số (#26 việc 2)

Math thuần + vector đã chạy. **Chưa chốt hằng số nào trong code** — `consumed_ref`,
`commit_ref` và `catch_up_cap` đều là tham số hàm, đúng yêu cầu của #26. Tài liệu
này là để review quyết.

Chạy lại bảng: `cd Eligibility/offchain && npm test`

---

## 1. Cái đã chốt (hard-code)

| | Giá trị | Nguồn |
|---|---|---|
| `W_CONSUMED` | 0.90 Q | spec §6.2 |
| `W_OFFPEAK` | 0.25 Q | spec §6.2 |
| `W_COMMIT` | 0.20 Q | spec §6.2 |
| `W_AGE` | 0.15 Q | spec §6.2 |
| Σ | 1.50 Q ⟹ eligibility ∈ **[1.00×, 2.50×]** | |
| `ALPHA_AGE_Q` | ⌊Q/6⌋ = 166_666_666 | spec §6.2, cơ chế EMA |

## 2. Cái chưa chốt (tham số)

| Tham số | Nghĩa | Đơn vị |
|---|---|---|
| `consumed_ref` | mức tiêu coi là "tiêu đủ" | nanogic |
| `commit_ref` | mức khoá coi là "cam kết đủ" | oildrop, **hoặc** phần trăm số dư |
| `catch_up_cap` | số bước EMA tối đa một lần cập nhật | epoch |

Không còn `load_ref` — `offPeakFactor` đã tắt, xem §3.

## 3. `offPeakFactor` tắt trong MVP — trần thật là 1.35×, không phải 1.60×

Hàm cũ ở đây đo `(load_ref − network_load) / load_ref`: **khoảng trống tải của
MẠNG**, không có một đối số nào của người dùng. Nó trả cùng một số cho tất cả mọi
người, nên 0.25Q — một phần sáu toàn dải — là hằng số cộng phẳng, không phân biệt
ai với ai *nhưng trông như đang hoạt động*. Đó là thứ tệ hơn cả tắt.

Spec §6.2 đòi thứ khác: **tỷ lệ lượng tiêu lúc thấp điểm của CHÍNH người đó**, nhãn
thấp-điểm lấy từ giá dịch vụ công bố (`demand_mult` trong beacon `PriceParam` của
ConsumeMAGIC — reference input đã sống, không phải metric phải phát minh). Chữ ký
đúng, ghi lại để việc 3 dựng:

```
off_peak_factor(consumed_offpeak_nanogic, consumed_total_nanogic)
```

Hai đối số đều per-user ⟹ **không có `load_ref` nào để chọn**. Đã gỡ hàm, gỡ luôn
`load_ref` khỏi bộ ứng viên và `network_load` khỏi hồ sơ. Callers truyền
`off_peak_r = 0`.

Hệ quả lên trần: MVP hiện chỉ còn age (0.15Q) + commit (0.20Q) ⟹ **1.35×**.
Khi `did_commit` thật về mà off-peak vẫn tắt thì là 2.25×; đủ cả hai mới là 2.50×.

## 4. Bảng payoff

Bốn hồ sơ #26 yêu cầu, cộng hồ sơ 5 (lý do ở §5.3). Bộ **B**:

```
━━━ B · balanced ━━━  consumed_ref=100 MAGIC · commit=1000 LAMP · cap=6

    profile                     age     age¹    consum  commit  MVP       full      rwd·MVP  rwd·full
    1 · giữ LAMP lâu + có tiêu  98%     66%     50%     30%     1.2081×   1.6581×   24       33
    2 · đầu cơ                  16%     16%     0%      0%      1.0249×   1.0249×   0        0
    3 · tiêu mới                16%     16%     100%    0%      1.0249×   1.9249×   81       153
    4 · giữ lâu, không tiêu     98%     66%     0%      0%      1.1481×   1.1481×   0        0
    5 · cá voi, khoá 1%         98%     66%     0%      100%    1.3481×   1.3481×   0        0

━━━ B-rel · commit theo TỈ LỆ số dư ━━━
    5 · cá voi, khoá 1%         98%     66%     0%      1%      1.1501×   1.1501×   0        0
```

Ba cột phải đọc kỹ, vì thiếu cột nào cũng đọc ra kết luận ngược:

| Cột | Nghĩa |
|---|---|
| `age` | vault cập nhật **mỗi epoch** — `catch_up_cap` **không bao giờ** chạm ở cột này |
| `age¹` | vault ngủ rồi bắt kịp **một lần** ở cuối — đây mới là cột `cap` chạm vào |
| `rwd` | `⌊0.4·consumed × eligibility / Q⌋` MAGIC. Slope `g` là **trần** spec §6.3, minh hoạ, việc 3 mới chốt |

Bộ A (nới) và C (siết) ở trong test output. Tóm tắt: A làm hồ sơ 1 bão hoà cả
`consum` lẫn `commit` (100%/100%) nên factor hết phân biệt được ai; C làm `consum`
của hồ sơ 1 xuống 5% và `commit` xuống 3%, tức hai factor thành vô dụng với người
dùng thường.

---

## 5. Đọc bảng — ba mục, hai mục đã sửa so với bản trước

### 5.1 `eligibility` là hệ-số-NHÂN, không phải phần thưởng

Bản PR đầu tiên của tài liệu này so hệ-số với hệ-số rồi kết luận "MVP thưởng
ngược". **Kết luận đó sai**, và cột `rwd` là thứ vạch ra:

> `SPEC:178` — *"`eligibility` là hệ-số-NHÂN lên `g(consumed)`, mà `g(0) = 0`.
> Người nắm LAMP / cam-kết-lịch nhưng tiêu 0 → `eligibility` có thể > Q nhưng cấp
> thực = g(0)·eligibility = 0."*

- Hồ sơ 2 (đầu cơ) và hồ sơ 3 (tiêu mới) trùng nhau ở cột MVP — nhưng **0 MAGIC**
  so với **81 MAGIC** ở cột thưởng. Phân biệt tuyệt đối.
- Hồ sơ 4 (giữ lâu, không tiêu) có hệ số cao hơn hồ sơ 3 — và nhận **0**.
- Hồ sơ 5 (cá voi) có hệ số cao nhất bảng ở bộ B — và nhận **0**.

Cái mất thật của MVP là **mất dải**, không phải đảo dấu: `consumedFactor` tắt kéo
trần từ 2.50× xuống, `offPeakFactor` tắt kéo tiếp xuống 1.35×. Hệ ít phân biệt hơn
giữa những người **đã tiêu**; nó không trả ngược cho ai cả.

Test `consuming nothing pays nothing, whatever the multiplier says` khoá đúng điều
này lại — nó assert cả hai chiều: hệ số **đúng là** xếp hạng ngược, và phần thưởng
thì không.

### 5.2 `catch_up_cap` — bảng cũ không đo được chính tham số nó đề xuất

Bản trước đề xuất `cap = 6` dựa trên một bảng mà **`cap` không có tác dụng gì**:
helper chạy `emaCatchUp(ema, balance, 1, cap)` mỗi epoch, nên `steps = min(1, cap)`
= 1 với mọi `cap ≥ 1`. `cap=1`, `cap=6`, `cap=10000` in ra ba bảng giống hệt nhau,
trong khi header vẫn in `cap=…`.

Đã thêm cột `age¹` (bắt kịp một lần) và test khoá cả hai chiều. Số thật ở cap = 6,
cùng 24 epoch tuổi:

| Thói quen cập nhật | age |
|---|---|
| mỗi epoch | **98.7%** |
| một lần ở cuối | **66.5%** |

Cap **là** phanh laundering chứ không chỉ là hàng rào ExUnits — chênh 32 điểm.

### 5.3 `commit_ref` tuyệt đối là trợ cấp cho cá voi — nhưng bar tỉ lệ **không** vá được

Cá voi 100k LAMP khoá 1000 LAMP (**1% số dư**): bar tuyệt đối cho `commit = 100%`,
bar tỉ lệ cho `1%`. Bar tỉ lệ đọc đúng bản chất — nhưng nó **không đóng được lỗ**:

- **Tách ví.** 100 ví × 1000 LAMP, mỗi ví khoá trọn ⟹ `commitFactor = 100%` ở
  **mọi** ví. Tách ví trên Cardano gần như miễn phí, nên bar tỉ lệ đọc ra đúng con
  số bar tuyệt đối cho.
- Đường đúng là gộp theo **DID**, cùng hạ tầng `INV-CONSUMED-ATTRIB` mà
  `consumedFactor` đang chờ. Ghi vào việc 3, đã ghi luôn vào docstring của
  `commit_factor` để người sau không tưởng bar tỉ lệ đã xong việc.

`ratio_q` nay **fail closed**: `reference ≤ 0` trả `0`, không phải `Q`. Bản cũ dùng
`max(1, reference)` nên một tham số **chưa cấu hình** phát trọn trọng số cho bất kỳ
ai có value ≥ 1 — và bộ `B-rel` ship đúng `commit_ref: 0n`. Đó là lỗi wiring, và
lỗi wiring không được trả tiền.

---

## 6. Đề xuất

| Tham số | Đề xuất | Vì sao |
|---|---|---|
| `commit_ref` | **theo tỉ lệ số dư**, và ghi nhận nó chưa đủ | §5.3. Tuyệt đối là lỗ rõ; tỉ lệ đỡ được cá voi một ví nhưng không đỡ được tách ví. Đóng hẳn ở việc 3 bằng gộp DID |
| `consumed_ref` | **100 MAGIC** (bộ B) | Tách được hồ sơ 1 (50%) khỏi hồ sơ 3 (100%). A cho cả hai 100%, C cho 5%/20% |
| `catch_up_cap` | **6** | Giờ có bằng chứng đo được: cap=6 cho kẻ ngủ 24 epoch 66.5% so với 98.7% của người cập nhật đều — phanh laundering thật, chênh 32 điểm. Cap nhỏ hơn thì người vắng lâu không bao giờ đuổi kịp |
| `load_ref` | **không còn tồn tại** | §3. `offPeakFactor` tắt; khi bật lại thì chữ ký per-user không có reference để chọn |

## 7. Ba câu hỏi ở review — đã chốt

1. **MVP có ship khi `consumedFactor` tắt không?** → **(a) ship.** §5.1: không có
   thưởng ngược, chỉ có mất dải. Hai hướng còn lại — đổi trọng số riêng cho MVP,
   hoặc chặn tới khi có `did_commit` — là thuốc chữa một bệnh không có.
2. **`network_load` đo bằng gì?** → Không đo. Factor đã tắt, chữ ký đúng ghi ở §3.
3. **`max(Q, ·)` ngoài cùng không bao giờ chạm** → **cố ý, giữ.** Chi phí bằng 0 và
   nó là chốt chặn cho một factor có dấu trong tương lai. Kèm cảnh báo tại chỗ:
   ai nới `clamp_q` cũng phải xử lý `weighted / q` — đó là chỗ thứ hai tử số âm gặp
   floor-vs-truncate, và không có gì kẹp sau nó.

## 8. Còn nợ, thuộc việc 3

| | Việc |
|---|---|
| `off_peak_factor` | dựng lại theo chữ ký per-user §3 |
| `consumed_factor` | cửa sổ **6 epoch** — spec §6.2 chốt cơ chế, hàm thuần không thấy epoch nên đây là **hợp đồng bắt buộc của caller**, đã ghi vào docstring. Truyền tổng lifetime là biến 0.90Q thành thành-tựu một-lần vĩnh viễn. Vector suy giảm nợ cùng chỗ cài cửa sổ |
| `commit_factor` | gộp theo DID (§5.3 tách ví) |
| `ema_catch_up` | `catch_up_cap` phải vào validator như **hằng compile-time** — không gì trong hàm chặn chính cái cap, redeemer/datum truyền vào là vòng lặp không chặn |
| `eligibility_q` | nếu thêm factor có dấu: `weighted / q` cần quyết `quotient` vs `/` + vector âm |

---

## 9. Đã kiểm

```
$ cd Eligibility/onchain && aiken check
    ...30 tests | 30 passed | 0 failed

$ cd Eligibility/offchain && npx vitest run
 ✓ ../tests/eligibility.test.ts  (29 tests)
   Test Files  1 passed (1)
        Tests  29 passed (29)

$ npx tsc --noEmit
(clean)
```

**P8 — ba vector răng, không chỉ một:**

- `TV-ELIG-EMA-CONVERGENCE` — bốn số hội tụ, khớp cả hai phía.
- `TV-ELIG-EMA-FALLING` — **mới**. Mọi vector cũ đều bắt đầu `ema = 0` với số dư
  phẳng hoặc tăng, mà trên đường đó dạng đang dùng `(αB + (Q−α)e)/Q` và dạng
  `e + (x−e)·α` bị bác **trùng khít từng bit**. Tức lý lẽ chọn dạng chưa hề được
  test, và quay ngược về dạng bị bác vẫn qua 100% suite. Hai dạng chỉ tách nhau khi
  số dư **giảm**: `401_877_574_222_093_621` so với `…625` — dạng bị bác trôi **lên**.
- `ema_step` **kẹp `max(0, ·)` hai phía**. `ema_q` là trường datum nên caller đưa
  số âm được, và Aiken chia sàn (`-5 → -5`) còn TS cắt-về-0 (`→ -4`): hai phía ghi
  hai datum khác nhau, sai lệch **cộng dồn**, off-chain dựng tx mà on-chain từ chối.
  Kẹp làm phân kỳ đó thành không thể chạm tới, thay vì chỉ khó chạm.

`TV-OVERFLOW` nay ghim **hằng số literal** ở cả hai phía
(`166_666_666_000_000_000_000_000`). Bản cũ tính lại đúng biểu thức của
implementation ở vế phải — một tautology: nó bắt được `Number` regression nhưng vẫn
xanh nếu `emaStep` nhân α vào nhầm số hạng.

Các số hội tụ **không** bằng 1−(5/6)ⁿ: α lưu là ⌊Q/6⌋ hơi nhỏ hơn 1/6, và mỗi bước
đều floor nên sai lệch cộng dồn. n=6 ra 665_102_021 trong khi giải tích làm tròn
thành 665_102_022. Bản implement là chuẩn — đừng "sửa" về phía giải tích.

Chưa có validator, chưa có datum, chưa chạm InstantGen. Việc 3 mới làm phần đó.
