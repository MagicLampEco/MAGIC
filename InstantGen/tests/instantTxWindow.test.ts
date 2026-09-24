// tests/instantTxWindow.test.ts — Nợ #79: ghim CHỖ GỌI, không ghim công thức.
//
// `ProtocolUtils/tests/utils.test.ts` đã ghim `epochValidityWindow` như một hàm.
// Tệp này ghim thứ hàm đó KHÔNG nói được: rằng `buildInstantGenTx` thật sự gọi nó,
// với `reserveTrailingSlots = 1`, và rằng mốc `instant_unlock_ms` ghi vào datum vì
// thế KHÔNG rơi vào slot cuối của epoch sau.
//
// Bài kiểm ở đây đi qua bộ dựng THẬT, với `LucidEvolution` giả (TestSupport/lucidFake.ts).
// Trước tệp này, bộ kiểm InstantGen xanh trong khi `instant.ts` chưa từng được nạp.

import { describe, it, expect } from "vitest";
import { Data } from "@lucid-evolution/lucid";
import { msPerEpoch, EmptyValidityWindowError, VALIDITY_MAX_AHEAD_MS } from "@magiclamp/protocol-utils";
import { makeLucidFake } from "../../TestSupport/lucidFake.js";
import { buildInstantGenTx } from "../offchain/src/instant.js";
import {
  VaultDatum, UMDatum, BackingBeaconDatum,
  type VaultDatum as TVaultDatum,
  type UMDatum as TUMDatum,
  type BackingBeaconDatum as TBackingBeaconDatum,
  type GenSchedule,
} from "../offchain/src/types.js";

// ── Bối cảnh: Preprod, epoch 100 ──────────────────────────────
const NETWORK = "Preprod" as const;
const P       = msPerEpoch(NETWORK);          // 432_000_000 ms
const E       = 100n;
const SLOT    = 1_000n;

const LAMP_POLICY = "aa".repeat(28);
const LAMP_NAME   = "744c414d50";             // "tLAMP" ở dạng hex
const LAMP_UNIT   = LAMP_POLICY + LAMP_NAME;
const VAULT_ID_UNIT = "bb".repeat(28) + "cc".repeat(8);

// Script tối giản hợp lệ — chỉ dùng để suy ra địa chỉ, không bao giờ được chạy.
const VAULT_SCRIPT = { type: "PlutusV3" as const, script: "49480100002221200101" };

function makeSchedule(overrides: Partial<GenSchedule> = {}): GenSchedule {
  return {
    schedule_id:            "5c4ed0",
    commit_epoch:           90n,
    start_fire_epoch:       200n,
    end_fire_epoch:         209n,
    schedule_length:        10n,
    lamp_per_epoch:         1_000_000_000n,
    rate_locked_q:          1_000_000_000n,
    baseline_at_commit_q:   1_000_000_000n,
    multiplier_at_commit_q: 1_000_000_000n,
    fired_count:            0n,
    auto_burn_target:       null,
    ...overrides,
  } as GenSchedule;
}

function makeVault(overrides: Partial<TVaultDatum> = {}): TVaultDatum {
  return {
    owner:                 "aabbccdd",
    lamp_balance:          100_000_000_000n,
    lamp_locked:           0n,
    loyalty_holdings:      [{ amount: 100_000_000_000n, acquired_epoch: 50n, is_locked: false }],
    magic_batches:         [],
    next_batch_index:      0n,
    vacuum_orders:         [],
    gen_schedules:         [makeSchedule()],
    profile:               "Flame",
    profile_changed_epoch: 0n,
    pending_profile:       null,
    last_updated_epoch:    99n,
    delegation_cert:       { current: [], pending: null, current_effective_epoch: 0n, last_changed_epoch: 0n },
    activity_state:        { recent_burn_epochs: [], consumed_credit: 1_000_000_000n },
    streak_state:          { current_streak: 0n, last_active_epoch: 0n },
    personal_delegate:     null,
    attribution:           { attribution_root: "00".repeat(32), last_event_epoch: 0n, total_events: 0n },
    // 🔴 Trường 17. Bản `makeVault` trong `instant.test.ts` KHÔNG có trường này, và
    // không gì báo: bộ kiểm đó không bao giờ mã hoá datum, nên số trường không bị
    // đối chiếu. `Data.to` với một type 18 trường thì đòi đủ 18.
    instant_unlock_ms:     0n,
    ...overrides,
  } as TVaultDatum;
}

const UM: TUMDatum = { smoothed_q: 1_000_000_000n, last_updated_epoch: 99n, history: [] };
const BEACON: TBackingBeaconDatum = {
  br_q: 2_000_000_000n, magic_supply: 1_000_000_000_000n, depeg: false, last_updated_epoch: 100n,
};

function utxo(datumHex: string, assets: Record<string, bigint>, ix = 0) {
  return {
    txHash: "ab".repeat(32), outputIndex: ix,
    address: "addr_test1wq" + "q".repeat(50),
    assets, datum: datumHex, datumHash: null, scriptRef: null,
  } as any;
}

async function dung(tipPosixMs: bigint, vaultOverrides: Partial<TVaultDatum> = {}) {
  const fake = makeLucidFake();
  const res = await buildInstantGenTx({
    lucid: fake.lucid as any,
    vaultUtxo: utxo(
      Data.to(makeVault(vaultOverrides), VaultDatum),
      { lovelace: 5_000_000n, [LAMP_UNIT]: 100_000_000_000n, [VAULT_ID_UNIT]: 1n },
    ),
    umDatumUtxo:       utxo(Data.to(UM, UMDatum), { lovelace: 2_000_000n }, 1),
    backingBeaconUtxo: utxo(Data.to(BEACON, BackingBeaconDatum), { lovelace: 2_000_000n }, 2),
    userAddress:  "addr_test1vq" + "q".repeat(50),
    vaultScript:  VAULT_SCRIPT,
    lampPolicyId: LAMP_POLICY,
    lampAssetName: LAMP_NAME,
    network:      NETWORK,
    tipPosixMs,
  } as any);
  return { res, tx: fake.onlyTx() };
}

/**
 * Dựng và chờ NÉM, trả về hai trường dữ liệu của lỗi.
 *
 * 🔴 KHÔNG dùng `rejects.toThrow(EmptyValidityWindowError)` ở tệp này. Bài kiểm nằm ở
 * `InstantGen/tests/`, bộ dựng nằm ở `InstantGen/offchain/src/` — hai chỗ phân giải
 * `@magiclamp/protocol-utils` qua hai cây `node_modules` khác nhau, nên có HAI đối
 * tượng lớp cùng tên và `instanceof` trả `false` trong khi lỗi hoàn toàn đúng. Đo
 * được: vitest in ra `Received: [EmptyValidityWindowError: …]` ngay dưới dòng
 * `expected error to be instance of EmptyValidityWindowError`.
 *
 * Khẳng định theo `name` + hai trường dữ liệu vì thế KHÔNG phải một bản hạ cấp: nó
 * ghim con số mà người gọi thật sự dùng (chờ bao lâu), thứ `instanceof` không chạm.
 */
async function nemVoiChoDoi(tipPosixMs: bigint) {
  try {
    await dung(tipPosixMs);
  } catch (e) {
    const err = e as Error & { waitMs?: bigint; retryAfterMs?: bigint };
    if (err.name !== "EmptyValidityWindowError") throw err;   // lỗi khác thì để nó nổi lên
    return { waitMs: err.waitMs, retryAfterMs: err.retryAfterMs };
  }
  throw new Error(`Chờ NÉM ở tip ${tipPosixMs} nhưng bộ dựng chạy xong bình thường.`);
}

function unlockMsTrongDatum(tx: ReturnType<ReturnType<typeof makeLucidFake>["onlyTx"]>): bigint {
  const out = tx.outputs[0];
  if (out === undefined) throw new Error("Bộ dựng không phát output nào — bài kiểm đọc nhầm chỗ.");
  const hex = (out.datum as { kind: string; value: string }).value;
  return Data.from(hex, VaultDatum).instant_unlock_ms;
}

describe("buildInstantGenTx — cửa sổ hiệu lực và mốc khoá", () => {

  // ── Cặp 1: chỗ gọi CÓ chừa một slot, và chừa ĐÚNG một ────────
  //
  // Đây là cặp ghim `reserveTrailingSlots: 1n`. Đổi nó về `0n` thì ca A đỏ ở
  // `validTo` và ca B đỏ ở mốc trong datum. Trước tệp này, đổi `1n`→`0n` để lại
  // 338 bài xanh.
  //
  // Tip nằm trong GIỜ CUỐI epoch: ở đầu epoch trần `VALIDITY_MAX_AHEAD_MS` thắng và
  // cận trên không chạm vùng chừa, nên cặp này sẽ xanh ở cả `1n` lẫn `0n`.

  const TIP_GIO_CUOI = (E + 1n) * P - 1_800_000n;

  it("A. `validTo` là slot ÁP CHÓT của epoch, không phải slot cuối", async () => {
    const tip = TIP_GIO_CUOI;
    const { tx } = await dung(tip);

    expect(tx.validFrom).toBe(Number(tip));
    // slot cuối của epoch E bắt đầu ở (E+1)P − 1000; chừa một slot ⟹ lùi thêm 1000.
    expect(tx.validTo).toBe(Number((E + 1n) * P - 2n * SLOT));
  });

  it("A-bis. đầu epoch ⟹ `validTo` = tip + trần, KHÔNG phải cuối epoch (chân trời node)", async () => {
    const tip = E * P + 1_000n;
    const { tx } = await dung(tip);

    expect(tx.validTo).toBe(Number(tip + VALIDITY_MAX_AHEAD_MS));
    // mốc khoá vẫn là cận-trên + P: khoá không ngắn đi, chỉ mở sớm hơn đúng phần cắt.
    expect(unlockMsTrongDatum(tx) - BigInt(tx.validTo!)).toBe(P);
  });

  it("B. mốc trong datum KHÔNG rơi vào slot cuối của epoch sau", async () => {
    const tip = TIP_GIO_CUOI;
    const { tx } = await dung(tip);

    const slotCuoiEpochSau = (E + 2n) * P - SLOT;   // ô chết: rút tại đây là khoảng rỗng
    const mocGhiRa = unlockMsTrongDatum(tx);

    expect(mocGhiRa).toBe((E + 2n) * P - 2n * SLOT);
    expect(mocGhiRa).not.toBe(slotCuoiEpochSau);
    // Và mốc vẫn phải nằm trong [P, 2P) tính từ cận trên — hợp đồng của I-ACT-7.
    const khoangKhoa = mocGhiRa - BigInt(tx.validTo!);
    expect(khoangKhoa).toBe(P);
  });

  // ── Cặp 2: hai cực của cổng khoảng-rỗng ──────────────────────
  //
  // Với một slot được chừa, hai slot CUỐI của epoch đều không dựng được: cận trên
  // lùi về đúng (hoặc dưới) cận dưới. Ca đối là slot thứ ba từ cuối.

  it("C. tip ở slot CUỐI epoch ⟹ NÉM, kèm đúng số mili-giây phải chờ", async () => {
    await expect(nemVoiChoDoi((E + 1n) * P - SLOT)).resolves.toEqual({
      waitMs: 1_000n, retryAfterMs: (E + 1n) * P,
    });
  });

  it("C-bis. tip ở slot ÁP CHÓT ⟹ vẫn NÉM, vì một slot đã bị chừa", async () => {
    await expect(nemVoiChoDoi((E + 1n) * P - 2n * SLOT)).resolves.toEqual({
      waitMs: 2_000n, retryAfterMs: (E + 1n) * P,
    });
  });

  it("D. cực đối — tip ở slot thứ BA từ cuối thì dựng được", async () => {
    const tip = (E + 1n) * P - 3n * SLOT;
    const { tx } = await dung(tip);

    expect(tx.completed).toBe(true);
    expect(tx.validFrom).toBe(Number(tip));
    expect(tx.validTo).toBe(Number((E + 1n) * P - 2n * SLOT));
    // Khoảng phải THẬT SỰ không rỗng — đúng một slot.
    expect(tx.validTo! - tx.validFrom!).toBe(Number(SLOT));
  });

  // ── Chỗ gọi có đi qua bộ dựng thật không ─────────────────────
  //
  // Ca này không kiểm cửa sổ; nó kiểm rằng bốn ca trên chạy qua `instant.ts` chứ
  // không qua một bản mô phỏng. Nếu bộ dựng ngừng gọi `.validTo()`, `validTo` sẽ là
  // `undefined` và cả bốn ca trên đỏ — chứ không âm thầm xanh.
  it("E. giao dịch dựng ra mang đúng hình dạng InstantGen (vault→vault, 2 tham chiếu)", async () => {
    const { tx, res } = await dung(E * P + 1_000n);

    expect(tx.collectFrom).toHaveLength(1);
    expect(tx.readFrom[0]).toHaveLength(2);      // UM + BackingBeacon
    expect(tx.outputs).toHaveLength(1);          // chỉ trả về chính két
    expect(tx.signerKeys).toEqual(["aabbccdd"]); // chủ két phải ký
    expect(res.currentEpoch).toBe(E);
    expect(res.newLampBalance).toBe(100_000_000_000n);  // I-ACT-7: LAMP đứng yên
  });
});
