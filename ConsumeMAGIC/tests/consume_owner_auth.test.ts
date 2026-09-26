// tests/consume_owner_auth.test.ts — chứng minh quyền chủ theo nhánh `Credential` ở ba bộ dựng
// (`buildConsumeTx`, `buildBindDidTx`, `buildMintEngageTx`).
//
// On-chain (`owner_auth.ak` ▸ `owner_authorized`): VerificationKey(pkh) ⟹ pkh ∈ extra_signatories;
// Script(h) ⟹ tx.withdrawals có khoá Script(h). Bộ dựng phải:
//   · khoá   ⟹ `addSignerKey(pkh)`, KHÔNG mục rút;
//   · script ⟹ `attachWithdraw` ĐÚNG MỘT LẦN, KHÔNG `addSignerKey(h)`; không truyền thì NÉM.
//
// Đi qua bộ dựng THẬT với `LucidEvolution` giả (TestSupport/lucidFake.ts), không cần network.

import { describe, it, expect } from "vitest";
import {
  Constr, Data, validatorToScriptHash,
  type LucidEvolution, type UTxO, type Validator,
} from "@lucid-evolution/lucid";
import { makeLucidFake } from "../../TestSupport/lucidFake.js";
import {
  buildConsumeTx, buildBindDidTx, buildMintEngageTx, type ConsumeParams,
} from "../offchain/src/consume.js";
import {
  encodeEngageDatum, decodeEngageDatum, encodePriceParam, type EngageDatumT,
} from "../offchain/src/types.js";

const consumeScript: Validator = { type: "PlutusV3", script: "49480100002221200101" };
const vaultScript:   Validator = { type: "PlutusV3", script: "4d4d01000033222220051200120011" };
const POLICY = validatorToScriptHash(consumeScript);
const NFT = POLICY + "ee".repeat(32);

const KEY_H = "0b".repeat(28);
const SCRIPT_H = "5c".repeat(28);
const DID_32 = "d1".repeat(32);

type Owner = EngageDatumT["owner"];

const priceDatum = encodePriceParam({
  op_prices: [{ op_type: 1n, base_price: 10_000_000n, demand_mult: 1_000_000_000n }],
  m_min: 500_000_000n,
  m_max: 2_000_000_000n,
  epoch: 0n,
});

const engageDatum = (owner: Owner, did = ""): string =>
  encodeEngageDatum({
    owner,
    consumed_count: 0n,
    last_epoch: 0n,
    did_commit: did,
    consumed_nanogic: 0n,
  });

/** Vault datum: Constr(_, [owner Credential, ..]) — đúng phần `all_vault_owners_are` đọc. */
const vaultDatum = (owner: Owner): string =>
  Data.to(new Constr(0, [
    "VerificationKey" in owner ? new Constr(0, [owner.VerificationKey[0]]) : new Constr(1, [owner.Script[0]]),
    0n,
  ]));

const mkUtxo = (over: Partial<UTxO>): UTxO => ({
  txHash: "00".repeat(32),
  outputIndex: 0,
  address: "addr_test1wq0000000000000000000000000000000000000000000000000000",
  assets: { lovelace: 2_000_000n },
  ...over,
});

/** attachWithdraw giả: đếm số lần gọi, gắn một mục rút ghi nhận được. */
function scriptAuth(hash = SCRIPT_H) {
  const calls = { n: 0 };
  const auth = {
    kind: "script" as const,
    hash,
    attachWithdraw: (t: any) => { calls.n++; return t.withdraw("stake_test1_gia", 0n, "d87980"); },
  };
  return { auth, calls };
}

// ── buildConsumeTx ────────────────────────────────────────────────────────────

function consumeParams(owner: Owner, lucid: unknown, over: Partial<ConsumeParams> = {}): ConsumeParams {
  return {
    lucid: lucid as LucidEvolution,
    engageUtxo: mkUtxo({ datum: engageDatum(owner), assets: { lovelace: 2_000_000n, [NFT]: 1n } }),
    vaultUtxo: mkUtxo({ outputIndex: 1, datum: vaultDatum(owner) }),
    priceBeaconUtxo: mkUtxo({ outputIndex: 2, datum: priceDatum }),
    consumeScript,
    vaultScript,
    opType: 1,
    opCount: 1n,
    vaultBurnRedeemerCbor: "d87980",
    vaultOutDatumCbor: "d87980",
    network: "Preview",
    tipPosixMs: 1_700_000_000_000n,
    ...over,
  } as ConsumeParams;
}

describe("buildConsumeTx — quyền chủ (BurnBatch phía vault) theo nhánh Credential", () => {
  it("chủ khoá ⟹ addSignerKey(pkh), KHÔNG mục rút", async () => {
    const fake = makeLucidFake();
    await buildConsumeTx(consumeParams({ VerificationKey: [KEY_H] }, fake.lucid));
    const tx = fake.onlyTx();
    expect(tx.signerKeys).toEqual([KEY_H]);
    expect(tx.withdrawals).toEqual([]);
    expect(tx.completed).toBe(true);
  });

  it("chủ script ⟹ attachWithdraw ĐÚNG MỘT LẦN, KHÔNG ký bằng h", async () => {
    const fake = makeLucidFake();
    const { auth, calls } = scriptAuth();
    await buildConsumeTx(consumeParams({ Script: [SCRIPT_H] }, fake.lucid, { ownerAuth: auth }));
    const tx = fake.onlyTx();
    expect(calls.n).toBe(1);
    expect(tx.signerKeys).toEqual([]);
    expect(tx.withdrawals).toEqual([{ rewardAddress: "stake_test1_gia", amount: 0n, redeemer: "d87980" }]);
  });

  it("CỰC ĐỐI — chủ script, không ownerAuth ⟹ NÉM OWNER_SCRIPT_WITNESS_UNAVAILABLE, không dựng", async () => {
    const fake = makeLucidFake();
    await expect(
      buildConsumeTx(consumeParams({ Script: [SCRIPT_H] }, fake.lucid)),
    ).rejects.toThrow(/OWNER_SCRIPT_WITNESS_UNAVAILABLE/);
    expect(fake.txs.every((t) => !t.completed)).toBe(true);
  });

  it("CỰC ĐỐI — ownerAuth khoá cho chủ script cùng 28 byte ⟹ OWNER_AUTH_MISMATCH", async () => {
    const fake = makeLucidFake();
    await expect(
      buildConsumeTx(consumeParams({ Script: [SCRIPT_H] }, fake.lucid, {
        ownerAuth: { kind: "key", pkh: SCRIPT_H },
      })),
    ).rejects.toThrow(/OWNER_AUTH_MISMATCH/);
  });

  it("ÂM — ownerSignerKeyHash (bia mộ) với chủ script ⟹ NÉM, kể cả khi trùng 28 byte", async () => {
    const fake = makeLucidFake();
    const { auth } = scriptAuth();
    await expect(
      buildConsumeTx(consumeParams({ Script: [SCRIPT_H] }, fake.lucid, {
        ownerAuth: auth,
        ownerSignerKeyHash: SCRIPT_H,
      })),
    ).rejects.toThrow(/ownerSignerKeyHash/);
  });
});

// ── buildBindDidTx ────────────────────────────────────────────────────────────

describe("buildBindDidTx — quyền chủ thread theo nhánh Credential", () => {
  const engage = (owner: Owner) =>
    mkUtxo({ datum: engageDatum(owner), assets: { lovelace: 2_000_000n, [NFT]: 1n } });

  it("chủ khoá ⟹ addSignerKey(pkh), KHÔNG mục rút", async () => {
    const fake = makeLucidFake();
    await buildBindDidTx({
      lucid: fake.lucid as LucidEvolution,
      engageUtxo: engage({ VerificationKey: [KEY_H] }),
      consumeScript,
      didCommit: DID_32,
    });
    const tx = fake.onlyTx();
    expect(tx.signerKeys).toEqual([KEY_H]);
    expect(tx.withdrawals).toEqual([]);
  });

  it("chủ script ⟹ attachWithdraw ĐÚNG MỘT LẦN, KHÔNG ký bằng h; owner giữ nguyên tag", async () => {
    const fake = makeLucidFake();
    const { auth, calls } = scriptAuth();
    const r = await buildBindDidTx({
      lucid: fake.lucid as LucidEvolution,
      engageUtxo: engage({ Script: [SCRIPT_H] }),
      consumeScript,
      didCommit: DID_32,
      ownerAuth: auth,
    });
    const tx = fake.onlyTx();
    expect(calls.n).toBe(1);
    expect(tx.signerKeys).toEqual([]);
    expect(tx.withdrawals).toHaveLength(1);
    expect(r.newEngageDatum.owner).toEqual({ Script: [SCRIPT_H] });
  });

  it("CỰC ĐỐI — chủ script, không ownerAuth ⟹ NÉM OWNER_SCRIPT_WITNESS_UNAVAILABLE", async () => {
    const fake = makeLucidFake();
    await expect(
      buildBindDidTx({
        lucid: fake.lucid as LucidEvolution,
        engageUtxo: engage({ Script: [SCRIPT_H] }),
        consumeScript,
        didCommit: DID_32,
      }),
    ).rejects.toThrow(/OWNER_SCRIPT_WITNESS_UNAVAILABLE/);
  });
});

// ── buildMintEngageTx ─────────────────────────────────────────────────────────

describe("buildMintEngageTx — ghi owner là Credential, chứng minh quyền theo nhánh", () => {
  const seedUtxo = mkUtxo({ txHash: "11".repeat(32), outputIndex: 3 });

  it("ownerPkh (bí danh nhánh khoá) ⟹ owner VerificationKey, addSignerKey, KHÔNG mục rút", async () => {
    const fake = makeLucidFake();
    const r = await buildMintEngageTx({
      lucid: fake.lucid as LucidEvolution, consumeScript, seedUtxo, ownerPkh: KEY_H.toUpperCase(),
      network: "Preview",
    });
    const tx = fake.onlyTx();
    expect(r.genesisDatum.owner).toEqual({ VerificationKey: [KEY_H] });
    expect(tx.signerKeys).toEqual([KEY_H]);
    expect(tx.withdrawals).toEqual([]);
    const out = tx.outputs[0]!.datum as { value: string };
    expect(decodeEngageDatum(out.value).owner).toEqual({ VerificationKey: [KEY_H] });
  });

  it("ownerAuth script ⟹ owner Script(h), attachWithdraw ĐÚNG MỘT LẦN, KHÔNG ký bằng h", async () => {
    const fake = makeLucidFake();
    const { auth, calls } = scriptAuth();
    const r = await buildMintEngageTx({
      lucid: fake.lucid as LucidEvolution, consumeScript, seedUtxo, ownerAuth: auth,
      network: "Preview",
    });
    const tx = fake.onlyTx();
    expect(r.genesisDatum.owner).toEqual({ Script: [SCRIPT_H] });
    expect(calls.n).toBe(1);
    expect(tx.signerKeys).toEqual([]);
    expect(tx.withdrawals).toHaveLength(1);
  });

  it("ÂM — truyền cả ownerAuth lẫn ownerPkh ⟹ MINT-ENGAGE-003", async () => {
    await expect(
      buildMintEngageTx({
        lucid: makeLucidFake().lucid as LucidEvolution, consumeScript, seedUtxo,
        ownerPkh: KEY_H, ownerAuth: { kind: "key", pkh: KEY_H }, network: "Preview",
      }),
    ).rejects.toThrow(/MINT-ENGAGE-003/);
  });

  it("consumeRefUtxo đúng script ⟹ readFrom, KHÔNG đính MintingPolicy; validToMs ⟹ validTo", async () => {
    const fake = makeLucidFake();
    const ref = { ...mkUtxo({ txHash: "22".repeat(32), outputIndex: 0 }), scriptRef: consumeScript };
    await buildMintEngageTx({
      lucid: fake.lucid as LucidEvolution, consumeScript, seedUtxo, ownerPkh: KEY_H, network: "Preview",
      consumeRefUtxo: ref, validToMs: 1_789_000_000_000n, collateralLovelace: 3_000_000n,
    });
    const tx = fake.onlyTx();
    expect(tx.readFrom).toEqual([[ref]]);
    expect(tx.attached).toEqual([]);
    expect(tx.validTo).toBe(1_789_000_000_000);
  });

  it("CẶP: không có consumeRefUtxo ⟹ đính MintingPolicy như cũ, không readFrom, không validTo", async () => {
    const fake = makeLucidFake();
    await buildMintEngageTx({
      lucid: fake.lucid as LucidEvolution, consumeScript, seedUtxo, ownerPkh: KEY_H, network: "Preview",
    });
    const tx = fake.onlyTx();
    expect(tx.readFrom).toEqual([]);
    expect(tx.attached).toEqual([consumeScript]);
    expect(tx.validTo).toBeUndefined();
  });

  it("ÂM — consumeRefUtxo mang script KHÁC (hoặc không mang script) ⟹ MINT-ENGAGE-004 trước khi chạm Lucid", async () => {
    const other = { type: "PlutusV3" as const, script: "4746010000222220" };
    for (const scriptRef of [other, undefined]) {
      await expect(buildMintEngageTx({
        lucid: undefined as unknown as LucidEvolution, consumeScript, seedUtxo, ownerPkh: KEY_H, network: "Preview",
        consumeRefUtxo: { ...mkUtxo({ txHash: "22".repeat(32), outputIndex: 0 }), scriptRef },
      })).rejects.toThrow(/MINT-ENGAGE-004/);
    }
  });

  it("ÂM — không truyền cái nào ⟹ MINT-ENGAGE-003", async () => {
    await expect(
      buildMintEngageTx({
        lucid: makeLucidFake().lucid as LucidEvolution, consumeScript, seedUtxo, network: "Preview",
      }),
    ).rejects.toThrow(/MINT-ENGAGE-003/);
  });

  it("ÂM — script hash 27 byte ⟹ OWNER_HASH_INVALID trước khi chạm Lucid", async () => {
    const { auth } = scriptAuth("5c".repeat(27));
    await expect(
      buildMintEngageTx({
        lucid: undefined as unknown as LucidEvolution, consumeScript, seedUtxo, ownerAuth: auth,
        network: "Preview",
      }),
    ).rejects.toThrow(/OWNER_HASH_INVALID/);
  });
});
