// VaultTxAPI/tests/anchorGate.test.ts — cổng nhận diện NFT anchor DID (`owner.ts` ▸
// `carriesAnchorNft`) và HAI chỗ gọi nó: nhân chứng `did_stake` và bộ đọc anchor của `funding`.
//
// `taad` đúc dưới CÙNG một policy cả anchor (tên 32 byte = blake2b_256(did), số lượng 1) lẫn
// token shard `pk-uniq\x00`… (8 byte) và cursor. Phép cũ "có tài sản bất kỳ dưới policy" nhận
// UTxO shard làm anchor, rồi lỗi hiện ra sai loại ở bước sau (Preprod 2026-09-27). Các ca
// dưới đây cho mỗi chỗ gọi một cặp: anchor thật qua, shard cùng policy bị từ chối.

import { describe, expect, it } from "vitest";
import type { UTxO } from "@lucid-evolution/lucid";

import { RecordedChainReader, type ChainTip } from "../src/chain.js";
import { ChainDidPaymentAnchorReader } from "../src/funding.js";
import { ownerApiErrorOf } from "../src/errors.js";
import { DidStakeWitnessProvider, carriesAnchorNft } from "../src/owner.js";

const POLICY = "a0".repeat(28);
const ANCHOR_UNIT = `${POLICY}${"5e".repeat(32)}`;          // tên 32 byte
const SHARD_UNIT = `${POLICY}706b2d756e697100`;             // "pk-uniq\x00", 8 byte
const TIP: ChainTip = { blockHeight: 1, blockHash: "00".repeat(32), blockTimePosixMs: 1_789_000_000_000n };

const utxo = (txHash: string, assets: Record<string, bigint>): UTxO =>
  ({ txHash, outputIndex: 0, address: "addr_test1wq" + "q".repeat(50), assets, datum: null, datumHash: null, scriptRef: null }) as UTxO;

const ANCHOR = utxo("ab".repeat(32), { lovelace: 2_000_000n, [ANCHOR_UNIT]: 1n });
const SHARD = utxo("ac".repeat(32), { lovelace: 2_000_000n, [SHARD_UNIT]: 1n });
const chain = new RecordedChainReader({}, TIP, [ANCHOR, SHARD]);

describe("carriesAnchorNft", () => {
  it("tên 32 byte, số lượng 1, đúng policy ⟹ có", () => {
    expect(carriesAnchorNft(ANCHOR.assets, POLICY)).toBe(true);
  });
  it("CỰC ĐỐI: shard 8 byte cùng policy ⟹ không", () => {
    expect(carriesAnchorNft(SHARD.assets, POLICY)).toBe(false);
  });
  it("CỰC ĐỐI: tên 32 byte nhưng số lượng 2 ⟹ không", () => {
    expect(carriesAnchorNft({ [ANCHOR_UNIT]: 2n }, POLICY)).toBe(false);
  });
  it("CỰC ĐỐI: tên 32 byte dưới policy KHÁC ⟹ không", () => {
    expect(carriesAnchorNft({ [`${"b0".repeat(28)}${"5e".repeat(32)}`]: 1n }, POLICY)).toBe(false);
  });
});

describe("bộ đọc anchor của funding", () => {
  const reader = new ChainDidPaymentAnchorReader({ chain, anchorNftPolicy: POLICY });
  it("anchor thật ⟹ trả UTxO", async () => {
    await expect(reader.read({ txHash: ANCHOR.txHash, outputIndex: 0 })).resolves.toBe(ANCHOR);
  });
  it("CỰC ĐỐI: UTxO shard cùng policy ⟹ 400 FUNDING_ANCHOR_INVALID", async () => {
    await expect(reader.read({ txHash: SHARD.txHash, outputIndex: 0 }))
      .rejects.toMatchObject({ httpStatus: 400, code: "FUNDING_ANCHOR_INVALID" });
  });
});

describe("nhân chứng did_stake", () => {
  const provider = new DidStakeWitnessProvider({ network: "Preview", chain, anchorNftPolicy: POLICY });
  const witness = (txHash: string) => ({
    didStakeScriptCbor: "4e4d01000033222220051200120011",
    anchorRef: { txHash, outputIndex: 0 },
    controllerPkh: "c1".repeat(28),
    deviceKeyHash: "d1".repeat(28),
  });
  const owner = { type: "script" as const, hash: "0a".repeat(28) };

  it("CỰC ĐỐI: UTxO shard cùng policy ⟹ 400 OWNER_ANCHOR_INVALID, trước mọi bước sau", async () => {
    await expect(provider.resolve(owner, witness(SHARD.txHash)))
      .rejects.toMatchObject({ httpStatus: 400, code: "OWNER_ANCHOR_INVALID" });
  });
  it("anchor thật ⟹ qua cổng anchor, hỏng ở một bước SAU nó", async () => {
    // Script mẫu không phải `did_stake` thật nên lượt vẫn hỏng — nhưng hỏng ở bước sau
    // cổng anchor. Mã khác OWNER_ANCHOR_INVALID là bằng chứng anchor thật đã qua cổng;
    // cặp với ca shard ở trên, hai ca chỉ khác nhau đúng ở tên tài sản.
    const err = await provider.resolve(owner, witness(ANCHOR.txHash)).then(() => null, (e: unknown) => e);
    expect(err).not.toBeNull();
    expect((err as { code?: string }).code).not.toBe("OWNER_ANCHOR_INVALID");
  });
});

describe("ownerApiErrorOf — câu trả app không lặp mã", () => {
  it("bỏ tiền tố `${code}: ` mà OwnerAuthError tự chèn", () => {
    const e = ownerApiErrorOf({ code: "OWNER_STAKE_NOT_REGISTERED", message: "OWNER_STAKE_NOT_REGISTERED: tài khoản thưởng chưa đăng ký." });
    expect(e.code).toBe("OWNER_STAKE_NOT_REGISTERED");
    expect(e.message).toBe("tài khoản thưởng chưa đăng ký.");
  });
  it("CỰC ĐỐI: câu không mang tiền tố thì giữ nguyên, kể cả khi nó nhắc mã ở giữa câu", () => {
    const msg = "lý do: OWNER_STAKE_NOT_REGISTERED: không cắt chỗ này.";
    expect(ownerApiErrorOf({ code: "OWNER_STAKE_NOT_REGISTERED", message: msg }).message).toBe(msg);
  });
});
