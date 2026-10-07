// VaultTxAPI/tests/service.test.ts — dịch vụ + bộ định tuyến, chạy không mạng không khoá.
//
// ══ BÀI GHIM QUAN TRỌNG NHẤT CỦA GÓI ══════════════════════════════════════════
// `summary KHÔNG phải tiếng vọng của yêu cầu`: tầng dựng trả về một giao dịch khoá
// 3 × λ trong khi yêu cầu xin 17 × λ. Bản tóm tắt phải nói 3 × λ — tức nói đúng thứ
// người dùng sắp KÝ, chứ không nói thứ họ vừa NHẬP.
//
// Một hiện thực chép `summary` từ tham số yêu cầu cho ra 119 000 000 ở đó và bài này
// đỏ. Đây là điều kiện cắn, và nó được viết ra thành một dòng `not.toBe`.
// ══════════════════════════════════════════════════════════════════════════════

import { describe, expect, it } from "vitest";

import { RecordedChainReader, type ChainTip } from "../src/chain.js";
import { parseDeployment, type Deployment } from "../src/config.js";
import { ChainUnavailableError } from "../src/errors.js";
import { CML, type UTxO } from "@lucid-evolution/lucid";
import { handle, type RouterDeps } from "../src/http.js";
import { EXPIRED_RETENTION_MS, IssuedTxRegistry, OwnerLockTable, PendingSpends } from "../src/locks.js";
import { VaultTxService } from "../src/service.js";
import { txBodyHash } from "../src/summary.js";
import { RecordedTxBuilder, enterpriseAddressOf } from "../src/txBuilder.js";
import {
  INPUT_TX_HASH, LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID, LAMP_UNIT, OTHER_OWNER_PKH, OWNER_PKH,
  SHARD_ADDRESS, VAULT_ADDRESS, VAULT_ID_UNIT, datumHex,
} from "./fixtures/preview.js";
import {
  PRERECORDED_VALIDITY_MS, buildTxCbor, emptyWitnessSetCbor, fakeWitnessSetCbor, prerecordedTtlSlot,
} from "./fixtures/tx.js";
import { CLOCK_SKEW_MARGIN_MS } from "../src/validity.js";
import { GEN_V2_REF_SCRIPTS, genV2Chain, genV2Json } from "./fixtures/genV2.js";
import { ENGAGE_ADDRESS, threadUtxo } from "./fixtures/engage.js";
import { BODY_SERVICE_SUBMIT, VKEY_A_HEX, flipFirstByte } from "./fixtures/witnessVectors.js";

/**
 * Cho qua phép kiểm chứng ký — CHỈ cho các bài dùng CBOR ghi sẵn. Tx ghi sẵn mang
 * `required_signers = OWNER_PKH` (khoá Preview thật, không có khoá riêng trong kho) và
 * `fakeWitnessSetCbor` là byte hằng, nên phép kiểm thật chắc chắn bác; điều các bài đó đo là
 * đường ghép + sổ phát-hành + khoá mềm, không phải chữ ký. Phép kiểm chữ ký thật được đo ở
 * `witnessCheck.test.ts` và ở khối "chữ ký thật" cuối tệp này (vector chứng ký ghi sẵn).
 */
const PASS_PRERECORDED_WITNESSES = (): void => {};

const LAMBDA = 7_000_000n;
const FEE = 178_000n;
const TTL = 180_000;
const NOW = 1_789_100_703_000;
const CHANGE_ADDRESS = enterpriseAddressOf("Preview", OWNER_PKH);

const BATCH_LIVE = { id: "b0".repeat(16), createdEpoch: 20_700n, amountNanogic: 5_000_000n };
const VAULT_DATUM_BEFORE = datumHex({ lampLockedOildrop: 2_000_000n, batches: [BATCH_LIVE] });

const TIP: ChainTip = {
  blockHeight: 4_651_976,
  blockHash: "14ae149dd07cd25ce37a6a4336f3939446bd68d9ad4a2e820201a474cc3ad72f",
  blockTimePosixMs: BigInt(NOW),
};

const DEPLOYMENT: Deployment = parseDeployment(JSON.stringify({
  source: "Preview, bản dựng thử của phép kiểm — không phải một lần deploy thật",
  lamp: { policy_id: LAMP_POLICY_ID, asset_name_hex: LAMP_ASSET_NAME_HEX },
  vaults: [{ vault_type: "Schedule", address: VAULT_ADDRESS }],
  shard_address: SHARD_ADDRESS,
  ref_script_utxos: {
    vault: `${"11".repeat(32)}#0`, shard: `${"22".repeat(32)}#1`, consume: `${"33".repeat(32)}#2`,
    ...GEN_V2_REF_SCRIPTS,
  },
  gen_v2: genV2Json("Preview"),
  consume: {
    engage_address: ENGAGE_ADDRESS,
    price_beacon_address: VAULT_ADDRESS,
    price_beacon_nft_unit: `${"55".repeat(28)}cafe`,
  },
}), "Preview");

/** Giao dịch khoá `L × λ` — ĐÂY là sự thật mà `summary` phải nói theo. */
function commitTxCbor(scheduleLength: bigint): string {
  return buildTxCbor({
    ttlSlot: prerecordedTtlSlot(NOW),
    inputs: [{ txHash: INPUT_TX_HASH, outputIndex: 0 }],
    feeLovelace: FEE,
    outputs: [
      {
        address: VAULT_ADDRESS,
        assets: { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
        inlineDatumHex: datumHex({
          lampLockedOildrop: 2_000_000n + scheduleLength * LAMBDA,
          batches: [BATCH_LIVE],
          genScheduleCount: 1,
        }),
      },
      { address: CHANGE_ADDRESS, assets: { lovelace: 9_400_000n } },
    ],
  });
}

function vaultUtxo(over: Partial<{ txHash: string; outputIndex: number; datum: string; idUnit: string }> = {}) {
  return {
    txHash: over.txHash ?? INPUT_TX_HASH,
    outputIndex: over.outputIndex ?? 0,
    address: VAULT_ADDRESS,
    assets: {
      lovelace: 5_659_030n,
      [LAMP_UNIT]: 1_001_000_000n,
      [over.idUnit ?? VAULT_ID_UNIT]: 1n,
    },
    datum: over.datum ?? VAULT_DATUM_BEFORE,
  };
}

interface Harness {
  service: VaultTxService;
  builder: RecordedTxBuilder;
  locks: OwnerLockTable;
  issued: IssuedTxRegistry;
  chain: RecordedChainReader;
  router: RouterDeps;
  internalErrors: { ref: string; cause: unknown }[];
  /** Đồng hồ dịch vụ, chỉ khi bài truyền `clock` (dời được giữa các lượt gọi). */
  clock?: { t: number };
}

function harness(opts: {
  clock?: { t: number };
  utxos?: ReturnType<typeof vaultUtxo>[];
  commitCbor?: string;
  failWith?: ChainUnavailableError;
  submitResult?: string;
  token?: string;
  pending?: PendingSpends;
  chainClass?: typeof RecordedChainReader;
  /** true ⟹ dùng phép kiểm chữ ký THẬT (mặc định của dịch vụ); vắng ⟹ `PASS_PRERECORDED_WITNESSES`. */
  realWitnessCheck?: boolean;
} = {}): Harness {
  const chain = new (opts.chainClass ?? RecordedChainReader)(
    // Thread Engage của chủ: `/tx/consume` chọn thread theo chủ lúc chạy (`engage.ts`).
    { [VAULT_ADDRESS]: opts.utxos ?? [vaultUtxo()], [ENGAGE_ADDRESS]: [threadUtxo({ type: "key", hash: OWNER_PKH }, "7e".repeat(32))], ...genV2Chain("Preview", { epoch: 20_707n }) },
    TIP,
    [],
    opts.failWith,
    opts.submitResult,
  );
  const builder = new RecordedTxBuilder({
    schedule_commit: opts.commitCbor ?? commitTxCbor(3n),
    schedule_fire: opts.commitCbor ?? commitTxCbor(3n),
    consume: opts.commitCbor ?? commitTxCbor(3n),
  });
  const locks = new OwnerLockTable(TTL);
  const issued = new IssuedTxRegistry();
  const service = new VaultTxService({
    network: "Preview",
    deployment: DEPLOYMENT,
    chain,
    builder,
    locks,
    issued,
    pending: opts.pending,
    lockTtlMs: TTL,
    now: () => opts.clock?.t ?? NOW,
    ...(opts.realWitnessCheck === true ? {} : { witnessCheck: PASS_PRERECORDED_WITNESSES }),
  });
  const internalErrors: { ref: string; cause: unknown }[] = [];
  const router: RouterDeps = {
    service,
    deploymentSource: DEPLOYMENT.source,
    vaultScopes: DEPLOYMENT.vaults,
    network: "Preview",
    chainLabel: "recorded",
    changeAddressStrategy: "enterprise_from_owner_pkh",
    token: opts.token ?? "",
    logInternal: (ref, cause) => internalErrors.push({ ref, cause }),
  };
  return { service, builder, locks, issued, chain, router, internalErrors, ...(opts.clock === undefined ? {} : { clock: opts.clock }) };
}

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return { method: "POST", url, headers, body };
}

describe("🔴 summary KHÔNG phải tiếng vọng của yêu cầu", () => {
  it("yêu cầu xin L=17 nhưng CBOR khoá L=3 ⟹ summary nói 3, không nói 17", async () => {
    const h = harness({ commitCbor: commitTxCbor(3n) });

    const out = await h.service.scheduleCommit({
      owner: { type: "key", hash: OWNER_PKH }, scheduleLength: 17n, lampPerEpoch: LAMBDA,
    });

    // Tham số yêu cầu ĐÃ tới tầng dựng — nên bài này không xanh vì tham số bị mất đường.
    // `toMatchObject`: từ Gen v2.0 bộ dựng còn ghi thêm `buildParams` (UTxO beacon/shard).
    expect(h.builder.lastCall).toMatchObject({
      route: "schedule_commit",
      params: { scheduleLength: 17n, lampPerEpoch: LAMBDA },
    });

    expect(out.summary.lamp.locked_delta_oildrop).toBe("21000000");      // 3 × λ, từ CBOR
    expect(out.summary.lamp.locked_delta_oildrop).not.toBe("119000000"); // 17 × λ, từ yêu cầu
    expect(out.summary.lamp.locked_delta_lamp).toBe("21.000000");
  });

  it("cùng yêu cầu, CBOR khác ⟹ summary khác — tức nó đi theo CBOR", async () => {
    const a = await harness({ commitCbor: commitTxCbor(3n) }).service.scheduleCommit({
      owner: { type: "key", hash: OWNER_PKH }, scheduleLength: 17n, lampPerEpoch: LAMBDA,
    });
    const b = await harness({ commitCbor: commitTxCbor(10n) }).service.scheduleCommit({
      owner: { type: "key", hash: OWNER_PKH }, scheduleLength: 17n, lampPerEpoch: LAMBDA,
    });
    expect(a.summary.lamp.locked_delta_oildrop).toBe("21000000");
    expect(b.summary.lamp.locked_delta_oildrop).toBe("70000000");
    expect(a.txHash).not.toBe(b.txHash);
  });
});

describe("VaultTxService — đường dựng", () => {
  it("trả tx CHƯA KÝ, hash thân giao dịch, và mốc hết hạn", async () => {
    const h = harness();
    const out = await h.service.scheduleCommit({
      owner: { type: "key", hash: OWNER_PKH }, scheduleLength: 3n, lampPerEpoch: LAMBDA,
    });
    expect(out.txCbor).toBe(commitTxCbor(3n));
    expect(out.txHash).toBe(txBodyHash(out.txCbor));
    // `expires_at` = `validTo` đọc từ CHÍNH thân tx (ttl ghi sẵn), không phải NOW + lockTtl.
    expect(out.expiresAt).toBe(new Date(NOW + PRERECORDED_VALIDITY_MS).toISOString());
    expect(out.expiresAt).not.toBe(new Date(NOW + TTL).toISOString());
    expect(out.expiresReason).toBe("tx_validity");
    expect(out.summary.requested_intent).toBe("schedule_commit");
    expect(out.summary.network).toBe("Preview");
    expect(out.ignored).toEqual([]);
  });

  it("chủ CHƯA CÓ vault ⟹ 404, KHÔNG phải một tx rỗng", async () => {
    const h = harness();
    await expect(h.service.scheduleCommit({
      owner: { type: "key", hash: OTHER_OWNER_PKH }, scheduleLength: 3n, lampPerEpoch: LAMBDA,
    })).rejects.toMatchObject({ httpStatus: 404, code: "VAULT_NOT_FOUND" });
  });

  it("KHÔNG đọc được chuỗi ⟹ 502, KHÔNG phải 404 — hai ca khác nhau", async () => {
    const h = harness({ failWith: new ChainUnavailableError("nút chết", { transport: "http" }) });
    await expect(h.service.scheduleCommit({
      owner: { type: "key", hash: OWNER_PKH }, scheduleLength: 3n, lampPerEpoch: LAMBDA,
    })).rejects.toMatchObject({ httpStatus: 502, code: "CHAIN_UNAVAILABLE" });
  });

  it("hai UTxO cùng NFT danh-tính ⟹ 409, không chọn đại một cái làm input", async () => {
    const h = harness({
      utxos: [vaultUtxo(), vaultUtxo({ txHash: "cc".repeat(32), outputIndex: 1 })],
    });
    await expect(h.service.scheduleCommit({
      owner: { type: "key", hash: OWNER_PKH }, scheduleLength: 3n, lampPerEpoch: LAMBDA,
    })).rejects.toMatchObject({ httpStatus: 409, code: "VAULT_IDENTITY_DUPLICATE" });
  });

  it("hai vault hợp lệ của cùng chủ ⟹ 409 VAULT_AMBIGUOUS", async () => {
    const h = harness({
      utxos: [vaultUtxo(), vaultUtxo({
        txHash: "cc".repeat(32), outputIndex: 1, idUnit: VAULT_ID_UNIT.slice(0, 56) + "ee".repeat(32),
      })],
    });
    await expect(h.service.scheduleCommit({
      owner: { type: "key", hash: OWNER_PKH }, scheduleLength: 3n, lampPerEpoch: LAMBDA,
    })).rejects.toMatchObject({ httpStatus: 409, code: "VAULT_AMBIGUOUS" });
  });

  it("UTxO lạ ở địa chỉ vault được ĐẾM và khai, không bị nuốt", async () => {
    const noNft = {
      txHash: "dd".repeat(32), outputIndex: 3, address: VAULT_ADDRESS,
      assets: { lovelace: 2_000_000n }, datum: VAULT_DATUM_BEFORE,
    };
    const h = harness({ utxos: [vaultUtxo(), noNft] });
    const out = await h.service.scheduleCommit({
      owner: { type: "key", hash: OWNER_PKH }, scheduleLength: 3n, lampPerEpoch: LAMBDA,
    });
    expect(out.ignored).toEqual([{ utxoRef: `${"dd".repeat(32)}#3`, reason: "NO_VAULT_ID_NFT" }]);
  });

  it("owner.hash sai khuôn ⟹ 400 OWNER_HASH_INVALID", async () => {
    const h = harness();
    await expect(h.service.scheduleCommit({
      owner: { type: "key", hash: "ABC" }, scheduleLength: 3n, lampPerEpoch: LAMBDA,
    })).rejects.toMatchObject({ httpStatus: 400, code: "OWNER_HASH_INVALID" });
  });
});

/** Đổi hash mà nút chuỗi (bản ghi) trả cho lượt nộp kế tiếp. */
function setSubmitResult(h: Harness, cbor: string | undefined): void {
  (h.chain as unknown as { submitResult: string | undefined }).submitResult = cbor === undefined ? undefined : txBodyHash(cbor);
}

/** Đổi CBOR ghi sẵn của bộ dựng giữa hai lượt — để hai lượt dựng ra hai tx KHÁC hash. */
function setCommitCbor(h: Harness, cbor: string): void {
  (h.builder as unknown as { txCborByRoute: Record<string, string> }).txCborByRoute.schedule_commit = cbor;
}
const KEY_OWNER_REQ = { owner: { type: "key" as const, hash: OWNER_PKH }, lampPerEpoch: LAMBDA };

describe("Khoá mềm theo chủ vault — lượt dựng mới THAY lượt cũ, xung đột bắt lúc NỘP", () => {
  it("lượt dựng thứ hai cho cùng chủ KHÔNG 409 — nó thay lượt đầu (đổi từ 409 OWNER_TX_IN_FLIGHT, 2026-10-03)", async () => {
    const h = harness();
    await h.service.scheduleCommit({ ...KEY_OWNER_REQ, scheduleLength: 3n });
    const second = await h.service.scheduleCommit({ ...KEY_OWNER_REQ, scheduleLength: 3n });
    expect(second.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(h.locks.peek(OWNER_PKH, NOW)?.txHash).toBe(second.txHash);
  });

  it("NGƯỜI LẠ dựng sau chủ (không ký được) ⟹ tx của chủ vẫn NỘP được — lượt dựng không thay được ở lúc nộp", async () => {
    const ownerCbor = commitTxCbor(3n);
    const h = harness({ submitResult: txBodyHash(ownerCbor), pending: new PendingSpends(TTL) });
    const mine = await h.service.scheduleCommit({ ...KEY_OWNER_REQ, scheduleLength: 3n });
    setCommitCbor(h, commitTxCbor(4n));
    const stranger = await h.service.scheduleCommit({ ...KEY_OWNER_REQ, scheduleLength: 4n });
    expect(stranger.txHash).not.toBe(mine.txHash);
    const out = await h.service.submit({ txCbor: ownerCbor, witnessCbor: fakeWitnessSetCbor() });
    expect(out.txHash).toBe(mine.txHash);
    expect(h.chain.submitted).toHaveLength(1);
  });

  it("hai thiết bị: T2 thay T1, T2 NỘP trước ⟹ nộp T1 ⟹ 409 TX_SUPERSEDED, không gọi nút chuỗi", async () => {
    const t1 = commitTxCbor(3n);
    const t2 = commitTxCbor(4n);
    const h = harness({ submitResult: txBodyHash(t2), pending: new PendingSpends(TTL) });
    await h.service.scheduleCommit({ ...KEY_OWNER_REQ, scheduleLength: 3n });
    setCommitCbor(h, t2);
    await h.service.scheduleCommit({ ...KEY_OWNER_REQ, scheduleLength: 4n });
    await h.service.submit({ txCbor: t2, witnessCbor: fakeWitnessSetCbor() });
    expect(h.chain.submitted).toHaveLength(1);
    await expect(h.service.submit({ txCbor: t1, witnessCbor: fakeWitnessSetCbor() }))
      .rejects.toMatchObject({
        httpStatus: 409, code: "TX_SUPERSEDED", details: { superseded_by: txBodyHash(t2), previously_submitted: false, submission: "none" },
      });
    expect(h.chain.submitted).toHaveLength(1);
    // CẶP: nộp LẠI chính T2 (rớt mạng) KHÔNG bị coi là xung đột với chính nó.
    await expect(h.service.submit({ txCbor: t2, witnessCbor: fakeWitnessSetCbor() })).resolves.toMatchObject({ txHash: txBodyHash(t2) });
  });

  it("HỒI QUY: T1 NỘP (rồi rơi khỏi mempool), T2 chung khoá NỘP sau ⟹ nộp lại T1 ⟹ 409, KHÔNG gửi lại", async () => {
    // Ngoài đời: hai lượt tạo két từ hai ví (không chung input). Gửi lại T1 ở đây = két thứ hai cho
    // cùng chủ, và mọi đường dựng sau đó trả VAULT_AMBIGUOUS.
    const t1 = commitTxCbor(3n);
    const t2 = commitTxCbor(4n);
    const h = harness({ submitResult: txBodyHash(t1) });
    await h.service.scheduleCommit({ ...KEY_OWNER_REQ, scheduleLength: 3n });
    await h.service.submit({ txCbor: t1, witnessCbor: fakeWitnessSetCbor() });
    setCommitCbor(h, t2);
    await h.service.scheduleCommit({ ...KEY_OWNER_REQ, scheduleLength: 4n });
    setSubmitResult(h, t2);
    await h.service.submit({ txCbor: t2, witnessCbor: fakeWitnessSetCbor() });
    expect(h.chain.submitted).toHaveLength(2);
    setSubmitResult(h, t1);
    await expect(h.service.submit({ txCbor: t1, witnessCbor: fakeWitnessSetCbor() })).rejects.toMatchObject({
      httpStatus: 409, code: "TX_SUPERSEDED",
      details: { superseded_by: txBodyHash(t2), previously_submitted: true, submission: "accepted" },
    });
    expect(h.chain.submitted).toHaveLength(2);
  });

  it("CỰC ĐỐI: T2 chỉ DỰNG, không nộp ⟹ nộp lại T1 trả lại kết quả cũ, KHÔNG gửi lên chuỗi lần nữa", async () => {
    const t1 = commitTxCbor(3n);
    const t2 = commitTxCbor(4n);
    const h = harness({ submitResult: txBodyHash(t1) });
    await h.service.scheduleCommit({ ...KEY_OWNER_REQ, scheduleLength: 3n });
    const first = await h.service.submit({ txCbor: t1, witnessCbor: fakeWitnessSetCbor() });
    expect(first.lockReleasedFor).toBe(OWNER_PKH);
    setCommitCbor(h, t2);
    await h.service.scheduleCommit({ ...KEY_OWNER_REQ, scheduleLength: 4n });
    const again = await h.service.submit({ txCbor: t1, witnessCbor: fakeWitnessSetCbor() });
    expect(again).toEqual(first);
    expect(h.chain.submitted).toHaveLength(1);
    // Và lượt nộp lại không thay T2 — lượt kế tiếp hợp lệ của chủ.
    expect(h.issued.lookup(txBodyHash(t2), NOW)?.supersededBy).toBeUndefined();
  });

  it("input đã bị tx KHÁC vừa nộp tiêu (tx không chung khoá trong sổ) ⟹ 409 TX_SUPERSEDED kèm input xung đột", async () => {
    const cbor = commitTxCbor(3n);
    const pending = new PendingSpends(TTL);
    const h = harness({ submitResult: txBodyHash(cbor), pending });
    // Dựng TRƯỚC khi tx kia được nộp (đường dựng chưa thấy gì để chặn) …
    await h.service.scheduleCommit({ ...KEY_OWNER_REQ, scheduleLength: 3n });
    // … rồi một tx KHÁC (không có trong sổ của tiến trình này) tiêu đúng UTxO vault.
    pending.note([`${INPUT_TX_HASH}#0`], NOW, "99".repeat(32));
    await expect(h.service.submit({ txCbor: cbor, witnessCbor: fakeWitnessSetCbor() }))
      .rejects.toMatchObject({
        httpStatus: 409, code: "TX_SUPERSEDED", details: { conflicting_inputs: [`${INPUT_TX_HASH}#0`], previously_submitted: false, submission: "none" },
      });
    expect(h.chain.submitted).toHaveLength(0);
  });

  it("dựng HỎNG thì nhả khoá — một lần lỗi không khoá chủ đó suốt thời hạn", async () => {
    const h = harness({ utxos: [] });
    await expect(h.service.scheduleCommit({
      owner: { type: "key", hash: OWNER_PKH }, scheduleLength: 3n, lampPerEpoch: LAMBDA,
    })).rejects.toMatchObject({ code: "VAULT_NOT_FOUND" });
    expect(h.locks.peek(OWNER_PKH, NOW)).toBeNull();
  });
});

describe("/tx/submit — ghép chứng ký của app, dịch vụ không ký gì", () => {
  it("bộ chứng ký RỖNG ⟹ 400, không đẩy lên chuỗi", async () => {
    const h = harness({ submitResult: "ff".repeat(32) });
    await expect(h.service.submit({
      txCbor: commitTxCbor(3n), witnessCbor: emptyWitnessSetCbor(),
    })).rejects.toMatchObject({ httpStatus: 400 });
    expect(h.chain.submitted).toEqual([]);
  });

  it("ghép chứng ký KHÔNG đổi hash thân giao dịch, và nhả khoá của chủ", async () => {
    const cbor = commitTxCbor(3n);
    const hash = txBodyHash(cbor);
    const h = harness({ submitResult: hash });

    await h.service.scheduleCommit({ owner: { type: "key", hash: OWNER_PKH }, scheduleLength: 3n, lampPerEpoch: LAMBDA });
    expect(h.locks.peek(OWNER_PKH, NOW)).not.toBeNull();

    const out = await h.service.submit({ txCbor: cbor, witnessCbor: fakeWitnessSetCbor() });
    expect(out.txHash).toBe(hash);
    expect(out.lockReleasedFor).toBe(OWNER_PKH);
    expect(h.locks.peek(OWNER_PKH, NOW)).toBeNull();
    expect(h.chain.submitted).toHaveLength(1);
  });

  it("nút chuỗi báo hash KHÁC ⟹ 502, không im lặng coi là xong", async () => {
    const h = harness({ submitResult: "ff".repeat(32) });
    // 🪦 Bản trước nộp thẳng `commitTxCbor(3n)` mà KHÔNG dựng trước. Sau khi cổng xuất
    // xứ vào, ca đó vẫn xanh — nhưng nó chết ở cổng xuất xứ, cũng mang đúng 502 và đúng
    // mã `SUBMIT_REJECTED`, tức đúng màu đúng tên mà sai chốt (`Forall §Kỷ luật phát
    // ngôn mục 6`). Phải dựng trước để đi tới được phép so hash của nút chuỗi.
    await h.service.scheduleCommit({ owner: { type: "key", hash: OWNER_PKH }, scheduleLength: 3n, lampPerEpoch: LAMBDA });
    await expect(h.service.submit({
      txCbor: commitTxCbor(3n), witnessCbor: fakeWitnessSetCbor(),
    })).rejects.toMatchObject({ httpStatus: 502, code: "SUBMIT_REJECTED" });
    // Và đây là dòng PHÂN BIỆT hai chốt: chốt xuất xứ chặn TRƯỚC khi nộp, chốt này báo
    // SAU khi đã nộp. Bỏ dòng này thì ca lại xanh ở cả hai bên đột biến.
    expect(h.chain.submitted).toHaveLength(1);
  });

  it("nộp một giao dịch dịch vụ CHƯA TỪNG dựng ⟹ từ chối, và không có gì lên chuỗi", async () => {
    // Không có cổng này thì `/tx/submit` là một đường nộp mượn được: ai cầm thẻ bài
    // chia sẻ cũng đẩy được giao dịch bất kỳ qua khoá nhà cung cấp của người vận hành.
    const cbor = commitTxCbor(3n);
    const h = harness({ submitResult: txBodyHash(cbor) });
    await expect(h.service.submit({ txCbor: cbor, witnessCbor: fakeWitnessSetCbor() }))
      .rejects.toMatchObject({ httpStatus: 502, code: "SUBMIT_REJECTED" });
    expect(h.chain.submitted).toEqual([]);
  });

  it("giao dịch đã dựng nhưng QUÁ HẠN nộp ⟹ từ chối, và không có gì lên chuỗi", async () => {
    const cbor = commitTxCbor(3n);
    const hash = txBodyHash(cbor);
    const h = harness({ submitResult: hash });
    await h.service.scheduleCommit({ owner: { type: "key", hash: OWNER_PKH }, scheduleLength: 3n, lampPerEpoch: LAMBDA });
    expect(h.issued.wasIssued(hash, NOW)).toBe(true);
    // Hạn dòng sổ = `validTo` của CHÍNH tx + biên lệch đồng hồ — quá hạn thì tờ giấy phép
    // nộp hết hiệu lực, không phải "còn hiệu lực nhưng chưa dùng".
    const lastOk = NOW + PRERECORDED_VALIDITY_MS + CLOCK_SKEW_MARGIN_MS - 1;
    expect(h.issued.wasIssued(hash, lastOk)).toBe(true);
    expect(h.issued.wasIssued(hash, lastOk + 1)).toBe(false);
  });

  it("CẶP qua /tx/submit: trước validTo + biên ⟹ nộp được; sau mốc đó ⟹ từ chối, không gì lên chuỗi", async () => {
    const cbor = commitTxCbor(3n);
    const hash = txBodyHash(cbor);
    const lastOk = NOW + PRERECORDED_VALIDITY_MS + CLOCK_SKEW_MARGIN_MS - 1;
    // Ca âm: đồng hồ dịch vụ vượt validTo + biên một ms.
    const late = harness({ submitResult: hash, clock: { t: NOW } });
    await late.service.scheduleCommit({ owner: { type: "key", hash: OWNER_PKH }, scheduleLength: 3n, lampPerEpoch: LAMBDA });
    late.clock!.t = lastOk + 1;
    // Tx CHÍNH dịch vụ phát, quá hạn ⟹ 410 TX_EXPIRED (không còn 502 SUBMIT_REJECTED "không do dịch vụ dựng").
    await expect(late.service.submit({ txCbor: cbor, witnessCbor: fakeWitnessSetCbor() })).rejects.toMatchObject({
      httpStatus: 410, code: "TX_EXPIRED",
      details: { tx_hash: hash, rebuild_safe: true, submission: "none",
        expired_at: new Date(NOW + PRERECORDED_VALIDITY_MS).toISOString() },
    });
    expect(late.chain.submitted).toEqual([]);
    // CẶP phân biệt: cùng tx, cùng thời điểm, nhưng dịch vụ CHƯA TỪNG phát ⟹ giữ mã cũ 502 SUBMIT_REJECTED.
    const never = harness({ submitResult: hash, clock: { t: lastOk + 1 } });
    await expect(never.service.submit({ txCbor: cbor, witnessCbor: fakeWitnessSetCbor() }))
      .rejects.toMatchObject({ httpStatus: 502, code: "SUBMIT_REJECTED" });
    // Quá khoảng giữ lại dòng hết hạn ⟹ sổ đã quên tx ⟹ trở về mã "không do dịch vụ phát".
    late.clock!.t = lastOk + 1 + EXPIRED_RETENTION_MS;
    await expect(late.service.submit({ txCbor: cbor, witnessCbor: fakeWitnessSetCbor() }))
      .rejects.toMatchObject({ httpStatus: 502, code: "SUBMIT_REJECTED" });
    // Ca dương: đúng ms cuối còn hạn — vượt NOW + lockTtl (mốc expires_at cũ), vẫn nhận.
    expect(lastOk).toBeGreaterThan(NOW + TTL);
    const ok = harness({ submitResult: hash, clock: { t: NOW } });
    await ok.service.scheduleCommit({ owner: { type: "key", hash: OWNER_PKH }, scheduleLength: 3n, lampPerEpoch: LAMBDA });
    ok.clock!.t = lastOk;
    await expect(ok.service.submit({ txCbor: cbor, witnessCbor: fakeWitnessSetCbor() })).resolves.toMatchObject({ txHash: hash });
    expect(ok.chain.submitted).toHaveLength(1);
  });

  it("cbor không phải hex ⟹ 400", async () => {
    const h = harness();
    await expect(h.service.submit({ txCbor: "zz", witnessCbor: fakeWitnessSetCbor() }))
      .rejects.toMatchObject({ httpStatus: 400 });
  });
});

describe("Bộ định tuyến", () => {
  it("/health không cần thẻ bài, in nhãn nguồn và khai KHÔNG giữ vật liệu ký", async () => {
    const h = harness({ token: "x".repeat(32) });
    const r = await handle({ method: "GET", url: "/health", headers: {} }, h.router);
    expect(r.status).toBe(200);
    expect(r.body.holds_signing_material).toBe(false);
    expect(r.body.deployment_source).toBe(DEPLOYMENT.source);
    expect(r.body.change_address_strategy).toBe("enterprise_from_owner_pkh");
  });

  it("dịch vụ không thẻ: yêu cầu đã qua proxy ⟹ 401, mọi header chuyển tiếp. CẶP: yêu cầu trên máy ⟹ qua cổng thẻ", async () => {
    const h = harness({ token: "" });
    const body = { owner_pkh: OWNER_PKH, schedule_length: "3", lamp_per_epoch: "7000000" };
    const forwarded: Record<string, string>[] = [
      { "x-forwarded-for": "203.0.113.7" }, { "X-Forwarded-For": "203.0.113.7" }, { forwarded: "for=203.0.113.7" },
      { "x-real-ip": "203.0.113.7" }, { "cf-connecting-ip": "203.0.113.7" },
    ];
    for (const hdr of forwarded) {
      const r = await handle(post("/tx/schedule-commit", body, hdr), h.router);
      expect(r.status).toBe(401);
      expect((r.body as { error: { code: string } }).error.code).toBe("UNAUTHORIZED");
    }
    expect((await handle(post("/tx/schedule-commit", body), h.router)).status).not.toBe(401);
    expect((await handle({ method: "GET", url: "/health", headers: { "cf-connecting-ip": "203.0.113.7" } }, h.router)).status)
      .toBe(200);
  });

  it("thiếu/sai thẻ bài ⟹ 401", async () => {
    const h = harness({ token: "x".repeat(32) });
    const body = { owner_pkh: OWNER_PKH, schedule_length: "3", lamp_per_epoch: "7000000" };
    expect((await handle(post("/tx/schedule-commit", body), h.router)).status).toBe(401);
    expect((await handle(post("/tx/schedule-commit", body, { authorization: "Bearer sai" }), h.router)).status).toBe(401);
    expect((await handle(post("/tx/schedule-commit", body, { authorization: `Bearer ${"x".repeat(32)}` }), h.router)).status).toBe(200);
  });

  it("GET vào đường dựng ⟹ 405; đường lạ ⟹ 404", async () => {
    const h = harness();
    expect((await handle({ method: "GET", url: "/tx/consume", headers: {} }, h.router)).status).toBe(405);
    expect((await handle({ method: "GET", url: "/không-có", headers: {} }, h.router)).status).toBe(404);
  });

  it("số tiền gửi lên dưới dạng SỐ JSON ⟹ 400 kèm lý do", async () => {
    const h = harness();
    const r = await handle(post("/tx/schedule-commit", {
      owner_pkh: OWNER_PKH, schedule_length: "3", lamp_per_epoch: 7_000_000,
    }), h.router);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/CHUỖI chữ số/);
  });

  it("đường dựng trả đủ tx_cbor · tx_hash · summary · expires_at", async () => {
    const h = harness();
    const r = await handle(post("/tx/schedule-commit", {
      owner_pkh: OWNER_PKH, schedule_length: "17", lamp_per_epoch: "7000000",
    }), h.router);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["expires_at", "expires_reason", "ignored", "ignored_other_owner_count", "required_signers", "server_time", "summary", "tx_cbor", "tx_hash", "witness_notes"]);
    const summary = r.body.summary as { lamp: { locked_delta_oildrop: string } };
    // Lại một lần nữa, qua trọn đường HTTP: bản tóm tắt đi theo CBOR, không theo thân bài.
    expect(summary.lamp.locked_delta_oildrop).toBe("21000000");
  });

  it("thân bài không phải đối tượng ⟹ 400, không phải 500", async () => {
    const h = harness();
    expect((await handle(post("/tx/consume", "chuỗi"), h.router)).status).toBe(400);
    expect(h.internalErrors).toEqual([]);
  });

  it("lỗi ngoài dự kiến ⟹ 500 kèm MÃ THAM CHIẾU tra ngược được, không kèm traceback", async () => {
    const h = harness();
    // Bộ dựng ghi sẵn không có CBOR cho `consume` khi ta cố tình bỏ nó đi.
    const broken = harness();
    (broken.builder as unknown as { txCborByRoute: Record<string, string> }).txCborByRoute = {};
    const r = await handle(post("/tx/consume", {
      owner_pkh: OWNER_PKH, op_type: 1, op_count: "2",
    }), broken.router);
    expect(r.status).toBe(500);
    const body = r.body as { error: { code: string; details: { reference_code: string } } };
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.details.reference_code).toMatch(/^ref_[0-9a-f]{12}$/);
    expect(JSON.stringify(r.body)).not.toMatch(/at .*\.ts:/);
    // Mã đó PHẢI tra được ở nhật ký — nếu không, nó chỉ là "có lỗi xảy ra" mặc đồng phục.
    expect(broken.internalErrors).toHaveLength(1);
    expect(broken.internalErrors[0]!.ref).toBe(body.error.details.reference_code);
  });
});

// ── Sau /tx/submit: input vừa tiêu chưa vào khối · nút từ chối thì nhả khoá ─────────────

const COMMIT = (h: Harness) =>
  h.service.scheduleCommit({ owner: { type: "key", hash: OWNER_PKH }, scheduleLength: 3n, lampPerEpoch: LAMBDA });

describe("/tx/submit xong ⟹ UTxO vault vừa tiêu không được dựng lại trước khi vào khối", () => {
  it("dựng lại trên đúng UTxO vừa nộp ⟹ 409 PREVIOUS_TX_PENDING", async () => {
    const cbor = commitTxCbor(3n);
    const h = harness({ submitResult: txBodyHash(cbor), pending: new PendingSpends(TTL) });
    await COMMIT(h);
    await h.service.submit({ txCbor: cbor, witnessCbor: fakeWitnessSetCbor() });
    // Nút đọc (bản ghi) vẫn trả UTxO cũ — đúng như Blockfrost trước khi giao dịch vào khối.
    await expect(COMMIT(h)).rejects.toMatchObject({ httpStatus: 409, code: "PREVIOUS_TX_PENDING" });
  });
  it("CỰC ĐỐI: UTxO vault KHÁC (giao dịch trước đã vào khối) ⟹ dựng được", async () => {
    const cbor = commitTxCbor(3n);
    const pending = new PendingSpends(TTL);
    const h = harness({ submitResult: txBodyHash(cbor), pending });
    await COMMIT(h);
    await h.service.submit({ txCbor: cbor, witnessCbor: fakeWitnessSetCbor() });
    const h2 = harness({ utxos: [vaultUtxo({ txHash: "9e".repeat(32) })], pending });
    await expect(COMMIT(h2)).resolves.toBeDefined();
  });
  it("sổ chỉ ghi khi nút NHẬN giao dịch — nút từ chối thì không ghi", async () => {
    const pending = new PendingSpends(TTL);
    const h = harness({ pending });   // không khai submitResult ⟹ bản ghi ném SubmitRejectedError
    await COMMIT(h);
    await expect(h.service.submit({ txCbor: commitTxCbor(3n), witnessCbor: fakeWitnessSetCbor() }))
      .rejects.toMatchObject({ code: "SUBMIT_REJECTED" });
    expect(pending.has(`${INPUT_TX_HASH}#0`, NOW)).toBe(false);
  });
});

describe("/tx/submit — nút từ chối thì nhả khoá, mất kết nối thì giữ", () => {
  it("nút TỪ CHỐI ⟹ khoá của chủ được nhả (giao dịch đó không bao giờ lên chuỗi)", async () => {
    const h = harness();   // bản ghi không khai kết quả nộp ⟹ SubmitRejectedError
    await COMMIT(h);
    expect(h.locks.peek(OWNER_PKH, NOW)).not.toBeNull();
    await expect(h.service.submit({ txCbor: commitTxCbor(3n), witnessCbor: fakeWitnessSetCbor() }))
      .rejects.toMatchObject({ code: "SUBMIT_REJECTED" });
    expect(h.locks.peek(OWNER_PKH, NOW)).toBeNull();
  });
  it("CỰC ĐỐI: mất kết nối lúc nộp ⟹ GIỮ khoá (không biết giao dịch đã vào mempool chưa)", async () => {
    class DeadOnSubmit extends RecordedChainReader {
      override async submitTx(): Promise<string> { throw new ChainUnavailableError("quá giờ", { transport: "timeout" }); }
    }
    const h = harness({ chainClass: DeadOnSubmit });
    await COMMIT(h);
    await expect(h.service.submit({ txCbor: commitTxCbor(3n), witnessCbor: fakeWitnessSetCbor() }))
      .rejects.toBeInstanceOf(ChainUnavailableError);
    expect(h.locks.peek(OWNER_PKH, NOW)).not.toBeNull();
  });
});

/** Nút chuỗi mất kết nối ở lượt nộp ĐẦU (sau khi nhận bytes — không biết đã vào mempool chưa),
 *  các lượt sau trả theo bản ghi. */
class TimeoutOnce extends RecordedChainReader {
  private dropped = false;
  override async submitTx(c: string): Promise<string> {
    if (!this.dropped) {
      this.dropped = true;
      this.submitted.push(c);
      throw new ChainUnavailableError("quá giờ", { transport: "timeout" });
    }
    return super.submitTx(c);
  }
}

describe("/tx/submit — gửi mà không có xác nhận (mất kết nối, hash nút lệch) ⟹ ghi \"unconfirmed\", không phải \"chưa gửi\"", () => {
  it("mất kết nối ⟹ unconfirmed; tx chung khoá dựng TRƯỚC bị thay; nộp lại GỬI lại và thành công", async () => {
    const t0 = commitTxCbor(2n);
    const t1 = commitTxCbor(3n);
    const h = harness({ chainClass: TimeoutOnce, submitResult: txBodyHash(t1) });
    setCommitCbor(h, t0);
    await h.service.scheduleCommit({ ...KEY_OWNER_REQ, scheduleLength: 2n });   // T0 dựng trước
    setCommitCbor(h, t1);
    await h.service.scheduleCommit({ ...KEY_OWNER_REQ, scheduleLength: 3n });
    await expect(h.service.submit({ txCbor: t1, witnessCbor: fakeWitnessSetCbor() })).rejects.toBeInstanceOf(ChainUnavailableError);
    expect(h.issued.lookup(txBodyHash(t1), NOW)?.submitUnconfirmedAtMs).toBe(NOW);
    // T0 dựng trước lượt gửi có-thể-đã-tới của T1 ⟹ bị thay, 409 không gọi nút.
    setSubmitResult(h, t0);
    await expect(h.service.submit({ txCbor: t0, witnessCbor: fakeWitnessSetCbor() })).rejects.toMatchObject({
      httpStatus: 409, code: "TX_SUPERSEDED", details: { superseded_by: txBodyHash(t1), previously_submitted: false, submission: "none" },
    });
    expect(h.chain.submitted).toHaveLength(1);
    // Nộp lại T1: không biết lượt đầu tới chưa ⟹ GỬI lại.
    setSubmitResult(h, t1);
    await expect(h.service.submit({ txCbor: t1, witnessCbor: fakeWitnessSetCbor() })).resolves.toMatchObject({ txHash: txBodyHash(t1) });
    expect(h.chain.submitted).toHaveLength(2);
  });

  it("CỰC ĐỐI: nút TỪ CHỐI (không phải mất kết nối) ⟹ vẫn \"chưa gửi\": T0 dựng trước KHÔNG bị thay, nộp được", async () => {
    const t0 = commitTxCbor(2n);
    const t1 = commitTxCbor(3n);
    const h = harness();   // không khai submitResult ⟹ bản ghi ném SubmitRejectedError
    setCommitCbor(h, t0);
    await h.service.scheduleCommit({ ...KEY_OWNER_REQ, scheduleLength: 2n });
    setCommitCbor(h, t1);
    await h.service.scheduleCommit({ ...KEY_OWNER_REQ, scheduleLength: 3n });
    await expect(h.service.submit({ txCbor: t1, witnessCbor: fakeWitnessSetCbor() })).rejects.toMatchObject({ code: "SUBMIT_REJECTED" });
    expect(h.issued.lookup(txBodyHash(t1), NOW)?.submitUnconfirmedAtMs).toBeUndefined();
    setSubmitResult(h, t0);
    await expect(h.service.submit({ txCbor: t0, witnessCbor: fakeWitnessSetCbor() })).resolves.toMatchObject({ txHash: txBodyHash(t0) });
  });

  it("mất kết nối rồi tx chung khoá khác NỘP ⟹ nộp lại T1 nhận 409 kèm submission \"unconfirmed\" — KHÔNG ngụ ý \"chưa lên chuỗi\"", async () => {
    const t1 = commitTxCbor(3n);
    const t2 = commitTxCbor(4n);
    const h = harness({ chainClass: TimeoutOnce });
    await h.service.scheduleCommit({ ...KEY_OWNER_REQ, scheduleLength: 3n });
    await expect(h.service.submit({ txCbor: t1, witnessCbor: fakeWitnessSetCbor() })).rejects.toBeInstanceOf(ChainUnavailableError);
    setCommitCbor(h, t2);
    await h.service.scheduleCommit({ ...KEY_OWNER_REQ, scheduleLength: 4n });
    setSubmitResult(h, t2);
    await h.service.submit({ txCbor: t2, witnessCbor: fakeWitnessSetCbor() });
    setSubmitResult(h, t1);
    await expect(h.service.submit({ txCbor: t1, witnessCbor: fakeWitnessSetCbor() })).rejects.toMatchObject({
      httpStatus: 409, code: "TX_SUPERSEDED",
      details: { superseded_by: txBodyHash(t2), previously_submitted: true, submission: "unconfirmed" },
    });
    expect(h.chain.submitted).toHaveLength(2);
  });

  it("nút báo hash KHÁC ⟹ 502 nhưng tx ĐÃ gửi ⟹ unconfirmed + input vào sổ chờ; CỰC ĐỐI: nút báo đúng hash ⟹ accepted", async () => {
    const cbor = commitTxCbor(3n);
    const pending = new PendingSpends(TTL);
    const h = harness({ submitResult: "ff".repeat(32), pending });
    await COMMIT(h);
    await expect(h.service.submit({ txCbor: cbor, witnessCbor: fakeWitnessSetCbor() })).rejects.toMatchObject({ code: "SUBMIT_REJECTED" });
    const e = h.issued.lookup(txBodyHash(cbor), NOW)!;
    expect(e.submitUnconfirmedAtMs).toBe(NOW);
    expect(e.submittedAtMs).toBeUndefined();
    expect(pending.has(`${INPUT_TX_HASH}#0`, NOW)).toBe(true);

    const okPending = new PendingSpends(TTL);
    const ok = harness({ submitResult: txBodyHash(cbor), pending: okPending });
    await COMMIT(ok);
    await ok.service.submit({ txCbor: cbor, witnessCbor: fakeWitnessSetCbor() });
    const g = ok.issued.lookup(txBodyHash(cbor), NOW)!;
    expect(g.submittedAtMs).toBe(NOW);
    expect(g.submitUnconfirmedAtMs).toBeUndefined();
  });
});

describe("thân bài dựng — vault của chủ KHÁC chỉ được đếm", () => {
  it("vault của chủ khác ⟹ không liệt kê trong `ignored`, đếm ở `ignored_other_owner_count`", async () => {
    const other = vaultUtxo({
      txHash: "ee".repeat(32),
      idUnit: VAULT_ID_UNIT.slice(0, 56) + "ee".repeat(32),
      datum: datumHex({ lampLockedOildrop: 0n, batches: [], ownerPkh: OTHER_OWNER_PKH }),
    });
    const noNft = { txHash: "dd".repeat(32), outputIndex: 3, address: VAULT_ADDRESS, assets: { lovelace: 2_000_000n }, datum: VAULT_DATUM_BEFORE };
    const h = harness({ utxos: [vaultUtxo(), other, noNft as ReturnType<typeof vaultUtxo>] });
    const r = await handle(post("/tx/schedule-commit", { owner_pkh: OWNER_PKH, schedule_length: "3", lamp_per_epoch: String(LAMBDA) }), h.router);
    expect(r.status).toBe(200);
    const body = r.body as { ignored: { reason: string }[]; ignored_other_owner_count: number };
    expect(body.ignored.map(x => x.reason)).toEqual(["NO_VAULT_ID_NFT"]);
    expect(body.ignored_other_owner_count).toBe(1);
  });
});

describe("/tx/submit — chữ ký THẬT (vector ghi sẵn, cổng không tiêm)", () => {
  // Tx mang `required_signers` = khoá thử A; dịch vụ dùng `assertWitnessesCoverTx` mặc định. Chữ ký
  // là vector ghi sẵn cho ĐÚNG thân tx dưới đây (`fixtures/witnessVectors.ts` ▸ `BODY_SERVICE_SUBMIT`).
  const vkeyA = CML.PublicKey.from_bytes(Buffer.from(VKEY_A_HEX, "hex"));
  const signerPkh = vkeyA.hash().to_hex();
  const cbor = buildTxCbor({
    // ttl 10′ ghim cứng: vector chữ ký đã ký đúng thân này; PRERECORDED_VALIDITY_MS đổi thì thân không được đổi theo.
    ttlSlot: prerecordedTtlSlot(NOW, 600_000),
    inputs: [{ txHash: INPUT_TX_HASH, outputIndex: 0 }],
    feeLovelace: FEE,
    outputs: [
      {
        address: VAULT_ADDRESS,
        assets: { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
        inlineDatumHex: datumHex({ lampLockedOildrop: 2_000_000n + 3n * LAMBDA, batches: [BATCH_LIVE], genScheduleCount: 1 }),
      },
      { address: CHANGE_ADDRESS, assets: { lovelace: 9_400_000n } },
    ],
    requiredSigners: [signerPkh],
  });
  const witnessesWith = (pk: CML.PublicKey, sig: CML.Ed25519Signature): string => {
    const vkeys = CML.VkeywitnessList.new();
    vkeys.add(CML.Vkeywitness.new(pk, sig));
    const ws = CML.TransactionWitnessSet.new();
    ws.set_vkeywitnesses(vkeys);
    return ws.to_cbor_hex();
  };
  const goodWitness = witnessesWith(vkeyA, CML.Ed25519Signature.from_hex(BODY_SERVICE_SUBMIT.sigA));
  const junkWitness = witnessesWith(vkeyA, CML.Ed25519Signature.from_hex(flipFirstByte(BODY_SERVICE_SUBMIT.sigA)));

  it("thân tx của khối này trùng đúng thân mà vector đã được ký (lệch ⟹ sinh lại fixtures/witnessVectors.ts)", () => {
    expect(txBodyHash(cbor)).toBe(BODY_SERVICE_SUBMIT.bodyHash);
  });

  it("CẶP (âm): chữ ký rác ⟹ 400, KHÔNG ghi PendingSpends, KHÔNG markSubmitted; tx thật vẫn nộp được sau đó", async () => {
    const pending = new PendingSpends(TTL);
    const h = harness({ commitCbor: cbor, submitResult: txBodyHash(cbor), pending, realWitnessCheck: true });
    await h.service.scheduleCommit({ ...KEY_OWNER_REQ, scheduleLength: 3n });
    await expect(h.service.submit({ txCbor: cbor, witnessCbor: junkWitness }))
      .rejects.toMatchObject({ httpStatus: 400, code: "WITNESS_SIGNATURE_INVALID" });
    expect(h.chain.submitted).toHaveLength(0);
    expect(pending.conflicts([`${INPUT_TX_HASH}#0`], NOW, "99".repeat(32))).toEqual([]);
    const entry = h.issued.lookup(txBodyHash(cbor), NOW);
    expect(entry?.submittedAtMs).toBeUndefined();
    expect(entry?.submitUnconfirmedAtMs).toBeUndefined();
    const out = await h.service.submit({ txCbor: cbor, witnessCbor: goodWitness });
    expect(out.txHash).toBe(txBodyHash(cbor));
    expect(h.chain.submitted).toHaveLength(1);
  });

  it("CẶP (dương): chữ ký đúng phủ đủ required_signers ⟹ qua phép kiểm, nộp và ghi sổ", async () => {
    const pending = new PendingSpends(TTL);
    const h = harness({ commitCbor: cbor, submitResult: txBodyHash(cbor), pending, realWitnessCheck: true });
    await h.service.scheduleCommit({ ...KEY_OWNER_REQ, scheduleLength: 3n });
    const out = await h.service.submit({ txCbor: cbor, witnessCbor: goodWitness });
    expect(out.txHash).toBe(txBodyHash(cbor));
    expect(h.chain.submitted).toHaveLength(1);
    expect(h.issued.lookup(txBodyHash(cbor), NOW)?.submittedAtMs).toBe(NOW);
  });
});
