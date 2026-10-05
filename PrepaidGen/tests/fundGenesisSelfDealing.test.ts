// tests/fundGenesisSelfDealing.test.ts — hai thay đổi chủ dự án chốt 2026-10-05:
//   (1) chặn TỰ HƯỞNG ở genesis quỹ: payment credential của `beneficiary` ≠ khoá
//       `platform`, và ≠ payment credential của `sponsorship.sponsor` (quỹ tài trợ);
//   (2) sàn đệm buffer-Paid `MIN_BUFFER_BPS` hạ 1500 → 0 (công thức `bufferFloor` giữ nguyên).
//
// Gương `prepaid.ak` ▸ `validate_mint_fund_nft` (cặp bài Aiken `fg_mint_beneficiary_*`,
// `rc_g5_*`, `fg_mint_buffer_*`, `pp_fund_claim_*buffer*`). Mỗi bài âm có một bài dương
// cực đối chỉ khác đúng chỗ cổng đo.

import { credentialToAddress, type Network, type UTxO } from "@lucid-evolution/lucid";
import { describe, expect, it } from "vitest";
import { MIN_BUFFER_BPS } from "../offchain/src/constants.js";
import { bufferFloor } from "../offchain/src/math.js";
import { assertFundGenesis, fundAfterClaim, maxClaimable } from "../offchain/src/prepaid.js";
import { planMintPaidFund } from "../offchain/src/tx/builders.js";
import type { PrepaidScripts } from "../offchain/src/tx/scripts.js";
import type { PaidFundDatum, PlutusAddress } from "../offchain/src/types.js";

const NET: Network = "Preprod";
const FUND_HASH = "44".repeat(28);
const VAULT_HASH = "11".repeat(28);
const PLATFORM = "77".repeat(28);
const BEN_PKH = "be".repeat(28);
const SPONSOR_PKH = "5b".repeat(28);
const SPONSOR_STAKE = "5d".repeat(28);
const OWNER_COMMIT = "c0".repeat(32);
const E9 = 1_000_000_000n;

const keyAddr = (h: string): PlutusAddress => ({
  payment_credential: { VerificationKey: [h] },
  stake_credential: null,
});
const scriptAddr = (h: string): PlutusAddress => ({
  payment_credential: { Script: [h] },
  stake_credential: null,
});
// Địa chỉ BASE của bên tài trợ — hình dạng T2 ghim nguyên văn.
const SPONSOR: PlutusAddress = {
  payment_credential: { VerificationKey: [SPONSOR_PKH] },
  stake_credential: { Inline: [{ VerificationKey: [SPONSOR_STAKE] }] },
};

function clean(over: Partial<PaidFundDatum> = {}): PaidFundDatum {
  return {
    fund_id: "aa".repeat(32),
    platform: PLATFORM,
    vault_hash: VAULT_HASH,
    carp_locked: 0n,
    credit_issued: 0n,
    magic_settled: 0n,
    provider_claimed: 0n,
    buffer_bps: MIN_BUFFER_BPS,
    last_updated_epoch: 0n,
    beneficiary: keyAddr(BEN_PKH),
    beneficiary_datum: null,
    sponsorship: null,
    sponsor_reclaimed: 0n,
    ...over,
  };
}

const sponsored = (beneficiary: PlutusAddress): PaidFundDatum =>
  clean({ beneficiary, sponsorship: { sponsor: SPONSOR, owner_commit: OWNER_COMMIT } });

describe("genesis quỹ — chặn tự hưởng, vế platform (2026-10-05)", () => {
  it("ÂM — beneficiary là chính khoá platform", () => {
    expect(() => assertFundGenesis(clean({ beneficiary: keyAddr(PLATFORM) }), FUND_HASH)).toThrow(
      /khoá platform/,
    );
  });

  it("ÂM — so không phân biệt hoa/thường (pkh platform viết hoa)", () => {
    expect(() =>
      assertFundGenesis(clean({ beneficiary: keyAddr(PLATFORM.toUpperCase()) }), FUND_HASH),
    ).toThrow(/khoá platform/);
  });

  it("DƯƠNG cực đối — chỉ khác hash khoá bên hưởng", () => {
    expect(assertFundGenesis(clean({ beneficiary: keyAddr(BEN_PKH) }), FUND_HASH)).toEqual([
      PLATFORM,
    ]);
  });

  it("DƯƠNG — cùng 28 byte của platform nhưng là SCRIPT (khác credential)", () => {
    expect(() =>
      assertFundGenesis(
        clean({ beneficiary: scriptAddr(PLATFORM), beneficiary_datum: "0b0b" }),
        FUND_HASH,
      ),
    ).not.toThrow();
  });
});

describe("genesis quỹ tài trợ — chặn tự hưởng, vế sponsor (2026-10-05)", () => {
  it("ÂM — beneficiary là địa chỉ ENTERPRISE của chính khoá tài trợ (sponsor là base)", () => {
    expect(() => assertFundGenesis(sponsored(keyAddr(SPONSOR_PKH)), FUND_HASH)).toThrow(
      /bên tài trợ/,
    );
  });

  it("DƯƠNG cực đối — chỉ khác hash khoá bên hưởng", () => {
    expect(() => assertFundGenesis(sponsored(keyAddr(BEN_PKH)), FUND_HASH)).not.toThrow();
  });

  it("DƯƠNG — quỹ KHÔNG tài trợ, beneficiary = khoá của một ví tài trợ ở nơi khác: không áp vế sponsor", () => {
    expect(() =>
      assertFundGenesis(clean({ beneficiary: keyAddr(SPONSOR_PKH) }), FUND_HASH),
    ).not.toThrow();
  });
});

// ── Sàn đệm buffer-Paid = 0 ──────────────────────────────────────────────────
const scripts: PrepaidScripts = {
  network: NET,
  params: {
    carpPolicyId: "22".repeat(28),
    carpAssetName: "5a".repeat(28),
    msPerEpoch: 86_400_000n,
    windowOriginMs: 0n,
    wakemeVaultHash: "ab".repeat(28),
  },
  vault: {
    script: { type: "PlutusV3", script: "" },
    hash: VAULT_HASH,
    address: credentialToAddress(NET, { type: "Script", hash: VAULT_HASH }),
  },
  paidFund: {
    script: { type: "PlutusV3", script: "" },
    hash: FUND_HASH,
    address: credentialToAddress(NET, { type: "Script", hash: FUND_HASH }),
  },
  carpUnit: "22".repeat(28) + "5a".repeat(28),
};

const seedUtxo: UTxO = {
  txHash: "55".repeat(32),
  outputIndex: 0,
  address: credentialToAddress(NET, { type: "Key", hash: PLATFORM }),
  assets: { lovelace: 5_000_000n },
  datum: null,
  datumHash: null,
  scriptRef: null,
};

const mint = (bufferBps: bigint, beneficiary: PlutusAddress = keyAddr(BEN_PKH)) =>
  planMintPaidFund({
    scripts,
    seedUtxo,
    platformPkh: PLATFORM,
    beneficiary,
    beneficiaryDatum: null,
    bufferBps,
    collectSeed: true,
  });

describe("sàn đệm buffer-Paid = 0 (chủ dự án chốt 2026-10-05)", () => {
  it("MIN_BUFFER_BPS == 0n", () => {
    expect(MIN_BUFFER_BPS).toBe(0n);
  });

  it("DƯƠNG — genesis buffer_bps = 0 dựng được, datum mang 0", () => {
    expect(mint(0n).datum.buffer_bps).toBe(0n);
  });

  it("ÂM cực đối — buffer_bps = −1 bị bộ dựng chặn (C-PP-15)", () => {
    expect(() => mint(-1n)).toThrow(/C-PP-15/);
  });

  it("ÂM — bộ dựng genesis từ chối beneficiary = khoá platform (qua assertFundGenesis)", () => {
    expect(() => mint(0n, keyAddr(PLATFORM))).toThrow(/khoá platform/);
  });

  it("bufferFloor(x, 0) == x — công thức giữ nguyên, sàn đúng bằng outstanding", () => {
    expect(bufferFloor(0n, 0n)).toBe(0n);
    expect(bufferFloor(500n * E9, 0n)).toBe(500n * E9);
    expect(bufferFloor(36_000_000_000_000_000_000n, 0n)).toBe(36_000_000_000_000_000_000n);
  });

  // Cặp với bài Aiken `pp_fund_claim_zero_buffer_to_outstanding_ok` /
  // `pp_fund_claim_same_amount_buffer_1500_rejected`: C = 1e9, M = 0,5e9.
  const half = (bps: bigint): PaidFundDatum =>
    clean({ carp_locked: E9, credit_issued: E9, magic_settled: E9 / 2n, buffer_bps: bps });

  it("DƯƠNG — đệm 0: rút tới ĐÚNG outstanding (0,5e9)", () => {
    expect(maxClaimable(half(0n))).toBe(E9 / 2n);
    expect(fundAfterClaim(half(0n), E9 / 2n, 1n).carp_locked).toBe(E9 / 2n);
  });

  it("ÂM cực đối — cùng lượng rút, đệm 1500 ⟹ phá sàn 0,575e9", () => {
    expect(() => fundAfterClaim(half(1_500n), E9 / 2n, 1n)).toThrow(/C-PP-6/);
  });
});
