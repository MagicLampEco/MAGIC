# ConsumeMAGIC — ORCHESTRATION (v3, mở rộng điều-phối CARP + Feecover)

> Trạng thái: **THIẾT KẾ** (anh chốt 2026-07-31, 3 hội đồng: game-theorist · optimizer · auditor-cardano).
> Mở rộng `CONTRACT.md` v2 (KHOÁ) — KHÔNG phá bất biến v2. v2 = lõi pricing+tiêu-MAGIC; doc này thêm lớp
> ĐIỀU-PHỐI: tiêu-MAGIC + mint/rút-CARP (CarpetMint) + ứng-ADA (Feecover/Phoenix) trong ÍT tx nhất.
> Caller: **AladinWork · OriLife · ProofChat**. Deploy: **Preview + Preprod**.
> Nguồn: `_Agents/topics/consumemagic-orchestration.md` (3 bản đồ discovery + 3 ghế hội đồng + gate).

## §0. Phạm vi + nguyên tắc

ConsumeMAGIC-orchestration là **lớp COMPOSER off-chain** dựng 1 tx đa-validator. Caller truyền:
**(a) cần tiêu bao nhiêu MAGIC** (caller tự tính, hàm KHÔNG tính hộ) **(b) CARP chuyển về đâu**. Hàm điều phối
mọi mảnh tx còn lại. KHÔNG phải 1 validator khối — mỗi module dựng mảnh-tx của mình theo interface-contract.

**Ba token (nhắc):** LAMP (nền, collateral), CARP (ANCHOR, native token, đồng-thanh-toán, mint qua CDP kèm nợ),
MAGIC (CREDIT, số kế toán, KHÔNG token/mint/burn, **fungible — cấm nhãn-nguồn**).

## §1. Bất biến KHOÁ v2 KHÔNG được phá (từ CONTRACT.md)

1. MAGIC = số kế toán, **KHÔNG tx.mint**. CARP-mint là native asset TÁCH khỏi lớp MAGIC.
2. Vault = nơi DUY NHẤT giảm MAGIC (qua `BurnBatch`). Consume chỉ ép `Σburns == required`.
3. **C-CM-1 value-preservation @engage TUYỆT ĐỐI**: Engage UTxO chỉ ADA + thread NFT. **CARP/ADA-transfer KHÔNG đi qua Engage UTxO** — đi UTxO/validator khác.
4. `Σburns == required` (`==`, AGGREGATE chống pay-once-consume-N). did_commit immutable, stale-price gate.
5. **KHÔNG refund/un-burn** — consume tại RELEASED.
6. **consume KHÔNG gác phía mint** (PoC verify: mint 10¹² CARP vẫn pass). Mỗi leg TỰ gác; an-toàn-CARP nằm ở CarpetMint, KHÔNG ở consume.

## §2. Hai ví dụ OriLife (đã hoà giải với anh — giữ nguyên bất biến)

**ex1 — định danh cây:** consume 3 MAGIC + chuyển 1 CARP vào OriLife Vault.
- Nguồn 1 CARP theo `br` (§4): nếu user đã cầm CARP → dùng CARP đó (br vô can). Nếu hệ phải cấp → route theo bảng-br.

**ex2 — thuê thợ (Oanh không có CARP, có LAMP, đã hết hạn-mức-gen-từ-LAMP):**
1. Oanh mở CDP khoá LAMP → **mint 108 CARP** (một event, một **GreenCheque** nợ = 108, MCR≥2.0).
2. Route: **100 → Pledge** (khoá, hoàn Oanh khi xong) · **5 phí → "người" đối-ứng-LAMP** · **3 → PrepaidGen**.
3. **PrepaidGen: 3 CARP → 3 MAGIC** (PSM-par 1:1; cửa gen nguồn CARP vì hết hạn-mức-LAMP).
4. **Consume 5 MAGIC** (2 sẵn + 3 mới, **fungible — không nhãn nguồn**). Cơ sở VP + hệ-số-gen epoch sau.

**GreenCheque** (khái niệm CarpetMint): công-cụ-nợ khi mint CARP, 2 phần — (a) Pledge → hoàn borrower; (b) phí → LAMP-backer.

## §3. Bất biến bảo-toàn (thay "Pledge không quy đổi", anh chốt §3)

Bản cũ "Pledge-CARP không quy đổi consumed" **BẤT KHẢ THI** — đó là nhãn-nguồn (nghịch fungibility); cross-tx
không chặn được ở value-level (Pledge nhả ra thành CARP tự do, tx sau nạp PrepaidGen bình thường). Viết lại:

> **`INV-CARP-ROLE-ONCE`:** một đơn-vị CARP khoá phục vụ **đúng MỘT vai tại một thời điểm** — hoặc Pledge-refund-lỏng,
> hoặc collateral-sinh-MAGIC (PrepaidGen), **KHÔNG đồng thời cả hai** (double-use cùng token trong một motion).
> Enforce ở **Pledge-validator** (khi-đang-khoá): CARP đang khoá Pledge KHÔNG được đồng thời là input PrepaidGen.
> Sau khi Pledge nhả (hết hợp đồng), Oanh tự nạp CARP đó vào PrepaidGen = **hợp lệ** (PrepaidGen tự-back bình thường,
> cô đánh đổi CARP-chuyển-nhượng lấy MAGIC-non-transfer). Đây KHÔNG phải lạm dụng.

## §4. Nguồn CARP theo trạng thái GreenBack (br) — bảng chốt

**Định lý hội đồng:** MINT qua CDP (MCR≥2.0) là **br-TĂNG/accretive** (`Σcol≥2·Σdebt ⟹ br≥2` tự-động); cap_surplus-GEN
+ RÚT-tồn là **br-GIẢM**. ⟹ gate cái RÚT chặt hơn cái BƠM.

| `br` GreenBack | MINT mới (CDP) | RÚT GreenBack-tồn | cap_surplus GEN |
|---|---|---|---|
| ≥ 2.0 Deep-Green | cho | **RÚT (rẻ hơn, buffer thừa thật)** | full (rationed §5) |
| 1.5–2.0 Green | **ƯU TIÊN (accretive)** | hạn chế | cho (rationed) |
| 1.0–1.5 Đỏ-Conformant | **CHO (accretive = hồi phục)** | từ chối | **0 (van đỏ)** |
| 0.9–1.0 Watch | hạn chế (self-collateral) | từ chối | 0 |
| < 0.9 Mất-nhãn | **TỪ CHỐI (chống xoắn ốc)** | từ chối | 0 + kích 5-bậc-cứu |

- Biến-quyết = **br + mức GreenBack-tồn**, KHÔNG phải "user có CARP không" (điều đó chỉ quyết trục NỢ GreenCheque).
- Đọc `br` = **br-beacon reference-input** (fixture Preview) — CHỈ trên đường MINT; tồn đọc off-chain (Blockfrost, free).
- Hệ **tự route** (mint vs rút), KHÔNG đẩy quyết định cho user (chống mệt-mỏi-quyết-định).

## §5. Rationing cap_surplus — 16-shard decrementing (anh chốt §1)

cap_surplus rút pool-backing CHUNG → không accumulator thì N chủ-thể vượt backing (lỗ Q2, phía SINH/rút).
**Vá (tái dùng `SHARD_COUNT=16`/`SHARD_CAP` ScheduleGen):** keeper đầu epoch chia tổng-surplus-khả-cấp vào 16 shard;
mỗi gen/rút **SPEND-và-DECREMENT** một shard → **trần toàn-cục CỨNG = Σ shard-cap**, atomic on-chain, "N chủ-thể"
biến mất, contention/16. KHÔNG pro-rata beacon-read. **Nửa phía MINT-CDP KHÔNG cần rationing** (conservation MCR≥2).
Neo cuối fail-safe = `⌊L_avail×RATE/Q⌋` (LAMP-khoá vật lý, độc-lập-oracle).

## §6. Kiến trúc composer — 2 path (tách theo ràng buộc VẬT LÝ eUTXO)

Ràng buộc cứng: **tx KHÔNG spend output do chính nó tạo** → nếu PrepaidGen tạo batch MAGIC mà consume phải burn
trên CÙNG vault UTxO → buộc 2 tx (trừ khi gộp redeemer `GenBurn` — xem §8).

**HOT-PATH (per-engagement) — gộp tối đa 1 tx:**
```
1. off-chain: query GreenBack-tồn + br-beacon → quyết mint_amt vs withdraw_amt (theo bảng §4, rút-tồn khi Deep-Green)
2. off-chain: VeData.reserveAnchor(cid,did) → thường {deferred:true, ada_now:0}
3. dựng tx (co-spend, dùng reference-script CIP-33 — KHÔNG inline kẻo vỡ 16KB):
   spend: consume.ak[engage] + vault[BurnBatch] + prepaid_vault[+N] + paid_fund[CARP]
        + CarpetMint.CDP[lock LAMP]        ; mint: CARP-policy[108, debt=GreenCheque]
   ref:   PriceParam · GlobalState(ρ) · br-beacon        (read-only, không contention)
   out:   Pledge-lock 100 · phí 5→backer · PrepaidGen-commit 3 · engage-cont · CDP-cont(debt)
   ADA:   Phoenix.feecoverAdvance (ứng phí tx)
4. balance (Lucid tự tính phí từ ExUnit) → ký (engine oracle + Feecover, KHÔNG chữ ký user — giữ UX drip)
```
ExUnit đo PoC: consume-composed 1.16M mem/372M cpu; 6 script ≈ 5–8M mem < 14M, cpu < 10B → **FIT**.

**COLD-PATH (1×/epoch, batched — CẤM nhét hot):**
- Feecover `SettleEpoch` co-spend `treasury_core.Collect` — sweep TOÀN BỘ repay CARP → Treasury 1 tx (contention).
- VeData anchor-batch — Merkle root nhiều CID → 1 anchor tx.

## §7. Interface-contract tới 3 module (composer chỉ giữ data-format + thứ tự + bất-biến)

```
CarpetMint.sourceCarp({ need, backingDid, lampCollateralUtxo, greenbackHint, brBeaconRef })
  → fragment{ inputs, outputs, mints, debtUtxo(GreenCheque) }   // TỰ chọn mint/rút theo br+tồn (§4)
VeData.reserveAnchor(cid, did)
  → { deferred: bool, ada_now: bigint, anchor_receipt: bytes }  // thường deferred=true, ada_now=0
Phoenix.feecoverAdvance(txDraft)
  → { fundedInputs, expectedRepayCarp, accrualUtxo }            // ứng ADA per-user; settle CARP cold-path
```
- **VeData KHÔNG là oracle-số-ADA** — đóng mảnh-tx, Lucid tự tính phí. Anchoring vốn BATCHED → không vào hot-tx.
- Composer điều phối cross-module được (eUTXO: 1 tx spend UTxO nhiều validator) — điều kiện: **không validator nào đòi
  độc-quyền-tx** (consume.ak tolerant — verified; CarpetMint/treasury chưa verify vì chưa code).

## §8. 4 điều-kiện FAIL-CLOSED bắt buộc trước deploy (auditor)

1. **BackingBeacon vắng/stale → CARP-mint + gen-từ-LAMP REJECT** (CarpetMint + InstantGen cap_surplus). br-param 28-byte-0 = cửa ĐÓNG.
2. **`debt == minted_NET` toàn-tx** trên policy CARP (CarpetMint) — phủ TỔNG mint bất kể 3 đích (Pledge/phí/PrepaidGen), không phủ từng đích.
3. **`ρ_cap`/`ρ_floor` compile-time** (không chỉ band/rate-limit) — chống genesis-spike ("lỗ lớn nhất CDP-mint").
4. **Feecover settle tách tx 1×/epoch**; per-consume chỉ advance-ADA.

## §9. 6 điều-kiện CỨNG (hội đồng game-theorist — chống lạm dụng)

1. Xanh chỉ nới **suất gen**, TUYỆT ĐỐI không nới collateral-terms/fee CARP-mint (chặn mint-and-dump).
2. `INV-CARP-ROLE-ONCE` (§3) — bảo-toàn, không nhãn-nguồn.
3. Fee GreenCheque: **backer ⟂ borrower ⟂ consumer** theo DID + phần fee = **sink Treasury** (γ<1); default "người đối-ứng LAMP" = GreenBack (fee→sink), backer-tư-nhân chỉ kênh mở rộng có cut-sink.
4. `INV-CONSUMED-ATTRIB` (§6.2 canonical) — tư-cách thành-phần-2 cross-DID/did_commit-gate (chống reflexive-gen-amplifier).
5. Rationing = 16-shard decrementing (§5) + cap per-DID lõm; KHÔNG pro-rata beacon.
6. Thanh-lý CDP chỉ chạm collateral-đã-pledge (không vét ví khác); MCR/fee cố định tại commit (không hồi tố); đền-bù thiếu từ 5-bậc-cứu.

## §10. Ranh giới module + trạng thái build

| Leg | Nội dung | Chủ | Trạng thái |
|---|---|---|---|
| **A** | consume.ak + vault BurnBatch + PriceParam | **MAGIC (tự làm)** | CÓ code, `aiken check` 24/24 |
| **C** | PrepaidGen (prepaid_vault + paid_fund + fund_nft) | **MAGIC (tự làm)** | CÓ code biên dịch |
| **Composer** | dựng tx đa-validator off-chain | **MAGIC (tự làm)** | CHƯA — xây mới |
| **B** | CarpetMint CDP + CARP-policy + GlobalState-ρ + GreenCheque + br fail-closed | CarpetMint (interface) | **ZERO code — BLOCKED** |
| **D** | Feecover provider-vault + treasury_core.Collect + did_commit | PhoenixKey (interface) | design B3, chưa build |

**🔴 CẤM deploy compose leg-B tới khi CarpetMint enforce đủ §8** (genesis-spike risk). MAGIC làm được NGAY: leg A+C +
composer-skeleton + deploy Preview leg-tiêu-MAGIC (không CARP). leg-B/D nối khi CarpetMint/Phoenix sẵn sàng.

## §11. Việc phải làm (thứ tự)

1. **MAGIC-side (không blocker):** composer-skeleton (leg A+C), helper `vaultBurnRedeemerCbor`+constr cho caller, deploy Preview leg-tiêu-MAGIC, e2e AladinWork↔consume.
2. **Soạn inbox CarpetMint** (duyệt-trước-gửi): trả H1-H6 + 4 fail-closed §8 + `debt==minted_net` + br-beacon + xác nhận "GreenBack-tồn là nguồn-rút hợp lệ khi kèm GreenCheque" + `sourceCarp` interface.
3. **Soạn inbox Phoenix:** CARP policy_id/asset_name/bytes (blocker B2) + `feecoverAdvance`/settle interface.
4. **Chờ CarpetMint/Phoenix** → nối leg-B/D → e2e đủ.
5. **Carpet-CARP-DacTa-Vi.md CHƯA tồn tại** — GreenBack/GreenCheque/RedBack/5-bậc cần spec riêng (ai viết: chờ anh phân — CarpetMint-team hay MAGIC).

## §12. Câu hỏi treo cần anh/CarpetMint

- **Lối-A gộp 1 tx** cần sửa vault redeemer `BurnBatch` (thêm field ĐUÔI `gen_prepaid`) = đụng **C-CM-2 interface KHOÁ v2** → chờ anh + consume-maintainer duyệt. Không thì Lối-B 2 tx (chênh ~0.3 ADA, chấp nhận được — **đo ExUnit Preview trước rồi quyết**).
- `sourceCarp` "GreenBack-tồn có phải nguồn-rút hợp lệ khi kèm GreenCheque" — CarpetMint xác nhận (H1-H6).
- Chủ `br_q` toàn-hệ (anh Aladin tầng instance) — 16-shard cần keeper refresh tổng-surplus; nguồn số đó?
