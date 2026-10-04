// tests/fundReclaim.test.ts — phần SỔ + kế hoạch giao dịch của `FundReclaim`
// (DESIGN-reclaim §10.6), gương `prepaid.ak` ▸ `validate_fund_reclaim` /
// `validate_fund_close` / `sponsor_payout`.
//
// Số liệu trùng bài Aiken `rc_*` (par_scale = 1):
//   tiếp nối: C = 10e9, M = 4e9, P = 1e9 ⟹ carp = 9e9, R = 6e9, E = 3e9
//   đóng:     C = 10e9, M = 4e9, P = 4e9 ⟹ carp = 6e9, R = 6e9, E = 0
//
// Bộ này KHÔNG chạy validator (không có két Wakeme trong emulator). Nó ghim rằng
// bộ lập kế hoạch dựng ĐÚNG hình dạng mà validator đòi; phần validator chấp nhận
// hình dạng đó do bài Aiken `rc_*` ghim.

import {
  credentialToAddress,
  getAddressDetails,
  type Network,
  type UTxO,
} from "@lucid-evolution/lucid";
import { Data } from "@lucid-evolution/lucid";
import { describe, expect, it } from "vitest";
import {
  fundAfterClaim,
  fundAfterLock,
  fundAfterReclaim,
  fundAfterSettle,
  maxClaimable,
  reclaimAmount,
} from "../offchain/src/prepaid.js";
import {
  encodeFundDatum,
  fundClaimRedeemer,
  fundReclaimRedeemer,
} from "../offchain/src/tx/codec.js";
import {
  planFundReclaim,
  reclaimPayoutDatumCbor,
  sponsorLockSigner,
} from "../offchain/src/tx/builders.js";
import type { PrepaidScripts } from "../offchain/src/tx/scripts.js";
import type { PaidFundDatum, PlutusAddress } from "../offchain/src/types.js";

const E9 = 1_000_000_000n;
const NET: Network = "Preprod";
const FUND_HASH = "44".repeat(28);
const VAULT_HASH = "11".repeat(28);
const WAKEME_HASH = "ab".repeat(28);
const CARP_POLICY = "22".repeat(28);
const CARP_NAME = "5a".repeat(28);
const CARP_UNIT = CARP_POLICY + CARP_NAME;
const FUND_ID = "aaaa" + "00".repeat(30);
const OTHER_FUND = "bbbb" + "00".repeat(30);
const SPONSOR_PKH = "5b".repeat(28);
const SPONSOR_STAKE = "5d".repeat(28);
const OWNER_COMMIT = "c0".repeat(32);
const EPOCH = 7n;

const keyAddr = (h: string): PlutusAddress => ({
  payment_credential: { VerificationKey: [h] },
  stake_credential: null,
});

const SPONSOR: PlutusAddress = {
  payment_credential: { VerificationKey: [SPONSOR_PKH] },
  stake_credential: { Inline: [{ VerificationKey: [SPONSOR_STAKE] }] },
};

function fundD(c: bigint, m: bigint, p: bigint, reclaimed = 0n, sponsored = true): PaidFundDatum {
  return {
    fund_id: FUND_ID,
    platform: "77".repeat(28),
    vault_hash: VAULT_HASH,
    carp_locked: c - p - reclaimed,
    credit_issued: c,
    magic_settled: m,
    provider_claimed: p,
    buffer_bps: 1_500n,
    last_updated_epoch: EPOCH,
    beneficiary: keyAddr("be".repeat(28)),
    beneficiary_datum: null,
    sponsorship: sponsored ? { sponsor: SPONSOR, owner_commit: OWNER_COMMIT } : null,
    sponsor_reclaimed: reclaimed,
  };
}

const contIn = () => fundD(10n * E9, 4n * E9, E9);
const closeIn = () => fundD(10n * E9, 4n * E9, 4n * E9);

// Bộ script giả: bộ lập kế hoạch chỉ đọc hash, địa chỉ, tham số — không đọc CBOR.
const MS = 86_400_000n;
const ORIGIN = 0n;
const scripts: PrepaidScripts = {
  network: NET,
  params: {
    carpPolicyId: CARP_POLICY,
    carpAssetName: CARP_NAME,
    msPerEpoch: MS,
    windowOriginMs: ORIGIN,
    wakemeVaultHash: WAKEME_HASH,
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
  carpUnit: CARP_UNIT,
};

const NFT_UNIT = FUND_HASH + FUND_ID;

function fundUtxo(d: PaidFundDatum, lovelace = 2_000_000n): UTxO {
  return {
    txHash: "55".repeat(32),
    outputIndex: 0,
    address: scripts.paidFund.address,
    assets: { lovelace, [CARP_UNIT]: d.carp_locked, [NFT_UNIT]: 1n },
    datum: encodeFundDatum(d),
    datumHash: null,
    scriptRef: null,
  };
}

// Cửa sổ nằm trọn trong kỳ EPOCH.
const validity = { fromMs: EPOCH * MS + 10n, toMs: EPOCH * MS + 20n };

describe("codec — FundReclaim", () => {
  it("FundReclaim mã hoá ra constr 3 `d87c80`", () => {
    expect(fundReclaimRedeemer()).toBe("d87c80");
  });
  it("cực đối: FundClaim vẫn là constr 2 `d87b…` (bài không xanh khi mọi nhánh cùng dịch)", () => {
    expect(fundClaimRedeemer(1n).startsWith("d87b")).toBe(true);
  });
  it("datum output trả = ByteArray `fund_id` (khớp `let tag: Data = fund_id`)", () => {
    expect(reclaimPayoutDatumCbor(FUND_ID)).toBe("5820" + FUND_ID);
    expect(reclaimPayoutDatumCbor(FUND_ID)).not.toBe(reclaimPayoutDatumCbor(OTHER_FUND));
  });
});

describe("sổ — fundAfterReclaim (gương reclaim_preconditions + sổ đầu ra)", () => {
  it("tiếp nối: R = phần chưa giao, quỹ giữ đúng E", () => {
    const o = fundAfterReclaim(contIn(), EPOCH);
    expect(o.closing).toBe(false);
    expect(o.reclaimed).toBe(6n * E9);
    expect(o.fundOut).toEqual({ ...contIn(), carp_locked: 3n * E9, sponsor_reclaimed: 6n * E9 });
  });

  it("đóng: E = 0 ⟹ BẮT BUỘC đóng, không datum đầu ra", () => {
    const o = fundAfterReclaim(closeIn(), EPOCH);
    expect(o.closing).toBe(true);
    expect(o.reclaimed).toBe(6n * E9);
    expect(o.fundOut).toBeNull();
  });

  it("ÂM — quỹ không tài trợ (R1)", () => {
    expect(() => fundAfterReclaim(fundD(10n * E9, 4n * E9, E9, 0n, false), EPOCH)).toThrow(/không phải quỹ tài trợ/);
  });

  it("ÂM — thu hồi lần hai (R14)", () => {
    expect(() => fundAfterReclaim(fundD(10n * E9, 4n * E9, 4n * E9, 1n), EPOCH)).toThrow(/đã thu hồi/);
  });

  it("ÂM — không còn gì chưa giao (R15) · cực đối: còn 1", () => {
    expect(() => fundAfterReclaim(fundD(4n * E9, 4n * E9, E9), EPOCH)).toThrow(/< 1/);
    const o = fundAfterReclaim(fundD(4n * E9 + 1n, 4n * E9, E9), EPOCH);
    expect(o.reclaimed).toBe(1n);
  });

  it("reclaimAmount không lấy phần provider đã kiếm (R12): R ≠ carp_locked khi E > 0", () => {
    expect(reclaimAmount(contIn())).toBe(6n * E9);
    expect(contIn().carp_locked).toBe(9n * E9);
  });
});

describe("sau thu hồi — các nhánh cũ dùng hạn-mức HIỆU LỰC", () => {
  const after = () => fundAfterReclaim(contIn(), EPOCH).fundOut!;

  it("FundLock bị chặn (L2) · cực đối: trước thu hồi nhận", () => {
    expect(() => fundAfterLock(after(), E9, EPOCH)).toThrow(/đã thu hồi/);
    expect(() => fundAfterLock(contIn(), E9, EPOCH)).not.toThrow();
  });

  it("FundSettle delta 1 vượt trần (S1) · cực đối: trước thu hồi nhận", () => {
    expect(() => fundAfterSettle(after(), 1n, EPOCH)).toThrow(/hiệu lực/);
    expect(() => fundAfterSettle(contIn(), 1n, EPOCH)).not.toThrow();
  });

  it("FundClaim rút đúng E, không E + 1 (C1)", () => {
    expect(maxClaimable(after())).toBe(3n * E9);
    expect(() => fundAfterClaim(after(), 3n * E9, EPOCH)).not.toThrow();
    expect(() => fundAfterClaim(after(), 3n * E9 + 1n, EPOCH)).toThrow();
  });
});

describe("kế hoạch — planFundReclaim", () => {
  it("tiếp nối: một spend FundReclaim, quỹ tiếp nối, output trả mang datum fund_id", () => {
    const r = planFundReclaim({ scripts, fundUtxo: fundUtxo(contIn()), validity });
    expect(r.closing).toBe(false);
    expect(r.reclaimed).toBe(6n * E9);
    expect(r.plan.spends).toHaveLength(1);
    expect(r.plan.spends[0]!.redeemerCbor).toBe("d87c80");
    expect(r.plan.mints).toHaveLength(0);
    expect(r.plan.signers).toHaveLength(0);
    expect(r.plan.owner).toBeNull();
    expect(r.plan.validity).toEqual(validity);

    const [fo, pay] = r.plan.outputs;
    expect(r.plan.outputs).toHaveLength(2);
    expect(fo!.address).toBe(scripts.paidFund.address);
    expect(fo!.assets).toEqual({ lovelace: 2_000_000n, [CARP_UNIT]: 3n * E9, [NFT_UNIT]: 1n });
    expect(fo!.datumCbor).toBe(encodeFundDatum({ ...contIn(), carp_locked: 3n * E9, sponsor_reclaimed: 6n * E9 }));

    expect(pay!.address).toBe(r.sponsorAddress);
    expect(pay!.datumCbor).toBe("5820" + FUND_ID);
    expect(pay!.assets).toEqual({ [CARP_UNIT]: 6n * E9 });
  });

  it("địa chỉ trả là địa chỉ ĐẦY ĐỦ (giữ stake của bên tài trợ — R9)", () => {
    const r = planFundReclaim({ scripts, fundUtxo: fundUtxo(contIn()), validity });
    const d = getAddressDetails(r.sponsorAddress);
    expect(d.paymentCredential).toEqual({ type: "Key", hash: SPONSOR_PKH });
    expect(d.stakeCredential).toEqual({ type: "Key", hash: SPONSOR_STAKE });
  });

  it("phần Wakeme khai đúng NFT két của owner_commit, redeemer ReclaimEpoch", () => {
    const r = planFundReclaim({ scripts, fundUtxo: fundUtxo(contIn()), validity });
    expect(r.wakeme).toEqual({
      scriptHash: WAKEME_HASH,
      vaultNftUnit: WAKEME_HASH + OWNER_COMMIT,
      reclaimEpochConstr: 1,
    });
  });

  it("đóng: đốt NFT −1, KHÔNG output nào ở địa chỉ quỹ, ADA quỹ theo phần trả", () => {
    const r = planFundReclaim({ scripts, fundUtxo: fundUtxo(closeIn(), 2_345_678n), validity });
    expect(r.closing).toBe(true);
    expect(r.fundDatumOut).toBeNull();
    expect(r.plan.mints).toHaveLength(1);
    expect(r.plan.mints[0]!.assets).toEqual({ [NFT_UNIT]: -1n });
    expect(r.plan.mints[0]!.script.hash).toBe(FUND_HASH);
    expect(r.plan.outputs).toHaveLength(1);
    expect(r.plan.outputs.some((o) => o.address === scripts.paidFund.address)).toBe(false);
    const pay = r.plan.outputs[0]!;
    expect(pay.datumCbor).toBe("5820" + FUND_ID);
    expect(pay.assets).toEqual({ lovelace: 2_345_678n, [CARP_UNIT]: 6n * E9 });
  });

  it("ÂM — quỹ không tài trợ: bộ lập kế hoạch ném, không dựng gì", () => {
    expect(() =>
      planFundReclaim({ scripts, fundUtxo: fundUtxo(fundD(10n * E9, 4n * E9, E9, 0n, false)), validity }),
    ).toThrow(/không phải quỹ tài trợ/);
  });

  it("ÂM — UTxO quỹ có CARP thật lệch sổ: ném ở bước đọc", () => {
    const u = fundUtxo(contIn());
    u.assets = { ...u.assets, [CARP_UNIT]: 9n * E9 + 5n };
    expect(() => planFundReclaim({ scripts, fundUtxo: u, validity })).toThrow(/C-PP-3/);
  });
});

describe("FundLock quỹ tài trợ đòi chữ ký bên tài trợ", () => {
  it("quỹ tài trợ ⟹ pkh bên tài trợ · cực đối: quỹ thường ⟹ không ai", () => {
    expect(sponsorLockSigner(contIn())).toBe(SPONSOR_PKH);
    expect(sponsorLockSigner(fundD(10n * E9, 4n * E9, E9, 0n, false))).toBeNull();
  });
});

// Kiểm vòng: Data.to(fund_id) bên TS khớp `cbor.serialise(fund_id)` bên Aiken
// (ByteArray 32 byte ⟹ tiền tố 0x58 0x20).
describe("Data ByteArray 32 byte", () => {
  it("tiền tố 5820", () => {
    expect(Data.to(FUND_ID).slice(0, 4)).toBe("5820");
  });
});
