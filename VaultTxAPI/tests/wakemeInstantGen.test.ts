// VaultTxAPI/tests/wakemeInstantGen.test.ts — `wakeme_vault_ref` của `POST /tx/instant-gen`.
//
// Ca đáng giá nhất là CẶP chỉ khác `gen_pin_period`: `< epoch` ⟹ `counted: true`, `lent_lamp`
// = conditional + owned; `>= epoch` ⟹ `counted: false`, `lent_lamp: "0"`. Validator CHO QUA cả
// hai — nên chỉ phản hồi phân biệt được chúng, và một hiện thực trả `counted: true` cho mọi két
// ghim đúng thì đỏ ở vế thứ hai.

import {
  Constr, Data, PROTOCOL_PARAMETERS_DEFAULT, credentialToAddress, unixTimeToSlot, type UTxO,
} from "@lucid-evolution/lucid";
import type { InstantGenLimits } from "@magiclamp/instantgen-sdk";
import { posixMsToEpoch, wakemeVaultHash } from "@magiclamp/protocol-utils";
import { describe, expect, it } from "vitest";

import { RecordedChainReader, type ChainTip, type OutRef } from "../src/chain.js";
import { parseDeployment } from "../src/config.js";
import { CodedApiError } from "../src/errors.js";
import { handle, type RouterDeps } from "../src/http.js";
import { IssuedTxRegistry, OwnerLockTable } from "../src/locks.js";
import { VaultTxService } from "../src/service.js";
import { RecordedTxBuilder, type BuildContext, type BuiltTx, type InstantGenBuildParams } from "../src/txBuilder.js";
import { mForBuild } from "../src/genV2.js";
import { referenceInputRefsOf } from "../src/wakeme.js";
import { inputRefsOf } from "../src/feePayer.js";
import {
  INPUT_TX_HASH, LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID, LAMP_UNIT, OTHER_OWNER_PKH, OWNER_PKH,
  SHARD_ADDRESS, VAULT_ADDRESS, VAULT_ID_UNIT, VAULT_SCRIPT_HASH, datumHex,
} from "./fixtures/preview.js";
import { buildTxCbor, prerecordedTtlSlot } from "./fixtures/tx.js";
import { GB_SHARD_REF, genV2Chain, genV2Json } from "./fixtures/genV2.js";

type Net = "Preprod" | "Preview";

const TTL = 180_000;
const NOW = 1_789_100_703_000;
const FIXTURE_TTL_SLOT = prerecordedTtlSlot(NOW, undefined, "Preprod");
const TIP: ChainTip = {
  blockHeight: 4_651_976,
  blockHash: "14ae149dd07cd25ce37a6a4336f3939446bd68d9ad4a2e820201a474cc3ad72f",
  blockTimePosixMs: BigInt(NOW),
};
const EPOCH = posixMsToEpoch(BigInt(NOW), "Preprod");

const WAKEME_HASH = wakemeVaultHash("Preprod");
const WAKEME_ADDRESS = credentialToAddress("Preprod", { type: "Script", hash: WAKEME_HASH });
const WAKEME_TX = "ab".repeat(32);
const WAKEME_REF = `${WAKEME_TX}#1`;
const OWNER_COMMIT = "c1".repeat(32);
const VAULT_NAME = VAULT_ID_UNIT.slice(56);
const CONDITIONAL = 300_000_000n;
const OWNED = 200_000_000n;
/** Két IG đã nối link tới két Wakeme của fixture (genesis `did_commit` hoặc RefreshCheckpoint). */
const LINKED = { link: OWNER_COMMIT } as const;

function deploymentJson(net: Net): string {
  return JSON.stringify({
    source: "bản dựng thử của phép kiểm — không phải một lần deploy thật",
    lamp: { policy_id: LAMP_POLICY_ID, asset_name_hex: LAMP_ASSET_NAME_HEX },
    vaults: [{ vault_type: "Instant", address: VAULT_ADDRESS }],
    shard_address: SHARD_ADDRESS,
    ref_script_utxos: {
      vault: `${"11".repeat(32)}#0`, shard: `${"22".repeat(32)}#1`, consume: `${"33".repeat(32)}#2`,
      gb_shard: GB_SHARD_REF,
    },
    consume: {
      engage_address: VAULT_ADDRESS,
      price_beacon_address: VAULT_ADDRESS,
      price_beacon_nft_unit: `${"55".repeat(28)}cafe`,
    },
    gen_v2: genV2Json(net),
  });
}

/** `link`: ô `wakeme_link` của két IG (vắng ⟹ "" — chưa nối). `sameEpoch`: checkpoint đã ở
 *  epoch hiện tại ⟹ lượt sinh KHÔNG làm mới ⟹ validator không đòi két Wakeme. */
interface VaultSpec { link?: string; sameEpoch?: boolean }

function vaultUtxo(v: VaultSpec = {}): UTxO {
  return {
    txHash: INPUT_TX_HASH, outputIndex: 0, address: VAULT_ADDRESS,
    assets: { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
    // Gen v2.0: cap_epoch 0 < EPOCH ⟹ lượt sinh làm mới checkpoint và ghim két Wakeme đưa vào.
    datum: datumHex({
      lampLockedOildrop: 0n, batches: [], instantUnlockMs: 0n, lastUpdatedEpoch: EPOCH - 1n,
      ...(v.link === undefined ? {} : { wakemeLink: v.link }),
      ...(v.sameEpoch === true ? { capEpoch: EPOCH, capNanogic: 1_000_000_000n, usageWindowEpoch: EPOCH } : {}),
    }),
  };
}

/** `both`: két ở CẢ inputs lẫn reference_inputs — ca duy nhất tách được vế "không ở inputs"
 *  khỏi vế "có ở reference_inputs"; thiếu nó thì gỡ vế thứ nhất mà bộ kiểm vẫn xanh. */
type Where = "reference" | "input" | "both" | "absent";

/** CBOR ghi sẵn: két ở `reference_inputs` (đúng), ở `inputs` (bị tiêu — sai), hoặc vắng. */
function instantTxCbor(where: Where): string {
  const wk = { txHash: WAKEME_TX, outputIndex: 1 };
  return buildTxCbor({ ttlSlot: FIXTURE_TTL_SLOT,
    inputs: where === "input" || where === "both"
      ? [{ txHash: INPUT_TX_HASH, outputIndex: 0 }, wk] : [{ txHash: INPUT_TX_HASH, outputIndex: 0 }],
    ...(where === "reference" || where === "both" ? { referenceInputs: [wk] } : {}),
    feeLovelace: 178_000n,
    outputs: [{
      address: VAULT_ADDRESS,
      assets: { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
      inlineDatumHex: datumHex({
        lampLockedOildrop: 0n,
        batches: [{ id: "c0".repeat(16), createdEpoch: EPOCH, amountNanogic: 4_000_000n }],
        instantUnlockMs: 1_789_000_000_000n,
        lastUpdatedEpoch: EPOCH, capEpoch: EPOCH, capNanogic: 1_000_000_000n, usageWindowEpoch: EPOCH,
      }),
    }],
  });
}

interface WakemeSpec {
  address?: string;
  pin?: Data;
  pinPeriod?: bigint;
  lampHeld?: bigint;
  outputIndex?: number;
}

function wakemeUtxo(s: WakemeSpec = {}): UTxO {
  const pin = s.pin ?? new Constr(0, [new Constr(0, [VAULT_SCRIPT_HASH, VAULT_NAME])]);
  const datum = Data.to(new Constr(0, [
    OWNER_COMMIT, 0n, 0n, CONDITIONAL, 0n, 0n, 0n, OWNED, 0n, 0n, 0n, pin, s.pinPeriod ?? EPOCH - 1n,
  ]));
  return {
    txHash: WAKEME_TX, outputIndex: s.outputIndex ?? 1, address: s.address ?? WAKEME_ADDRESS,
    assets: { lovelace: 2_000_000n, [WAKEME_HASH + OWNER_COMMIT]: 1n, [LAMP_UNIT]: s.lampHeld ?? CONDITIONAL + OWNED },
    datum,
  };
}

/** Bộ đọc chuỗi đếm lượt `utxosByOutRef`; `missing` ⟹ ném như bộ đọc HTTP thật (400 UTXO_NOT_FOUND). */
class CountingChain extends RecordedChainReader {
  byRefCalls = 0;
  constructor(net: Net, refUtxos: UTxO[], private readonly missing = false, vault: VaultSpec = {}) {
    // Két IG có ở CẢ bảng theo địa chỉ lẫn bảng theo tham chiếu, như chuỗi thật: đường có ví trả
    // phí (báo giá) đọc lại các input khác UTxO trả phí theo tham chiếu (`service.ts` ▸
    // `checkFeePayer`), nên thiếu nó thì báo giá đỏ 502 CHAIN_UNAVAILABLE vì fixture, không vì mã.
    super({ [VAULT_ADDRESS]: [vaultUtxo(vault)], ...genV2Chain(net, { epoch: EPOCH }) }, TIP, [vaultUtxo(vault), ...refUtxos]);
  }
  override async utxosByOutRef(refs: OutRef[]): Promise<UTxO[]> {
    this.byRefCalls++;
    if (this.missing) {
      throw new CodedApiError(400, "UTXO_NOT_FOUND", "không có", { out_ref: `${refs[0]!.txHash}#${refs[0]!.outputIndex}` });
    }
    return super.utxosByOutRef(refs);
  }
}

function harness(opts: {
  net?: Net; wakeme?: UTxO; wakemes?: UTxO[]; missing?: boolean; where?: Where; vault?: VaultSpec;
  builder?: RecordedTxBuilder;
} = {}) {
  const net = opts.net ?? "Preprod";
  const deployment = parseDeployment(deploymentJson(net), net);
  const wk = opts.wakemes ?? (opts.wakeme === undefined ? [] : [opts.wakeme]);
  const chain = new CountingChain(net, wk, opts.missing, opts.vault);
  const builder = opts.builder ?? new RecordedTxBuilder({ instant_gen: instantTxCbor(opts.where ?? "reference") });
  const service = new VaultTxService({
    network: net, deployment, chain, builder,
    locks: new OwnerLockTable(TTL), issued: new IssuedTxRegistry(),
    lockTtlMs: TTL, now: () => NOW,
  });
  const router: RouterDeps = {
    service, deploymentSource: deployment.source, vaultScopes: deployment.vaults, network: net,
    chainLabel: "recorded", changeAddressStrategy: "enterprise_from_owner_pkh", token: "", logInternal: () => {},
  };
  return { chain, builder, router, service };
}

/** `m = 1` nanogic: đủ nhỏ để dưới mọi trần của fixture — tệp này kiểm két Wakeme, không kiểm trần. */
const post = (body: unknown) => ({ method: "POST", url: "/tx/instant-gen", headers: {}, body: { m: "1", ...(body as object) } });
const codeOf = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;
const detailsOf = (r: { body: unknown }) => (r.body as { error: { details: Record<string, unknown> } }).error.details;
const summaryOf = (r: { body: unknown }) => (r.body as { summary: Record<string, unknown> }).summary;

describe("POST /tx/instant-gen — wakeme_vault_ref", () => {
  it("vắng trường + két IG chưa nối link ⟹ không đọc két, không đưa két vào bộ dựng, summary.wakeme nói vault_not_linked", async () => {
    const h = harness({ where: "absent" });
    const r = await handle(post({ owner_pkh: OWNER_PKH }), h.router);
    expect(r.status).toBe(200);
    expect(summaryOf(r).wakeme).toEqual({ lent_lamp: "0", counted: false, reason: "vault_not_linked" });
    expect(h.chain.byRefCalls).toBe(0);
    expect(h.builder.lastCall).toMatchObject({ route: "instant_gen", params: { m: 1n } });
    expect(h.builder.lastCall!.wakeme).toBeUndefined();
  });

  it("ref sai dạng ⟹ 400 WAKEME_VAULT_REF_SHAPE (chuỗi lệch khuôn, và kiểu không phải chuỗi)", async () => {
    const h = harness({ wakeme: wakemeUtxo() });
    for (const bad of ["abc#0", `${WAKEME_TX}`, `${WAKEME_TX}#01`, 7, null]) {
      const r = await handle(post({ owner_pkh: OWNER_PKH, wakeme_vault_ref: bad }), h.router);
      expect(r.status).toBe(400);
      expect(codeOf(r)).toBe("WAKEME_VAULT_REF_SHAPE");
    }
    expect(h.chain.byRefCalls).toBe(0);
  });

  it("mạng chưa có két Wakeme ⟹ 501 WAKEME_VAULT_UNAVAILABLE, không chạm chuỗi", async () => {
    const h = harness({ net: "Preview", wakeme: wakemeUtxo() });
    const r = await handle(post({ owner_pkh: OWNER_PKH, wakeme_vault_ref: WAKEME_REF }), h.router);
    expect(r.status).toBe(501);
    expect(codeOf(r)).toBe("WAKEME_VAULT_UNAVAILABLE");
    expect(h.chain.byRefCalls).toBe(0);
  });

  it("UTxO không tồn tại ⟹ 404 WAKEME_VAULT_NOT_FOUND", async () => {
    const h = harness({ missing: true });
    const r = await handle(post({ owner_pkh: OWNER_PKH, wakeme_vault_ref: WAKEME_REF }), h.router);
    expect(r.status).toBe(404);
    expect(codeOf(r)).toBe("WAKEME_VAULT_NOT_FOUND");
    expect(detailsOf(r).wakeme_vault_ref).toBe(WAKEME_REF);
  });

  it("két nằm ở script khác ⟹ 409 WAKEME_VAULT_SCRIPT_MISMATCH", async () => {
    const h = harness({ wakeme: wakemeUtxo({ address: VAULT_ADDRESS }) });
    const r = await handle(post({ owner_pkh: OWNER_PKH, wakeme_vault_ref: WAKEME_REF }), h.router);
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("WAKEME_VAULT_SCRIPT_MISMATCH");
    expect(detailsOf(r).expected_script_hash).toBe(WAKEME_HASH);
    expect(detailsOf(r).seen_payment_credential).toEqual({ type: "Script", hash: VAULT_SCRIPT_HASH });
  });

  // Từ 2026-10-02: két chưa ghim vault này KHÔNG còn là lỗi (validator cho qua với L_lent = 0 —
  // chủ két IG nối link trước, két Wakeme ghim sau). Phản hồi 200 NÓI RA counted:false + ghim thấy.
  // Từ 2026-10-03 (luật 6 siết) ca đó chỉ còn hợp lệ khi két IG ĐÃ nối link tới chính két Wakeme
  // này (genesis `did_commit` hoặc RefreshCheckpoint) — nên các ca `counted: false` dưới đây
  // dựng két IG đã nối (`LINKED`). Két link rỗng: xem khối "luật 6" cuối tệp.
  it("két ghim vault KHÁC ⟹ 200, counted false, reason not_pinned_to_this_vault, kèm ghim thấy được", async () => {
    const other = "de".repeat(32);
    const h = harness({ vault: LINKED, wakeme: wakemeUtxo({ pin: new Constr(0, [new Constr(0, [VAULT_SCRIPT_HASH, other])]) }) });
    const r = await handle(post({ owner_pkh: OWNER_PKH, wakeme_vault_ref: WAKEME_REF }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(summaryOf(r).wakeme).toEqual({
      ref: WAKEME_REF, lent_lamp: "0", counted: false, reason: "not_pinned_to_this_vault",
      seen_pin: { hash: VAULT_SCRIPT_HASH, name: other },
    });
  });

  it("két KHÔNG ghim (None) ⟹ 200, counted false, seen_pin = null", async () => {
    const h = harness({ vault: LINKED, wakeme: wakemeUtxo({ pin: new Constr(1, []) }) });
    const r = await handle(post({ owner_pkh: OWNER_PKH, wakeme_vault_ref: WAKEME_REF }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(summaryOf(r).wakeme).toMatchObject({ counted: false, reason: "not_pinned_to_this_vault", seen_pin: null });
  });

  describe("CẶP ca chỉ khác gen_pin_period", () => {
    it("gen_pin_period < epoch ⟹ counted true, lent = conditional + owned", async () => {
      const h = harness({ wakeme: wakemeUtxo({ pinPeriod: EPOCH - 1n }) });
      const r = await handle(post({ owner_pkh: OWNER_PKH, wakeme_vault_ref: WAKEME_REF }), h.router);
      expect(r.status).toBe(200);
      expect(summaryOf(r).wakeme).toEqual({ ref: WAKEME_REF, lent_lamp: (CONDITIONAL + OWNED).toString(), counted: true });
      expect(h.builder.lastCall!.wakeme?.scriptHash).toBe(WAKEME_HASH);
      expect(h.builder.lastCall!.wakeme?.utxo.txHash).toBe(WAKEME_TX);
    });

    it("gen_pin_period == epoch ⟹ counted false, lent 0, reason — vẫn 200 (validator cho qua)", async () => {
      const h = harness({ vault: LINKED, wakeme: wakemeUtxo({ pinPeriod: EPOCH }) });
      const r = await handle(post({ owner_pkh: OWNER_PKH, wakeme_vault_ref: WAKEME_REF }), h.router);
      expect(r.status).toBe(200);
      expect(summaryOf(r).wakeme).toEqual({
        ref: WAKEME_REF, lent_lamp: "0", counted: false, reason: "pinned_in_current_period",
      });
    });
  });

  it("value thiếu LAMP so với datum ⟹ counted false, reason lamp_short_of_datum", async () => {
    const h = harness({ vault: LINKED, wakeme: wakemeUtxo({ lampHeld: CONDITIONAL + OWNED - 1n }) });
    const r = await handle(post({ owner_pkh: OWNER_PKH, wakeme_vault_ref: WAKEME_REF }), h.router);
    expect(r.status).toBe(200);
    expect(summaryOf(r).wakeme).toEqual({ ref: WAKEME_REF, lent_lamp: "0", counted: false, reason: "lamp_short_of_datum" });
  });

  describe("đọc lại CBOR: két ở reference_inputs, KHÔNG ở inputs", () => {
    it("fixture đúng thật sự đặt két ở reference_inputs và không ở inputs", () => {
      const cbor = instantTxCbor("reference");
      const same = (x: { txHash: string; outputIndex: number }) => x.txHash === WAKEME_TX && x.outputIndex === 1;
      expect(referenceInputRefsOf(cbor).some(same)).toBe(true);
      expect(inputRefsOf(cbor).some(same)).toBe(false);
    });

    it("két ở CẢ inputs lẫn reference_inputs ⟹ 422 WAKEME_VAULT_TX_MISMATCH (vế 'không ở inputs')", async () => {
      const h = harness({ wakeme: wakemeUtxo(), where: "both" });
      const r = await handle(post({ owner_pkh: OWNER_PKH, wakeme_vault_ref: WAKEME_REF }), h.router);
      expect(r.status).toBe(422);
      expect(codeOf(r)).toBe("WAKEME_VAULT_TX_MISMATCH");
      expect((r.body as { error: { message: string } }).error.message).toContain("TIÊU");
    });

    it("bộ dựng TIÊU két (nằm trong inputs) ⟹ 422 WAKEME_VAULT_TX_MISMATCH", async () => {
      const h = harness({ wakeme: wakemeUtxo(), where: "input" });
      const r = await handle(post({ owner_pkh: OWNER_PKH, wakeme_vault_ref: WAKEME_REF }), h.router);
      expect(r.status).toBe(422);
      expect(codeOf(r)).toBe("WAKEME_VAULT_TX_MISMATCH");
    });

    it("bộ dựng bỏ quên két (không có trong reference_inputs) ⟹ 422 WAKEME_VAULT_TX_MISMATCH", async () => {
      const h = harness({ wakeme: wakemeUtxo(), where: "absent" });
      const r = await handle(post({ owner_pkh: OWNER_PKH, wakeme_vault_ref: WAKEME_REF }), h.router);
      expect(r.status).toBe(422);
      expect(codeOf(r)).toBe("WAKEME_VAULT_TX_MISMATCH");
    });
  });
});

// ── Đường người mới (2026-10-02): tự định vị két Wakeme theo NFT `(wakeme_vault_hash, wakeme_link)` ──

describe("POST /tx/instant-gen — vắng wakeme_vault_ref, két IG ĐÃ nối link ⟹ dịch vụ tự định vị", () => {
  const linked: VaultSpec = { link: OWNER_COMMIT };

  it("1 két đã ghim vault này ⟹ 200, đưa đúng két vào bộ dựng, summary.wakeme.source = located, counted true", async () => {
    const h = harness({ vault: linked, wakeme: wakemeUtxo() });
    const r = await handle(post({ owner_pkh: OWNER_PKH }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(summaryOf(r).wakeme).toEqual({
      ref: WAKEME_REF, lent_lamp: (CONDITIONAL + OWNED).toString(), counted: true, source: "located",
    });
    expect(h.builder.lastCall!.wakeme?.utxo.txHash).toBe(WAKEME_TX);
  });

  it("CẶP: 1 két CHƯA ghim vault này ⟹ 200, counted false, reason not_pinned_to_this_vault, vẫn đưa két vào", async () => {
    const h = harness({ vault: linked, wakeme: wakemeUtxo({ pin: new Constr(1, []) }) });
    const r = await handle(post({ owner_pkh: OWNER_PKH }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(summaryOf(r).wakeme).toEqual({
      ref: WAKEME_REF, lent_lamp: "0", counted: false, reason: "not_pinned_to_this_vault", seen_pin: null, source: "located",
    });
    expect(h.builder.lastCall!.wakeme?.utxo.txHash).toBe(WAKEME_TX);
  });

  it("2 két mang cùng NFT ⟹ 409 WAKEME_VAULT_AMBIGUOUS kèm candidates, bộ dựng KHÔNG bị gọi", async () => {
    const h = harness({ vault: linked, wakemes: [wakemeUtxo(), wakemeUtxo({ outputIndex: 2 })] });
    const r = await handle(post({ owner_pkh: OWNER_PKH }), h.router);
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("WAKEME_VAULT_AMBIGUOUS");
    expect(detailsOf(r)).toEqual({ wakeme_link: OWNER_COMMIT, candidates: [`${WAKEME_TX}#1`, `${WAKEME_TX}#2`] });
    expect(h.builder.lastCall).toBeNull();
  });

  it("NFT nằm ở địa chỉ KHÔNG phải script két Wakeme ⟹ không tính là két (validator lọc theo credential)", async () => {
    const h = harness({ vault: linked, wakemes: [wakemeUtxo({ address: VAULT_ADDRESS })] });
    const r = await handle(post({ owner_pkh: OWNER_PKH }), h.router);
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe("WAKEME_VAULT_REF_REQUIRED");
  });

  it("0 két + lượt làm mới checkpoint ⟹ 400 WAKEME_VAULT_REF_REQUIRED, located_count 0 (validator sẽ đòi két)", async () => {
    const h = harness({ vault: linked });
    const r = await handle(post({ owner_pkh: OWNER_PKH }), h.router);
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe("WAKEME_VAULT_REF_REQUIRED");
    expect(detailsOf(r)).toEqual({ wakeme_link: OWNER_COMMIT, located_count: 0 });
    expect(h.builder.lastCall).toBeNull();
  });

  it("CẶP: 0 két + CÙNG epoch (không làm mới) ⟹ 200, summary.wakeme.reason = wakeme_vault_not_found", async () => {
    const h = harness({ vault: { ...linked, sameEpoch: true }, where: "absent" });
    const r = await handle(post({ owner_pkh: OWNER_PKH }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(summaryOf(r).wakeme).toEqual({ lent_lamp: "0", counted: false, reason: "wakeme_vault_not_found" });
    expect(h.builder.lastCall!.wakeme).toBeUndefined();
  });

  it("app GỬI ref ⟹ dùng đúng ref đó, không tra theo NFT (không có `source`)", async () => {
    const h = harness({ vault: linked, wakemes: [wakemeUtxo(), wakemeUtxo({ outputIndex: 2 })] });
    const r = await handle(post({ owner_pkh: OWNER_PKH, wakeme_vault_ref: WAKEME_REF }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(summaryOf(r).wakeme).toEqual({ ref: WAKEME_REF, lent_lamp: (CONDITIONAL + OWNED).toString(), counted: true });
  });
});

// ── Luật 6 siết 2026-10-03 (`checkpoint.ak ▸ resolve_link`): link rỗng KHÔNG còn là ngoại lệ ──
// Két IG link rỗng + két Wakeme `L_lent = 0` ⟹ validator FAIL ⟹ dịch vụ ném 422 có mã TRƯỚC khi
// dựng, câu lỗi chỉ đường RefreshCheckpoint. Mỗi ca âm có cặp chỉ khác đúng một vế.

describe("POST /tx/instant-gen — luật 6: két link rỗng không nối được ở lượt sinh", () => {
  it("link rỗng + két KHÔNG ghim (None) ⟹ 422 WAKEME_LINK_CHANGE_REJECTED, chỉ đường refresh-checkpoint, bộ dựng KHÔNG gọi", async () => {
    const h = harness({ wakeme: wakemeUtxo({ pin: new Constr(1, []) }) });
    const r = await handle(post({ owner_pkh: OWNER_PKH, wakeme_vault_ref: WAKEME_REF }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(codeOf(r)).toBe("WAKEME_LINK_CHANGE_REJECTED");
    expect((r.body as { error: { message: string } }).error.message).toMatch(/RefreshCheckpoint[\s\S]*\/tx\/refresh-checkpoint/);
    expect(detailsOf(r)).toMatchObject({
      wakeme_link: "", owner_commit: OWNER_COMMIT, lent_lamp: "0", checkpoint_refresh: true,
      next_route: "/tx/refresh-checkpoint",
    });
    expect(h.builder.lastCall).toBeNull();
  });

  it("CẶP: cùng két Wakeme, két IG ĐÃ nối link tới nó ⟹ 200 (vế b: owner_commit == link)", async () => {
    const h = harness({ vault: LINKED, wakeme: wakemeUtxo({ pin: new Constr(1, []) }) });
    const r = await handle(post({ owner_pkh: OWNER_PKH, wakeme_vault_ref: WAKEME_REF }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it("CẶP: link rỗng + két ĐANG ghim két này (L_lent > 0), lượt làm mới ⟹ 200 (vế c)", async () => {
    const h = harness({ wakeme: wakemeUtxo() });
    const r = await handle(post({ owner_pkh: OWNER_PKH, wakeme_vault_ref: WAKEME_REF }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(summaryOf(r).wakeme).toMatchObject({ counted: true });
    expect(h.builder.lastCall!.wakeme?.utxo.txHash).toBe(WAKEME_TX);
  });

  it("link rỗng + két ghim két này nhưng CÙNG epoch (không làm mới) ⟹ 422, checkpoint_refresh false", async () => {
    const h = harness({ vault: { sameEpoch: true }, wakeme: wakemeUtxo() });
    const r = await handle(post({ owner_pkh: OWNER_PKH, wakeme_vault_ref: WAKEME_REF }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(codeOf(r)).toBe("WAKEME_LINK_CHANGE_REJECTED");
    expect(detailsOf(r)).toMatchObject({ wakeme_link: "", checkpoint_refresh: false });
    expect(h.builder.lastCall).toBeNull();
  });

  it("link X + két Wakeme Y (KHÔNG ghim két này) ⟹ 422 (đổi link ở lượt sinh)", async () => {
    const h = harness({ vault: { link: "d0".repeat(32) }, wakeme: wakemeUtxo({ pin: new Constr(1, []) }) });
    const r = await handle(post({ owner_pkh: OWNER_PKH, wakeme_vault_ref: WAKEME_REF }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(codeOf(r)).toBe("WAKEME_LINK_CHANGE_REJECTED");
    expect(detailsOf(r)).toMatchObject({ wakeme_link: "d0".repeat(32), owner_commit: OWNER_COMMIT });
    expect(h.builder.lastCall).toBeNull();
  });
});

describe("GET /health — lamp", () => {
  it("khai policy + tên LAMP của bản deploy (máy đọc), giữ nguyên deployment_source", async () => {
    const h = harness();
    const r = await handle({ method: "GET", url: "/health", headers: {}, body: undefined }, h.router);
    expect(r.status).toBe(200);
    const b = r.body as Record<string, unknown>;
    expect(b.lamp).toEqual({ policy_id: LAMP_POLICY_ID, asset_name_hex: LAMP_ASSET_NAME_HEX });
    expect(b.deployment_source).toBe("bản dựng thử của phép kiểm — không phải một lần deploy thật");
  });
});

// ── /tx/quote route instant-gen: không gửi `m` ⟹ báo giá tại m = max_m ──────────────

/** Bộ dựng của báo giá: CBOR đi theo UTxO trả phí báo giá tự chọn (tổng hợp) — nếu không, cổng
 *  đọc lại `checkFeePayerTx` đỏ ở vế "UTxO trả phí không phải input". Ghi lại `m` đã nhận. */
class QuoteBuilder extends RecordedTxBuilder {
  ms: bigint[] = [];
  constructor() {
    super({});
    this.coinsPerUtxoByteValue = PROTOCOL_PARAMETERS_DEFAULT.coinsPerUtxoByte;
  }
  override async instantGen(ctx: BuildContext, p: InstantGenBuildParams): Promise<BuiltTx> {
    this.ms.push(p.m);
    const fp = ctx.feePayerUtxo;
    if (fp === undefined || ctx.collateralLovelace === undefined) throw new Error("[QuoteBuilder] chỉ dựng đường có ví trả phí.");
    const fee = 180_000n;
    const u = fp.assets.lovelace!;
    return {
      txCbor: buildTxCbor({
        inputs: [{ txHash: INPUT_TX_HASH, outputIndex: 0 }, { txHash: fp.txHash, outputIndex: fp.outputIndex }],
        feeLovelace: fee,
        outputs: [
          {
            address: VAULT_ADDRESS,
            assets: { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
            inlineDatumHex: datumHex({
              lampLockedOildrop: 0n,
              batches: [{ id: "c0".repeat(16), createdEpoch: EPOCH, amountNanogic: 4_000_000n }],
              instantUnlockMs: 1_789_000_000_000n,
              lastUpdatedEpoch: EPOCH, capEpoch: EPOCH, capNanogic: 1_000_000_000n, usageWindowEpoch: EPOCH,
            }),
          },
          { address: fp.address, assets: { lovelace: u - fee } },
        ],
        requiredSigners: [OWNER_PKH],
        collateralInputs: [{ txHash: fp.txHash, outputIndex: fp.outputIndex }],
        collateralReturn: { address: fp.address, assets: { lovelace: u - ctx.collateralLovelace } },
        ttlSlot: BigInt(unixTimeToSlot("Preprod", NOW + 600_000)),
      }),
    };
  }
}

describe("POST /tx/quote — instant-gen không gửi m", () => {
  const quote = (params: Record<string, unknown>) =>
    ({ method: "POST", url: "/tx/quote", headers: {}, body: { route: "instant-gen", params } });
  type QuoteSummary = { m_nanogic: string; m_source: string; gen_limits: { max_m_nanogic: string } };

  it("vắng m ⟹ 200, bộ dựng nhận m = max_m; summary.m_source = max_m, gen_limits.max_m_nanogic = m đã dựng", async () => {
    const b = new QuoteBuilder();
    const h = harness({ builder: b });
    const r = await handle(quote({ owner_pkh: OWNER_PKH }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const s = (r.body as { summary: QuoteSummary }).summary;
    expect(s.m_source).toBe("max_m");
    expect(b.ms.length).toBeGreaterThan(0);
    expect(b.ms.every(m => m === b.ms[0])).toBe(true);
    expect(s.gen_limits.max_m_nanogic).toBe(b.ms[0]!.toString());
    expect(b.ms[0]! > 0n).toBe(true);
    // `m_nanogic` đọc lại TỪ CBOR (lượng đúc trong datum đầu ra), không chép tham số.
    expect(s.m_nanogic).toBe("4000000");
  });

  it("CẶP: m = \"0\" ⟹ như vắng (max_m); m = \"5\" ⟹ m_source = request, bộ dựng nhận đúng 5", async () => {
    const b0 = new QuoteBuilder();
    const r0 = await handle(quote({ owner_pkh: OWNER_PKH, m: "0" }), harness({ builder: b0 }).router);
    expect(r0.status, JSON.stringify(r0.body)).toBe(200);
    expect((r0.body as { summary: QuoteSummary }).summary.m_source).toBe("max_m");
    const b5 = new QuoteBuilder();
    const r5 = await handle(quote({ owner_pkh: OWNER_PKH, m: "5" }), harness({ builder: b5 }).router);
    expect(r5.status, JSON.stringify(r5.body)).toBe(200);
    expect((r5.body as { summary: QuoteSummary }).summary.m_source).toBe("request");
    expect(b5.ms[0]).toBe(5n);
  });

  it("CỰC ĐỐI: đường dựng thật /tx/instant-gen vẫn đòi m (vắng / \"0\" ⟹ 400 INSTANT_GEN_M_INVALID)", async () => {
    for (const body of [{ owner_pkh: OWNER_PKH }, { owner_pkh: OWNER_PKH, m: "0" }]) {
      const h = harness();
      const r = await handle({ method: "POST", url: "/tx/instant-gen", headers: {}, body }, h.router);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(codeOf(r)).toBe("INSTANT_GEN_M_INVALID");
      expect(h.builder.lastCall).toBeNull();
    }
  });
});

describe("mForBuild — trần max_m", () => {
  const limits = (maxM: bigint) => ({ maxM, genSoFar: 0n, capNanogic: 0n, capLamp: 0n, gbAvailable: 0n, lent: 0n }) as unknown as InstantGenLimits;
  it("vắng m + max_m > 0 ⟹ m = max_m", () => {
    expect(mForBuild(undefined, limits(7n))).toBe(7n);
  });
  it("CẶP: vắng m + max_m = 0 ⟹ 422 INSTANT_GEN_MAX_M_ZERO (không báo giá trên m bịa)", () => {
    expect(() => mForBuild(undefined, limits(0n))).toThrow(expect.objectContaining({ code: "INSTANT_GEN_MAX_M_ZERO", httpStatus: 422 }));
  });
  it("gửi m > max_m ⟹ 422 INSTANT_GEN_M_ABOVE_MAX; m = max_m ⟹ nhận", () => {
    expect(() => mForBuild(8n, limits(7n))).toThrow(expect.objectContaining({ code: "INSTANT_GEN_M_ABOVE_MAX" }));
    expect(mForBuild(7n, limits(7n))).toBe(7n);
  });
});

// ── /tx/create-vault: két instant 0 LAMP + did_commit, chặn két thứ hai ─────────────

const NEW_OWNER = { type: "key" as const, hash: OTHER_OWNER_PKH };
const NEW_CHANGE = credentialToAddress("Preprod", { type: "Key", hash: OTHER_OWNER_PKH });
const DID = "d1".repeat(32);

/** Tx tạo két instant: đúc NFT, output két mang NFT (+ LAMP nếu `lamp > 0`) + datum genesis. */
function createInstantCbor(o: { lamp?: bigint; link?: string; owner?: typeof NEW_OWNER } = {}): string {
  const lamp = o.lamp ?? 0n;
  return buildTxCbor({ ttlSlot: FIXTURE_TTL_SLOT,
    inputs: [{ txHash: INPUT_TX_HASH, outputIndex: 1 }],
    feeLovelace: 190_000n,
    mint: { [VAULT_ID_UNIT]: 1n },
    requiredSigners: [(o.owner ?? NEW_OWNER).hash],
    outputs: [
      {
        address: VAULT_ADDRESS,
        assets: { lovelace: 6_000_000n, ...(lamp === 0n ? {} : { [LAMP_UNIT]: lamp }), [VAULT_ID_UNIT]: 1n },
        inlineDatumHex: datumHex({
          owner: o.owner ?? NEW_OWNER, lampBalanceOildrop: lamp, lampLockedOildrop: 0n, instantUnlockMs: 0n,
          ...(o.link === undefined ? {} : { wakemeLink: o.link }),
        }),
      },
      { address: NEW_CHANGE, assets: { lovelace: 9_000_000n } },
    ],
  });
}

function createHarness(o: { cbor?: string; vault?: VaultSpec } = {}) {
  const builder = new RecordedTxBuilder({ create_vault: o.cbor ?? createInstantCbor({ link: DID }) }, VAULT_ID_UNIT);
  return harness({ builder, ...(o.vault === undefined ? {} : { vault: o.vault }) });
}
const createPost = (over: Record<string, unknown> = {}) => ({
  method: "POST", url: "/tx/create-vault", headers: {},
  body: { kind: "instant", owner: NEW_OWNER, lamp_amount: "0", change_address: NEW_CHANGE, did_commit: DID, ...over },
});

describe("POST /tx/create-vault — két instant của người mới", () => {
  it("0 LAMP + did_commit ⟹ 200; bộ dựng nhận lampAmount 0 + wakemeLink; summary.vault.wakeme_link đọc từ CBOR", async () => {
    const h = createHarness();
    const r = await handle(createPost(), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const v = (r.body as { summary: { vault: Record<string, unknown> } }).summary.vault;
    expect(v.lamp_deposit_oildrop).toBe("0");
    expect(v.wakeme_link).toBe(DID);
    expect(h.builder.lastCall).toMatchObject({ route: "create_vault", params: { lampAmount: 0n, wakemeLink: DID } });
  });

  it("CỰC ĐỐI: bộ dựng trả datum với wakeme_link KHÁC did_commit ⟹ 422 TX_SUMMARY_UNDECODABLE, không phát tx", async () => {
    const h = createHarness({ cbor: createInstantCbor({ link: "e2".repeat(32) }) });
    const r = await handle(createPost(), h.router);
    expect(r.status).toBe(422);
    expect(codeOf(r)).toBe("TX_SUMMARY_UNDECODABLE");
  });

  it("CỰC ĐỐI: lamp_amount \"0\" cho két schedule ⟹ 400 LAMP_AMOUNT_INVALID; \"-1\" cho instant ⟹ 400", async () => {
    const h = createHarness();
    const r = await handle(createPost({ kind: "schedule", did_commit: undefined }), h.router);
    expect(r.status).toBe(400);
    const r2 = await handle(createPost({ lamp_amount: "-1" }), h.router);
    expect(r2.status).toBe(400);
    expect(h.builder.lastCall).toBeNull();
  });

  it("did_commit cho két schedule ⟹ 400 DID_COMMIT_UNEXPECTED; did_commit sai khuôn ⟹ 400 DID_COMMIT_INVALID", async () => {
    const h = createHarness();
    const r = await handle(createPost({ kind: "schedule", lamp_amount: "1000000" }), h.router);
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe("DID_COMMIT_UNEXPECTED");
    const r2 = await handle(createPost({ did_commit: "D1".repeat(32) }), h.router);
    expect(r2.status).toBe(400);
    expect(codeOf(r2)).toBe("DID_COMMIT_INVALID");
    expect(h.builder.lastCall).toBeNull();
  });

  it("chủ ĐÃ có két instant ⟹ 409 VAULT_ALREADY_EXISTS (matched_by owner), bộ dựng KHÔNG bị gọi", async () => {
    const h = createHarness({ cbor: createInstantCbor({ owner: { type: "key", hash: OWNER_PKH } }) });
    const r = await handle(createPost({ owner: { type: "key", hash: OWNER_PKH }, did_commit: undefined }), h.router);
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("VAULT_ALREADY_EXISTS");
    expect(detailsOf(r)).toEqual({
      vault_type: "Instant",
      existing: [{ vault_ref: `${INPUT_TX_HASH}#0`, vault_nft: VAULT_ID_UNIT, matched_by: "owner" }],
    });
    expect(h.builder.lastCall).toBeNull();
  });

  it("chủ KHÁC nhưng két đang có đã nối CÙNG did_commit ⟹ 409 VAULT_ALREADY_EXISTS (matched_by did_commit)", async () => {
    const h = createHarness({ vault: { link: DID } });
    const r = await handle(createPost(), h.router);
    expect(r.status).toBe(409);
    expect(detailsOf(r)).toEqual({
      vault_type: "Instant",
      existing: [{ vault_ref: `${INPUT_TX_HASH}#0`, vault_nft: VAULT_ID_UNIT, matched_by: "did_commit" }],
    });
  });
});
