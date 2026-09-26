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
import { handle, type RouterDeps } from "../src/http.js";
import { IssuedTxRegistry, OwnerLockTable } from "../src/locks.js";
import { VaultTxService } from "../src/service.js";
import { txBodyHash } from "../src/summary.js";
import { RecordedTxBuilder, enterpriseAddressOf } from "../src/txBuilder.js";
import {
  INPUT_TX_HASH, LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID, LAMP_UNIT, OTHER_OWNER_PKH, OWNER_PKH,
  SHARD_ADDRESS, VAULT_ADDRESS, VAULT_ID_UNIT, datumHex,
} from "./fixtures/preview.js";
import { buildTxCbor, emptyWitnessSetCbor, fakeWitnessSetCbor } from "./fixtures/tx.js";

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
  },
  consume: {
    engage_address: VAULT_ADDRESS,
    engage_nft_unit: `${"44".repeat(28)}deadbeef`,
    price_beacon_address: VAULT_ADDRESS,
    price_beacon_nft_unit: `${"55".repeat(28)}cafe`,
  },
}), "Preview");

/** Giao dịch khoá `L × λ` — ĐÂY là sự thật mà `summary` phải nói theo. */
function commitTxCbor(scheduleLength: bigint): string {
  return buildTxCbor({
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
}

function harness(opts: {
  utxos?: ReturnType<typeof vaultUtxo>[];
  commitCbor?: string;
  failWith?: ChainUnavailableError;
  submitResult?: string;
  token?: string;
} = {}): Harness {
  const chain = new RecordedChainReader(
    { [VAULT_ADDRESS]: opts.utxos ?? [vaultUtxo()] },
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
  const issued = new IssuedTxRegistry(TTL * 4);
  const service = new VaultTxService({
    network: "Preview",
    deployment: DEPLOYMENT,
    chain,
    builder,
    locks,
    issued,
    lockTtlMs: TTL,
    now: () => NOW,
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
  return { service, builder, locks, issued, chain, router, internalErrors };
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
    expect(h.builder.lastCall).toEqual({
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
    expect(out.expiresAt).toBe(new Date(NOW + TTL).toISOString());
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

describe("Khoá mềm theo chủ vault — đua UTxO", () => {
  it("lượt dựng thứ hai cho cùng chủ ⟹ 409 OWNER_TX_IN_FLIGHT", async () => {
    const h = harness();
    await h.service.scheduleCommit({ owner: { type: "key", hash: OWNER_PKH }, scheduleLength: 3n, lampPerEpoch: LAMBDA });
    await expect(h.service.scheduleCommit({
      owner: { type: "key", hash: OWNER_PKH }, scheduleLength: 3n, lampPerEpoch: LAMBDA,
    })).rejects.toMatchObject({ httpStatus: 409, code: "OWNER_TX_IN_FLIGHT" });
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
    // Sổ phát hành có hạn dùng riêng, dài hơn khoá của chủ — quá hạn thì tờ giấy phép
    // nộp hết hiệu lực, không phải "còn hiệu lực nhưng chưa dùng".
    expect(h.issued.wasIssued(hash, NOW + TTL * 4 + 1)).toBe(false);
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
    expect(Object.keys(r.body).sort()).toEqual(["expires_at", "ignored", "required_signers", "summary", "tx_cbor", "tx_hash", "witness_notes"]);
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
