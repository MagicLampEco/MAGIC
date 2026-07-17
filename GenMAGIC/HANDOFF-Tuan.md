# GenMAGIC v0.2 — bàn giao Tuân test

**Ngày:** 2026-07-17 · **Từ:** MAGIC agent (đại diện anh Aladin) · **Tới:** Tuân (owner) · review: Long
**Trạng thái:** code build + test đơn-vị XANH; **CHƯA sẵn sàng test tích hợp** — còn 3 điểm chờ anh Aladin chốt (mục ⚠️).

---

## 1. Đây là gì

Engine **GenMAGIC** — giải blocker Wakeme §3.7-1 (*"engine Gen ĐỌC số dư on-chain → drip MAGIC → KHÔNG spend LAMP"*).
Mô hình **GenDrip**: user nắm LAMP-điều-kiện trong vault Wakeme → engine đọc `conditional_lamp` qua `reference_input`
(KHÔNG spend) → nhỏ giọt MAGIC vào `MagicAccount`. **LAMP đứng yên** (I-ACT-7). MAGIC = account, không token/policy-id.

Thay **InstantGen + SnapshotGen cũ** (đã → `Legacy/stale-genmodel-2026-07/`). Bỏ hẳn UM/PM/LF/halving/profile/cổng-tiêu-thật.

**Spec chuẩn:** [`Specs/GenMAGIC-Math-Vi.md`](../Specs/GenMAGIC-Math-Vi.md) (v0.2).
**Biên bản 2 vòng hội đồng:** [`Specs/_council/`](../Specs/_council/) (v0.1: 48 phát hiện; v0.2-attack: 30 phát hiện).

## 2. Đã build + test (bằng chứng)

```bash
cd GenMAGIC/offchain && npm install && npm test     # → 32/32 pass
cd GenMAGIC/onchain  && aiken check                 # → 14 checks, 0 errors, 0 warnings
cd GenMAGIC/onchain  && aiken build                 # → plutus.json, validator hash bee708e4…
```

- `offchain/src/math.ts` + `onchain/lib/magiclamp/gen/math.ak` — **bit-identical (P8)**, cùng test vector.
- Test **tái lập 5 đòn** hội đồng đánh sập v0.1 (vault giả 2 ADA `c=10¹²`, kíp nổ `vest_start_slot=10¹⁸`,
  lệch thừa số Q, floor nuốt G1, thấp-điểm không thang) → v0.2 chặn cả 5.

## 3. Em ĐÃ vá (hội đồng tấn công 17/7)

| Mã | Lỗ | Vá |
|---|---|---|
| **B2** | `nhip_tran` khai mà validator không ép → over-issuance không trần (5/5 trục) | `gen_magic.ak`: thêm `expect nb.nhip_gen <= nb.nhip_tran` |
| **B5** | double-satisfaction (first-match address, value không bảo toàn) | count-guard đúng-1-input + đúng-1-output + `acc_out.value == own_in.value` |
| **S6** | không kiểm nhất quán `so_lieu` | thêm `expect so_lieu.tieu_thap_diem <= so_lieu.da_tieu` |

Ba vá này là bất biến VALIDATOR ⟹ cần **test tích hợp** (mock tx / testnet) để xác nhận — test đơn-vị hiện chỉ phủ math.

## 4. ⚠️ CHẶN — chờ anh Aladin chốt TRƯỚC khi test tích hợp có nghĩa

**B1 — datum vault 7-field vs 9-field.** `types.ak` giả định `ActivationVaultDatum` **7 field** (mô hình closed-loop-pot
`@3d5fdce`). Nhưng `PhoenixKey-Validator` đang commit datum **9 field** (v4.1: thêm `vested_unlocked`, `idle_epochs_p2`).
Aiken decode 9→7 **CRASH** ⟹ drip BẤT KỲ vault sống nào cũng fail. **Em không verify được nhánh nào đang là main**
(gh 404 repo private; local mirror fetch hỏng). → **Cần Tuân/Long xác nhận nhánh Wakeme chuẩn**, rồi em sửa `types.ak` khớp.

**B3 — account chưa có genesis/uniqueness.** Ai cũng pay-to-script tạo `MagicAccount` datum bịa; 1 DID tạo N account
cùng trỏ 1 vault → drip N lần/epoch. Cần cơ chế: NFT-singleton per-DID **hoặc** engine dedup did_commit trước khi ký.
→ **quyết định kiến trúc**.

**B4 — `đã_tiêu` vô căn cứ (gãy trụ cột G4).** `so_lieu.da_tieu` chỉ là số trong redeemer, on-chain chỉ kiểm "engine ký",
KHÔNG nối với Σburns thật của ConsumeMAGIC. Vì G9 reset mỗi epoch, "tiêu" phần dư **chi phí = 0** ⟹ ghim `r_tieu=Q`
miễn phí ⟹ đạt công-dân-hạng-nhất không trả đồng nào. **INV-G4 đúng về hệ số nhưng vô nghĩa khi input bịa 100%.**
→ **quyết định thiết kế** (3 hướng trong biên bản: nối phí-thật, Merkle-anchor kiểm-chứng-được, hoặc hạ nhãn INV-G4 thành trust-assumption).

## 5. Sửa trước mainnet (không chặn happy-path)

S1 xác thực vault-NFT (`H_did` canonical off-chain) · S2 epoch cứng → brick account · S3 cold-start e=0 chưa có
đối ứng .ak · S4 `w_thap` code (0.2Q) ≠ spec (0) · S5 over-budget khi B<N · S7 did_commit binding ConsumeMAGIC.
Chi tiết + neo `file:dòng`: biên bản `Specs/_council/`.

## 6. Thứ tự đề xuất

B1 (để test chạy) → B2/B5/S6 (em vá rồi, cần test tích hợp) → B3/B4/S1-S4 (chờ anh Aladin) → S5/S7.

## 7. Chưa làm (ngoài phạm vi phiên này)

- **ScheduleGen** viết lại theo GenDrip (bản cũ fire-LAMP→Treasury vi phạm I-ACT-7) — nuôi `cam_kết_lịch`.
- **ConsumeMAGIC ↔ GenMAGIC nối dây** (`đã_tiêu` = Σburns thật) — chính là B4.
- **`scripts/` gốc** dựng lại (deploy cũ UM/vacuum/instant — mô hình chết).
- **Tx testnet thật** — ví Preview đã sẵn (3787 tADA + tLAMP 20 NGUYÊN-LAMP), chờ B1 chốt datum.
