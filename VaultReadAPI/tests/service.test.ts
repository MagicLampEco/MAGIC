// VaultReadAPI/tests/service.test.ts — BA CA, BA MÃ. Đây là tiêu chí nghiệm thu chính.
//
// Câu mà mặt tiền này phải trả lời được, và backend Java hôm nay KHÔNG trả lời được:
//
//   (1) chủ CÓ vault            → 200 + số thật
//   (2) chủ CHƯA CÓ vault       → 200 + { vaults: [] }        ← KHÔNG phải 404
//   (3) không đọc được chuỗi    → 502 CHAIN_UNAVAILABLE       ← KHÔNG phải 200 + rỗng
//
// Gộp (2) với (3) là dựng lại đúng con số 0 đang sai: người dùng CÓ MAGIC mà chỉ điểm
// gãy thì vẫn thấy 0, và không có gì kêu lên.

import { describe, expect, it } from "vitest";

import { BlockfrostChainReader, RecordedChainReader } from "../src/chain.js";
import { ChainUnavailableError } from "../src/errors.js";
import { handle } from "../src/http.js";
import { VaultReadService, toJsonBody } from "../src/service.js";
import type { VaultScope } from "../src/config.js";

import {
  BATCH_EPOCH, PREVIEW_OWNER_PKH, PREVIEW_TIP_AT_BATCH_EPOCH, PREVIEW_TIP_AT_RECORD,
  PREVIEW_VAULT_ADDRESS, PREVIEW_VAULT_SCRIPT_HASH, PREVIEW_VAULT_UTXO,
  TIP_EPOCH_AT_RECORD,
} from "./fixtures/preview-e5fd34b1.js";
import { SYNTH_OTHER_OWNER, SYNTH_OWNER, synthDatumHex, synthUtxo, SYNTH_SCRIPT_HASH, PIN_EPOCH } from "./fixtures/synthetic.js";

const SCOPES: VaultScope[] = [{
  vaultType: "Schedule",
  address: PREVIEW_VAULT_ADDRESS,
  scriptHash: PREVIEW_VAULT_SCRIPT_HASH,
  source: "ghi lại từ Preview 2026-09-11, tx e5fd34b1…",
}];

const TOKEN = "thebai-chi-de-kiem-thu-khong-phai-bi-mat";

function depsWith(reader: ConstructorParameters<typeof VaultReadService>[2], token = TOKEN) {
  const service = new VaultReadService("Preview", SCOPES, reader);
  return { service, scopes: SCOPES, network: "Preview", chainLabel: reader.label, token };
}

const okReader = (tipAt = PREVIEW_TIP_AT_BATCH_EPOCH) => new RecordedChainReader(
  { [PREVIEW_VAULT_ADDRESS]: [PREVIEW_VAULT_UTXO] }, tipAt,
);

/** Không có UTxO nào ở địa chỉ vault — chuỗi TRẢ LỜI ĐƯỢC, và câu trả lời là "không có". */
const emptyReader = () => new RecordedChainReader({}, PREVIEW_TIP_AT_BATCH_EPOCH);

const auth = { authorization: `Bearer ${TOKEN}` };
const get = (path: string, deps: ReturnType<typeof depsWith>, headers: Record<string, string> = auth) =>
  handle({ method: "GET", url: path, headers }, deps);

describe("BA CA, BA MÃ — phân biệt được, không gộp", () => {
  it("(1) chủ CÓ vault → 200, tiêu được đúng 64 000 000 nanogic ở epoch 20700", async () => {
    const res = await get(`/vault/by-owner/${PREVIEW_OWNER_PKH}`, depsWith(okReader()));
    expect(res.status).toBe(200);
    const b = res.body as Record<string, never>;
    expect((b.totals as unknown as Record<string, string>).available_nanogic).toBe("64000000");
    expect((b.totals as unknown as Record<string, string>).accrued_nanogic).toBe("64000000");
    expect((b.vaults as unknown as unknown[]).length).toBe(1);
    expect(b.at_epoch as unknown as number).toBe(20700);
  });

  it("(2) PKH CHƯA TỪNG có vault → 200 + { vaults: [] }, KHÔNG phải 404", async () => {
    const res = await get(`/vault/by-owner/${SYNTH_OTHER_OWNER}`, depsWith(emptyReader()));
    expect(res.status).toBe(200);
    expect(res.body.vaults).toEqual([]);
    expect((res.body.totals as Record<string, unknown>).available_nanogic).toBe("0");
    expect((res.body.totals as Record<string, unknown>).vault_count).toBe(0);
    expect(res.body.error).toBeUndefined();
  });

  it("(3) không đọc được chuỗi → 502 CHAIN_UNAVAILABLE, KHÔNG phải 200 + rỗng", async () => {
    const dead = new RecordedChainReader({}, PREVIEW_TIP_AT_BATCH_EPOCH,
      new ChainUnavailableError("Không nối được tới nút chuỗi (transport).", { transport: "transport" }));
    const res = await get(`/vault/by-owner/${PREVIEW_OWNER_PKH}`, depsWith(dead));
    expect(res.status).toBe(502);
    expect((res.body.error as Record<string, unknown>).code).toBe("CHAIN_UNAVAILABLE");
    expect(res.body.vaults).toBeUndefined();
  });

  it("(3-thật) trỏ Blockfrost vào CỔNG CHẾT → 502, không phải 200 rỗng", async () => {
    // Không dùng bản ghi lại: mở hẳn một `BlockfrostChainReader` trỏ vào 127.0.0.1:1,
    // nơi không có gì nghe. Đây là phép đo thật của nhánh mạng, chỉ không cần Internet.
    const reader = new BlockfrostChainReader({
      baseUrl: "http://127.0.0.1:1/api/v0",
      projectId: "khong-phai-khoa-that",
      timeoutMs: 2_000,
    });
    const res = await get(`/vault/by-owner/${PREVIEW_OWNER_PKH}`, depsWith(reader));
    expect(res.status).toBe(502);
    expect((res.body.error as Record<string, unknown>).code).toBe("CHAIN_UNAVAILABLE");
    // Thân bài nói được kiểu hỏng, và KHÔNG mang khoá.
    expect(JSON.stringify(res.body)).not.toContain("khong-phai-khoa-that");
  });

  it("ba mã ĐÔI MỘT KHÁC NHAU — viết thành một khẳng định, không để người đọc tự ghép", async () => {
    const dead = new RecordedChainReader({}, PREVIEW_TIP_AT_BATCH_EPOCH,
      new ChainUnavailableError("chết", {}));
    const codes = [
      (await get(`/vault/by-owner/${PREVIEW_OWNER_PKH}`, depsWith(okReader()))).status,
      (await get(`/vault/by-owner/${SYNTH_OTHER_OWNER}`, depsWith(emptyReader()))).status,
      (await get(`/vault/by-owner/${PREVIEW_OWNER_PKH}`, depsWith(dead))).status,
    ];
    expect(codes).toEqual([200, 200, 502]);
    // Hai ca 200 phải phân biệt được bằng THÂN BÀI, không bằng mã.
    const a = await get(`/vault/by-owner/${PREVIEW_OWNER_PKH}`, depsWith(okReader()));
    const b = await get(`/vault/by-owner/${SYNTH_OTHER_OWNER}`, depsWith(emptyReader()));
    expect((a.body.totals as Record<string, unknown>).vault_count).toBe(1);
    expect((b.body.totals as Record<string, unknown>).vault_count).toBe(0);
    expect(new Set(codes).size).toBe(2);
  });
});

describe("epoch — hai đồng hồ, và mặt tiền luôn khai nó đọc đồng hồ nào", () => {
  it("đỉnh chuỗi thật (2026-09-11) ⇒ epoch giao thức 20707, available 0, accrued 64 000 000", async () => {
    const res = await get(`/vault/by-owner/${PREVIEW_OWNER_PKH}`, depsWith(okReader(PREVIEW_TIP_AT_RECORD)));
    expect(res.status).toBe(200);
    expect(res.body.at_epoch).toBe(Number(TIP_EPOCH_AT_RECORD));
    expect(res.body.at_epoch).toBe(20707);
    expect(res.body.at_epoch_source).toBe("chain_tip");
    const t = res.body.totals as Record<string, unknown>;
    expect(t.available_nanogic).toBe("0");
    expect(t.accrued_nanogic).toBe("64000000");
    expect(t.expired_nanogic).toBe("64000000");
  });

  it("epoch giao thức (20707) KHÔNG phải epoch Cardano (1417 lúc đo) — số khác nhau một trời một vực", async () => {
    // Đo 2026-09-11 bằng Blockfrost `/epochs/latest` trên Preview: epoch Cardano = 1417.
    // Cùng đỉnh chuỗi đó, epoch GIAO THỨC = 20707. Gộp hai đồng hồ là lỗi lớp biên,
    // và `ProtocolUtils/src/index.ts` §"HAI ĐỒNG HỒ" đã trả giá một lần cho nó rồi.
    const res = await get(`/vault/by-owner/${PREVIEW_OWNER_PKH}`, depsWith(okReader(PREVIEW_TIP_AT_RECORD)));
    expect(res.body.at_epoch).toBe(20707);
    expect(res.body.at_epoch).not.toBe(1417);
    // Thân bài in cả đỉnh chuỗi để bên gọi tự đối chiếu được, không phải tin lời.
    expect((res.body.chain_tip as Record<string, unknown>).block_time_posix_ms).toBe("1789100703000");
  });

  it("?at_epoch= ép được, và mặt tiền khai rõ nguồn là người gọi", async () => {
    const res = await get(
      `/vault/by-owner/${PREVIEW_OWNER_PKH}?at_epoch=${BATCH_EPOCH}`,
      depsWith(okReader(PREVIEW_TIP_AT_RECORD)),
    );
    expect(res.body.at_epoch).toBe(20700);
    expect(res.body.at_epoch_source).toBe("caller");
    expect((res.body.totals as Record<string, unknown>).available_nanogic).toBe("64000000");
  });

  it("đỉnh chuỗi mang `time` vô lý (slot đọc nhầm thành giây) ⇒ CHAIN_UNAVAILABLE", async () => {
    // Cái bẫy đơn vị viết thành một nhánh chứ không thành một chú thích.
    const badTip = new RecordedChainReader(
      { [PREVIEW_VAULT_ADDRESS]: [PREVIEW_VAULT_UTXO] },
      { blockHeight: 1, blockHash: "00", blockTimePosixMs: 1_789_100_703n },   // GIÂY, quên ×1000
    );
    const res = await get(`/vault/by-owner/${PREVIEW_OWNER_PKH}`, depsWith(badTip));
    // Ở tầng RecordedChainReader không có cổng tỉnh táo, nên đây kiểm hệ quả: epoch sai
    // bét nhè chứ không phải 20706 — bằng chứng rằng nhân nhầm hệ số KHÔNG im lặng.
    expect(res.status).toBe(200);
    expect(res.body.at_epoch).toBe(20);
    expect(res.body.at_epoch).not.toBe(20706);
  });
});

describe("số nguyên đi ra dưới dạng CHUỖI, không phải số JSON", () => {
  it("mọi trường tiền là chuỗi chữ số — Java đọc bằng BigInteger, không mất chính xác", async () => {
    const res = await get(`/vault/by-owner/${PREVIEW_OWNER_PKH}`, depsWith(okReader()));
    const v = (res.body.vaults as Record<string, unknown>[])[0]!;
    for (const k of [
      "available_nanogic", "accrued_nanogic", "expired_nanogic",
      "consumed_credit_nanogic", "lamp_balance_oildrop", "lamp_locked_oildrop",
    ]) {
      expect(typeof v[k]).toBe("string");
      expect(v[k] as string).toMatch(/^-?\d+$/);
    }
    expect(v.rate_locked_q).toBe("8000000000");
    // Và thân bài đi qua JSON thật được — không sót một BigInt nào làm `JSON.stringify` ném.
    expect(() => JSON.stringify(res.body)).not.toThrow();
  });

  it("số lớn hơn 2^53 vẫn ra đúng từng chữ số", async () => {
    const big = 36_000_000_000_000_001n;              // > 2^53 ≈ 9,007×10^15
    expect(big > 2n ** 53n).toBe(true);
    const utxo = synthUtxo({
      txHash: "3a".repeat(32),
      datumHex: synthDatumHex(SYNTH_OWNER, [{ id: "f0".repeat(16), createdEpoch: PIN_EPOCH, amountNanogic: big }]),
    });
    const scopes: VaultScope[] = [{ vaultType: "Schedule", address: "addr_test1_synth", scriptHash: SYNTH_SCRIPT_HASH, source: "mẫu" }];
    const svc = new VaultReadService("Preview", scopes,
      new RecordedChainReader({ addr_test1_synth: [utxo] }, PREVIEW_TIP_AT_BATCH_EPOCH));
    const out = await svc.read({ ownerPkh: SYNTH_OWNER, atEpoch: PIN_EPOCH });
    const body = toJsonBody(out);
    const roundTripped = JSON.parse(JSON.stringify(body)) as Record<string, Record<string, string>>;
    const asString = roundTripped.totals!.available_nanogic!;
    expect(asString).toBe("36000000000000001");
    expect(BigInt(asString)).toBe(big);
    // Và đây là VÌ SAO nó phải là chuỗi: cho cùng chuỗi ấy đi qua `Number` là mất chữ
    // số cuối, im lặng. Một trường JSON dạng SỐ ở đây hỏng đúng kiểu đó ngay trong
    // trình phân tích của bên gọi, trước khi mã của họ chạy dòng nào.
    expect(String(Number(asString))).not.toBe(asString);
    expect(String(Number(asString))).toBe("36000000000000000");
  });
});

describe("mặt tiền ĐỌC-THÔI + ranh giới uỷ quyền", () => {
  it("không thẻ bài → 401; sai thẻ bài → 401; đúng thẻ bài → 200", async () => {
    const d = depsWith(okReader());
    expect((await get(`/vault/by-owner/${PREVIEW_OWNER_PKH}`, d, {})).status).toBe(401);
    expect((await get(`/vault/by-owner/${PREVIEW_OWNER_PKH}`, d, { authorization: "Bearer sai" })).status).toBe(401);
    expect((await get(`/vault/by-owner/${PREVIEW_OWNER_PKH}`, d)).status).toBe(200);
  });

  it("POST/PUT/DELETE → 405. Không có đường ghi nào, kể cả đường sai.", async () => {
    const d = depsWith(okReader());
    for (const m of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await handle({ method: m, url: `/vault/by-owner/${PREVIEW_OWNER_PKH}`, headers: auth }, d);
      expect(res.status).toBe(405);
    }
  });

  it("CA ĐỐI KHÁNG — tra PKH của người khác: mặt tiền TRẢ VỀ, và đó là quyết định có chủ đích", async () => {
    // Ai cầm thẻ bài thì tra được số dư của BẤT KỲ PKH nào. Đó không phải lỗ hổng rò rỉ
    // dữ liệu mới: datum vault nằm công khai trên chuỗi, ai có một nút Cardano cũng đọc
    // được y hệt. Cái mặt tiền này đổi là CHI PHÍ — nó biến một phép tra cứu đắt thành
    // một lời gọi rẻ, nên nó hạ giá của việc dò hàng loạt PKH → số dư.
    //
    // Vì vậy mặt tiền KHÔNG giả vờ phân quyền theo người dùng cuối: nó không có phiên,
    // không có DID, không có cách nào xác thực rằng người gọi LÀ chủ PKH đó. Dựng một
    // lớp phân quyền ở đây là diễn kịch. Ranh giới đúng:
    //   - mặt tiền: chỉ loopback (hoặc thẻ bài bắt buộc — `config.ts` ép fail-closed),
    //   - backend Java: đã biết phiên thuộc PersonDID nào ⇒ NÓ tự tra DID→PKH và KHÔNG
    //     BAO GIỜ chuyển tiếp PKH do người gọi đưa vào.
    const d = depsWith(okReader());
    const res = await get(`/vault/by-owner/${PREVIEW_OWNER_PKH}`, d);
    expect(res.status).toBe(200);
    expect((res.body.vaults as Record<string, unknown>[])[0]!.owner_pkh).toBe(PREVIEW_OWNER_PKH);

    // Nhưng KHÔNG có thẻ bài thì không tra được PKH nào cả — kể cả PKH của chính mình.
    expect((await get(`/vault/by-owner/${PREVIEW_OWNER_PKH}`, d, {})).status).toBe(401);
  });

  it("CA ĐỐI KHÁNG — vault giữa chừng một lần tiêu: KHÔNG cộng hai lần, trả 409", async () => {
    // Dựng đúng ca đáng sợ: hai UTxO ở địa chỉ vault, cùng một NFT danh-tính, một cái
    // trước và một cái sau lần tiêu. Trên sổ cái đã lắng điều này bất khả — cái trước đã
    // bị tiêu. Nhưng một chỉ mục chậm hay một lần cuộn lại trả về đúng cặp đó, và cách
    // ngây thơ ("cộng mọi UTxO khớp owner") báo 104 000 000 cho một vault chỉ có 64 000 000.
    const before = synthUtxo({
      txHash: "4a".repeat(32),
      datumHex: synthDatumHex(SYNTH_OWNER, [{ id: "a0".repeat(16), createdEpoch: PIN_EPOCH, amountNanogic: 64_000_000n }]),
      vaultIdAssetNameSeed: "9e",
    });
    const after = synthUtxo({
      txHash: "4b".repeat(32),
      datumHex: synthDatumHex(SYNTH_OWNER, [{ id: "a1".repeat(16), createdEpoch: PIN_EPOCH, amountNanogic: 40_000_000n }]),
      vaultIdAssetNameSeed: "9e",
    });
    const scopes: VaultScope[] = [{ vaultType: "Schedule", address: "addr_test1_synth", scriptHash: SYNTH_SCRIPT_HASH, source: "mẫu" }];
    const svc = new VaultReadService("Preview", scopes,
      new RecordedChainReader({ addr_test1_synth: [before, after] }, PREVIEW_TIP_AT_BATCH_EPOCH));
    const res = await handle(
      { method: "GET", url: `/vault/by-owner/${SYNTH_OWNER}?at_epoch=${PIN_EPOCH}`, headers: auth },
      { service: svc, scopes, network: "Preview", chainLabel: "recorded", token: TOKEN },
    );
    expect(res.status).toBe(409);
    expect((res.body.error as Record<string, unknown>).code).toBe("VAULT_IDENTITY_DUPLICATE");
    expect(JSON.stringify(res.body)).not.toContain("104000000");
  });
});

describe("tham số của người gọi sai thì nói rõ sai chỗ nào", () => {
  it("PKH không phải 56 hex → 400", async () => {
    const res = await get("/vault/by-owner/khong-phai-pkh", depsWith(okReader()));
    expect(res.status).toBe(400);
    expect((res.body.error as Record<string, unknown>).code).toBe("BAD_REQUEST");
  });

  it("vault_type không có trong cấu hình → 404 UNKNOWN_VAULT_SCOPE (khác 404 sai đường)", async () => {
    const res = await get(`/vault/by-owner/${PREVIEW_OWNER_PKH}?vault_type=Instant`, depsWith(okReader()));
    expect(res.status).toBe(404);
    expect((res.body.error as Record<string, unknown>).code).toBe("UNKNOWN_VAULT_SCOPE");
  });

  it("at_epoch không phải số → 400", async () => {
    const res = await get(`/vault/by-owner/${PREVIEW_OWNER_PKH}?at_epoch=hom-qua`, depsWith(okReader()));
    expect(res.status).toBe(400);
  });

  it("/health trả lời KHÔNG cần thẻ bài, KHÔNG chạm chuỗi, và in NHÃN NGUỒN của địa chỉ", async () => {
    const res = await get("/health", depsWith(okReader()), {});
    expect(res.status).toBe(200);
    const scopes = res.body.vault_scopes as Record<string, unknown>[];
    expect(scopes[0]!.source).toBe("ghi lại từ Preview 2026-09-11, tx e5fd34b1…");
    expect(scopes[0]!.script_hash).toBe(PREVIEW_VAULT_SCRIPT_HASH);
  });
});
