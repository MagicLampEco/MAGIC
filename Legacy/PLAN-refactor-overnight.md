# Kế hoạch hợp nhất MAGIC + bàn giao (soạn đêm 29/6, chờ anh duyệt)

> Tài liệu này tổng hợp kết quả nhóm Agent phân tích (đọc-only) + evidence build, để anh duyệt khi dậy.
> Chưa thực hiện thao tác khó-đảo nào (không move Legacy, không push, không xây lõi sai-hướng).

## 1. PHÁT HIỆN LỚN — phạm vi thực tế khác "refactor"

Code MAGIC hiện tại **KHÔNG có lớp tiền tệ của spec v0.3** (grep xác nhận = 0):
- Không có MintingPolicy native / policy-id → **MAGIC đang là "số kế toán" trong `VaultDatum`, KHÔNG chuyển nhượng**.
- Không có CDP/Vault sinh-nợ, MCR, `P_redeem`, GreenPeg/RedPeg, `cap_surplus`, `br_safe`.
- SnapshotGen + ScheduleGen = công thức CŨ (LF/OAC/khoá-tỉ-giá) — spec tự ghi "CHƯA cài".

⟹ Việc = **XÂY MỚI lớp tiền tệ** + **tái dùng ngoại vi** (SDK, scripts, khoá-LAMP-vault, ProtocolUtils, FlowRate, Paymaster — phần này build+test PASS, vững).

## 2. EVIDENCE BUILD (đã chạy thật — xem BUILD-STATUS-baseline.md)
9/9 project onchain có aiken.toml gốc **PASS** (~193 test). GetMAGIC + LampDistribution chưa có aiken.toml gốc → kiểm riêng (2 module này bị bản phân-tích bỏ sót, liên quan cửa nạp tiền user của AladinWork).

## 3. THỨ TỰ AN TOÀN (B0→B10)
- **B0. CHỐT THAM SỐ + dọn spec TRƯỚC** (chặn cứng — xem §5). Không code lõi khi tham số treo.
- **B1.** Karantin: VacuumGen + reports cũ + 8 file CARP-* lỗi-thời + branch paymaster → `/Projects/Legacy` (chờ anh duyệt mới move).
- **B2.** Gộp về MỘT Aiken project + lib chung (types/math/backing). `aiken build` phải XANH (evidence) trước khi đi tiếp.
- **B3.** Re-apply param `lamp_asset_name` (ý 4vault) lên vault.ak hiện tại (Instant/Schedule) → mở khoá mainnet. Rủi ro thấp, làm sớm để có 1 mảng chạy thật.
- **B4.** XÂY MintingPolicy lõi (GreenPeg) + backing (B, br, g_min, cap_surplus) + INV-NO-UNBACKED/MINT-TWO-PATH. TRUNG TÂM.
- **B5.** CDP/Vault (đường-đúc 1) + P_redeem≡1 + liquidation + NSF. Phụ thuộc B4.
- **B6.** SnapshotMint (đường-đúc 2) viết-lại MATH (tích-phân, cap_surplus, cổng-đỏ, cashback-bound + HYBRID). Phụ thuộc B4-B5.
- **B7.** ConsumeMAGIC: kế-toán → token thật + 3-van (giữ pricing FIR). Phụ thuộc B4.
- **B8.** ScheduleMint/ScheduleBack (carry buffer-2 + waterfall + cổng-κ) + Escrow §5.2 (AladinWork). Phụ thuộc B7 + did_commit (giao Long).
- **B9.** RedPeg/RedBack/Treasury. Sau solvency-core.
- **B10.** did_commit thật + stress-test LAMP −50/−70/−85/−90%-flash (xác nhận g_min) + CI (.github/workflows, dựng từ B2). CỔNG genesis.

Vòng RÀ + TẤN CÔNG (anh yêu cầu) chèn sau mỗi B4-B9: completeness/nhất-quán critic + red-team kinh-tế (sim MECE) + red-team code/security (Aiken exploit). Lặp tới sạch, evidence thật.

## 4. CÂU TRẢ LỜI ca AladinWork (thuê "định danh cây" ORL-04)
"Người định danh" = Genie được thuê TẠO bản ghi định danh cho CÂY (không phải định danh người).
- **MAGIC:** phí nền-tảng CỐ ĐỊNH theo JobType (vd logo=10 MAGIC), KHÔNG theo giá HĐ. ORL-04 chưa chốt số (DAO param, pilot=0).
- **Phí từ:** bên mua (Aladin) trả phí nền-tảng; phí mạng mỗi thao tác escrow cả-2-bên. Giá dịch vụ VND đi off-chain, nền tảng không cắt %.
- **Phí đến:** tách 4 ngả (MagicLamp + AladinWork + App Treasury + Rice-pot). MÂU THUẪN phiên-bản: escrow v0.6 nói ĐỐT; chốt mới nói → Treasury KHÔNG đốt. Cần hợp nhất.
- **Vai DID:** job định-danh bắt buộc tier `credentialed_human` (sinh trắc, chống Sybil).
- **CHẶN:** escrow MAGIC on-chain bị chặn vì token MAGIC native CHƯA code (đúng phát hiện §1).
- Link test thực tế: sau khi xây token + escrow → CI GitHub Actions (anh duyệt push).

## 5. THAM SỐ ANH CẦN CHỐT (B0 — chặn cứng trước khi xây lõi)
| Tham số | Gợi ý từ mô phỏng | Cần anh |
|---|---|---|
| `g_min` (sàn nonLAMP) | **≥67%** (flash crash xác nhận lằn ranh) | chốt cứng? |
| `wᵢ` + số epoch tích phân SnapshotMint | 6 epoch | chốt trọng số |
| `κ` cổng Schedule | 0,6 | chốt |
| `protocol_cut_bps` (phí thực-đốt) | ? | chốt |
| `η` cọc escrow `B=max(B_min, η·V_job)` | ? | chốt |
| MCR_base + biên NSF | 200%, NSF≤1,4, biên [150%,300%] | xác nhận |
| HYBRID: mint=phí-thực-đốt-lõm? | có | xác nhận ghi §6 |
| Chuộc khi backing yếu: P_redeem≡1 (bất-công-thời-gian) hay theo-br | treo | **quyết** |

## 6. LUẬN ĐIỂM CŨ CỦA ANH cần loại (Agent rà thấy còn sót trong file lỗi-thời → Legacy)
Reward-CARP 300%-Treasury (kênh đúc thứ 3); "300% ngang DJED" (sai loại suy); MAGIC=số-kế-toán-không-chuyển-nhượng; ba-token LAMP/MAGIC/CARP; flywheel-đẩy-giá-LAMP; "tự lên 280%"; "zero-oracle cho định-giá" (thực ra oracle-dependent cho thế-chấp); g_min≥50% (đã nâng 67%).

## 7. ĐÃ LÀM (an toàn, đảo được)
- Branch `refactor/magic-unified`; `/Projects/Legacy` tạo (rỗng); spec chuẩn + session-state copy sang `MAGIC/SPEC/` (CARP gốc nguyên).
- aiken check 9 project (evidence). Dọn §6 g_min cho khớp §8/§12.

## 8. CHƯA LÀM (chờ anh) — không tự ý
- Move CARP/MAGIC*/VacuumGen → Legacy (khó-đảo).
- Push GitHub / CI (cần anh duyệt nội dung).
- Xây lõi B4+ (chờ chốt tham số §5).
- Gộp Aiken project B2 (rủi ro mất-logic, cần làm cẩn thận từng bước có test).
