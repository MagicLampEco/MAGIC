// tests/fundReclaim.test.ts — phần SỔ + kế hoạch giao dịch của `FundReclaim`
// (DESIGN-reclaim §10.6), gương `prepaid.ak` ▸ `validate_fund_reclaim` /
// `validate_fund_close` / `sponsor_payout`.
//
// Số liệu trùng bài Aiken `rc_*` (par_scale = 1):
//   tiếp nối: C = 10e9, M = 4e9, P = 1e9 ⟹ carp = 9e9, R = 6e9, E = 3e9
//   đóng:     C = 10e9, M = 4e9, P = 4e9 ⟹ carp = 6e9, R = 6e9, E = 0
// Có `u` (consumed_unsettled của dòng bị gỡ, §10.11): R = C − (M + u) (vector V5).
//   tiếp nối, u = 1e9: R = 5e9, E = 4e9, magic_settled' = 5e9
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
  assertSponsoredLock,
  fundAfterClaim,
  fundAfterLock,
  fundAfterReclaim,
  fundAfterSettle,
  fundClaimClose,
  fundClaimCloses,
  maxClaimable,
  reclaimAmount,
  reclaimUnsettled,
  vaultAfterCloseLine,
} from "../offchain/src/prepaid.js";
import {
  closeSponsoredLineRedeemer,
  encodeFundDatum,
  encodeVaultDatum,
  fundClaimRedeemer,
  fundReclaimRedeemer,
  settleLineRedeemer,
} from "../offchain/src/tx/codec.js";
import {
  planFundClaim,
  planFundReclaim,
  planMintPaidFund,
  reclaimPayoutDatumCbor,
  sponsorLockSigner,
} from "../offchain/src/tx/builders.js";
import type { PrepaidScripts } from "../offchain/src/tx/scripts.js";
import type {
  MagicBatch,
  PaidFundDatum,
  PlutusAddress,
  PrepaidCredit,
  PrepaidVaultDatum,
} from "../offchain/src/types.js";

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
// Mốc thu hồi dự phòng của fixture: epoch genesis (7) + 200.
const RECLAIM_AFTER = 207n;

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
    sponsorship: sponsored
      ? { sponsor: SPONSOR, owner_commit: OWNER_COMMIT, reclaim_after_epoch: RECLAIM_AFTER }
      : null,
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
// ── vault mang dòng của quỹ (DESIGN-reclaim §10.11) ──────────────────────────
const VAULT_NFT = VAULT_HASH + "c1".repeat(32);
const U = E9; // consumed_unsettled của dòng quỹ tài trợ

const credit = (fid: string, remaining: bigint, u: bigint): PrepaidCredit => ({
  fund_id: fid,
  remaining,
  issued_epoch: 5n,
  last_draw_epoch: 6n,
  consumed_unsettled: u,
});
const batch = (id: string, fid: string): MagicBatch => ({
  batch_id: id,
  source: 3n,
  created_epoch: EPOCH,
  current_amount: 5n * E9,
  decay_window: 1n,
  profile_at_creation: 0n,
  contract_id: fid,
});
function vaultD(u = U, lines: PrepaidCredit[] | null = null): PrepaidVaultDatum {
  return {
    owner: { VerificationKey: ["0e".repeat(28)] },
    did_commit: OWNER_COMMIT,
    prepaid_credits: lines ?? [credit(OTHER_FUND, 3n * E9, 7n), credit(FUND_ID, 2n * E9, u)],
    magic_batches: [batch("01".repeat(32), FUND_ID), batch("02".repeat(32), OTHER_FUND), batch("03".repeat(32), FUND_ID)],
    next_batch_index: 3n,
    personal_delegate: null,
    last_updated_epoch: 6n,
    attribution: { attribution_root: "", last_event_epoch: 0n, total_events: 0n },
  };
}
function vaultUtxo(d: PrepaidVaultDatum): UTxO {
  return {
    txHash: "66".repeat(32),
    outputIndex: 1,
    address: scripts.vault.address,
    assets: { lovelace: 3_000_000n, [VAULT_NFT]: 1n },
    datum: encodeVaultDatum(d),
    datumHash: null,
    scriptRef: null,
  };
}

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
  it("CloseSponsoredLine = constr 7, thẻ 1280 `d90500`, mang fund_id · cực đối: SettleLine vẫn `d87f`", () => {
    expect(closeSponsoredLineRedeemer(FUND_ID)).toBe("d905009f5820" + FUND_ID + "ff");
    expect(settleLineRedeemer(FUND_ID).startsWith("d87f")).toBe(true);
  });
});

describe("u — reclaimUnsettled (gương reclaim_unsettled + sponsored_line_unsettled)", () => {
  it("quỹ đã cấp ⟹ u = consumed_unsettled của ĐÚNG dòng fund_id (không lấy dòng quỹ khác)", () => {
    expect(reclaimUnsettled(contIn(), vaultD())).toBe(U);
    expect(reclaimUnsettled(contIn(), vaultD(0n))).toBe(0n);
  });
  it("ÂM — quỹ đã cấp mà không kèm vault: không có đường bỏ qua vault", () => {
    expect(() => reclaimUnsettled(contIn(), null)).toThrow(/BẮT BUỘC đồng tiêu vault/);
  });
  it("ÂM — vault 0 hoặc 2 dòng cho quỹ · cực đối: 1 dòng nhận", () => {
    expect(() => reclaimUnsettled(contIn(), vaultD(U, [credit(OTHER_FUND, 1n, 0n)]))).toThrow(/0 dòng/);
    expect(() =>
      reclaimUnsettled(contIn(), vaultD(U, [credit(FUND_ID, 1n, 0n), credit(FUND_ID, 1n, 0n)])),
    ).toThrow(/2 dòng/);
    expect(reclaimUnsettled(contIn(), vaultD(U, [credit(FUND_ID, 1n, 5n)]))).toBe(5n);
  });
  it("quỹ chưa cấp ⟹ u = 0 không kèm vault · ÂM: kèm vault thì ném", () => {
    const zero = fundD(0n, 0n, 0n);
    expect(reclaimUnsettled(zero, null)).toBe(0n);
    expect(() => reclaimUnsettled(zero, vaultD())).toThrow(/chưa cấp đồng nào/);
  });
});

describe("sổ — fundAfterReclaim (gương reclaim_preconditions + sổ đầu ra)", () => {
  it("tiếp nối, u = 0: R = phần chưa giao, quỹ giữ đúng E", () => {
    const o = fundAfterReclaim(contIn(), EPOCH, 0n);
    expect(o.closing).toBe(false);
    expect(o.reclaimed).toBe(6n * E9);
    expect(o.fundOut).toEqual({ ...contIn(), carp_locked: 3n * E9, sponsor_reclaimed: 6n * E9 });
  });

  it("tiếp nối, u > 0: R trừ u, phần u ở lại quỹ VÀ vào magic_settled · cực đối u = 0", () => {
    const o = fundAfterReclaim(contIn(), EPOCH, U);
    expect(o.reclaimed).toBe(5n * E9);
    expect(o.fundOut).toEqual({
      ...contIn(),
      carp_locked: 4n * E9,
      sponsor_reclaimed: 5n * E9,
      magic_settled: 5n * E9,
    });
    // Phần u rút được ngay bằng FundClaim (provider đã giao): E = 4e9 = (M + u) − P.
    expect(maxClaimable(o.fundOut!)).toBe(4n * E9);
    expect(reclaimAmount(contIn(), U)).not.toBe(reclaimAmount(contIn(), 0n));
  });

  it("đóng: E = 0 ⟹ BẮT BUỘC đóng, không datum đầu ra", () => {
    const o = fundAfterReclaim(closeIn(), EPOCH, 0n);
    expect(o.closing).toBe(true);
    expect(o.reclaimed).toBe(6n * E9);
    expect(o.fundOut).toBeNull();
  });

  it("u quyết hình dạng: cùng quỹ, u = 0 ⟹ đóng; u > 0 ⟹ tiếp nối với E = u", () => {
    expect(fundAfterReclaim(closeIn(), EPOCH, 0n).closing).toBe(true);
    const o = fundAfterReclaim(closeIn(), EPOCH, U);
    expect(o.closing).toBe(false);
    expect(o.fundOut!.carp_locked).toBe(U);
  });

  it("quỹ chưa cấp đồng nào: R = 0 ⟹ đóng (trả min-ADA) · ÂM: u ≠ 0", () => {
    const o = fundAfterReclaim(fundD(0n, 0n, 0n), EPOCH, 0n);
    expect(o).toMatchObject({ reclaimed: 0n, closing: true, fundOut: null });
    expect(() => fundAfterReclaim(fundD(0n, 0n, 0n), EPOCH, 1n)).toThrow(/chưa cấp đồng nào/);
  });

  it("ÂM — quỹ không tài trợ (R1)", () => {
    expect(() => fundAfterReclaim(fundD(10n * E9, 4n * E9, E9, 0n, false), EPOCH, 0n)).toThrow(/không phải quỹ tài trợ/);
  });

  it("ÂM — thu hồi lần hai (R14)", () => {
    expect(() => fundAfterReclaim(fundD(10n * E9, 4n * E9, 4n * E9, 1n), EPOCH, 0n)).toThrow(/đã thu hồi/);
  });

  it("ÂM — không còn gì chưa giao (R15) · cực đối: còn 1", () => {
    expect(() => fundAfterReclaim(fundD(4n * E9, 4n * E9, E9), EPOCH, 0n)).toThrow(/< 1/);
    const o = fundAfterReclaim(fundD(4n * E9 + 1n, 4n * E9, E9), EPOCH, 0n);
    expect(o.reclaimed).toBe(1n);
    // u làm phần chưa giao về 0 ⟹ cũng ném.
    expect(() => fundAfterReclaim(fundD(4n * E9 + 1n, 4n * E9, E9), EPOCH, 1n)).toThrow(/< 1/);
  });

  it("reclaimAmount không lấy phần provider đã kiếm (R12): R ≠ carp_locked khi E > 0", () => {
    expect(reclaimAmount(contIn(), 0n)).toBe(6n * E9);
    expect(contIn().carp_locked).toBe(9n * E9);
  });
});

describe("vault — vaultAfterCloseLine (gương validate_close_sponsored_line)", () => {
  it("gỡ ĐÚNG dòng + MỌI batch của quỹ, giữ dòng/batch quỹ khác, đóng dấu kỳ", () => {
    const out = vaultAfterCloseLine(vaultD(), FUND_ID, EPOCH);
    expect(out.prepaid_credits).toEqual([credit(OTHER_FUND, 3n * E9, 7n)]);
    expect(out.magic_batches.map((b) => b.batch_id)).toEqual(["02".repeat(32)]);
    expect(out).toEqual({
      ...vaultD(),
      prepaid_credits: out.prepaid_credits,
      magic_batches: out.magic_batches,
      last_updated_epoch: EPOCH,
    });
  });
  it("ÂM — vault không có dòng quỹ", () => {
    expect(() => vaultAfterCloseLine(vaultD(U, [credit(OTHER_FUND, 1n, 0n)]), FUND_ID, EPOCH)).toThrow(/0 dòng/);
  });
});

describe("sau thu hồi — các nhánh cũ dùng hạn-mức HIỆU LỰC", () => {
  const after = () => fundAfterReclaim(contIn(), EPOCH, 0n).fundOut!;

  it("FundLock bị chặn (L2) · cực đối: trước thu hồi nhận", () => {
    expect(() => fundAfterLock(after(), E9, EPOCH)).toThrow(/đã thu hồi/);
    expect(() => fundAfterLock(contIn(), E9, EPOCH)).not.toThrow();
  });

  it("FundSettle delta 1 vượt trần (S1) · cực đối: trước thu hồi nhận", () => {
    expect(() => fundAfterSettle(after(), 1n, EPOCH)).toThrow(/hiệu lực/);
    expect(() => fundAfterSettle(contIn(), 1n, EPOCH)).not.toThrow();
  });

  it("FundClaim: tối đa E; rút TRỌN E phải đi nhánh ĐÓNG, E − 1 đi tiếp nối, E + 1 ném", () => {
    expect(maxClaimable(after())).toBe(3n * E9);
    expect(() => fundAfterClaim(after(), 3n * E9 - 1n, EPOCH)).not.toThrow();
    expect(() => fundAfterClaim(after(), 3n * E9, EPOCH)).toThrow(/ĐÓNG/);
    expect(fundClaimCloses(after(), 3n * E9)).toBe(true);
    expect(() => fundClaimClose(after(), 3n * E9)).not.toThrow();
    expect(() => fundAfterClaim(after(), 3n * E9 + 1n, EPOCH)).toThrow();
    expect(() => fundClaimClose(after(), 3n * E9 + 1n)).toThrow(/TRỌN/);
  });

  it("cực đối nhánh đóng: quỹ CHƯA thu hồi rút trọn ⟹ không rẽ đóng", () => {
    const fresh = fundD(4n * E9, 4n * E9, 0n);
    expect(fundClaimCloses(fresh, fresh.carp_locked)).toBe(false);
    expect(() => fundClaimClose(fresh, fresh.carp_locked)).toThrow(/chưa thu hồi/);
  });
});

describe("kế hoạch — planFundReclaim", () => {
  it("tiếp nối có vault: spend quỹ FundReclaim + vault CloseSponsoredLine, vault gỡ dòng, quỹ ghi u", () => {
    const vu = vaultUtxo(vaultD());
    const r = planFundReclaim({ scripts, fundUtxo: fundUtxo(contIn()), vaultUtxo: vu, validity });
    expect(r.closing).toBe(false);
    expect(r.unsettled).toBe(U);
    expect(r.reclaimed).toBe(5n * E9);
    expect(r.plan.spends.map((s) => s.redeemerCbor)).toEqual([
      "d87c80",
      "d905009f5820" + FUND_ID + "ff",
    ]);
    expect(r.plan.spends[1]!.script.hash).toBe(VAULT_HASH);
    expect(r.plan.mints).toHaveLength(0);
    expect(r.plan.signers).toHaveLength(0);
    expect(r.plan.owner).toBeNull();
    expect(r.plan.validity).toEqual(validity);

    expect(r.plan.outputs).toHaveLength(3);
    const [vo, fo, pay] = r.plan.outputs;
    expect(vo!.address).toBe(scripts.vault.address);
    expect(vo!.assets).toEqual(vu.assets);
    expect(vo!.datumCbor).toBe(encodeVaultDatum(vaultAfterCloseLine(vaultD(), FUND_ID, EPOCH)));
    expect(r.vaultDatumOut).toEqual(vaultAfterCloseLine(vaultD(), FUND_ID, EPOCH));

    const fundOut = { ...contIn(), carp_locked: 4n * E9, sponsor_reclaimed: 5n * E9, magic_settled: 5n * E9 };
    expect(fo!.address).toBe(scripts.paidFund.address);
    expect(fo!.assets).toEqual({ lovelace: 2_000_000n, [CARP_UNIT]: 4n * E9, [NFT_UNIT]: 1n });
    expect(fo!.datumCbor).toBe(encodeFundDatum(fundOut));

    expect(pay!.address).toBe(r.sponsorAddress);
    expect(pay!.datumCbor).toBe("5820" + FUND_ID);
    expect(pay!.assets).toEqual({ [CARP_UNIT]: 5n * E9 });
  });

  it("ÂM — quỹ đã cấp mà không truyền vault: bộ lập kế hoạch ném (không có đường bỏ qua vault)", () => {
    expect(() => planFundReclaim({ scripts, fundUtxo: fundUtxo(contIn()), validity })).toThrow(
      /BẮT BUỘC đồng tiêu vault/,
    );
  });

  it("ÂM — vault giả (không ở script vault) ném ở bước đọc", () => {
    const vu = { ...vaultUtxo(vaultD()), address: scripts.paidFund.address };
    expect(() => planFundReclaim({ scripts, fundUtxo: fundUtxo(contIn()), vaultUtxo: vu, validity })).toThrow(
      /không ở script vault/,
    );
  });

  it("địa chỉ trả là địa chỉ ĐẦY ĐỦ (giữ stake của bên tài trợ — R9)", () => {
    const r = planFundReclaim({ scripts, fundUtxo: fundUtxo(contIn()), vaultUtxo: vaultUtxo(vaultD()), validity });
    const d = getAddressDetails(r.sponsorAddress);
    expect(d.paymentCredential).toEqual({ type: "Key", hash: SPONSOR_PKH });
    expect(d.stakeCredential).toEqual({ type: "Key", hash: SPONSOR_STAKE });
  });

  it("phần Wakeme khai đúng NFT két của owner_commit, redeemer ReclaimEpoch", () => {
    const r = planFundReclaim({ scripts, fundUtxo: fundUtxo(contIn()), vaultUtxo: vaultUtxo(vaultD()), validity });
    expect(r.wakeme).toEqual({
      scriptHash: WAKEME_HASH,
      vaultNftUnit: WAKEME_HASH + OWNER_COMMIT,
      reclaimEpochConstr: 1,
    });
  });

  it("đóng: đốt NFT −1, KHÔNG output nào ở địa chỉ quỹ, ADA quỹ theo phần trả", () => {
    const r = planFundReclaim({
      scripts,
      fundUtxo: fundUtxo(closeIn(), 2_345_678n),
      vaultUtxo: vaultUtxo(vaultD(0n)),
      validity,
    });
    expect(r.closing).toBe(true);
    expect(r.fundDatumOut).toBeNull();
    expect(r.plan.mints).toHaveLength(1);
    expect(r.plan.mints[0]!.assets).toEqual({ [NFT_UNIT]: -1n });
    expect(r.plan.mints[0]!.script.hash).toBe(FUND_HASH);
    expect(r.plan.outputs).toHaveLength(2); // vault + output trả
    expect(r.plan.outputs.some((o) => o.address === scripts.paidFund.address)).toBe(false);
    const pay = r.plan.outputs.find((o) => o.address === r.sponsorAddress)!;
    expect(pay.datumCbor).toBe("5820" + FUND_ID);
    expect(pay.assets).toEqual({ lovelace: 2_345_678n, [CARP_UNIT]: 6n * E9 });
  });

  it("quỹ chưa cấp: đóng KHÔNG kèm vault, output trả chỉ min-ADA (không khoá CARP 0)", () => {
    const zero = fundD(0n, 0n, 0n);
    const r = planFundReclaim({ scripts, fundUtxo: fundUtxo(zero, 1_800_000n), validity });
    expect(r).toMatchObject({ closing: true, reclaimed: 0n, unsettled: 0n, vaultDatumOut: null });
    expect(r.plan.spends).toHaveLength(1);
    expect(r.plan.mints[0]!.assets).toEqual({ [NFT_UNIT]: -1n });
    expect(r.plan.outputs).toEqual([
      { address: r.sponsorAddress, datumCbor: "5820" + FUND_ID, assets: { lovelace: 1_800_000n } },
    ]);
  });

  it("ÂM — quỹ không tài trợ: bộ lập kế hoạch ném, không dựng gì", () => {
    expect(() =>
      planFundReclaim({
        scripts,
        fundUtxo: fundUtxo(fundD(10n * E9, 4n * E9, E9, 0n, false)),
        vaultUtxo: vaultUtxo(vaultD()),
        validity,
      }),
    ).toThrow(/không phải quỹ tài trợ/);
  });

  it("ÂM — UTxO quỹ có CARP thật lệch sổ: ném ở bước đọc", () => {
    const u = fundUtxo(contIn());
    u.assets = { ...u.assets, [CARP_UNIT]: 9n * E9 + 5n };
    expect(() => planFundReclaim({ scripts, fundUtxo: u, vaultUtxo: vaultUtxo(vaultD()), validity })).toThrow(/C-PP-3/);
  });
});

describe("kế hoạch — planFundClaim nhánh ĐÓNG (rút cuối quỹ đã thu hồi)", () => {
  const after = () => fundAfterReclaim(contIn(), EPOCH, 0n).fundOut!;

  it("rút TRỌN E: đốt NFT, CARP về bên hưởng, min-ADA về bên tài trợ (datum fund_id), platform ký", () => {
    const r = planFundClaim({ scripts, fundUtxo: fundUtxo(after(), 2_222_222n), amount: 3n * E9, validity });
    expect(r.closing).toBe(true);
    expect(r.fundDatumOut).toBeNull();
    expect(r.plan.spends).toHaveLength(1);
    expect(r.plan.spends[0]!.redeemerCbor).toBe(fundClaimRedeemer(3n * E9));
    expect(r.plan.mints).toEqual([
      expect.objectContaining({ assets: { [NFT_UNIT]: -1n } }),
    ]);
    expect(r.plan.signers).toEqual([contIn().platform]);
    expect(r.plan.outputs.some((o) => o.address === scripts.paidFund.address)).toBe(false);
    expect(r.plan.outputs).toEqual([
      { address: r.beneficiaryAddress, datumCbor: null, assets: { [CARP_UNIT]: 3n * E9 } },
      { address: r.sponsorAddress, datumCbor: "5820" + FUND_ID, assets: { lovelace: 2_222_222n } },
    ]);
    expect(getAddressDetails(r.sponsorAddress!).stakeCredential).toEqual({ type: "Key", hash: SPONSOR_STAKE });
  });

  it("cực đối: rút E − 1 ⟹ tiếp nối, không đốt, không output tới bên tài trợ", () => {
    const r = planFundClaim({ scripts, fundUtxo: fundUtxo(after()), amount: 3n * E9 - 1n, validity });
    expect(r.closing).toBe(false);
    expect(r.sponsorAddress).toBeNull();
    expect(r.plan.mints).toHaveLength(0);
    expect(r.fundDatumOut!.carp_locked).toBe(1n);
  });

  it("ÂM — beneficiary trùng sponsor: nhánh rút-cuối bị từ chối sớm (fail-closed)", () => {
    const same: PlutusAddress = keyAddr("be".repeat(28));
    const f = { ...after(), sponsorship: { sponsor: same, owner_commit: OWNER_COMMIT, reclaim_after_epoch: RECLAIM_AFTER } };
    expect(() => planFundClaim({ scripts, fundUtxo: fundUtxo(f), amount: 3n * E9, validity })).toThrow(
      /beneficiary trùng địa chỉ sponsor/,
    );
    // cực đối: rút không trọn thì không đi nhánh đóng ⟹ không chạm cổng này.
    expect(() => planFundClaim({ scripts, fundUtxo: fundUtxo(f), amount: E9, validity })).not.toThrow();
  });
});

describe("FundLock quỹ tài trợ", () => {
  it("đòi chữ ký bên tài trợ · cực đối: quỹ thường ⟹ không ai", () => {
    expect(sponsorLockSigner(contIn())).toBe(SPONSOR_PKH);
    expect(sponsorLockSigner(fundD(10n * E9, 4n * E9, E9, 0n, false))).toBeNull();
  });

  it("đúng DID + mở dòng khi quỹ chưa cấp: nhận", () => {
    expect(() => assertSponsoredLock(vaultD(U, []), fundD(0n, 0n, 0n), FUND_ID)).not.toThrow();
  });
  it("ÂM — vault chưa gắn DID (did_commit rỗng)", () => {
    expect(() => assertSponsoredLock({ ...vaultD(U, []), did_commit: "" }, fundD(0n, 0n, 0n), FUND_ID)).toThrow(
      /chưa gắn DID/,
    );
  });
  it("ÂM — vault mang DID khác owner_commit", () => {
    expect(() =>
      assertSponsoredLock({ ...vaultD(U, []), did_commit: "c1".repeat(32) }, fundD(0n, 0n, 0n), FUND_ID),
    ).toThrow(/vault mang DID/);
  });
  it("ÂM — mở dòng THỨ HAI khi quỹ đã cấp · cực đối: nạp thêm vào dòng đã có thì nhận", () => {
    expect(() => assertSponsoredLock(vaultD(U, []), contIn(), FUND_ID)).toThrow(/một dòng trọn đời/);
    expect(() => assertSponsoredLock(vaultD(), contIn(), FUND_ID)).not.toThrow();
  });
  it("quỹ thường: không cổng DID/một-dòng", () => {
    const plain = fundD(10n * E9, 4n * E9, E9, 0n, false);
    expect(() => assertSponsoredLock({ ...vaultD(U, []), did_commit: "" }, plain, FUND_ID)).not.toThrow();
  });
});

// Kiểm vòng: Data.to(fund_id) bên TS khớp `cbor.serialise(fund_id)` bên Aiken
// (ByteArray 32 byte ⟹ tiền tố 0x58 0x20).
describe("Data ByteArray 32 byte", () => {
  it("tiền tố 5820", () => {
    expect(Data.to(FUND_ID).slice(0, 4)).toBe("5820");
  });
});

// ══════════════════════════════════════════════════════════════
// Đường thu hồi DỰ PHÒNG (DESIGN-reclaim §10.12, 2026-10-05) — gương bước 3(a) của
// `reclaim_preconditions` và vế `MUT-G-AFTER` của `validate_mint_fund_nft`.
// ══════════════════════════════════════════════════════════════
const at = (e: bigint) => ({ fromMs: e * MS + 10n, toMs: e * MS + 20n });

describe("đường dự phòng — planFundReclaim path: \"sponsor\"", () => {
  it("đúng mốc (==), quỹ đã cấp, có vault: bên tài trợ ký, không phần Wakeme", () => {
    const r = planFundReclaim({
      scripts, fundUtxo: fundUtxo(contIn()), vaultUtxo: vaultUtxo(vaultD()),
      validity: at(RECLAIM_AFTER), path: "sponsor",
    });
    expect(r.epoch).toBe(RECLAIM_AFTER);
    expect(r.plan.signers).toEqual([SPONSOR_PKH]);
    expect(r.wakeme).toBeNull();
    expect(r.reclaimed).toBe(5n * E9);
    expect(r.plan.spends.map((x) => x.redeemerCbor)).toEqual(["d87c80", "d905009f5820" + FUND_ID + "ff"]);
  });

  it("ÂM — trước mốc một epoch, quỹ đã cấp: ném", () => {
    expect(() =>
      planFundReclaim({
        scripts, fundUtxo: fundUtxo(contIn()), vaultUtxo: vaultUtxo(vaultD()),
        validity: at(RECLAIM_AFTER - 1n), path: "sponsor",
      }),
    ).toThrow(/chưa tới lượt/);
  });

  it("ÂM — quỹ đã cấp, dự phòng mà không kèm vault: ném (phần u của provider)", () => {
    expect(() =>
      planFundReclaim({ scripts, fundUtxo: fundUtxo(contIn()), validity: at(RECLAIM_AFTER), path: "sponsor" }),
    ).toThrow(/BẮT BUỘC đồng tiêu vault/);
  });

  it("quỹ chưa cấp: trước mốc vẫn dựng được (đóng, không vault, bên tài trợ ký)", () => {
    const r = planFundReclaim({
      scripts, fundUtxo: fundUtxo(fundD(0n, 0n, 0n), 1_800_000n), validity, path: "sponsor",
    });
    expect(r.epoch).toBeLessThan(RECLAIM_AFTER);
    expect(r).toMatchObject({ closing: true, reclaimed: 0n, wakeme: null });
    expect(r.plan.signers).toEqual([SPONSOR_PKH]);
  });

  it("đường wakeme (mặc định) không thêm chữ ký bên tài trợ", () => {
    const r = planFundReclaim({ scripts, fundUtxo: fundUtxo(contIn()), vaultUtxo: vaultUtxo(vaultD()), validity });
    expect(r.plan.signers).toEqual([]);
    expect(r.wakeme).not.toBeNull();
  });
});

describe("genesis quỹ tài trợ — planMintPaidFund", () => {
  const seed: UTxO = {
    txHash: "66".repeat(32),
    outputIndex: 0,
    address: credentialToAddress(NET, { type: "Key", hash: "66".repeat(28) }),
    assets: { lovelace: 5_000_000n },
  };
  const base = {
    scripts, seedUtxo: seed, platformPkh: "77".repeat(28), beneficiary: keyAddr("be".repeat(28)),
    beneficiaryDatum: null, bufferBps: 0n, collectSeed: true,
  };

  it("mốc = epoch(cận TRÊN) + 200; cận DƯỚI lùi về epoch 0 không kéo mốc xuống", () => {
    const v = { fromMs: 0n, toMs: EPOCH * MS + 20n };
    const r = planMintPaidFund({ ...base, sponsorship: { sponsor: SPONSOR, owner_commit: OWNER_COMMIT }, validity: v });
    expect(r.datum.sponsorship).toEqual({ sponsor: SPONSOR, owner_commit: OWNER_COMMIT, reclaim_after_epoch: EPOCH + 200n });
    expect(r.plan.validity).toEqual(v);
  });

  it("ÂM — quỹ tài trợ thiếu validity: ném", () => {
    expect(() => planMintPaidFund({ ...base, sponsorship: { sponsor: SPONSOR, owner_commit: OWNER_COMMIT } })).toThrow(
      /cận TRÊN/,
    );
  });

  it("quỹ thường: sponsorship null, không cần validity", () => {
    const r = planMintPaidFund(base);
    expect(r.datum.sponsorship).toBeNull();
  });
});
