// VaultTxAPI/tests/didOwner.test.ts — chủ `owner: {type:"did"}`: dịch vụ tự suy `Script(did_stake)`
// + nhân chứng từ anchor trên chuỗi (`didOwner.ts`), rồi đi CÙNG đường nhân chứng với chủ script
// tường minh (`owner.ts` ▸ `DidStakeWitnessProvider`).
//
// Ca chốt là ca TƯƠNG ĐƯƠNG: một yêu cầu `{type:"did"}` và cùng yêu cầu đó viết tường minh
// (`owner` script + `owner_witness`) phải ra CÙNG CBOR, cùng ngữ cảnh giao cho bộ dựng, cùng khoá
// mềm. Mỗi ca âm khẳng định thêm: bộ dựng KHÔNG được gọi.

import { describe, expect, it } from "vitest";
import {
  Constr, Data, applyParamsToScript, credentialToRewardAddress, scriptHashToCredential, validatorToScriptHash,
  type UTxO,
} from "@lucid-evolution/lucid";
import type { OwnerRef } from "@magiclamp/protocol-utils";

import { RecordedChainReader, type ChainTip } from "../src/chain.js";
import { parseDeployment, type Deployment } from "../src/config.js";
import { DidOwnerResolver } from "../src/didOwner.js";
import { handle, type RouterDeps } from "../src/http.js";
import { IssuedTxRegistry, OwnerLockTable } from "../src/locks.js";
import { DidStakeWitnessProvider, parseOwnerFields } from "../src/owner.js";
import { VaultTxService } from "../src/service.js";
import { SponsorTxService, sponsorRoute, type SponsorTxServiceDeps } from "../src/sponsor.js";
import { RecordedTxBuilder, enterpriseAddressOf, type TxBuilderPort } from "../src/txBuilder.js";
import {
  INPUT_TX_HASH, LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID, LAMP_UNIT, OWNER_PKH,
  SHARD_ADDRESS, VAULT_ADDRESS, VAULT_ID_UNIT, datumHex,
} from "./fixtures/preview.js";
import { buildTxCbor } from "./fixtures/tx.js";
import { GEN_V2_REF_SCRIPTS, genV2Chain, genV2Json } from "./fixtures/genV2.js";

const TTL = 180_000;
const NOW = 1_789_100_703_000;
const FEE = 190_000n;
const DEPOSIT = 1_001_000_000n;
const TIP: ChainTip = { blockHeight: 1, blockHash: "14".repeat(32), blockTimePosixMs: BigInt(NOW) };
const CHANGE_ADDRESS = enterpriseAddressOf("Preview", OWNER_PKH);

// Script `did_stake` GIẢ chưa apply (mẫu này apply được; `4746010000222220` thì không).
const UNAPPLIED = "49480100002221200101";
const UNAPPLIED_HASH = validatorToScriptHash({ type: "PlutusV3", script: UNAPPLIED });
const POLICY = "a0".repeat(28);
const DID = "did:phoenix:preprod:abc123";
// blake2b_256(utf8(DID)) tính độc lập bằng Python hashlib (2026-10-03).
const ANCHOR_NAME = "9000b767ee33c6ddf6b5fd558fff37c5fa082d3a584ae4f39d581234df24d94a";
const ANCHOR_UNIT = POLICY + ANCHOR_NAME;
const CTRL = "c1".repeat(28);
const DEV = "d1".repeat(28);
const AUX = "e1".repeat(28);

// Suy ĐỘC LẬP với `didOwner.ts`: apply thẳng bằng Lucid với tên từ vector Python.
const APPLIED = applyParamsToScript(UNAPPLIED, [POLICY, ANCHOR_NAME]);
const SCRIPT_HASH = validatorToScriptHash({ type: "PlutusV3", script: APPLIED });
const SCRIPT_OWNER: OwnerRef = { type: "script", hash: SCRIPT_HASH };
const REWARD_ADDRESS = credentialToRewardAddress("Preview", scriptHashToCredential(SCRIPT_HASH));

const NONE = new Constr(1, []);
/** `TAADDatum` 18 trường (PhoenixKey-Validator ▸ lib/phoenixkey/types.ak @ c9050b9). */
function taadDatum(o: { status?: Constr<never>; fields?: number; controller?: unknown; aux?: string[] } = {}): string {
  const f: unknown[] = [
    "00", new Constr(0, []), o.controller ?? CTRL, "", 0n, o.status ?? new Constr(0, []), [], NONE, NONE, NONE,
    NONE, NONE, NONE, 0n, DEV, o.aux ?? [AUX], NONE, 0n,
  ];
  return Data.to(new Constr(0, f.slice(0, o.fields ?? 18) as never[]) as never);
}
const anchorUtxo = (txHash: string, datum: string | null = taadDatum()): UTxO => ({
  txHash, outputIndex: 0, address: VAULT_ADDRESS,
  assets: { lovelace: 2_000_000n, [ANCHOR_UNIT]: 1n }, datum, datumHash: null, scriptRef: null,
} as UTxO);

const DEPLOYMENT_JSON = {
  source: "Preview, bản dựng thử của phép kiểm — không phải một lần deploy thật",
  lamp: { policy_id: LAMP_POLICY_ID, asset_name_hex: LAMP_ASSET_NAME_HEX },
  vaults: [{ vault_type: "Schedule", address: VAULT_ADDRESS }],
  shard_address: SHARD_ADDRESS,
  ref_script_utxos: {
    vault: `${"11".repeat(32)}#0`, shard: `${"22".repeat(32)}#1`, consume: `${"33".repeat(32)}#2`,
    ...GEN_V2_REF_SCRIPTS,
  },
  gen_v2: genV2Json("Preview"),
  consume: { engage_address: VAULT_ADDRESS, price_beacon_address: VAULT_ADDRESS, price_beacon_nft_unit: `${"55".repeat(28)}cafe` },
  did_stake: { anchor_nft_policy: POLICY, unapplied_script: { cbor: UNAPPLIED, hash: UNAPPLIED_HASH } },
};
const DEPLOYMENT: Deployment = parseDeployment(JSON.stringify(DEPLOYMENT_JSON), "Preview");

function createTxCbor(owner: OwnerRef, signers: string[]): string {
  return buildTxCbor({
    inputs: [{ txHash: INPUT_TX_HASH, outputIndex: 1 }],
    feeLovelace: FEE,
    mint: { [VAULT_ID_UNIT]: 1n },
    requiredSigners: signers,
    outputs: [
      {
        address: VAULT_ADDRESS,
        assets: { lovelace: 5_000_000n, [LAMP_UNIT]: DEPOSIT, [VAULT_ID_UNIT]: 1n },
        inlineDatumHex: datumHex({ owner, lampBalanceOildrop: DEPOSIT, lampLockedOildrop: 0n }),
      },
      { address: CHANGE_ADDRESS, assets: { lovelace: 9_000_000n } },
    ],
  });
}

function harness(opts: { anchors?: UTxO[]; resolver?: boolean; signers?: string[] } = {}) {
  const anchors = opts.anchors ?? [anchorUtxo("ab".repeat(32))];
  const chain = new RecordedChainReader({ ...genV2Chain("Preview", { epoch: 20_707n }) }, TIP, anchors);
  chain.rewardAccounts[REWARD_ADDRESS] = { registered: true, withdrawableLovelace: 0n };
  const inner = new RecordedTxBuilder({ create_vault: createTxCbor(SCRIPT_OWNER, opts.signers ?? [CTRL, DEV]) }, VAULT_ID_UNIT);
  // Ghi lại ngữ cảnh mà bộ dựng nhận (owner + chi tiết nhân chứng), để so hai cách khai chủ.
  const seen: Array<{ method: string; owner: unknown; details: unknown }> = [];
  const builder = new Proxy(inner, {
    get(t, prop, recv) {
      const v = Reflect.get(t, prop, recv);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        const ctx = args[0] as { owner?: unknown; ownerAuth?: { details?: unknown } } | undefined;
        seen.push({ method: String(prop), owner: ctx?.owner, details: ctx?.ownerAuth?.details });
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  }) as unknown as TxBuilderPort;
  const issued = new IssuedTxRegistry();
  const service = new VaultTxService({
    network: "Preview", deployment: DEPLOYMENT, chain, builder, locks: new OwnerLockTable(TTL),
    issued, lockTtlMs: TTL, now: () => NOW,
    ownerWitness: new DidStakeWitnessProvider({ network: "Preview", chain, anchorNftPolicy: POLICY }),
    ...(opts.resolver === false ? {} : {
      didOwner: new DidOwnerResolver({ chain, anchorNftPolicy: POLICY, unappliedScript: { cbor: UNAPPLIED, hash: UNAPPLIED_HASH } }),
    }),
  });
  const router: RouterDeps = {
    service, deploymentSource: DEPLOYMENT.source, vaultScopes: DEPLOYMENT.vaults, network: "Preview",
    chainLabel: "recorded", changeAddressStrategy: "enterprise_from_owner_pkh", token: "", logInternal: () => {},
  };
  return { router, seen, issued, chain };
}

const post = (body: unknown) => ({ method: "POST", url: "/tx/create-vault", headers: {}, body });
const createBody = (over: Record<string, unknown>) => ({
  kind: "schedule", lamp_amount: DEPOSIT.toString(), change_address: CHANGE_ADDRESS, ...over,
});
const errCode = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;

describe("parseOwnerFields — chủ kiểu did", () => {
  it("DƯƠNG: did + device_key_hash tuỳ chọn", () => {
    expect(parseOwnerFields({ owner: { type: "did", did: DID } })).toEqual({ type: "did", did: DID });
    expect(parseOwnerFields({ owner: { type: "did", did: DID, device_key_hash: AUX } }))
      .toEqual({ type: "did", did: DID, deviceKeyHash: AUX });
  });
  it.each([
    ["không có tiền tố did:", "phoenix:abc"],
    ["chỉ có tiền tố", "did:"],
    ["có khoảng trắng", "did:a b"],
    ["ngoài ASCII", "did:phoenix:ă"],
    ["dài 257 byte", `did:${"a".repeat(253)}`],
    ["không phải chuỗi", 42],
  ])("CỰC ĐỐI %s ⟹ 400 OWNER_DID_SHAPE", (_n, did) => {
    expect(() => parseOwnerFields({ owner: { type: "did", did } }))
      .toThrow(expect.objectContaining({ httpStatus: 400, code: "OWNER_DID_SHAPE" }));
  });
  it("biên: đúng 256 byte vẫn qua", () => {
    const did = `did:${"a".repeat(252)}`;
    expect(parseOwnerFields({ owner: { type: "did", did } })).toEqual({ type: "did", did });
  });
  it("CỰC ĐỐI: kèm owner_witness hoặc owner_pkh ⟹ 400 OWNER_DID_CONFLICT", () => {
    expect(() => parseOwnerFields({ owner: { type: "did", did: DID }, owner_witness: {} }))
      .toThrow(expect.objectContaining({ code: "OWNER_DID_CONFLICT" }));
    expect(() => parseOwnerFields({ owner: { type: "did", did: DID }, owner_pkh: OWNER_PKH }))
      .toThrow(expect.objectContaining({ code: "OWNER_DID_CONFLICT" }));
  });
  it("CỰC ĐỐI: trường lạ / device_key_hash sai hình dạng", () => {
    expect(() => parseOwnerFields({ owner: { type: "did", did: DID, hash: SCRIPT_HASH } }))
      .toThrow(expect.objectContaining({ code: "OWNER_CREDENTIAL_SHAPE" }));
    expect(() => parseOwnerFields({ owner: { type: "did", did: DID, device_key_hash: "AB".repeat(28) } }))
      .toThrow(expect.objectContaining({ code: "OWNER_HASH_INVALID" }));
  });
});

describe("DidOwnerResolver", () => {
  const resolver = (anchors: UTxO[]) => new DidOwnerResolver({
    chain: new RecordedChainReader({}, TIP, anchors), anchorNftPolicy: POLICY,
    unappliedScript: { cbor: UNAPPLIED, hash: UNAPPLIED_HASH },
  });
  it("DƯƠNG: hash = apply (policy, blake2b_256(did)) tính độc lập; thiết bị mặc định = device_pkh", async () => {
    const r = await resolver([anchorUtxo("ab".repeat(32))]).resolve({ type: "did", did: DID });
    expect(r.ownerRef).toEqual(SCRIPT_OWNER);
    expect(r.witness).toEqual({
      didStakeScriptCbor: APPLIED, anchorRef: { txHash: "ab".repeat(32), outputIndex: 0 },
      controllerPkh: CTRL, deviceKeyHash: DEV,
    });
    expect(r.did).toBe(DID);
  });
  it("thiết bị chỉ định: device_pkh hoặc thiết bị phụ qua; khoá ngoài danh sách ⟹ 400 OWNER_DEVICE_NOT_LISTED", async () => {
    const res = resolver([anchorUtxo("ab".repeat(32))]);
    expect((await res.resolve({ type: "did", did: DID, deviceKeyHash: AUX })).witness.deviceKeyHash).toBe(AUX);
    expect((await res.resolve({ type: "did", did: DID, deviceKeyHash: DEV })).witness.deviceKeyHash).toBe(DEV);
    await expect(res.resolve({ type: "did", did: DID, deviceKeyHash: CTRL }))
      .rejects.toMatchObject({ httpStatus: 400, code: "OWNER_DEVICE_NOT_LISTED" });
  });
  it.each([
    ["không anchor", [], 422, "OWNER_ANCHOR_NOT_FOUND"],
    ["hai anchor", [anchorUtxo("ab".repeat(32)), anchorUtxo("ac".repeat(32))], 422, "OWNER_ANCHOR_AMBIGUOUS"],
    ["không datum", [anchorUtxo("ab".repeat(32), null)], 422, "OWNER_ANCHOR_SCHEMA"],
    ["17 trường", [anchorUtxo("ab".repeat(32), taadDatum({ fields: 17 }))], 422, "OWNER_ANCHOR_SCHEMA"],
    ["controller không phải 28 byte", [anchorUtxo("ab".repeat(32), taadDatum({ controller: "c1" }))], 422, "OWNER_ANCHOR_SCHEMA"],
    ["aux có phần tử lạ", [anchorUtxo("ab".repeat(32), taadDatum({ aux: ["e1"] }))], 422, "OWNER_ANCHOR_SCHEMA"],
    ["status Recovering (ctor 1)", [anchorUtxo("ab".repeat(32), taadDatum({ status: new Constr(1, []) as Constr<never> }))], 422, "OWNER_ANCHOR_NOT_ACTIVE"],
  ] as const)("CỰC ĐỐI %s ⟹ mã lỗi theo bảng", async (_n, anchors, status, code) => {
    await expect(resolver([...anchors]).resolve({ type: "did", did: DID }))
      .rejects.toMatchObject({ httpStatus: status, code });
  });
});

describe("đường /tx/create-vault với chủ did", () => {
  it("TƯƠNG ĐƯƠNG: {type:did} ⟹ CÙNG CBOR, cùng ngữ cảnh bộ dựng, cùng khoá mềm với chủ script tường minh", async () => {
    const a = harness();
    const ra = await handle(post(createBody({ owner: { type: "did", did: DID } })), a.router);
    const b = harness();
    const rb = await handle(post(createBody({
      owner: SCRIPT_OWNER,
      owner_witness: {
        did_stake_script_cbor: APPLIED, anchor_ref: `${"ab".repeat(32)}#0`, controller_pkh: CTRL, device_key_hash: DEV,
      },
    })), b.router);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    const ba = ra.body as Record<string, unknown> & { summary: Record<string, unknown> };
    const bb = rb.body as Record<string, unknown> & { summary: Record<string, unknown> };
    expect(ba.tx_cbor).toBe(bb.tx_cbor);
    expect(ba.owner).toEqual(SCRIPT_OWNER);
    expect(ba.required_signers).toEqual(bb.required_signers);
    expect(ba.witness_notes).toEqual(bb.witness_notes);
    expect(a.seen).toEqual(b.seen);
    expect(a.seen.length).toBeGreaterThan(0);
    expect(ba.summary.owner_did).toBe(DID);
    expect(bb.summary.owner_did).toBeUndefined();
    const { owner_did: _drop, ...restA } = ba.summary;
    expect(restA).toEqual(bb.summary);
    expect(a.issued.lookup(ba.tx_hash as string, NOW)?.lockKeys).toEqual([`script:${SCRIPT_HASH}`]);
    expect(b.issued.lookup(bb.tx_hash as string, NOW)?.lockKeys).toEqual([`script:${SCRIPT_HASH}`]);
  });

  it.each([
    ["không anchor", { anchors: [] }, 422, "OWNER_ANCHOR_NOT_FOUND"],
    ["hai anchor", { anchors: [anchorUtxo("ab".repeat(32)), anchorUtxo("ac".repeat(32))] }, 422, "OWNER_ANCHOR_AMBIGUOUS"],
    ["datum 17 trường", { anchors: [anchorUtxo("ab".repeat(32), taadDatum({ fields: 17 }))] }, 422, "OWNER_ANCHOR_SCHEMA"],
    ["anchor không Active", { anchors: [anchorUtxo("ab".repeat(32), taadDatum({ status: new Constr(1, []) as Constr<never> }))] }, 422, "OWNER_ANCHOR_NOT_ACTIVE"],
    ["bản deploy thiếu unapplied_script", { resolver: false }, 501, "OWNER_SCRIPT_WITNESS_UNAVAILABLE"],
  ] as const)("CỰC ĐỐI %s ⟹ mã lỗi theo bảng, bộ dựng không được gọi", async (_n, o, status, code) => {
    const h = harness(o as Parameters<typeof harness>[0]);
    const r = await handle(post(createBody({ owner: { type: "did", did: DID } })), h.router);
    expect(r.status).toBe(status);
    expect(errCode(r)).toBe(code);
    expect(h.seen).toEqual([]);
  });

  it("CỰC ĐỐI: thiết bị ngoài danh sách / kèm owner_witness ⟹ 400, bộ dựng không được gọi", async () => {
    const h = harness();
    const r1 = await handle(post(createBody({ owner: { type: "did", did: DID, device_key_hash: CTRL } })), h.router);
    expect([r1.status, errCode(r1)]).toEqual([400, "OWNER_DEVICE_NOT_LISTED"]);
    const r2 = await handle(post(createBody({ owner: { type: "did", did: DID }, owner_witness: {} })), h.router);
    expect([r2.status, errCode(r2)]).toEqual([400, "OWNER_DID_CONFLICT"]);
    const r3 = await handle(post(createBody({ owner: { type: "did", did: DID }, owner_pkh: OWNER_PKH })), h.router);
    expect([r3.status, errCode(r3)]).toEqual([400, "OWNER_DID_CONFLICT"]);
    expect(h.seen).toEqual([]);
  });

  it("thiết bị phụ chỉ định đi vào required_signers của nhân chứng", async () => {
    const h = harness({ signers: [CTRL, AUX] });
    const r = await handle(post(createBody({ owner: { type: "did", did: DID, device_key_hash: AUX } })), h.router);
    expect(r.status).toBe(200);
    expect((h.seen[0]!.details as { requiredSigners: string[] }).requiredSigners).toEqual([CTRL, AUX]);
  });
});

describe("đường /tx/sponsor/plan với chủ did", () => {
  const SPONSOR = "f1".repeat(28);
  const resolver = (anchors: UTxO[]) => new DidOwnerResolver({
    chain: new RecordedChainReader({}, TIP, anchors), anchorNftPolicy: POLICY,
    unappliedScript: { cbor: UNAPPLIED, hash: UNAPPLIED_HASH },
  });
  // `plan` chỉ đụng `resolveOwner` của dịch vụ tài trợ ⟹ dựng dịch vụ với ĐÚNG phụ thuộc đó.
  const svc = (anchors: UTxO[]) => new SponsorTxService({ didOwner: resolver(anchors) } as unknown as SponsorTxServiceDeps);
  it("TƯƠNG ĐƯƠNG: kế hoạch của chủ did = kế hoạch của chủ script suy ra, cộng owner_did", async () => {
    const viaDid = await sponsorRoute("/tx/sponsor/plan", { owner: { type: "did", did: DID }, sponsor_pkh: SPONSOR },
      svc([anchorUtxo("ab".repeat(32))]));
    const explicit = await sponsorRoute("/tx/sponsor/plan", { owner: SCRIPT_OWNER, sponsor_pkh: SPONSOR }, undefined);
    const { owner_did, ...rest } = viaDid;
    expect(owner_did).toBe(DID);
    expect(rest).toEqual(explicit);
  });
  it("CỰC ĐỐI: chủ did mà không có dịch vụ tài trợ ⟹ 501; không anchor ⟹ 422", async () => {
    await expect(sponsorRoute("/tx/sponsor/plan", { owner: { type: "did", did: DID }, sponsor_pkh: SPONSOR }, undefined))
      .rejects.toMatchObject({ httpStatus: 501, code: "OWNER_SCRIPT_WITNESS_UNAVAILABLE" });
    await expect(sponsorRoute("/tx/sponsor/plan", { owner: { type: "did", did: DID }, sponsor_pkh: SPONSOR }, svc([])))
      .rejects.toMatchObject({ httpStatus: 422, code: "OWNER_ANCHOR_NOT_FOUND" });
  });
});

describe("cấu hình did_stake.unapplied_script — kiểm lúc khởi động", () => {
  const withDidStake = (didStake: unknown) => JSON.stringify({ ...DEPLOYMENT_JSON, did_stake: didStake });
  it("DƯƠNG: cặp cbor+hash khớp ⟹ nạp", () => {
    expect(DEPLOYMENT.didStake).toEqual({ anchorNftPolicy: POLICY, unappliedScript: { cbor: UNAPPLIED, hash: UNAPPLIED_HASH } });
  });
  it("vắng unapplied_script ⟹ nạp, không có khối suy DID", () => {
    expect(parseDeployment(withDidStake({ anchor_nft_policy: POLICY }), "Preview").didStake).toEqual({ anchorNftPolicy: POLICY });
  });
  it("CỰC ĐỐI: hash lệch cbor ⟹ từ chối khởi động", () => {
    expect(() => parseDeployment(withDidStake({
      anchor_nft_policy: POLICY, unapplied_script: { cbor: UNAPPLIED, hash: "97".repeat(28) },
    }), "Preview")).toThrow(/Từ chối khởi động/);
  });
  it("CỰC ĐỐI: chỉ một trong hai trường ⟹ lỗi cấu hình", () => {
    expect(() => parseDeployment(withDidStake({ anchor_nft_policy: POLICY, unapplied_script: { cbor: UNAPPLIED } }), "Preview"))
      .toThrow(/CẢ HAI/);
    expect(() => parseDeployment(withDidStake({ anchor_nft_policy: POLICY, unapplied_script: { hash: UNAPPLIED_HASH } }), "Preview"))
      .toThrow(/CẢ HAI/);
  });
});
