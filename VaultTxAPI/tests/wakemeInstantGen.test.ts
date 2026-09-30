// VaultTxAPI/tests/wakemeInstantGen.test.ts — `wakeme_vault_ref` của `POST /tx/instant-gen`.
//
// Ca đáng giá nhất là CẶP chỉ khác `gen_pin_period`: `< epoch` ⟹ `counted: true`, `lent_lamp`
// = conditional + owned; `>= epoch` ⟹ `counted: false`, `lent_lamp: "0"`. Validator CHO QUA cả
// hai — nên chỉ phản hồi phân biệt được chúng, và một hiện thực trả `counted: true` cho mọi két
// ghim đúng thì đỏ ở vế thứ hai.

import { Constr, Data, credentialToAddress, type UTxO } from "@lucid-evolution/lucid";
import { posixMsToEpoch, wakemeVaultHash } from "@magiclamp/protocol-utils";
import { describe, expect, it } from "vitest";

import { RecordedChainReader, type ChainTip, type OutRef } from "../src/chain.js";
import { parseDeployment } from "../src/config.js";
import { CodedApiError } from "../src/errors.js";
import { handle, type RouterDeps } from "../src/http.js";
import { IssuedTxRegistry, OwnerLockTable } from "../src/locks.js";
import { VaultTxService } from "../src/service.js";
import { RecordedTxBuilder } from "../src/txBuilder.js";
import { referenceInputRefsOf } from "../src/wakeme.js";
import { inputRefsOf } from "../src/feePayer.js";
import {
  INPUT_TX_HASH, LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID, LAMP_UNIT, OWNER_PKH,
  SHARD_ADDRESS, VAULT_ADDRESS, VAULT_ID_UNIT, VAULT_SCRIPT_HASH, datumHex,
} from "./fixtures/preview.js";
import { buildTxCbor } from "./fixtures/tx.js";

type Net = "Preprod" | "Preview";

const TTL = 180_000;
const NOW = 1_789_100_703_000;
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

function deploymentJson(): string {
  return JSON.stringify({
    source: "bản dựng thử của phép kiểm — không phải một lần deploy thật",
    lamp: { policy_id: LAMP_POLICY_ID, asset_name_hex: LAMP_ASSET_NAME_HEX },
    vaults: [{ vault_type: "Instant", address: VAULT_ADDRESS }],
    shard_address: SHARD_ADDRESS,
    ref_script_utxos: {
      vault: `${"11".repeat(32)}#0`, shard: `${"22".repeat(32)}#1`, consume: `${"33".repeat(32)}#2`,
    },
    consume: {
      engage_address: VAULT_ADDRESS,
      price_beacon_address: VAULT_ADDRESS,
      price_beacon_nft_unit: `${"55".repeat(28)}cafe`,
    },
    instant: {
      um_datum_address: VAULT_ADDRESS,
      um_nft_unit: `${"66".repeat(28)}554d`,
      backing_beacon_address: VAULT_ADDRESS,
      backing_beacon_nft_unit: `${"77".repeat(28)}6242`,
    },
  });
}

function vaultUtxo(): UTxO {
  return {
    txHash: INPUT_TX_HASH, outputIndex: 0, address: VAULT_ADDRESS,
    assets: { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
    datum: datumHex({ lampLockedOildrop: 0n, batches: [], instantUnlockMs: 0n }),
  };
}

/** `both`: két ở CẢ inputs lẫn reference_inputs — ca duy nhất tách được vế "không ở inputs"
 *  khỏi vế "có ở reference_inputs"; thiếu nó thì gỡ vế thứ nhất mà bộ kiểm vẫn xanh. */
type Where = "reference" | "input" | "both" | "absent";

/** CBOR ghi sẵn: két ở `reference_inputs` (đúng), ở `inputs` (bị tiêu — sai), hoặc vắng. */
function instantTxCbor(where: Where): string {
  const wk = { txHash: WAKEME_TX, outputIndex: 1 };
  return buildTxCbor({
    inputs: where === "input" || where === "both"
      ? [{ txHash: INPUT_TX_HASH, outputIndex: 0 }, wk] : [{ txHash: INPUT_TX_HASH, outputIndex: 0 }],
    ...(where === "reference" || where === "both" ? { referenceInputs: [wk] } : {}),
    feeLovelace: 178_000n,
    outputs: [{
      address: VAULT_ADDRESS,
      assets: { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
      inlineDatumHex: datumHex({
        lampLockedOildrop: 0n,
        batches: [{ id: "c0".repeat(16), createdEpoch: 20_700n, amountNanogic: 4_000_000n }],
        instantUnlockMs: 1_789_000_000_000n,
      }),
    }],
  });
}

interface WakemeSpec {
  address?: string;
  pin?: Data;
  pinPeriod?: bigint;
  lampHeld?: bigint;
}

function wakemeUtxo(s: WakemeSpec = {}): UTxO {
  const pin = s.pin ?? new Constr(0, [new Constr(0, [VAULT_SCRIPT_HASH, VAULT_NAME])]);
  const datum = Data.to(new Constr(0, [
    OWNER_COMMIT, 0n, 0n, CONDITIONAL, 0n, 0n, 0n, OWNED, 0n, 0n, 0n, pin, s.pinPeriod ?? EPOCH - 1n,
  ]));
  return {
    txHash: WAKEME_TX, outputIndex: 1, address: s.address ?? WAKEME_ADDRESS,
    assets: { lovelace: 2_000_000n, [WAKEME_HASH + OWNER_COMMIT]: 1n, [LAMP_UNIT]: s.lampHeld ?? CONDITIONAL + OWNED },
    datum,
  };
}

/** Bộ đọc chuỗi đếm lượt `utxosByOutRef`; `missing` ⟹ ném như bộ đọc HTTP thật (400 UTXO_NOT_FOUND). */
class CountingChain extends RecordedChainReader {
  byRefCalls = 0;
  constructor(refUtxos: UTxO[], private readonly missing = false) {
    super({ [VAULT_ADDRESS]: [vaultUtxo()] }, TIP, refUtxos);
  }
  override async utxosByOutRef(refs: OutRef[]): Promise<UTxO[]> {
    this.byRefCalls++;
    if (this.missing) {
      throw new CodedApiError(400, "UTXO_NOT_FOUND", "không có", { out_ref: `${refs[0]!.txHash}#${refs[0]!.outputIndex}` });
    }
    return super.utxosByOutRef(refs);
  }
}

function harness(opts: { net?: Net; wakeme?: UTxO; missing?: boolean; where?: Where } = {}) {
  const net = opts.net ?? "Preprod";
  const deployment = parseDeployment(deploymentJson(), net);
  const chain = new CountingChain(opts.wakeme === undefined ? [] : [opts.wakeme], opts.missing);
  const builder = new RecordedTxBuilder({ instant_gen: instantTxCbor(opts.where ?? "reference") });
  const service = new VaultTxService({
    network: net, deployment, chain, builder,
    locks: new OwnerLockTable(TTL), issued: new IssuedTxRegistry(TTL * 4),
    lockTtlMs: TTL, now: () => NOW,
  });
  const router: RouterDeps = {
    service, deploymentSource: deployment.source, vaultScopes: deployment.vaults, network: net,
    chainLabel: "recorded", changeAddressStrategy: "enterprise_from_owner_pkh", token: "", logInternal: () => {},
  };
  return { chain, builder, router };
}

const post = (body: unknown) => ({ method: "POST", url: "/tx/instant-gen", headers: {}, body });
const codeOf = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;
const detailsOf = (r: { body: unknown }) => (r.body as { error: { details: Record<string, unknown> } }).error.details;
const summaryOf = (r: { body: unknown }) => (r.body as { summary: Record<string, unknown> }).summary;

describe("POST /tx/instant-gen — wakeme_vault_ref", () => {
  it("vắng trường ⟹ y như cũ: không đọc két, không đưa két vào bộ dựng, summary không có `wakeme`", async () => {
    const h = harness({ where: "absent" });
    const r = await handle(post({ owner_pkh: OWNER_PKH }), h.router);
    expect(r.status).toBe(200);
    expect(summaryOf(r).wakeme).toBeUndefined();
    expect(h.chain.byRefCalls).toBe(0);
    expect(h.builder.lastCall).toEqual({ route: "instant_gen", params: {} });
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

  it("két ghim vault KHÁC ⟹ 409 WAKEME_VAULT_PIN_MISMATCH, kèm ghim thấy được", async () => {
    const other = "de".repeat(32);
    const h = harness({ wakeme: wakemeUtxo({ pin: new Constr(0, [new Constr(0, [VAULT_SCRIPT_HASH, other])]) }) });
    const r = await handle(post({ owner_pkh: OWNER_PKH, wakeme_vault_ref: WAKEME_REF }), h.router);
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("WAKEME_VAULT_PIN_MISMATCH");
    expect(detailsOf(r).seen_pin).toEqual({ hash: VAULT_SCRIPT_HASH, name: other });
    expect(detailsOf(r).expected_pin).toEqual({ hash: VAULT_SCRIPT_HASH, name: VAULT_NAME });
  });

  it("két KHÔNG ghim (None) ⟹ 409 WAKEME_VAULT_PIN_MISMATCH, seen_pin = null", async () => {
    const h = harness({ wakeme: wakemeUtxo({ pin: new Constr(1, []) }) });
    const r = await handle(post({ owner_pkh: OWNER_PKH, wakeme_vault_ref: WAKEME_REF }), h.router);
    expect(r.status).toBe(409);
    expect(detailsOf(r).seen_pin).toBeNull();
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
      const h = harness({ wakeme: wakemeUtxo({ pinPeriod: EPOCH }) });
      const r = await handle(post({ owner_pkh: OWNER_PKH, wakeme_vault_ref: WAKEME_REF }), h.router);
      expect(r.status).toBe(200);
      expect(summaryOf(r).wakeme).toEqual({
        ref: WAKEME_REF, lent_lamp: "0", counted: false, reason: "pinned_in_current_period",
      });
    });
  });

  it("value thiếu LAMP so với datum ⟹ counted false, reason lamp_short_of_datum", async () => {
    const h = harness({ wakeme: wakemeUtxo({ lampHeld: CONDITIONAL + OWNED - 1n }) });
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
