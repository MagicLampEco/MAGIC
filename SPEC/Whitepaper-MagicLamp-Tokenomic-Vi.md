# Whitepaper MagicLamp Tokenomic — ĐÃ CHUYỂN (bia mộ)

> **File này KHÔNG còn là nguồn chân lý.** Chuyển 2026-07-17 vì mô hình sinh MAGIC trong đó đã lỗi thời.
> Giữ lại bia mộ này vì nhiều repo đang trỏ tới đường dẫn cũ (CARP, Launch, PhoenixKeyDID/Feecover, LampNetCloud/Loom).

## Đi đâu

| Bạn cần | Đọc ở |
|---|---|
| **Whitepaper tokenomic (bản mới)** | `/LAMP/docs/` — repo LAMP (MAGIC phụ thuộc LAMP một chiều) |
| **Cơ chế sinh MAGIC (chuẩn)** | `PhoenixKeyDID/Wakeme/spec/PhoenixKey-Wakeme-{Math,Tech}.md` — Wakeme là module primitive của PhoenixKey |
| **Công thức gen + hệ-số-tư-cách** | `MAGIC/Specs/` |
| **Bản cũ + bằng chứng vì sao bỏ** | `MAGIC/Legacy/stale-genmodel-2026-07/` |

## Sai ở đâu (tóm tắt — chi tiết ở Legacy README)

Bản cũ ghi **cổng-tiêu-thật**: *"Điều kiện cần (cả hai): (1) nắm LAMP đủ tư cách; (2) tiêu dùng thật trong epoch"*,
và công thức trung-bình-có-trọng-số 7 epoch `M = w₀·M(L₀) + … + w₆·M(L₆)`.

**Mô hình thật (GenDrip):** **chỉ cần nắm LAMP là sinh được MAGIC** — không có cổng tiêu-thật.
Lịch-sử-tiêu-dùng chỉ **nhân vào tỷ-lệ** sinh (hệ-số-tư-cách), không chặn quyền sinh.
Engine Gen **ĐỌC** `conditional_lamp` qua `reference_input`; **LAMP đứng yên** (I-ACT-7);
MAGIC = account-trong-Vault, không mint token, không policy-id.
