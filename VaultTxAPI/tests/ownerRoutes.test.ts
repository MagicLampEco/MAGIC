// VaultTxAPI/tests/ownerRoutes.test.ts — chủ `Credential` trên đường HTTP, và `/tx/create-vault`.
//
// Mỗi ca dương có một ca cực đối đứng cạnh, khác ĐÚNG một điều:
//   · chủ khoá ↔ chủ script cùng 28 byte (bộ dựng nhận đúng loại nhân chứng, khoá mềm tách)
//   · datum mang đúng chủ ↔ datum mang chủ khác tag (dịch vụ đọc lại CBOR, không tin bộ dựng)
//   · có provider ↔ không provider (501, không phải 400: người vận hành thiếu, không phải app)
import { describe, expect, it } from "vitest";
import type { TxBuilder } from "@lucid-evolution/lucid";
import type { OwnerRef } from "@magiclamp/protocol-utils";

import { RecordedChainReader, type ChainTip } from "../src/chain.js";
import { parseDeployment, type Deployment } from "../src/config.js";
import { handle, type RouterDeps } from "../src/http.js";
import { IssuedTxRegistry, OwnerLockTable } from "../src/locks.js";
import type { OwnerWitnessProvider, ScriptOwnerWitness } from "../src/owner.js";
import { VaultTxService } from "../src/service.js";
import { txBodyHash } from "../src/summary.js";
import { RecordedTxBuilder, enterpriseAddressOf } from "../src/txBuilder.js";
import {
  INPUT_TX_HASH, LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID, LAMP_UNIT, OWNER_PKH,
  SHARD_ADDRESS, VAULT_ADDRESS, VAULT_ID_UNIT, datumHex,
} from "./fixtures/preview.js";
import { buildTxCbor } from "./fixtures/tx.js";

const TTL = 180_000;
const NOW = 1_789_100_703_000;
const FEE = 190_000n;
const DEPOSIT = 1_001_000_000n;
const CHANGE_ADDRESS = enterpriseAddressOf("Preview", OWNER_PKH);
const CTRL = "c1".repeat(28);
const DEV = "d1".repeat(28);
const TIP: ChainTip = { blockHeight: 1, blockHash: "14".repeat(32), blockTimePosixMs: BigInt(NOW) };

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
    price_beacon_address: VAULT_ADDRESS,
    price_beacon_nft_unit: `${"55".repeat(28)}cafe`,
  },
}), "Preview");

const KEY_OWNER: OwnerRef = { type: "key", hash: OWNER_PKH };
const SCRIPT_OWNER: OwnerRef = { type: "script", hash: OWNER_PKH };
const WITNESS_BODY = {
  did_stake_script_cbor: "4e4d01000033222220051200120011",
  anchor_ref: `${"ab".repeat(32)}#0`,
  controller_pkh: CTRL,
  device_key_hash: DEV,
};

/** Giao dịch tạo vault: đúc NFT, output vault mang NFT + LAMP + datum chủ `owner`. */
function createTxCbor(owner: OwnerRef, opts: { lamp?: bigint; mint?: boolean; signers?: string[] } = {}): string {
  const lamp = opts.lamp ?? DEPOSIT;
  return buildTxCbor({
    inputs: [{ txHash: INPUT_TX_HASH, outputIndex: 1 }],
    feeLovelace: FEE,
    mint: opts.mint === false ? undefined : { [VAULT_ID_UNIT]: 1n },
    requiredSigners: opts.signers,
    outputs: [
      {
        address: VAULT_ADDRESS,
        assets: { lovelace: 5_000_000n, [LAMP_UNIT]: lamp, [VAULT_ID_UNIT]: 1n },
        inlineDatumHex: datumHex({ owner, lampBalanceOildrop: lamp, lampLockedOildrop: 0n }),
      },
      { address: CHANGE_ADDRESS, assets: { lovelace: 9_000_000n } },
    ],
  });
}

/** Nhân chứng giả: ghi lại lần gọi, trả một `attachWithdraw` không đụng gì. */
class FakeWitness implements OwnerWitnessProvider {
  calls: { owner: OwnerRef; w: ScriptOwnerWitness }[] = [];
  async resolve(owner: OwnerRef, w: ScriptOwnerWitness) {
    this.calls.push({ owner, w });
    return {
      auth: { kind: "script" as const, hash: owner.hash, attachWithdraw: (tx: TxBuilder) => tx },
      requiredSigners: [w.controllerPkh, w.deviceKeyHash],
      notes: ["giả: rút did_stake"],
    };
  }
}

function harness(opts: { createCbor?: string; witness?: OwnerWitnessProvider | null; vaultOwner?: OwnerRef } = {}) {
  const vaultUtxo = {
    txHash: INPUT_TX_HASH, outputIndex: 0, address: VAULT_ADDRESS,
    assets: { lovelace: 5_000_000n, [LAMP_UNIT]: DEPOSIT, [VAULT_ID_UNIT]: 1n },
    datum: datumHex({ owner: opts.vaultOwner ?? KEY_OWNER }),
  };
  const chain = new RecordedChainReader({ [VAULT_ADDRESS]: [vaultUtxo] }, TIP);
  const builder = new RecordedTxBuilder(
    {
      create_vault: opts.createCbor ?? createTxCbor(KEY_OWNER, { signers: [OWNER_PKH] }),
      instant_gen: buildTxCbor({ feeLovelace: FEE, outputs: [] }),
      schedule_commit: buildTxCbor({
        inputs: [{ txHash: INPUT_TX_HASH, outputIndex: 0 }],
        feeLovelace: FEE,
        outputs: [{
          address: VAULT_ADDRESS,
          assets: { lovelace: 5_000_000n, [LAMP_UNIT]: DEPOSIT, [VAULT_ID_UNIT]: 1n },
          inlineDatumHex: datumHex({ owner: opts.vaultOwner ?? KEY_OWNER, lampLockedOildrop: 2_000_000n + 21_000_000n, genScheduleCount: 1 }),
        }],
      }),
    },
    VAULT_ID_UNIT,
  );
  const locks = new OwnerLockTable(TTL);
  const witness = opts.witness === null ? undefined : (opts.witness ?? new FakeWitness());
  const service = new VaultTxService({
    network: "Preview", deployment: DEPLOYMENT, chain, builder, locks,
    issued: new IssuedTxRegistry(TTL * 4), lockTtlMs: TTL, now: () => NOW, ownerWitness: witness,
  });
  const router: RouterDeps = {
    service, deploymentSource: DEPLOYMENT.source, vaultScopes: DEPLOYMENT.vaults, network: "Preview",
    chainLabel: "recorded", changeAddressStrategy: "enterprise_from_owner_pkh", token: "",
    logInternal: () => {},
  };
  return { service, builder, locks, router, witness };
}

const post = (url: string, body: unknown) => ({ method: "POST", url, headers: {}, body });
const createBody = (over: Record<string, unknown> = {}) => ({
  kind: "schedule", owner: KEY_OWNER, lamp_amount: DEPOSIT.toString(), change_address: CHANGE_ADDRESS, ...over,
});

describe("POST /tx/create-vault", () => {
  it("DƯƠNG chủ khoá: trả tx chưa ký + vault_nft + required_signers đọc TỪ CBOR", async () => {
    const h = harness();
    const r = await handle(post("/tx/create-vault", createBody()), h.router);
    expect(r.status).toBe(200);
    const b = r.body as Record<string, unknown> & { summary: { vault: Record<string, unknown> } };
    expect(Object.keys(b).sort()).toEqual([
      "expires_at", "owner", "required_signers", "summary", "tx_cbor", "tx_hash",
      "vault_address", "vault_nft", "witness_notes",
    ]);
    expect(b.vault_nft).toBe(VAULT_ID_UNIT);
    expect(b.vault_address).toBe(VAULT_ADDRESS);
    expect(b.owner).toEqual(KEY_OWNER);
    expect(b.required_signers).toEqual([OWNER_PKH]);
    expect(b.tx_hash).toBe(txBodyHash(b.tx_cbor as string));
    expect(b.summary.vault.owner).toEqual(KEY_OWNER);
    expect(b.summary.vault.lamp_deposit_oildrop).toBe(DEPOSIT.toString());
    expect(h.builder.lastCall).toMatchObject({ route: "create_vault", params: { lampAmount: DEPOSIT } });
    expect(h.builder.lastCall?.ownerAuthKind).toBeUndefined();
  });

  it("DƯƠNG chủ script qua provider giả: bộ dựng nhận nhân chứng script, ghi chú đi ra", async () => {
    const fake = new FakeWitness();
    const h = harness({ witness: fake, createCbor: createTxCbor(SCRIPT_OWNER, { signers: [CTRL, DEV] }) });
    const r = await handle(post("/tx/create-vault", createBody({ owner: SCRIPT_OWNER, owner_witness: WITNESS_BODY })), h.router);
    expect(r.status).toBe(200);
    const b = r.body as { owner: unknown; required_signers: string[]; witness_notes: string[] };
    expect(b.owner).toEqual(SCRIPT_OWNER);
    expect(b.required_signers).toEqual([CTRL, DEV]);
    expect(b.witness_notes[0]).toBe("giả: rút did_stake");
    expect(h.builder.lastCall?.ownerAuthKind).toBe("script");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.w.anchorRef).toEqual({ txHash: "ab".repeat(32), outputIndex: 0 });
  });

  it("CỰC ĐỐI: bộ dựng trả datum chủ KHÁC TAG (cùng 28 byte) ⟹ 422 TX_SUMMARY_UNDECODABLE, không phát tx", async () => {
    const h = harness({ createCbor: createTxCbor(SCRIPT_OWNER) });
    const r = await handle(post("/tx/create-vault", createBody()), h.router);
    expect(r.status).toBe(422);
    expect((r.body as { error: { code: string } }).error.code).toBe("TX_SUMMARY_UNDECODABLE");
  });

  it("CỰC ĐỐI: tx không đúc NFT ⟹ 422 (NFT danh-tính phải sinh trong chính tx)", async () => {
    const h = harness({ createCbor: createTxCbor(KEY_OWNER, { mint: false }) });
    const r = await handle(post("/tx/create-vault", createBody()), h.router);
    expect(r.status).toBe(422);
  });

  it("CỰC ĐỐI: tx khoá lượng LAMP khác yêu cầu ⟹ 422", async () => {
    const h = harness({ createCbor: createTxCbor(KEY_OWNER, { lamp: DEPOSIT - 1n }) });
    const r = await handle(post("/tx/create-vault", createBody()), h.router);
    expect(r.status).toBe(422);
  });

  it("ÂM owner sai hình dạng ⟹ 400 có mã, bộ dựng KHÔNG bị gọi", async () => {
    const cases: [unknown, string][] = [
      [{ type: "pool", hash: OWNER_PKH }, "OWNER_CREDENTIAL_SHAPE"],
      [{ type: "key", hash: OWNER_PKH, extra: 1 }, "OWNER_CREDENTIAL_SHAPE"],
      [{ type: "key", hash: OWNER_PKH.toUpperCase().replace(/[0-9]/g, "A") }, "OWNER_HASH_INVALID"],
      ["key:" + OWNER_PKH, "OWNER_CREDENTIAL_SHAPE"],
    ];
    for (const [owner, code] of cases) {
      const h = harness();
      const r = await handle(post("/tx/create-vault", createBody({ owner })), h.router);
      expect(r.status, JSON.stringify(owner)).toBe(400);
      expect((r.body as { error: { code: string } }).error.code, JSON.stringify(owner)).toBe(code);
      expect(h.builder.lastCall).toBeNull();
    }
  });

  it("ÂM lamp_amount: số JSON / \"0\" / \"abc\" / âm ⟹ 400, bộ dựng KHÔNG bị gọi", async () => {
    for (const lamp_amount of [1_001_000_000, "0", "abc", "-5", "1.5"]) {
      const h = harness();
      const r = await handle(post("/tx/create-vault", createBody({ lamp_amount })), h.router);
      expect(r.status, String(lamp_amount)).toBe(400);
      expect(h.builder.lastCall, String(lamp_amount)).toBeNull();
    }
  });

  it("ÂM hai trường chủ lệch (owner script, owner_pkh cùng 28 byte) ⟹ 400 OWNER_ALIAS_MISMATCH", async () => {
    const h = harness();
    const r = await handle(post("/tx/create-vault", createBody({ owner: SCRIPT_OWNER, owner_pkh: OWNER_PKH })), h.router);
    expect(r.status).toBe(400);
    expect((r.body as { error: { code: string } }).error.code).toBe("OWNER_ALIAS_MISMATCH");
    expect(h.builder.lastCall).toBeNull();
  });

  it("CẶP bí danh: chỉ owner_pkh ⟹ 200 như owner key", async () => {
    const h = harness();
    const body = createBody({ owner_pkh: OWNER_PKH });
    delete (body as Record<string, unknown>).owner;
    const r = await handle(post("/tx/create-vault", body), h.router);
    expect(r.status).toBe(200);
    expect((r.body as { owner: unknown }).owner).toEqual(KEY_OWNER);
  });

  it("ÂM chủ script khi dịch vụ KHÔNG có provider ⟹ 501; có provider nhưng thiếu owner_witness ⟹ 400", async () => {
    const none = harness({ witness: null });
    const r1 = await handle(post("/tx/create-vault", createBody({ owner: SCRIPT_OWNER, owner_witness: WITNESS_BODY })), none.router);
    expect(r1.status).toBe(501);
    expect((r1.body as { error: { code: string } }).error.code).toBe("OWNER_SCRIPT_WITNESS_UNAVAILABLE");

    const some = harness();
    const r2 = await handle(post("/tx/create-vault", createBody({ owner: SCRIPT_OWNER })), some.router);
    expect(r2.status).toBe(400);
    expect((r2.body as { error: { code: string } }).error.code).toBe("OWNER_SCRIPT_WITNESS_UNAVAILABLE");
    expect(some.builder.lastCall).toBeNull();
  });

  it("ÂM thiếu change_address / địa chỉ sai mạng ⟹ 400", async () => {
    const h = harness();
    const body = createBody();
    delete (body as Record<string, unknown>).change_address;
    expect((await handle(post("/tx/create-vault", body), h.router)).status).toBe(400);
    const mainnet = enterpriseAddressOf("Mainnet", OWNER_PKH);
    const r = await handle(post("/tx/create-vault", createBody({ change_address: mainnet })), h.router);
    expect(r.status).toBe(400);
    expect((r.body as { error: { code: string } }).error.code).toBe("CHANGE_ADDRESS_INVALID");
  });

  it("ÂM kind lạ / kind instant khi bản deploy không có vault Instant ⟹ 4xx, bộ dựng KHÔNG bị gọi", async () => {
    const h = harness();
    expect((await handle(post("/tx/create-vault", createBody({ kind: "prepaid" })), h.router)).status).toBe(400);
    const r = await handle(post("/tx/create-vault", createBody({ kind: "instant" })), h.router);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(h.builder.lastCall).toBeNull();
  });
});

describe("đường dựng có sẵn — chủ script", () => {
  it("chủ script không gửi change_address ⟹ 400 CHANGE_ADDRESS_REQUIRED; gửi ⟹ 200, nhân chứng script", async () => {
    const h = harness({ vaultOwner: SCRIPT_OWNER });
    const base = { owner: SCRIPT_OWNER, owner_witness: WITNESS_BODY, schedule_length: "3", lamp_per_epoch: "7000000" };
    const r1 = await handle(post("/tx/schedule-commit", base), h.router);
    expect(r1.status).toBe(400);
    expect((r1.body as { error: { code: string } }).error.code).toBe("CHANGE_ADDRESS_REQUIRED");

    const r2 = await handle(post("/tx/schedule-commit", { ...base, change_address: CHANGE_ADDRESS }), h.router);
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(h.builder.lastCall?.ownerAuthKind).toBe("script");
  });

  it("CỰC ĐỐI: vault chủ script, yêu cầu chủ key cùng 28 byte ⟹ không tìm thấy vault (404)", async () => {
    const h = harness({ vaultOwner: SCRIPT_OWNER });
    const r = await handle(post("/tx/schedule-commit", {
      owner: KEY_OWNER, schedule_length: "3", lamp_per_epoch: "7000000",
    }), h.router);
    expect(r.status).toBe(404);
  });

  it("chủ khoá gửi kèm owner_witness ⟹ 400 OWNER_WITNESS_UNEXPECTED", async () => {
    const h = harness();
    const r = await handle(post("/tx/schedule-commit", {
      owner: KEY_OWNER, owner_witness: WITNESS_BODY, schedule_length: "3", lamp_per_epoch: "7000000",
    }), h.router);
    expect(r.status).toBe(400);
    expect((r.body as { error: { code: string } }).error.code).toBe("OWNER_WITNESS_UNEXPECTED");
  });
});
