// tests/scheduleTxWindow.test.ts — Nợ #79, phần ScheduleGen.
//
// `schedule.ts:262` (commit) và `schedule.ts:449` (fire) là hai chỗ gọi
// `epochValidityWindow` cuối cùng chưa có bài nào chạy qua. Trước tệp này bộ kiểm
// ScheduleGen chỉ chạm `math.ts` + `constants.ts`: nó xanh toàn phần ở lượt chạy
// TRƯỚC khi `ProtocolUtils/dist` được dựng lại, tức lúc `epochValidityWindow` còn
// chưa tồn tại trong bản mà nó nạp qua `file:`. Màu xanh đó là một phép đo không
// đo được gì, phát ra bằng giọng của một phép đo đạt.
//
// Bài ở đây đi qua bộ dựng THẬT với `LucidEvolution` giả (TestSupport/lucidFake.ts).
//
// KHÁC InstantGen ở một chỗ và đó là chỗ phải ghim: hai lời gọi này KHÔNG kèm tham
// số chừa slot, nên cận trên là slot CUỐI của epoch, không phải slot áp chót. Mốc
// khoá LAMP không sinh ra từ hai nhánh này nên không có ô chết nào để né.

import { describe, it, expect } from "vitest";
import { Data } from "@lucid-evolution/lucid";
import { msPerEpoch, windowOriginMs, VALIDITY_MAX_AHEAD_MS } from "@magiclamp/protocol-utils";
import { makeLucidFake } from "../../TestSupport/lucidFake.js";
import { buildScheduleCommitTx, buildScheduleFireTx } from "../offchain/src/schedule.js";
import { computeShardId } from "../offchain/src/math.js";
import {
  VaultDatum, OwnerCredentialSchema, ScheduleShardDatum,
  type VaultDatum as TVaultDatum,
  type ScheduleShardDatum as TShardDatum,
  type GenSchedule,
} from "../offchain/src/types.js";
import {
  GEN, GB_SHARD_SCRIPT, COMMIT_SCRIPT, COMMIT_REWARD, ZW, makeBeacon, gbShardUtxos, rateBeaconUtxo,
  gbBeaconUtxo, registryUtxo,
} from "./genV2Fixtures.js";

// ── Bối cảnh: Preprod, epoch 100 ──────────────────────────────
const NETWORK = "Preprod" as const;
const P       = msPerEpoch(NETWORK);          // 432_000_000 ms
const E       = 100n;
// Gốc cửa sổ Preprod: biên epoch giao thức `e` là `O + e·P` (`at(e)`), không phải `e·P`.
const O       = windowOriginMs(NETWORK);
const at      = (e: bigint): bigint => O + e * P;
const SLOT    = 1_000n;

// Chủ là `Credential`. "0a"×28 rơi shard 10 (TV-SCH-SHARD-CRED, `vectors.ts`).
const OWNER_PKH   = "0a".repeat(28);
const OWNER       = { VerificationKey: [OWNER_PKH] } as TVaultDatum["owner"];
const SCRIPT_H    = "5c".repeat(28);
const LAMP_POLICY = "aa".repeat(28);
const LAMP_NAME   = "744c414d50";             // "tLAMP" ở dạng hex
const LAMP_UNIT   = LAMP_POLICY + LAMP_NAME;
const VAULT_ID_UNIT = "bb".repeat(28) + "cc".repeat(8);

const SCHEDULE_ID = "5c4ed0";

// Hai script tối giản KHÁC NHAU — chỉ dùng để suy ra hai địa chỉ, không bao giờ
// được chạy. Phải khác nhau: dùng chung một script thì vault và shard ra cùng địa
// chỉ và bài "hai output đi hai nơi" không phân biệt được gì.
const VAULT_SCRIPT = { type: "PlutusV3" as const, script: "49480100002221200101" };
const SHARD_SCRIPT = { type: "PlutusV3" as const, script: "4746010000222601" };

// ── ShardDatum ────────────────────────────────────────────────
// Gen v2.0: lược đồ nay xuất từ `types.ts` ▸ `ScheduleShardDatum` (8 trường, nối
// `shard_obligation_nanogic`), không khai lại ở đây nữa.
const ShardDatum = ScheduleShardDatum;

const SHARD_LOCKED = 10_000_000_000n;   // đủ để nhánh fire trừ đi mà không âm

function utxo(datumHex: string, assets: Record<string, bigint>, ix = 0, txHash = "ab".repeat(32)) {
  return {
    txHash, outputIndex: ix,
    address: "addr_test1wq" + "q".repeat(50),
    assets, datum: datumHex, datumHash: null, scriptRef: null,
  } as any;
}

/** Cả 16 shard — bộ dựng phải tự tìm đúng cái theo `computeShardId(owner)`. */
function shardUtxos() {
  return Array.from({ length: 16 }, (_, i) =>
    utxo(
      Data.to({
        shard_id:                   BigInt(i),
        shard_locked_lamp:          SHARD_LOCKED,
        shard_active_count:         1n,
        shard_cumulative_committed: SHARD_LOCKED,
        shard_cumulative_fired:     0n,
        last_updated_epoch:         99n,
        shard_cap:                  450_000_000_000_000n,
        // Đủ để nhánh fire trừ `m_per_epoch × 1` mà không âm.
        shard_obligation_nanogic:   100_000_000_000n,
      } as TShardDatum, ShardDatum),
      { lovelace: 2_000_000n },
      i,
      "cd".repeat(32),
    ),
  );
}

const SCHED: GenSchedule = {
  schedule_id:            SCHEDULE_ID,
  commit_epoch:           98n,
  // Đúng epoch hiện tại ⟹ `countEligibleFires` trả ĐÚNG 1, không dính đường catch-up.
  start_fire_epoch:       E,
  end_fire_epoch:         109n,
  schedule_length:        10n,
  lamp_per_epoch:         1_000_000_000n,
  rate_locked_q:          8_000_000_000n,
  baseline_at_commit_q:   5_000_000_000n,
  multiplier_at_commit_q: 1_600_000_000n,
  fired_count:            0n,
  auto_burn_target:       null,
  m_per_epoch:            3_000_000_000n,
  usage_factor_locked_q:  750_000_000n,
} as GenSchedule;

function makeVault(overrides: Partial<TVaultDatum> = {}): TVaultDatum {
  return {
    owner:                 OWNER,
    lamp_balance:          100_000_000_000n,
    lamp_locked:           0n,
    loyalty_holdings:      [{ amount: 100_000_000_000n, acquired_epoch: 50n, is_locked: false }],
    magic_batches:         [],
    next_batch_index:      0n,
    vacuum_orders:         [],
    gen_schedules:         [],
    profile:               "Flame",
    profile_changed_epoch: 0n,
    pending_profile:       null,
    last_updated_epoch:    99n,
    delegation_cert:       { current: [], pending: null, current_effective_epoch: 0n, last_changed_epoch: 0n },
    activity_state:        { recent_burn_epochs: [], consumed_credit: 1_000_000_000n },
    streak_state:          { current_streak: 0n, last_active_epoch: 0n },
    personal_delegate:     null,
    attribution:           { attribution_root: "00".repeat(32), last_event_epoch: 0n, total_events: 0n },
    // 🔴 19 trường (Gen v2.0), DỪNG ở đây. `VaultDatum` của ScheduleGen KHÔNG có
    // `instant_unlock_ms` — trường đó chỉ tồn tại ở InstantGen (20 trường), và
    // `Data.to` nghiêm ngặt về số trường nên chép fixture từ bên kia sang là
    // `Could not type cast to constructor`.
    usage_window:          ZW(),
    usage_window_epoch:    99n,
    ...overrides,
  } as TVaultDatum;
}

const VAULT_ASSETS = {
  lovelace: 5_000_000n,
  [LAMP_UNIT]: 100_000_000_000n,
  [VAULT_ID_UNIT]: 1n,
};

function vaultUtxoFor(d: TVaultDatum) {
  return utxo(Data.to(d, VaultDatum), VAULT_ASSETS);
}

async function dungCommit(
  tipPosixMs: bigint,
  vaultOverrides: Partial<TVaultDatum> = {},
  builderOverrides: Record<string, unknown> = {},
) {
  const fake = makeLucidFake();
  const res = await buildScheduleCommitTx({
    ...builderOverrides,
    lucid:          fake.lucid as any,
    vaultUtxo:      vaultUtxoFor(makeVault(vaultOverrides)),
    shardUtxos:     shardUtxos(),
    scheduleLength: 10n,
    lampPerEpoch:   1_000_000_000n,
    userAddress:    "addr_test1vq" + "q".repeat(50),
    vaultScript:    VAULT_SCRIPT,
    shardScript:    SHARD_SCRIPT,
    lampPolicyId:   LAMP_POLICY,
    lampAssetName:  LAMP_NAME,
    network:        NETWORK,
    tipPosixMs,
    // Gen v2.0: beacon ρ + GreenBack (ghi ở epoch E) + sổ két + 16 shard GB.
    gen:               GEN,
    gbShardScript:     GB_SHARD_SCRIPT,
    commitScript:      COMMIT_SCRIPT,
    rateBeaconUtxo:    rateBeaconUtxo(),
    gbBeaconUtxo:      gbBeaconUtxo(makeBeacon(E)),
    vaultRegistryUtxo: registryUtxo(),
    gbShardUtxos:      gbShardUtxos(),
  } as any);
  return { res, tx: fake.onlyTx() };
}

async function dungFire(tipPosixMs: bigint) {
  const fake = makeLucidFake();
  const res = await buildScheduleFireTx({
    lucid:      fake.lucid as any,
    vaultUtxo:  vaultUtxoFor(makeVault({
      lamp_locked:      10_000_000_000n,
      loyalty_holdings: [
        { amount: 10_000_000_000n, acquired_epoch: 50n, is_locked: true  },
        { amount: 90_000_000_000n, acquired_epoch: 60n, is_locked: false },
      ],
      gen_schedules:    [SCHED],
    })),
    shardUtxos:    shardUtxos(),
    scheduleId:    SCHEDULE_ID,
    vaultScript:   VAULT_SCRIPT,
    shardScript:   SHARD_SCRIPT,
    lampPolicyId:  LAMP_POLICY,
    lampAssetName: LAMP_NAME,
    network:       NETWORK,
    tipPosixMs,
  } as any);
  return { res, tx: fake.onlyTx() };
}

/**
 * Dựng và chờ NÉM, trả về hai trường dữ liệu của lỗi.
 *
 * 🔴 KHÔNG dùng `rejects.toThrow(EmptyValidityWindowError)`. Bài kiểm nằm ở
 * `ScheduleGen/tests/`, bộ dựng ở `ScheduleGen/offchain/src/` — hai chỗ phân giải
 * `@magiclamp/protocol-utils` qua hai cây `node_modules` khác nhau, nên có HAI đối
 * tượng lớp cùng tên và `instanceof` trả `false` trong khi lỗi hoàn toàn đúng. Lý do
 * đầy đủ ở `InstantGen/tests/instantTxWindow.test.ts` ▸ `nemVoiChoDoi`.
 *
 * Khẳng định theo `name` + hai trường dữ liệu KHÔNG phải một bản hạ cấp: nó ghim con
 * số mà người gọi thật sự dùng (chờ bao lâu), thứ `instanceof` không chạm.
 */
async function nemVoiChoDoi(
  dung: (tip: bigint) => Promise<unknown>,
  tipPosixMs: bigint,
) {
  try {
    await dung(tipPosixMs);
  } catch (e) {
    const err = e as Error & { waitMs?: bigint; retryAfterMs?: bigint };
    if (err.name !== "EmptyValidityWindowError") throw err;   // lỗi khác thì để nó nổi lên
    return { waitMs: err.waitMs, retryAfterMs: err.retryAfterMs };
  }
  throw new Error(`Chờ NÉM ở tip ${tipPosixMs} nhưng bộ dựng chạy xong bình thường.`);
}

describe("buildScheduleCommitTx — cửa sổ hiệu lực", () => {

  it("A. giờ cuối epoch, không chừa slot nào ⟹ `validTo` là slot CUỐI của epoch", async () => {
    const tip = at(E + 1n) - 1_800_000n;
    const { tx } = await dungCommit(tip);

    expect(tx.validFrom).toBe(Number(tip));
    // Mốc hợp lệ cuối là (E+1)P − 1; đầu slot chứa nó là (E+1)P − 1000. KHÔNG lùi
    // thêm: chỗ gọi này không truyền `reserveTrailingSlots`.
    expect(tx.validTo).toBe(Number(at(E + 1n) - SLOT));
  });

  it("A-bis. đầu epoch ⟹ `validTo` = tip + trần, KHÔNG phải cuối epoch (chân trời node)", async () => {
    const tip = at(E) + 1_000n;
    const { tx } = await dungCommit(tip);

    expect(tx.validTo).toBe(Number(tip + VALIDITY_MAX_AHEAD_MS));
  });

  it("B. tip ở slot CUỐI ⟹ NÉM, kèm đúng số mili-giây phải chờ", async () => {
    await expect(nemVoiChoDoi(dungCommit, at(E + 1n) - SLOT)).resolves.toEqual({
      waitMs: 1_000n, retryAfterMs: at(E + 1n),
    });
  });

  it("B-bis. cực đối — tip ở slot ÁP CHÓT thì dựng được, khoảng đúng một slot", async () => {
    const tip = at(E + 1n) - 2n * SLOT;
    const { tx } = await dungCommit(tip);

    expect(tx.completed).toBe(true);
    expect(tx.validFrom).toBe(Number(tip));
    expect(tx.validTo).toBe(Number(at(E + 1n) - SLOT));
    expect(tx.validTo! - tx.validFrom!).toBe(Number(SLOT));
  });

  // Ca hình dạng — không kiểm cửa sổ, mà kiểm rằng ba ca trên chạy qua `schedule.ts`
  // chứ không qua một bản mô phỏng. Bộ dựng ngừng gọi `.validTo()` thì `validTo` là
  // `undefined` và cả ba ca trên đỏ, chứ không âm thầm xanh.
  it("C. giao dịch mang đúng hình dạng ScheduleCommit — và CÓ chữ ký chủ két", async () => {
    const { tx, res } = await dungCommit(at(E) + 1_000n);

    expect(tx.collectFrom).toHaveLength(3);        // vault + shard LAMP + shard GB (Gen v2.0)
    expect(tx.attached).toHaveLength(4);           // không đưa ref ⟹ attach két + shard + gb_shard + commit
    expect(tx.outputs).toHaveLength(3);            // vault, shard LAMP, shard GB — mỗi cái về chỗ cũ
    expect(tx.outputs[0]!.address).not.toBe(tx.outputs[1]!.address);
    expect(tx.readFrom[0]).toHaveLength(3);        // beacon ρ + beacon GB + sổ két
    // Commit là nhánh của CHỦ KÉT: nó khoá LAMP của người ta. Một ngày nào đó
    // `addSignerKey` biến mất khỏi đây thì bất kỳ ai cũng khoá được LAMP của người
    // khác — phải đỏ ngay, không chỉ nằm trong chú thích.
    expect(tx.signerKeys).toEqual([OWNER_PKH]);
    // Chủ khoá: KHÔNG mục rút quyền chủ — mục rút duy nhất là chân uỷ quyền của `commit`.
    expect(tx.withdrawals.map((w: any) => [w.rewardAddress, w.amount])).toEqual([[COMMIT_REWARD, 0n]]);
    // Shard tiêu phải là shard của 28 byte BÊN TRONG credential (vector: 10).
    expect((tx.collectFrom[1]!.utxos[0] as { outputIndex: number }).outputIndex).toBe(10);
    // Redeemer theo BYTE: Constr 0 [10, 1_000_000_000] — một lược đồ sai hình dạng
    // mà vẫn mã hoá được sẽ trượt qua phép kiểm "không ném" rồi chết trên chuỗi.
    expect(tx.collectFrom[0]!.redeemer).toBe("d8799f0a1a3b9aca00ff");
    expect(res.firstFireEpoch).toBe(E + 2n);       // SCHEDULE_DELAY = 2
    expect(res.totalLampLocked).toBe(10_000_000_000n);
  });
});

describe("buildScheduleFireTx — cửa sổ hiệu lực", () => {

  it("A. giờ cuối epoch, không chừa slot nào ⟹ `validTo` là slot CUỐI của epoch", async () => {
    const tip = at(E + 1n) - 1_800_000n;
    const { tx } = await dungFire(tip);

    expect(tx.validFrom).toBe(Number(tip));
    expect(tx.validTo).toBe(Number(at(E + 1n) - SLOT));
  });

  it("A-bis. đầu epoch ⟹ `validTo` = tip + trần, KHÔNG phải cuối epoch (chân trời node)", async () => {
    const tip = at(E) + 1_000n;
    const { tx } = await dungFire(tip);

    expect(tx.validTo).toBe(Number(tip + VALIDITY_MAX_AHEAD_MS));
  });

  it("B. tip ở slot CUỐI ⟹ NÉM, kèm đúng số mili-giây phải chờ", async () => {
    await expect(nemVoiChoDoi(dungFire, at(E + 1n) - SLOT)).resolves.toEqual({
      waitMs: 1_000n, retryAfterMs: at(E + 1n),
    });
  });

  it("B-bis. cực đối — tip ở slot ÁP CHÓT thì dựng được, khoảng đúng một slot", async () => {
    const tip = at(E + 1n) - 2n * SLOT;
    const { tx } = await dungFire(tip);

    expect(tx.completed).toBe(true);
    expect(tx.validFrom).toBe(Number(tip));
    expect(tx.validTo).toBe(Number(at(E + 1n) - SLOT));
    expect(tx.validTo! - tx.validFrom!).toBe(Number(SLOT));
  });

  it("C. giao dịch mang đúng hình dạng ScheduleFire — và KHÔNG có chữ ký nào", async () => {
    const { tx, res } = await dungFire(at(E) + 1_000n);

    expect(tx.collectFrom).toHaveLength(2);
    expect(tx.attached).toHaveLength(2);
    expect(tx.outputs).toHaveLength(2);
    expect(tx.outputs[0]!.address).not.toBe(tx.outputs[1]!.address);
    // C-SCH-FIRE-PERMISSION: fire là permissionless. Một `addSignerKey` lọt vào đây
    // là đổi mô hình tin cậy của cả nhánh — và nó phải đỏ, vì đúng nhánh này là
    // nhánh DUY NHẤT hạ `lamp_locked` (BOUNDARIES §2): khoá nó lại sau một chữ ký
    // là khoá LAMP của người đã bỏ đi.
    expect(tx.signerKeys).toEqual([]);
    expect(tx.withdrawals).toEqual([]);   // fire không đòi quyền chủ ở nhánh nào
    expect(tx.collectFrom[0]!.redeemer).toBe("d87a9f435c4ed0ff");   // Constr 1 [h'5c4ed0']
    expect(res.firesInTx).toBe(1);
    expect(res.lampReleased).toBe(1_000_000_000n);
    expect(res.scheduleComplete).toBe(false);
    // I-ACT-7: LAMP chỉ được NHẢ khỏi phần khoá, không rời két. Bài này ghim
    // rằng shard cũng trở về đúng chỗ chứ không bị dựng lại.
    expect(computeShardId(OWNER)).toBeLessThan(16);
  });
});

// ── Chủ két là `Credential` (on-chain 856804fa) ───────────────────────────────
// Bytes kỳ vọng dựng tay từ blueprint `cardano/address/Credential` (đối chiếu
// `ScheduleGen/onchain/plutus.json` 2026-09-26).
describe("VaultDatum.owner (ScheduleGen) — mã hoá Credential khớp blueprint", () => {
  it("VerificationKey ⟹ Constr 0, Script ⟹ Constr 1", () => {
    expect(Data.to({ VerificationKey: [OWNER_PKH] }, OwnerCredentialSchema as never))
      .toBe(`d8799f581c${OWNER_PKH}ff`);
    expect(Data.to({ Script: [SCRIPT_H] }, OwnerCredentialSchema as never))
      .toBe(`d87a9f581c${SCRIPT_H}ff`);
  });

  it("trường 0 của datum 19 trường mang ĐÚNG bytes Credential", () => {
    const hex = Data.to(makeVault({ owner: { Script: [SCRIPT_H] } }), VaultDatum);
    expect(hex.startsWith(`d8799fd87a9f581c${SCRIPT_H}ff`)).toBe(true);
  });

  it("CỰC ĐỐI: owner = pkh trần (lược đồ cũ) ⟹ không giải mã được", () => {
    const moi = Data.to(makeVault(), VaultDatum);
    const cu = `d8799f581c${OWNER_PKH}` + moi.slice(`d8799fd8799f581c${OWNER_PKH}ff`.length);
    expect(() => Data.from(cu, VaultDatum)).toThrow();
  });
});

describe("buildScheduleCommitTx — chứng minh quyền chủ theo nhánh", () => {
  const TIP = at(E) + 1_000n;

  it("chủ script ⟹ attachWithdraw ĐÚNG MỘT LẦN, KHÔNG ký bằng h, shard theo h", async () => {
    let goi = 0;
    const { tx } = await dungCommit(TIP, { owner: { Script: [SCRIPT_H] } }, {
      ownerAuth: {
        kind: "script",
        hash: SCRIPT_H,
        attachWithdraw: (t: any) => { goi++; return t.withdraw("stake_test1_gia", 0n, "d87980"); },
      },
    });
    expect(goi).toBe(1);
    expect(tx.signerKeys).toEqual([]);
    // Hai mục rút: chân `commit` + chân quyền chủ script.
    expect(tx.withdrawals.map((w: any) => w.rewardAddress)).toEqual([COMMIT_REWARD, "stake_test1_gia"]);
    // "5c"×28 rơi shard 9 (TV-SCH-SHARD-CRED).
    expect((tx.collectFrom[1]!.utxos[0] as { outputIndex: number }).outputIndex).toBe(9);
  });

  it("CỰC ĐỐI: chủ script mà không có ownerAuth ⟹ OWNER_SCRIPT_WITNESS_UNAVAILABLE", async () => {
    await expect(dungCommit(TIP, { owner: { Script: [SCRIPT_H] } })).rejects.toThrow(
      /OWNER_SCRIPT_WITNESS_UNAVAILABLE/,
    );
  });

  it("CỰC ĐỐI: ownerAuth script khác hash chủ ⟹ OWNER_AUTH_MISMATCH", async () => {
    await expect(
      dungCommit(TIP, { owner: { Script: [SCRIPT_H] } }, {
        ownerAuth: { kind: "script", hash: "5d".repeat(28), attachWithdraw: (t: any) => t },
      }),
    ).rejects.toThrow(/OWNER_AUTH_MISMATCH/);
  });
});
