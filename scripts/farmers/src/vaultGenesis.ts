// scripts/farmers/src/vaultGenesis.ts — mở vault (genesis) cho một nông dân.
//
// TODO — CHƯA DỰNG. Lý do, theo thứ tự nặng nhẹ:
//   1. Genesis phải đúc NFT one-shot danh tính vault cùng tx (BOUNDARIES §2 ▸ INV-VAULT-IDENTITY,
//      `asset_name = blake2b_256(cbor.serialise(seed))`, policy = script hash vault). Quên là LAMP
//      kẹt vĩnh viễn — nên bộ dựng này phải có cặp ca kiểm dương/âm TRƯỚC khi có đường live.
//   2. Datum genesis mang `owner` — phải đi qua owner.ts ▸ ownerOf (adapter duy nhất), vì
//      `owner` sắp đổi sang Credential. Viết bộ dựng trước lần đổi đó là viết hai lần.
//   3. INV-ONE-PERSON-ONE-VAULT chưa được ép ở cổng genesis (BOUNDARIES §2) ⟹ ràng buộc tạm
//      "chỉ testnet"; bộ dựng không được giả định tra ngược vault → DID.
//   4. Bộ dựng tham khảo đang có dùng ví deploy làm chủ: scripts/deploy/05_create_instant_vault.ts,
//      scripts/deploy/07_create_schedule_vault.ts — cần tách phần dựng tx khỏi phần chọn ví
//      trước khi gọi được cho ví nông dân.
// Tới khi có bộ dựng: executor trả `skip` với câu dưới đây, và mọi bước phụ thuộc vault ghi
// `skip dependency-not-done` — không bước nào im.

export const VAULT_GENESIS_STATUS =
  "chưa có bộ dựng genesis vault cho ví nông dân (scripts/farmers/src/vaultGenesis.ts: TODO — cần NFT danh tính + owner qua ownerOf)";
