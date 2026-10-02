// VaultTxAPI/tests/prepaidDeployment.test.ts — khuôn cấu hình két Prepaid (`config.ts` ▸
// `PREPAID_VAULT_TYPE`) và cổng route chặn két đó (`service.ts` ▸ `assertScopesSupported`).
//
// Mỗi ca dương đi kèm ca âm khác ĐÚNG MỘT khoá. Ca cực đối quan trọng nhất là "Instant thiếu
// shard VẪN ném": việc mở khuôn Prepaid không được nới shard cho hai loại két kia.

import { describe, expect, it } from "vitest";
import { credentialToAddress, scriptHashToCredential, type UTxO } from "@lucid-evolution/lucid";

import { RecordedChainReader, type ChainTip } from "../src/chain.js";
import { parseDeployment, PREPAID_VAULT_TYPE } from "../src/config.js";
import { ConfigMissingError, TxApiError } from "../src/errors.js";
import { IssuedTxRegistry, OwnerLockTable } from "../src/locks.js";
import { VaultTxService } from "../src/service.js";
import { RecordedTxBuilder, requireShard } from "../src/txBuilder.js";
import { LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID, OWNER_PKH, SHARD_ADDRESS, VAULT_ADDRESS } from "./fixtures/preview.js";

const scriptAddr = (hash: string) => credentialToAddress("Preview", scriptHashToCredential(hash));
const PREPAID_VAULT_HASH = "c1".repeat(28);
const PAID_FUND_HASH = "c2".repeat(28);
const PREPAID_VAULT_ADDRESS = scriptAddr(PREPAID_VAULT_HASH);
const PAID_FUND_ADDRESS = scriptAddr(PAID_FUND_HASH);
const CONSUME = {
  engage_address: VAULT_ADDRESS,
  price_beacon_address: VAULT_ADDRESS,
  price_beacon_nft_unit: `${"55".repeat(28)}cafe`,
};
const LAMP = { policy_id: LAMP_POLICY_ID, asset_name_hex: LAMP_ASSET_NAME_HEX };

function prepaidJson(over: Record<string, unknown> = {}, refsOver: Record<string, unknown> = {}): string {
  const refs: Record<string, unknown> = {
    vault: `${"11".repeat(32)}#0`,
    paid_fund: `${"12".repeat(32)}#0`,
    consume: `${"33".repeat(32)}#2`,
    ...refsOver,
  };
  for (const [k, v] of Object.entries(refs)) if (v === undefined) delete refs[k];
  const o: Record<string, unknown> = {
    source: "Preview, khối Prepaid dựng thử của phép kiểm — không phải một lần deploy thật",
    lamp: LAMP,
    vaults: [{ vault_type: PREPAID_VAULT_TYPE, address: PREPAID_VAULT_ADDRESS }],
    paid_fund: { address: PAID_FUND_ADDRESS },
    ref_script_utxos: refs,
    consume: CONSUME,
    ...over,
  };
  for (const [k, v] of Object.entries(o)) if (v === undefined) delete o[k];
  return JSON.stringify(o);
}

function instantJson(over: Record<string, unknown> = {}, refsOver: Record<string, unknown> = {}): string {
  const refs: Record<string, unknown> = {
    vault: `${"11".repeat(32)}#0`, shard: `${"22".repeat(32)}#1`, consume: `${"33".repeat(32)}#2`, ...refsOver,
  };
  for (const [k, v] of Object.entries(refs)) if (v === undefined) delete refs[k];
  const o: Record<string, unknown> = {
    source: "Preview, khối Instant dựng thử của phép kiểm — không phải một lần deploy thật",
    lamp: LAMP,
    vaults: [{ vault_type: "Instant", address: VAULT_ADDRESS }],
    shard_address: SHARD_ADDRESS,
    ref_script_utxos: refs,
    consume: CONSUME,
    ...over,
  };
  for (const [k, v] of Object.entries(o)) if (v === undefined) delete o[k];
  return JSON.stringify(o);
}

describe("parseDeployment — khối két Prepaid", () => {
  it("hợp lệ ⟹ nạp được: quỹ + ref-script quỹ, KHÔNG shard; hash quỹ suy từ địa chỉ", () => {
    const d = parseDeployment(prepaidJson(), "Preview");
    expect(d.vaults).toEqual([{ vaultType: "Prepaid", address: PREPAID_VAULT_ADDRESS, scriptHash: PREPAID_VAULT_HASH }]);
    expect(d.prepaid).toEqual({ fundAddress: PAID_FUND_ADDRESS, fundScriptHash: PAID_FUND_HASH });
    expect(d.refScriptUtxos.paidFund).toEqual({ txHash: "12".repeat(32), outputIndex: 0 });
    expect(d.refScriptUtxos.vault).toEqual({ txHash: "11".repeat(32), outputIndex: 0 });
    expect(d.shardAddress).toBeUndefined();
    expect(d.refScriptUtxos.shard).toBeUndefined();
  });

  it("thiếu ref_script_utxos.paid_fund ⟹ ném, nêu đúng khoá", () => {
    expect(() => parseDeployment(prepaidJson({}, { paid_fund: undefined }), "Preview"))
      .toThrow(/ref_script_utxos\.paid_fund/);
  });

  it("thiếu khối paid_fund / paid_fund.address ⟹ ném", () => {
    expect(() => parseDeployment(prepaidJson({ paid_fund: undefined }), "Preview")).toThrow(/paid_fund/);
    expect(() => parseDeployment(prepaidJson({ paid_fund: {} }), "Preview")).toThrow(/paid_fund\.address/);
  });

  it("paid_fund.address không phải địa chỉ script / trùng script két ⟹ ném", () => {
    const keyAddr = credentialToAddress("Preview", { type: "Key", hash: OWNER_PKH });
    expect(() => parseDeployment(prepaidJson({ paid_fund: { address: keyAddr } }), "Preview")).toThrow(/paid_fund\.address/);
    expect(() => parseDeployment(prepaidJson({ paid_fund: { address: PREPAID_VAULT_ADDRESS } }), "Preview"))
      .toThrow(/trùng script/);
  });

  it("khối Prepaid mang shard_address hoặc ref_script_utxos.shard ⟹ ném (két Prepaid không có shard)", () => {
    expect(() => parseDeployment(prepaidJson({ shard_address: SHARD_ADDRESS }), "Preview")).toThrow(/shard_address.*KHÔNG có shard/);
    expect(() => parseDeployment(prepaidJson({}, { shard: `${"22".repeat(32)}#1` }), "Preview"))
      .toThrow(/ref_script_utxos\.shard.*KHÔNG có shard/);
  });

  it("trộn Prepaid với Instant trong một khối ⟹ ném", () => {
    expect(() => parseDeployment(prepaidJson({
      vaults: [
        { vault_type: PREPAID_VAULT_TYPE, address: PREPAID_VAULT_ADDRESS },
        { vault_type: "Instant", address: VAULT_ADDRESS },
      ],
      shard_address: undefined,
    }), "Preview")).toThrow(/trộn/);
  });
});

describe("parseDeployment — CỰC ĐỐI: Instant/Schedule vẫn BẮT BUỘC shard, không nhận khoá Prepaid", () => {
  it("Instant đủ shard ⟹ nạp được, không có `prepaid`", () => {
    const d = parseDeployment(instantJson(), "Preview");
    expect(d.shardAddress).toBe(SHARD_ADDRESS);
    expect(d.refScriptUtxos.shard).toEqual({ txHash: "22".repeat(32), outputIndex: 1 });
    expect(d.prepaid).toBeUndefined();
    expect(d.refScriptUtxos.paidFund).toBeUndefined();
  });

  it("Instant thiếu shard_address ⟹ VẪN ném", () => {
    expect(() => parseDeployment(instantJson({ shard_address: undefined }), "Preview")).toThrow(/shard_address/);
  });

  it("Instant thiếu ref_script_utxos.shard ⟹ VẪN ném", () => {
    expect(() => parseDeployment(instantJson({}, { shard: undefined }), "Preview")).toThrow(/ref_script_utxos\.shard/);
  });

  it("Schedule thiếu shard_address ⟹ VẪN ném (loại vắng mặt shard không suy ra Prepaid)", () => {
    expect(() => parseDeployment(instantJson({
      vaults: [{ vault_type: "Schedule", address: VAULT_ADDRESS }], shard_address: undefined,
    }), "Preview")).toThrow(/shard_address/);
  });

  it("khối Instant mang paid_fund / ref_script_utxos.paid_fund ⟹ ném (cấu hình lạc chỗ)", () => {
    expect(() => parseDeployment(instantJson({ paid_fund: { address: PAID_FUND_ADDRESS } }), "Preview")).toThrow(/paid_fund/);
    expect(() => parseDeployment(instantJson({}, { paid_fund: `${"12".repeat(32)}#0` }), "Preview"))
      .toThrow(/ref_script_utxos\.paid_fund/);
  });
});

describe("requireShard — nơi đọc shard không đọc `undefined` thành địa chỉ", () => {
  it("khối Prepaid ⟹ 501 CONFIG_MISSING nêu route; khối Instant ⟹ trả đúng shard", () => {
    const pre = parseDeployment(prepaidJson(), "Preview");
    let caught: unknown;
    try { requireShard(pre, "/tx/schedule-fire"); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ConfigMissingError);
    expect((caught as ConfigMissingError).details).toMatchObject({ route: "/tx/schedule-fire" });
    const ins = parseDeployment(instantJson(), "Preview");
    expect(requireShard(ins, "/tx/schedule-fire")).toEqual({
      address: SHARD_ADDRESS, ref: { txHash: "22".repeat(32), outputIndex: 1 },
    });
  });
});

describe("cổng route — khối Prepaid ⟹ 501 VAULT_KIND_UNSUPPORTED TRƯỚC khi đọc chuỗi", () => {
  const TIP: ChainTip = { blockHeight: 1, blockHash: "00".repeat(32), blockTimePosixMs: 1_789_100_703_000n };

  class CountingChain extends RecordedChainReader {
    reads = 0;
    override async utxosAt(address: string): Promise<UTxO[]> { this.reads++; return super.utxosAt(address); }
    override async tip(): Promise<ChainTip> { this.reads++; return super.tip(); }
  }

  function service(json: string) {
    const chain = new CountingChain({}, TIP);
    const builder = new RecordedTxBuilder({});
    const svc = new VaultTxService({
      network: "Preview",
      deployment: parseDeployment(json, "Preview"),
      chain,
      builder,
      locks: new OwnerLockTable(180_000),
      issued: new IssuedTxRegistry(720_000),
      lockTtlMs: 180_000,
      now: () => 1_789_100_703_000,
    });
    return { svc, chain, builder };
  }

  it("/tx/consume trên khối Prepaid ⟹ 501 VAULT_KIND_UNSUPPORTED, route nêu trong details, 0 lượt đọc chuỗi", async () => {
    const { svc, chain, builder } = service(prepaidJson());
    const p = svc.consume({ owner: { type: "key", hash: OWNER_PKH }, opType: 0, opCount: 1n });
    await expect(p).rejects.toBeInstanceOf(TxApiError);
    await p.catch((e: TxApiError) => {
      expect(e.httpStatus).toBe(501);
      expect(e.code).toBe("VAULT_KIND_UNSUPPORTED");
      expect(e.details).toMatchObject({ vault_type: "Prepaid", route: "consume" });
    });
    expect(chain.reads).toBe(0);
    expect(builder.lastCall).toBeNull();
  });

  it("CẶP: cùng yêu cầu trên khối Instant ⟹ KHÔNG phải VAULT_KIND_UNSUPPORTED (cổng không chặn nhầm)", async () => {
    const { svc, chain } = service(instantJson());
    const e = await svc.consume({ owner: { type: "key", hash: OWNER_PKH }, opType: 0, opCount: 1n })
      .then(() => null, (x: unknown) => x);
    expect((e as TxApiError | null)?.code).not.toBe("VAULT_KIND_UNSUPPORTED");
    expect(chain.reads).toBeGreaterThan(0);
  });
});
