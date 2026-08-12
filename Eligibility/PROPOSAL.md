# Eligibility — số liệu để chốt hằng số (#26 việc 2)

Math thuần + vector đã chạy. **Chưa chốt hằng số nào trong code** — cả ba
`reference` và `catch_up_cap` đều là tham số hàm, đúng yêu cầu của #26. Tài liệu
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
| `load_ref` | tải mạng coi là "đỉnh" | chưa có định nghĩa metric |
| `catch_up_cap` | số bước EMA tối đa một lần cập nhật | epoch |

---

## 3. Bảng payoff

Bốn hồ sơ #26 yêu cầu, cộng hồ sơ 5 tôi thêm (lý do ở §4.3). `offpk` giữ cố định
50% cho mọi hồ sơ — off-peak là lựa chọn *khi nào* sinh, không phải thuộc tính
của *ai*, nên để nó thay đổi sẽ làm nhiễu bảng về danh tính.

`MVP` = `did_commit = #""` nên `consumedFactor` tắt. `full` = có DID thật.

```
━━━ B · balanced ━━━  consumed_ref=100 MAGIC · commit=1000 LAMP · load_ref=1000 · cap=6
    profile                     age      consum   offpk    commit   MVP       full
    1 · giữ LAMP lâu + có tiêu  98%      50%      50%      30%      1.3331×   1.7831×
    2 · đầu cơ                  16%      0%       50%      0%       1.1499×   1.1499×
    3 · tiêu mới                16%      100%     50%      0%       1.1499×   2.0499×
    4 · giữ lâu, không tiêu     98%      0%       50%      0%       1.2731×   1.2731×
    5 · cá voi, khoá 1%         98%      0%       50%      100%     1.4731×   1.4731×

━━━ B-rel · commit theo TỈ LỆ số dư ━━━
    1 · giữ LAMP lâu + có tiêu  98%      50%      50%      29%      1.3330×   1.7830×
    2 · đầu cơ                  16%      0%       50%      0%       1.1499×   1.1499×
    3 · tiêu mới                16%      100%     50%      0%       1.1499×   2.0499×
    4 · giữ lâu, không tiêu     98%      0%       50%      0%       1.2731×   1.2731×
    5 · cá voi, khoá 1%         98%      0%       50%      1%       1.2751×   1.2751×
```

Bộ A (nới) và C (siết) ở trong test output. Tóm tắt: A làm hồ sơ 1 bão hoà cả
`consum` lẫn `commit` (100%/100%) nên factor hết phân biệt được ai; C làm `consum`
của hồ sơ 1 xuống 5% và `commit` xuống 3%, tức hai factor thành vô dụng với người
dùng thường.

---

## 4. Ba phát hiện — đọc trước khi chọn số

### 4.1 MVP không phân biệt nổi người tiêu với kẻ đầu cơ

Hồ sơ 2 (đầu cơ, 10× số dư, không tiêu) và hồ sơ 3 (tiêu 200 MAGIC) ra **cùng
một con số 1.1499×**, ở *mọi* bộ hằng số. Thứ duy nhất phân biệt hai người này là
`consumedFactor` — đúng cái term bị tắt trong MVP.

Không bộ hằng số nào sửa được điều này. Nó là hệ quả cấu trúc của việc tắt 0.90Q
trên tổng 1.50Q.

### 4.2 MVP thưởng người giữ thụ động hơn người tiêu

Hồ sơ 4 (giữ lâu, **không tiêu gì**) = **1.2731×**
Hồ sơ 3 (mới, **tiêu 200 MAGIC**) = **1.1499×**

Người không đóng góp gì được trả cao hơn người tiêu nhiều nhất bảng. Đây là
ngược hẳn ý đồ thiết kế, và nó tự động biến mất khi `consumedFactor` bật (2.0499×
so với 1.2731×).

### 4.3 `commit_ref` tuyệt đối là trợ cấp cho cá voi

Đây là lý do tôi thêm hồ sơ 5. Với bốn hồ sơ đầu, B và B-rel gần như trùng nhau
(1.3331× vs 1.3330×) — nhưng chỉ vì tôi vô tình chọn `commit_ref` ≈ số dư người
dùng thường. Trùng hợp, không phải kết luận.

Cá voi 100k LAMP khoá 1000 LAMP (**1% số dư**):

| | commit factor | MVP |
|---|---|---|
| `commit_ref` tuyệt đối (B) | **100%** | **1.4731×** — cao nhất bảng |
| `commit_ref` theo tỉ lệ (B-rel) | 1% | 1.2751× |

Với bar tuyệt đối, cá voi bỏ tiền lẻ ra là vượt mặt cả người giữ lâu + có tiêu
(1.3331×). Bar theo tỉ lệ đọc đúng bản chất.

---

## 5. Đề xuất

| Tham số | Đề xuất | Vì sao |
|---|---|---|
| `commit_ref` | **theo tỉ lệ số dư** | §4.3. Bar tuyệt đối là lỗ, không phải tuning |
| `consumed_ref` | **100 MAGIC** (bộ B) | Tách được hồ sơ 1 (50%) khỏi hồ sơ 3 (100%). A cho cả hai 100%, C cho 5%/20% |
| `catch_up_cap` | **6** | α=1/6 ⟹ 6 bước ≈ 66.5% hội tụ, khớp cửa sổ làm mượt. Cap nhỏ hơn thì người vắng lâu không bao giờ đuổi kịp |
| `load_ref` | **chưa chốt được** | Chưa ai định nghĩa "network load" đo bằng gì. 1000 trong bảng là placeholder, không phải đề xuất |

## 6. Câu hỏi cho review

1. **MVP có nên ship khi `consumedFactor` tắt không?** §4.1 + §4.2 nói hệ thống
   lúc đó thưởng ngược. Ba hướng: (a) ship, chấp nhận 1 giai đoạn; (b) đổi trọng
   số riêng cho MVP để 0.90Q chia lại cho ba factor còn lại; (c) chặn tới khi có
   `did_commit` thật. Tôi không tự chọn — đây là quyết định kinh tế, không phải kỹ thuật.
2. **`network_load` đo bằng gì?** Không có định nghĩa thì `offPeakFactor` không
   implement thật được, và nó đang là +0.125Q phẳng cho tất cả mọi người.
3. **`max(Q, ·)` ngoài cùng không bao giờ chạm.** Mọi `rᵢ` đã clamp về [0,Q] và
   mọi trọng số không âm ⟹ tổng không âm. Tôi giữ vì spec viết vậy và vì nó là
   thứ duy nhất chặn một factor có dấu trong tương lai. Xác nhận là cố ý?

---

## 7. Đã kiểm

```
Eligibility aiken check    27 pass / 0 fail
Eligibility vitest         22 pass / 0 fail
```

`TV-ELIG-EMA-CONVERGENCE` ghim đúng cùng bốn số nguyên ở **cả hai phía** — đó là
răng của P8. Các số này **không** bằng 1−(5/6)ⁿ: α lưu là ⌊Q/6⌋ hơi nhỏ hơn 1/6,
và mỗi bước đều floor nên sai lệch cộng dồn. n=6 ra 665_102_021 trong khi giải
tích làm tròn thành 665_102_022. Bản implement là chuẩn — đừng "sửa" về phía giải
tích.

Chưa có validator, chưa có datum, chưa chạm InstantGen. Việc 3 mới làm phần đó.
