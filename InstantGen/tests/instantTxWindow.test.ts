// tests/instantTxWindow.test.ts — Nợ #79: ghim CHỖ GỌI của bộ dựng két InstantGen Gen v2.0.
//
// `ProtocolUtils/tests/utils.test.ts` đã ghim `epochValidityWindow` như một hàm. Tệp này
// ghim thứ hàm đó KHÔNG nói được: rằng `buildInstantGenTx` thật sự gọi nó với
// `reserveTrailingSlots = 1` (còn `buildRefreshCheckpointTx` với 0), rằng mốc
// `instant_unlock_ms` ghi vào datum vì thế KHÔNG rơi vào slot cuối của epoch sau, và
// hình dạng giao dịch Gen v2.0 (két + shard GB, tham chiếu beacon GB + sổ két [+ ρ, két
// Wakeme]). Cổng số học của lượt sinh nằm ở `instantGates.test.ts` (hàm thuần).
//
// Bài kiểm đi qua bộ dựng THẬT, với `LucidEvolution` giả (TestSupport/lucidFake.ts).

import { describe, it, expect } from "vitest";
import { Data, Constr } from "@lucid-evolution/lucid";
import { VALIDITY_MAX_AHEAD_MS } from "@magiclamp/protocol-utils";
import { makeLucidFake } from "../../TestSupport/lucidFake.js";
import { buildInstantGenTx, buildRefreshCheckpointTx } from "../offchain/src/instant.js";
import {
  VaultDatum, VaultRedeemer, GbShard, OwnerCredentialSchema,
  type VaultDatum as TVaultDatum,
} from "../offchain/src/types.js";
import { computeCapLent, computeCapPp } from "../offchain/src/math.js";
import {
  NETWORK, P, E, SLOT, at, OWNER_PKH, VAULT_SCRIPT, SHARD_SCRIPT, VP, REGISTRY_POLICY,
  LAMP_BALANCE, LAMP_UNIT, SHARD_ID, GB_SEQ, SHARD_RESET, WAKEME_COMMIT,
  makeVault, makeShard, makeRate, vaultUtxo, greenbackUtxo, shardUtxo, registryUtxo, rateUtxo, wakemeUtxo,
} from "./instantFixtures.js";

const M = 1_000_000n;

async function dung(
  tipPosixMs: bigint,
  vaultOverrides: Partial<TVaultDatum> = {},
  builderOverrides: Record<string, unknown> = {},
) {
  const fake = makeLucidFake();
  const res = await buildInstantGenTx({
    lucid: fake.lucid as any,
    network: NETWORK,
    tipPosixMs,
    vaultUtxo: vaultUtxo(makeVault(vaultOverrides)),
    vaultScript: VAULT_SCRIPT,
    vaultParams: VP,
    greenbackBeaconUtxo: greenbackUtxo(),
    gbShardUtxo: shardUtxo(),
    gbShardScript: SHARD_SCRIPT,
    vaultRegistryUtxo: registryUtxo(),
    vaultRegistryPolicy: REGISTRY_POLICY,
    m: M,
    ...builderOverrides,
  } as any);
  return { res, tx: fake.onlyTx() };
}

async function dungRefresh(tipPosixMs: bigint, vaultOverrides: Partial<TVaultDatum> = {}, builderOverrides: Record<string, unknown> = {}) {
  const fake = makeLucidFake();
  const res = await buildRefreshCheckpointTx({
    lucid: fake.lucid as any,
    network: NETWORK,
    tipPosixMs,
    vaultUtxo: vaultUtxo(makeVault(vaultOverrides)),
    vaultScript: VAULT_SCRIPT,
    vaultParams: VP,
    rateBeaconUtxo: rateUtxo(),
    coinsPerUtxoByte: 4_310n,
    ...builderOverrides,
  } as any);
  return { res, tx: fake.onlyTx() };
}

/**
 * Dựng và chờ NÉM `EmptyValidityWindowError`, trả hai trường dữ liệu của lỗi.
 *
 * 🔴 KHÔNG dùng `rejects.toThrow(EmptyValidityWindowError)`: bài kiểm và bộ dựng phân giải
 * `@magiclamp/protocol-utils` qua hai cây `node_modules` khác nhau ⟹ hai đối tượng lớp
 * cùng tên, `instanceof` trả `false` trong khi lỗi đúng. Khẳng định theo `name` + hai
 * trường ghim con số người gọi thật sự dùng (chờ bao lâu).
 */
async function nemVoiChoDoi(tipPosixMs: bigint) {
  try {
    await dung(tipPosixMs);
  } catch (e) {
    const err = e as Error & { waitMs?: bigint; retryAfterMs?: bigint };
    if (err.name !== "EmptyValidityWindowError") throw err;
    return { waitMs: err.waitMs, retryAfterMs: err.retryAfterMs };
  }
  throw new Error(`Chờ NÉM ở tip ${tipPosixMs} nhưng bộ dựng chạy xong bình thường.`);
}

type Recorded = ReturnType<ReturnType<typeof makeLucidFake>["onlyTx"]>;

function datumRa(tx: Recorded): TVaultDatum {
  const out = tx.outputs[0];
  if (out === undefined) throw new Error("Bộ dựng không phát output nào — bài kiểm đọc nhầm chỗ.");
  return Data.from((out.datum as { value: string }).value, VaultDatum);
}

const TIP_DAU = at(E) + 1_000n;
const TIP_GIO_CUOI = at(E + 1n) - 1_800_000n;

describe("buildInstantGenTx — cửa sổ hiệu lực và mốc khoá", () => {
  // Cặp ghim `reserveTrailingSlots: 1n`: đổi về `0n` thì A đỏ ở `validTo`, B đỏ ở mốc
  // trong datum. Tip nằm trong GIỜ CUỐI epoch — ở đầu epoch trần VALIDITY_MAX_AHEAD_MS
  // thắng và cận trên không chạm vùng chừa.

  it("A. `validTo` là slot ÁP CHÓT của epoch, không phải slot cuối", async () => {
    const { tx } = await dung(TIP_GIO_CUOI);
    expect(tx.validFrom).toBe(Number(TIP_GIO_CUOI));
    expect(tx.validTo).toBe(Number(at(E + 1n) - 2n * SLOT));
  });

  it("A-bis. đầu epoch ⟹ `validTo` = tip + trần, KHÔNG phải cuối epoch", async () => {
    const { tx } = await dung(TIP_DAU);
    expect(tx.validTo).toBe(Number(TIP_DAU + VALIDITY_MAX_AHEAD_MS));
    expect(datumRa(tx).instant_unlock_ms - BigInt(tx.validTo!)).toBe(P);
  });

  it("B. mốc trong datum KHÔNG rơi vào slot cuối của epoch sau", async () => {
    const { tx } = await dung(TIP_GIO_CUOI);
    const moc = datumRa(tx).instant_unlock_ms;
    expect(moc).toBe(at(E + 2n) - 2n * SLOT);
    expect(moc).not.toBe(at(E + 2n) - SLOT);
    expect(moc - BigInt(tx.validTo!)).toBe(P);
  });

  it("B-bis. mốc cũ xa hơn ⟹ bộ dựng GIỮ mốc cũ (max), không ghi đè bằng cận trên + P", async () => {
    const xa = at(E + 5n);
    const { tx } = await dung(TIP_GIO_CUOI, { instant_unlock_ms: xa });
    expect(datumRa(tx).instant_unlock_ms).toBe(xa);
  });

  it("C. tip ở slot CUỐI epoch ⟹ NÉM, kèm đúng số mili-giây phải chờ", async () => {
    await expect(nemVoiChoDoi(at(E + 1n) - SLOT)).resolves.toEqual({ waitMs: 1_000n, retryAfterMs: at(E + 1n) });
  });

  it("C-bis. tip ở slot ÁP CHÓT ⟹ vẫn NÉM, vì một slot đã bị chừa", async () => {
    await expect(nemVoiChoDoi(at(E + 1n) - 2n * SLOT)).resolves.toEqual({ waitMs: 2_000n, retryAfterMs: at(E + 1n) });
  });

  it("D. cực đối — tip ở slot thứ BA từ cuối thì dựng được, khoảng đúng một slot", async () => {
    const tip = at(E + 1n) - 3n * SLOT;
    const { tx } = await dung(tip);
    expect(tx.completed).toBe(true);
    expect(tx.validTo! - tx.validFrom!).toBe(Number(SLOT));
  });
});

describe("buildInstantGenTx — hình dạng giao dịch Gen v2.0", () => {
  it("E. tiêu két + shard, trả cả hai về đúng địa chỉ, tham chiếu GB + sổ két", async () => {
    const { tx, res } = await dung(TIP_DAU);
    const v = vaultUtxo(makeVault());
    const s = shardUtxo();

    expect(tx.collectFrom).toHaveLength(2);
    expect(tx.collectFrom[0]!.redeemer).toBe(Data.to({ InstantGen: { claimed_amount: M } }, VaultRedeemer));
    // Draw { amount: 1e6 } = Constr 0 [1e6] — literal, không suy từ chính lược đồ đang kiểm.
    expect(tx.collectFrom[1]!.redeemer).toBe("d8799f1a000f4240ff");
    expect(tx.readFrom).toHaveLength(1);
    expect(tx.readFrom[0]).toEqual([greenbackUtxo(), registryUtxo()]);   // không ρ: két đã làm mới trong E
    expect(tx.attached).toEqual([VAULT_SCRIPT, SHARD_SCRIPT]);

    expect(tx.outputs).toHaveLength(2);
    expect(tx.outputs[0]!.address).toBe(v.address);
    expect(tx.outputs[0]!.assets).toEqual(v.assets);                     // IG-14: value nguyên
    expect(tx.outputs[1]!.address).toBe(s.address);
    expect(tx.outputs[1]!.assets).toEqual(s.assets);
    const shardOut = Data.from((tx.outputs[1]!.datum as { value: string }).value, GbShard);
    expect(shardOut).toEqual({ shard_id: SHARD_ID, seq: GB_SEQ, reset_amount: SHARD_RESET, remaining: SHARD_RESET - M });

    const d = datumRa(tx);
    expect(d.lamp_balance).toBe(LAMP_BALANCE);                            // I-ACT-7
    expect(d.usage_window[0]!.generated).toBe(M);
    expect(d.magic_batches.map(b => b.initial_amount)).toEqual([M]);
    expect(tx.signerKeys).toEqual([OWNER_PKH]);
    expect(tx.withdrawals).toEqual([]);
    expect(res.currentEpoch).toBe(E);
    expect(res.m).toBe(M);
  });

  it("làm mới checkpoint ⟹ ρ đứng ĐẦU danh sách tham chiếu; thiếu ρ ⟹ GEN-INST-011", async () => {
    const lui = { cap_epoch: E - 1n, usage_window_epoch: E - 1n };
    const { tx } = await dung(TIP_DAU, lui, { rateBeaconUtxo: rateUtxo() });
    expect(tx.readFrom[0]).toEqual([rateUtxo(), greenbackUtxo(), registryUtxo()]);
    expect(datumRa(tx).cap_epoch).toBe(E);
    await expect(dung(TIP_DAU, lui)).rejects.toThrow(/GEN-INST-011/);
  });

  it("két Wakeme ghim két này ⟹ tham chiếu cuối danh sách, link := owner_commit, L_lent vào trần", async () => {
    const lui = { cap_epoch: E - 1n, usage_window_epoch: E - 1n };
    const w = wakemeUtxo();
    const { tx, res } = await dung(TIP_DAU, lui, { rateBeaconUtxo: rateUtxo(), wakemeVaultUtxo: w });
    expect(tx.readFrom[0]).toEqual([rateUtxo(), greenbackUtxo(), registryUtxo(), w]);
    expect(datumRa(tx).wakeme_link).toBe(WAKEME_COMMIT);
    expect(res.outputs.lent).toBe(1_000_000_000n);
    expect(res.outputs.capLamp).toBe(computeCapPp(LAMP_BALANCE) + computeCapLent(1_000_000_000n));
  });

  it("CỰC ĐỐI: m vượt maxM ⟹ NÉM trước khi dựng (không có giao dịch nào tới complete)", async () => {
    const fake = makeLucidFake();
    await expect(buildInstantGenTx({
      lucid: fake.lucid as any, network: NETWORK, tipPosixMs: TIP_DAU,
      vaultUtxo: vaultUtxo(), vaultScript: VAULT_SCRIPT, vaultParams: VP,
      greenbackBeaconUtxo: greenbackUtxo(), gbShardUtxo: shardUtxo(), gbShardScript: SHARD_SCRIPT,
      vaultRegistryUtxo: registryUtxo(), vaultRegistryPolicy: REGISTRY_POLICY,
      m: computeCapPp(LAMP_BALANCE) + 1n,
    } as any)).rejects.toThrow(/GEN-INST-008/);
    expect(fake.txs).toEqual([]);
  });

  it("CỰC ĐỐI: sổ két không liệt kê script két ⟹ GEN-INST-016", async () => {
    await expect(dung(TIP_DAU, {}, { vaultRegistryUtxo: registryUtxo(["dd".repeat(28)]) })).rejects.toThrow(/GEN-INST-016.*sổ két/);
  });

  it("CỰC ĐỐI: UTxO shard mang NFT của shard KHÁC ⟹ GEN-INST-016", async () => {
    const other = (SHARD_ID + 1n) % 16n;
    await expect(dung(TIP_DAU, {}, { gbShardUtxo: shardUtxo(makeShard({ shard_id: other }), other) })).rejects.toThrow(/GEN-INST-016/);
  });

  it("CỰC ĐỐI: két mang datum 18 trường (Gen v1) ⟹ VAULT_DATUM_V1", async () => {
    const f = (Data.from(Data.to(makeVault(), VaultDatum)) as Constr<Data>).fields.slice(0, 18);
    await expect(dung(TIP_DAU, {}, { vaultUtxo: vaultUtxo(Data.to(new Constr(0, f))) })).rejects.toThrow(/VAULT_DATUM_V1/);
  });

  it("CỰC ĐỐI: gbShardScript có hash khác gb_shard_policy_id ⟹ GEN-INST-009", async () => {
    await expect(dung(TIP_DAU, {}, { gbShardScript: VAULT_SCRIPT })).rejects.toThrow(/GEN-INST-009/);
  });
});

// ── Người dùng mới: két IG 0 LAMP, lượt sinh ĐẦU cùng kỳ genesis két Wakeme ──────────
// Gương `vault.ak ▸ np_first_gen_zero_lamp_genesis_pin_ok` / `…_repinned_same_period_fail` /
// `np_journey_unlinked_first_gen_zero_lamp_fail`: két vừa genesis (cap_epoch 0 ⟹ lượt sinh
// làm mới, cần ρ), không LAMP riêng, link khai sẵn = owner_commit. Ba ca chỉ khác ô [2]/[11]
// của két Wakeme; ca dương qua IG-6 NHỜ L_lent, hai ca đối trượt ở đúng IG-6 (GEN-INST-001).
describe("buildInstantGenTx — két 0 LAMP, phần mượn từ két Wakeme ghim lúc genesis", () => {
  const ZERO_LAMP: Partial<TVaultDatum> = {
    lamp_balance: 0n, lamp_locked: 0n, loyalty_holdings: [], wakeme_link: WAKEME_COMMIT,
    cap_epoch: 0n, cap_nanogic: 0n, usage_window_epoch: 0n, last_updated_epoch: 0n,
  };
  const LENT = 1_000_000_000n;  // 700_000_000 + 300_000_000 của `wakemeUtxo`
  /** Két IG không mang LAMP: bỏ hẳn mục LAMP khỏi value (không để mục số lượng 0). */
  function zeroLampVault(over: Partial<TVaultDatum> = {}) {
    const u = vaultUtxo(makeVault({ ...ZERO_LAMP, ...over }));
    const { [LAMP_UNIT]: _drop, ...assets } = u.assets;
    void _drop;
    return { ...u, assets };
  }
  const dungZero = (w: ReturnType<typeof wakemeUtxo>, over: Partial<TVaultDatum> = {}) =>
    dung(TIP_DAU, {}, { vaultUtxo: zeroLampVault(over), rateBeaconUtxo: rateUtxo(), wakemeVaultUtxo: w });

  it("ghim từ genesis CÙNG kỳ (vest_start ∈ kỳ E, [12] = E) ⟹ dựng được, trần = cap_pp(0) + cap_lent(L_lent)", async () => {
    const { tx, res } = await dungZero(wakemeUtxo({ vestStartMs: at(E) + 5_000n, pinPeriod: E }));
    expect(tx.completed).toBe(true);
    expect(res.outputs.lent).toBe(LENT);
    expect(res.outputs.lAvail).toBe(0n);
    expect(res.outputs.capLamp).toBe(computeCapPp(0n) + computeCapLent(LENT));
    const d = datumRa(tx);
    expect(d.lamp_balance).toBe(0n);                // I-ACT-7: không LAMP nào vào/ra két
    expect(d.wakeme_link).toBe(WAKEME_COMMIT);
    expect(d.cap_epoch).toBe(E);
    expect(d.usage_window[0]!.generated).toBe(M);
    expect(tx.readFrom[0]).toContainEqual(wakemeUtxo({ vestStartMs: at(E) + 5_000n, pinPeriod: E }));
  });

  it("CỰC ĐỐI: genesis kỳ E−1, ĐỔI ghim ở kỳ E ⟹ L_lent = 0 ⟹ GEN-INST-001 (IG-6)", async () => {
    await expect(dungZero(wakemeUtxo({ vestStartMs: at(E - 1n) + 5_000n, pinPeriod: E })))
      .rejects.toThrow(/GEN-INST-001.*L_lent 0/);
  });

  // Từ 2026-10-03 (luật 6 bỏ vế (a)) ca này chết SỚM HƠN: link rỗng + két chưa ghim ⟹
  // không nối được (GEN-INST-011), trước khi tới IG-6. Gương `np_journey_unlinked_first_gen_zero_lamp_fail`.
  it("CỰC ĐỐI: link rỗng, két Wakeme genesis CHƯA ghim két IG ⟹ không nối được (luật 6) ⟹ GEN-INST-011", async () => {
    await expect(dungZero(wakemeUtxo({ vestStartMs: at(E) + 5_000n, pinPeriod: E, pinned: false }), { wakeme_link: "" }))
      .rejects.toThrow(/GEN-INST-011.*luật 6/s);
  });
});

// ── Chủ két là `Credential` ──────────────────────────────────────────────────
// Bytes kỳ vọng dựng tay từ blueprint `cardano/address/Credential`: VerificationKey =
// Constr 0 [bytes 28], Script = Constr 1 [bytes 28].
const SCRIPT_H = "5c".repeat(28);
const CBOR_VK  = `d8799f581c${OWNER_PKH}ff`;
const CBOR_SC  = `d87a9f581c${SCRIPT_H}ff`;
const OwnerCredential = OwnerCredentialSchema as unknown as TVaultDatum["owner"];

describe("VaultDatum.owner — mã hoá Credential khớp blueprint", () => {
  it("VerificationKey ⟹ Constr 0, Script ⟹ Constr 1, cùng 28 byte", () => {
    expect(Data.to({ VerificationKey: [OWNER_PKH] }, OwnerCredential)).toBe(CBOR_VK);
    expect(Data.to({ Script: [SCRIPT_H] }, OwnerCredential)).toBe(CBOR_SC);
  });

  it("trường 0 của datum 20 trường mang ĐÚNG bytes Credential", () => {
    const hex = Data.to(makeVault({ owner: { Script: [SCRIPT_H] } }), VaultDatum);
    expect(hex.startsWith(`d8799f${CBOR_SC}`)).toBe(true);
    expect(Data.from(hex, VaultDatum).owner).toEqual({ Script: [SCRIPT_H] });
  });

  it("CỰC ĐỐI: owner = pkh trần (lược đồ trước Credential) KHÔNG giải mã được", () => {
    const moi = Data.to(makeVault(), VaultDatum);
    const cu = `d8799f581c${OWNER_PKH}` + moi.slice(`d8799f${CBOR_VK}`.length);
    expect(() => Data.from(cu, VaultDatum)).toThrow();
  });

  it("CỰC ĐỐI: hash 27 byte ⟹ lược đồ từ chối mã hoá", () => {
    expect(() => Data.to({ VerificationKey: ["0a".repeat(27)] }, OwnerCredential)).toThrow();
  });
});

describe("buildInstantGenTx — chứng minh quyền chủ theo nhánh", () => {
  // Két chủ script: shard GB theo hash trong owner ⟹ phải đưa đúng shard của hash đó.
  const shardOf = async (owner: TVaultDatum["owner"]) => {
    const { vaultShardId } = await import("../offchain/src/greenback.js");
    const id = vaultShardId(owner);
    return shardUtxo(makeShard({ shard_id: id }), id);
  };

  it("chủ khoá ⟹ addSignerKey(pkh), KHÔNG mục rút", async () => {
    const { tx } = await dung(TIP_DAU);
    expect(tx.signerKeys).toEqual([OWNER_PKH]);
    expect(tx.withdrawals).toEqual([]);
  });

  it("chủ script ⟹ attachWithdraw ĐÚNG MỘT LẦN, KHÔNG ký bằng h", async () => {
    let goi = 0;
    const owner = { Script: [SCRIPT_H] } as TVaultDatum["owner"];
    const { tx } = await dung(TIP_DAU, { owner }, {
      gbShardUtxo: await shardOf(owner),
      ownerAuth: {
        kind: "script", hash: SCRIPT_H,
        attachWithdraw: (t: any) => { goi++; return t.withdraw("stake_test1_gia", 0n, "d87980"); },
      },
    });
    expect(goi).toBe(1);
    expect(tx.signerKeys).toEqual([]);
    expect(tx.withdrawals).toEqual([{ rewardAddress: "stake_test1_gia", amount: 0n, redeemer: "d87980" }]);
  });

  it("CỰC ĐỐI: chủ script mà không có ownerAuth ⟹ NÉM OWNER_SCRIPT_WITNESS_UNAVAILABLE", async () => {
    const owner = { Script: [SCRIPT_H] } as TVaultDatum["owner"];
    await expect(dung(TIP_DAU, { owner }, { gbShardUtxo: await shardOf(owner) })).rejects.toThrow(/OWNER_SCRIPT_WITNESS_UNAVAILABLE/);
  });

  it("CỰC ĐỐI: ownerAuth khoá cho két chủ script cùng 28 byte ⟹ OWNER_AUTH_MISMATCH", async () => {
    const owner = { Script: [OWNER_PKH] } as TVaultDatum["owner"];
    await expect(
      dung(TIP_DAU, { owner }, { gbShardUtxo: await shardOf(owner), ownerAuth: { kind: "key", pkh: OWNER_PKH } }),
    ).rejects.toThrow(/OWNER_AUTH_MISMATCH/);
  });
});

describe("vault script: readFrom ref-script khi có", () => {
  const refUtxo = (scriptRef: unknown) => ({ ...vaultUtxo(), outputIndex: 7, datum: undefined, scriptRef });

  it("có ref đúng script ⟹ đọc, chỉ đính kèm shard", async () => {
    const ref = refUtxo(VAULT_SCRIPT);
    const { tx } = await dung(TIP_DAU, {}, { vaultRefScriptUtxo: ref });
    expect(tx.attached).toEqual([SHARD_SCRIPT]);
    expect(tx.readFrom.flat()).toContain(ref);
  });

  it("CỰC ĐỐI — vắng ref ⟹ đính kèm script két", async () => {
    const { tx } = await dung(TIP_DAU);
    expect(tx.attached).toContain(VAULT_SCRIPT);
  });

  it("ref mang script KHÁC ⟹ GEN-INST-009", async () => {
    await expect(dung(TIP_DAU, {}, { vaultRefScriptUtxo: refUtxo(SHARD_SCRIPT) })).rejects.toThrow(/GEN-INST-009/);
  });

  it("ref không mang script ⟹ GEN-INST-009", async () => {
    await expect(dung(TIP_DAU, {}, { vaultRefScriptUtxo: refUtxo(null) })).rejects.toThrow(/GEN-INST-009/);
  });
});

describe("buildRefreshCheckpointTx", () => {
  it("redeemer Constr 6, value két ra == value vào NGUYÊN KHỐI, chỉ tham chiếu ρ", async () => {
    const { tx, res } = await dungRefresh(TIP_DAU);
    expect(tx.collectFrom).toHaveLength(1);
    expect(tx.collectFrom[0]!.redeemer).toBe(Data.to("RefreshCheckpoint", VaultRedeemer));
    expect(tx.collectFrom[0]!.redeemer).toBe("d87f80");                    // Constr 6 []
    expect(tx.readFrom[0]).toEqual([rateUtxo()]);
    expect(tx.outputs).toHaveLength(1);
    expect(tx.outputs[0]!.assets).toEqual(vaultUtxo().assets);
    expect(datumRa(tx)).toEqual(res.outputDatum);
    expect(res.currentEpoch).toBe(E);
    expect(tx.signerKeys).toEqual([OWNER_PKH]);
  });

  it("KHÔNG chừa slot cuối (reserve 0): cặp với lượt sinh ở cùng tip", async () => {
    const { tx } = await dungRefresh(TIP_GIO_CUOI);
    expect(tx.validTo).toBe(Number(at(E + 1n) - SLOT));
    const gen = await dung(TIP_GIO_CUOI);
    expect(gen.tx.validTo).toBe(Number(at(E + 1n) - 2n * SLOT));
  });

  it("link đã ghim, vắng két Wakeme ⟹ gỡ ghim; có két ⟹ link := owner_commit", async () => {
    const go = await dungRefresh(TIP_DAU, { wakeme_link: WAKEME_COMMIT });
    expect(datumRa(go.tx).wakeme_link).toBe("");
    const w = wakemeUtxo();
    const noi = await dungRefresh(TIP_DAU, {}, { wakemeVaultUtxo: w });
    expect(datumRa(noi.tx).wakeme_link).toBe(WAKEME_COMMIT);
    expect(noi.tx.readFrom[0]).toEqual([rateUtxo(), w]);
  });

  it("CỰC ĐỐI: beacon ρ đặt sai địa chỉ ⟹ GEN-INST-016", async () => {
    const sai = { ...rateUtxo(makeRate()), address: greenbackUtxo().address };
    await expect(dungRefresh(TIP_DAU, {}, { rateBeaconUtxo: sai })).rejects.toThrow(/GEN-INST-016/);
  });

  it("két không nằm ở script két ⟹ GEN-INST-009", async () => {
    const lech = { ...vaultUtxo(), address: shardUtxo().address };
    await expect(dungRefresh(TIP_DAU, {}, { vaultUtxo: lech })).rejects.toThrow(/GEN-INST-009/);
  });

  // Cặp min-ADA: lovelace ra = max(vào, min-ADA của datum ra). Hai ca chỉ khác lovelace két:
  // két dư ADA ⟹ giữ nguyên; két dưới min-ADA của datum ra ⟹ nạp thêm, token khác không đổi.
  it("két 5 ADA ⟹ lovelace ra = vào", async () => {
    const { tx } = await dungRefresh(TIP_DAU);
    expect(tx.completed).toBe(true);
    expect(tx.outputs[0]!.assets.lovelace).toBe(vaultUtxo().assets.lovelace);
  });
  it("CỰC ĐỐI: két 1 ADA (dưới min-ADA của datum ra) ⟹ lovelace ra > vào, token khác nguyên khối", async () => {
    const thap = { ...vaultUtxo(), assets: { ...vaultUtxo().assets, lovelace: 1_000_000n } };
    const { tx } = await dungRefresh(TIP_DAU, {}, { vaultUtxo: thap });
    const { lovelace: ra, ...khacRa } = tx.outputs[0]!.assets;
    const { lovelace: _vao, ...khacVao } = thap.assets;
    expect(ra! > 1_000_000n).toBe(true);
    expect(khacRa).toEqual(khacVao);
  });
  it("CỰC ĐỐI: không truyền coinsPerUtxoByte mà provider không có config ⟹ NÉM (bộ giả không đệm)", async () => {
    await expect(dungRefresh(TIP_DAU, {}, { coinsPerUtxoByte: undefined })).rejects.toThrow(/config/);
  });
});
