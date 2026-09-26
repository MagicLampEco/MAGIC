// scripts/assetNames.ts — tên tài sản HẰNG (hex) của các NFT hạ tầng do kho này đúc.
//
// Tách khỏi `config.ts` vì `config.ts` đòi khoá Blockfrost và ví ngay lúc nạp mô-đun:
// một công cụ chỉ cần đọc hằng (như `gen_vault_tx_api_deployment.ts`, tự khai không đọc bí
// mật nào) mà import `config.ts` thì chết ở dòng đòi khoá trước khi làm được gì. `config.ts`
// dựng `ASSET_NAMES` từ chính bảng này, nên hai chỗ không lệch được.
export const STATIC_ASSET_NAMES = {
  um_nft:    "554d44",     // "UMD"
  shard_nft: "5348415244", // "SHARD"
  backing:   "425251",     // "BRQ" — BackingBeacon
} as const;
