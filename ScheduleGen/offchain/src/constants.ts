// src/constants.ts — GenMAGIC v3.3 Constants (ScheduleGen)
export const Q                   = 1_000_000_000n;
// SLOTS_PER_EPOCH removed — network-specific. Use slotsPerEpoch(network) / msPerEpoch(network)
// from @magiclamp/protocol-utils.
export const OILDROP_PER_LAMP        = 1_000_000n;
export const NANOGIC_PER_MAGIC   = 1_000_000_000n;
export const SNAPSHOT_BASE_RATE_Q = 5_000_000_000n;   // R_snap [Constitutional]

// ── S(L) segments (§11.3, §19.6) [Constitutional] ────────────
export const S_SEG1_INTERCEPT_Q = 1_500_000_000n;
export const S_SEG1_SLOPE_Q     = 10_000_000n;
export const S_SEG2_KNEE        = 50n;
export const S_SEG2_INTERCEPT_Q = 2_000_000_000n;
export const S_SEG2_SLOPE_Q     = 5_000_000n;
export const S_SEG3_KNEE        = 150n;
export const S_SEG3_INTERCEPT_Q = 2_500_000_000n;
export const S_SEG3_SLOPE_Q     = 2_500_000n;

// ── Schedule params (§19.6) ───────────────────────────────────
export const SCHEDULE_MIN_LENGTH     = 10n;           // [Significant]
export const SCHEDULE_MAX_LENGTH     = 200n;          // [Significant]
export const MIN_LAMP_PER_FIRE       = 1_000_000n;    // 1 LAMP [Routine]
export const SCHEDULE_DELAY          = 2n;             // epochs [Constitutional]
export const SCHEDULE_DECAY_WINDOW   = 1n;             // cliff [Constitutional]
export const MAX_FIRES_PER_TX_CATCHUP = 8;            // [Routine]
export const MAX_GEN_SCHEDULES       = 20;            // [Routine]
export const MAX_BATCHES_PER_VAULT   = 32;            // [Routine]
// Hạ 64 → 40 ngày 2026-09-14 — 64 nằm TRÊN trần ExUnit thật. Lý do + số đo ở
// `ScheduleGen/onchain/lib/magiclamp/protocol/constants.ak` ▸ `max_loyalty_holdings`.
// P8: hai bên phải đổi trong CÙNG commit.
export const MAX_LOYALTY_HOLDINGS    = 40;            // [Routine]

// ── Shard [Constitutional] ────────────────────────────────────
export const SHARD_COUNT = 16;
export const SHARD_CAP   = 450_000_000_000_000n;      // 4.5×10^14 oildrop = 450M LAMP per shard
export const PARTICIPATION_CAP_BPS = 2000;            // 20% [Routine]

// ── Testnet config ────────────────────────────────────────────
export const TESTNET_CONFIG = {
  network:          "Preview" as const,
  blockfrostUrl:    "https://cardano-preview.blockfrost.io/api/v0",
  vaultScriptHash:  "REPLACE_WITH_VAULT_SCRIPT_HASH",
  shardScriptHash:  "REPLACE_WITH_SHARD_SCRIPT_HASH",
  lampPolicyId:     "REPLACE_WITH_LAMP_POLICY_ID",
  lampAssetName:    "744c414d50",   // "tLAMP"
  shardNftPolicyId: "REPLACE_WITH_SHARD_NFT_POLICY_ID",
  shardNftAssetName:"5348415244",  // "SHARD"
};

// ══ BẢN CHÉP CÓ NHÃN từ InstantGen/offchain/src/constants.ts @ 1e9a72d9 ══
// Sửa một bên phải sửa bên kia cùng commit (BOUNDARIES P8); bài so giá trị:
// ScheduleGen/tests/genFormulaMirror.test.ts. Khối Aiken tương ứng: onchain/.../constants.ak.

// TẠM (`LENT_PP_CAP`, Spec §12) — trần phần sinh từ LAMP-mượn, nanogic/epoch.
export const LENT_PP_CAP = 1_000_000_000n;   // nanogic = 1 MAGIC/epoch

// ── Gen v2.0 — công thức sinh chung F(L, usage_ratio, GB) (SPEC §6.1.1–§6.1.3, §11) ──
// PHẢI trùng BIT với khối cùng tên trong
// `InstantGen/onchain/lib/magiclamp/protocol/constants.ak` (P8) — lý do + dẫn xuất ở đó.
// Hàm dùng các hằng này: `genFormula.ts`.
export const USAGE_FACTOR_FLOOR_Q  = 500_000_000n;               // TẠM, CC-GEN-USAGE-FLOOR
export const SCALE_COVERAGE_Q      = 1_000_000_000n;             // TẠM, CC-GEN-SCALE-COVERAGE
export const USAGE_WINDOW_LEN      = 7;                          // ô 0 = epoch mở, 1..6 = đã đóng
export const INSTANT_SCALE_HORIZON = 6n;                         // SPEC §6.1.4
export const GB_VAULT_SHARE_Q      = 50_000_000n;                // TẠM, CC-GEN-GB-VAULT-SHARE
export const GB_SHARD_CAP_NANOGIC  = 1_800_000_000_000_000n;     // TẠM, CC-GEN-SURPLUS-SHARD
export const BUFFER_EP             = 2n;                         // TẠM, SPEC §6.4 · §11 (ScheduleGen)
export const RHO_MAX_Q             = 4_000_000_000n;             // TẠM, chép từ apply-param GenBeacons rate_param

// ── Gen v2.0 gói (c): beacon + cổng κ TẠM — gương `onchain/.../constants.ak` (P8) ──
// Khối này là của RIÊNG ScheduleGen (không chép từ InstantGen). Bài so giá trị với
// `constants.ak`: `ScheduleGen/tests/datumV2.test.ts` ▸ "hằng Gen v2.0 gói (c)".
export const RATE_NFT_NAME        = "52484f";   // "RHO" — policy = hash script `rate_param`
export const GREENBACK_NFT_NAME   = "474242";   // "GBB" — policy = hash script `greenback_beacon`
export const GB_SHARD_NFT_PREFIX  = "474253";   // "GBS" ‖ byte(shard_id)
// Không có trong `constants.ak` của ScheduleGen (két không đọc sổ); shard GB đọc nó —
// chép có nhãn từ `GenBeacons/onchain/lib/genbeacons/constants.ak` ▸ `vault_registry_nft_name`.
export const VAULT_REGISTRY_NFT_NAME = "565247"; // "VRG"
// Beacon GreenBack phải ghi TRONG epoch hiện tại (SPEC §6.1.3).
export const GREENBACK_BEACON_MAX_AGE_EPOCHS = 0n;
// horizon của `scale_limit` cho ScheduleGen = min(N, 6) (SPEC §6.1.4).
export const SCHEDULE_SCALE_HORIZON_CAP = 6n;
// 🔴 Cổng κ TẠM, fail-closed (SPEC §6.4): trần trên `shard_obligation_nanogic` mỗi shard =
// `gb_shard_cap_nanogic`. Trỏ vào hằng, không gõ số — y như bản Aiken.
export const SCHEDULE_OBLIGATION_CAP_PER_SHARD = GB_SHARD_CAP_NANOGIC;
