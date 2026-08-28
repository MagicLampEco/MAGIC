# Legacy/scripts — kho lưu trữ, KHÔNG dùng cho deploy mới

Script deploy/test của 4 module mô hình cũ (`InstantGen`, `SnapshotGen`,
`VacuumGen`, `UMKeeper`). Giữ lại để đọc lại và tái dựng kết quả testnet cũ,
không phải để chạy cho mạng mới.

Deploy hiện hành nằm ở `scripts/` ở gốc repo.

## Vì sao ở đây

Bốn module trên đã chuyển xuống `Legacy/` (xem PR dời kho). Script trỏ vào
chúng nên chuyển theo — để `scripts/` ở gốc chỉ còn thứ chạy được. Không có CI
trong repo và script chạy bằng `tsx` nên không typecheck, nghĩa là đường dẫn
gãy sẽ không có gì báo cho tới lúc ai đó chạy thật.

## Đường dẫn

Script ở đây import theo:

- module legacy cùng cấp — `../../VacuumGen/…`, `../../UMKeeper/…`
- module legacy nằm sâu — `../../stale-genmodel-2026-07/InstantGen/…`,
  `…/SnapshotGen/…`, `…/Consolidate/…`
- thứ còn sống ở gốc — `../../../MagicSDK/…`, `../../../ScheduleGen/…`
- config dùng chung — `../../../scripts/config.js` (một bản duy nhất, không nhân đôi)

## Chạy (nếu thật sự cần)

```bash
cd Legacy/scripts && npm install
npm run test:instant      # ví dụ
```

Cần `aiken build` ở module tương ứng trước, vì `plutus.json` là artifact không
commit.
