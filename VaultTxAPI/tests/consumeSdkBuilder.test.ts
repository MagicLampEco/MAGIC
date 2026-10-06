// VaultTxAPI/tests/consumeSdkBuilder.test.ts — `POST /tx/consume` đi qua bộ dựng THẬT
// (`SdkTxBuilder.consume`), ghim đường beacon ρ / két Wakeme từ tầng dịch vụ xuống tới
// `buildConsumeTx`.
//
// ══ VÌ SAO CÓ TỆP NÀY ═══════════════════════════════════════════════════════════
// `consumeCheckpoint.test.ts` dùng bộ dựng GHI SẴN nên chỉ ghim được tầng dịch vụ → cổng
// `TxBuilderPort`. Chặng còn lại — `SdkTxBuilder.consume` lấy `vaultSide.rateBeaconUtxo` do
// `buildVaultBurnBatch` trả rồi chuyển vào `buildConsumeTx` — chưa bài nào ghim. Thiếu chặng
// đó thì tx làm mới checkpoint KHÔNG mang beacon ρ ở reference input và chết trên chuỗi, trong
// khi mọi bài ở tầng trên vẫn xanh.
//
// CẶP: két Instant v2 sang epoch mới ⟹ `buildConsumeTx` nhận ĐÚNG UTxO beacon ρ (và két Wakeme
// khi `wakeme_link` khác rỗng); cùng epoch ⟹ KHÔNG có `rateBeaconUtxo`.
//
// Cái gì bị giả, cái gì chạy thật:
//   · `buildConsumeTx` — giả (ghi lại đối số, trả CBOR ghi sẵn). Đây là điểm đo.
//   · `buildVaultBurnBatch` — CHẠY THẬT (bọc `vi.fn` để đọc đối số): quyết định làm mới hay
//     không là của SDK, và cặp này phải đi qua quyết định đó chứ không qua một bản giả.
//   · `decodePriceParam` / `requiredFromBeacon` — giả, trả `required` cố định: giá không phải
//     đối tượng của tệp này, và dựng datum PriceParam thật chỉ thêm một chỗ hỏng không liên quan.
//   · `lucidFor` — thay trên thể hiện để không gọi Blockfrost; đối tượng Lucid chỉ đi vào
//     `buildConsumeTx` đã giả.
//   · Script vault/consume — script giả ĐÚNG HÌNH DẠNG, địa chỉ suy từ hash của chính nó, để
//     `assertScriptHash` của bộ dựng chạy thật.
// ══════════════════════════════════════════════════════════════════════════════

import {
  Constr, Data, credentialToAddress, validatorToScriptHash, type Script, type UTxO,
} from "@lucid-evolution/lucid";
import { posixMsToEpoch, wakemeVaultHash } from "@magiclamp/protocol-utils";
import {
  buildConsumeManyTx, buildConsumeTx, buildVaultBurnBatch, requiredFromBeacon, requiredFromBeaconPairs, type PlutusJson,
} from "@magiclamp/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RecordedChainReader, type ChainTip } from "../src/chain.js";
import { parseDeployment } from "../src/config.js";
import { handle, type RouterDeps } from "../src/http.js";
import { IssuedTxRegistry, OwnerLockTable } from "../src/locks.js";
import { VaultTxService } from "../src/service.js";
import { SdkTxBuilder } from "../src/txBuilder.js";
import {
  INPUT_TX_HASH, LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID, LAMP_UNIT, OWNER_PKH, SHARD_ADDRESS, datumHex,
} from "./fixtures/preview.js";
import { engageDatumHex } from "./fixtures/engage.js";
import { GB_SHARD_REF, genV2Chain, genV2Json } from "./fixtures/genV2.js";
import { buildTxCbor, prerecordedTtlSlot } from "./fixtures/tx.js";
import { withConsumeLeg } from "./fixtures/consume.js";

vi.mock("@magiclamp/sdk", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@magiclamp/sdk")>();
  return {
    ...orig,
    buildConsumeTx: vi.fn(),
    buildConsumeManyTx: vi.fn(),
    buildVaultBurnBatch: vi.fn(orig.buildVaultBurnBatch),
    decodePriceParam: vi.fn(() => ({})),
    // 1 MAGIC — dưới lô sống 5 MAGIC của két.
    requiredFromBeacon: vi.fn(() => 1_000_000_000n),
    // `pairs` đi đường RIÊNG (sàn từng cặp) — cùng 1 MAGIC để CBOR ghi sẵn dùng chung vế két.
    requiredFromBeaconPairs: vi.fn(() => 1_000_000_000n),
  };
});

const NET = "Preprod" as const;
const TTL = 180_000;
const NOW = 1_789_100_703_000;
const FIXTURE_TTL_SLOT = prerecordedTtlSlot(NOW, undefined, "Preprod");
const TIP: ChainTip = {
  blockHeight: 4_651_976,
  blockHash: "14ae149dd07cd25ce37a6a4336f3939446bd68d9ad4a2e820201a474cc3ad72f",
  blockTimePosixMs: BigInt(NOW),
};
const EPOCH = posixMsToEpoch(BigInt(NOW), NET);
const RATE_REF = `${"a9".repeat(32)}#0`;

const VAULT_SCRIPT: Script = { type: "PlutusV3", script: "4e4d01000033222220051200120011" };
const CONSUME_SCRIPT: Script = { type: "PlutusV3", script: "4e4d01000033222220051200120012" };
const VAULT_HASH = validatorToScriptHash(VAULT_SCRIPT);
const CONSUME_HASH = validatorToScriptHash(CONSUME_SCRIPT);
const VAULT_ADDR = credentialToAddress(NET, { type: "Script", hash: VAULT_HASH });
const ENGAGE_ADDR = credentialToAddress(NET, { type: "Script", hash: CONSUME_HASH });
const VAULT_NAME = "5a".repeat(32);
const VAULT_ID = VAULT_HASH + VAULT_NAME;
const PRICE_NFT = `${"55".repeat(28)}cafe`;
const VAULT_REF = `${"11".repeat(32)}#0`;
const CONSUME_REF = `${"33".repeat(32)}#2`;

const WAKEME_HASH = wakemeVaultHash(NET);
const WAKEME_TX = "ab".repeat(32);
const WAKEME_REF = `${WAKEME_TX}#1`;
const OWNER_COMMIT = "c1".repeat(32);
const CONDITIONAL = 300_000_000n;
const OWNED = 200_000_000n;

/** Blueprint tối thiểu: chỉ đủ để `resolveConstrIndex` suy chỉ số `BurnBatch` (= 2, InstantGen). */
const VAULT_BLUEPRINT = {
  preamble: {},
  validators: [{ title: "vault.vault.spend", redeemer: { schema: { $ref: "#/definitions/R" } } }],
  definitions: { R: { anyOf: [{ title: "BurnBatch", index: 2, fields: [] }] } },
} as unknown as PlutusJson;

const LIVE_BATCH = { id: "b0".repeat(16), createdEpoch: EPOCH, amountNanogic: 5_000_000_000n };

function vaultDatum(capEpoch: bigint, wakemeLink: string): string {
  return datumHex({
    lampLockedOildrop: 0n, batches: [LIVE_BATCH], instantUnlockMs: 0n,
    lastUpdatedEpoch: EPOCH - 1n, capEpoch, wakemeLink,
  });
}

function wakemeUtxo(): UTxO {
  const pin = new Constr(0, [new Constr(0, [VAULT_HASH, VAULT_NAME])]);
  return {
    txHash: WAKEME_TX, outputIndex: 1, address: credentialToAddress(NET, { type: "Script", hash: WAKEME_HASH }),
    assets: { lovelace: 2_000_000n, [WAKEME_HASH + OWNER_COMMIT]: 1n, [LAMP_UNIT]: CONDITIONAL + OWNED },
    datum: Data.to(new Constr(0, [
      OWNER_COMMIT, 0n, 0n, CONDITIONAL, 0n, 0n, 0n, OWNED, 0n, 0n, 0n, pin, EPOCH - 1n,
    ])),
  };
}

function consumeTxCbor(withWakeme: boolean, thread: UTxO, pairs = [{ opType: 1, opCount: 1n }]): string {
  return buildTxCbor(withConsumeLeg({ ttlSlot: FIXTURE_TTL_SLOT,
    inputs: [{ txHash: INPUT_TX_HASH, outputIndex: 0 }],
    ...(withWakeme ? { referenceInputs: [{ txHash: WAKEME_TX, outputIndex: 1 }] } : {}),
    feeLovelace: 178_000n,
    outputs: [{
      address: VAULT_ADDR,
      assets: { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID]: 1n },
      inlineDatumHex: datumHex({
        lampLockedOildrop: 0n, batches: [{ ...LIVE_BATCH, amountNanogic: 4_000_000_000n }], instantUnlockMs: 0n,
        lastUpdatedEpoch: EPOCH, capEpoch: EPOCH, usageWindowEpoch: EPOCH, consumedCreditNanogic: 1_000_000_000n,
      }),
    }],
  }, {
    // `requiredFromBeacon` giả = 1 MAGIC (khối `vi.mock` đầu tệp) — cùng lượng két đốt ở trên.
    thread, vaultRef: { txHash: INPUT_TX_HASH, outputIndex: 0 }, pairs,
    requiredNanogic: 1_000_000_000n,
  }));
}

const outRef = (s: string) => { const [txHash, i] = s.split("#"); return { txHash: txHash!, outputIndex: Number(i) }; };

function harness(o: { capEpoch: bigint; wakemeLink?: string }) {
  const withWakeme = (o.wakemeLink ?? "") !== "";
  const deployment = parseDeployment(JSON.stringify({
    source: "bản dựng thử của phép kiểm — không phải một lần deploy thật",
    lamp: { policy_id: LAMP_POLICY_ID, asset_name_hex: LAMP_ASSET_NAME_HEX },
    vaults: [{ vault_type: "Instant", address: VAULT_ADDR }],
    shard_address: SHARD_ADDRESS,
    ref_script_utxos: { vault: VAULT_REF, shard: `${"22".repeat(32)}#1`, consume: CONSUME_REF, gb_shard: GB_SHARD_REF },
    consume: { engage_address: ENGAGE_ADDR, price_beacon_address: VAULT_ADDR, price_beacon_nft_unit: PRICE_NFT },
    gen_v2: genV2Json(NET),
  }), NET);

  const vault: UTxO = {
    txHash: INPUT_TX_HASH, outputIndex: 0, address: VAULT_ADDR,
    assets: { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID]: 1n },
    datum: vaultDatum(o.capEpoch, o.wakemeLink ?? ""),
  };
  const priceBeacon: UTxO = {
    txHash: "56".repeat(32), outputIndex: 0, address: VAULT_ADDR,
    assets: { lovelace: 2_000_000n, [PRICE_NFT]: 1n }, datum: Data.to(new Constr(0, [])),
  };
  const thread: UTxO = {
    txHash: "7e".repeat(32), outputIndex: 0, address: ENGAGE_ADDR,
    assets: { lovelace: 2_000_000n, [CONSUME_HASH + "01"]: 1n },
    datum: engageDatumHex({ type: "key", hash: OWNER_PKH }),
  };
  const refScript = (ref: string, scriptRef: Script): UTxO =>
    ({ ...outRef(ref), address: VAULT_ADDR, assets: { lovelace: 20_000_000n }, scriptRef });

  const chain = new RecordedChainReader(
    { [VAULT_ADDR]: [vault, priceBeacon], [ENGAGE_ADDR]: [thread], ...genV2Chain(NET, { epoch: EPOCH }) },
    TIP,
    [refScript(VAULT_REF, VAULT_SCRIPT), refScript(CONSUME_REF, CONSUME_SCRIPT), ...(withWakeme ? [wakemeUtxo()] : [])],
  );
  const builder = new SdkTxBuilder({
    network: NET, blockfrostUrl: "http://không-dùng.invalid", blockfrostProjectId: "không-dùng",
    deployment, chain, vaultPlutusJson: VAULT_BLUEPRINT,
  });
  // Không gọi Blockfrost: Lucid chỉ đi vào `buildConsumeTx` đã giả.
  (builder as unknown as { lucidFor: () => Promise<unknown> }).lucidFor = async () => ({});
  vi.mocked(buildConsumeTx).mockResolvedValue(
    { tx: { toCBOR: () => consumeTxCbor(withWakeme, thread) } } as unknown as Awaited<ReturnType<typeof buildConsumeTx>>);

  const service = new VaultTxService({
    network: NET, deployment, chain, builder,
    locks: new OwnerLockTable(TTL), issued: new IssuedTxRegistry(),
    lockTtlMs: TTL, now: () => NOW,
  });
  const router: RouterDeps = {
    service, deploymentSource: deployment.source, vaultScopes: deployment.vaults, network: NET,
    chainLabel: "recorded", changeAddressStrategy: "enterprise_from_owner_pkh", token: "", logInternal: () => {},
  };
  return { router, thread };
}

const post = (body: Record<string, unknown> = {}) => ({
  method: "POST", url: "/tx/consume", headers: {},
  body: { owner_pkh: OWNER_PKH, op_type: 1, op_count: "1", ...body },
});
const refOf = (u: UTxO | undefined) => (u === undefined ? undefined : `${u.txHash}#${u.outputIndex}`);
type ConsumeArgs = { rateBeaconUtxo?: UTxO; wakemeVaultUtxo?: UTxO; vaultKind: string };
const consumeArgs = () => vi.mocked(buildConsumeTx).mock.calls[0]![0] as unknown as ConsumeArgs;
const burnArgs = () => vi.mocked(buildVaultBurnBatch).mock.calls[0]![0] as unknown as { rateBeaconUtxo?: UTxO };

beforeEach(() => {
  vi.mocked(buildConsumeTx).mockReset();
  vi.mocked(buildConsumeManyTx).mockReset();
  vi.mocked(requiredFromBeacon).mockClear();
  vi.mocked(requiredFromBeaconPairs).mockClear();
  vi.mocked(buildVaultBurnBatch).mockClear();
});

describe("SdkTxBuilder.consume — beacon ρ tới `buildConsumeTx`", () => {
  it("script giả băm ra hash khác nhau (không thì cặp dưới xanh vì địa chỉ trùng)", () => {
    expect(VAULT_HASH).not.toBe(CONSUME_HASH);
  });

  it("CẶP (a): két Instant sang epoch mới ⟹ buildConsumeTx nhận ĐÚNG UTxO beacon ρ", async () => {
    const h = harness({ capEpoch: EPOCH - 1n });
    const r = await handle(post(), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(vi.mocked(buildConsumeTx)).toHaveBeenCalledTimes(1);
    const a = consumeArgs();
    expect(a.vaultKind).toBe("instant");
    expect(refOf(a.rateBeaconUtxo)).toBe(RATE_REF);
    expect(a.wakemeVaultUtxo).toBeUndefined();
    // Quyết định làm mới đi qua SDK thật: nó nhận ρ từ dịch vụ.
    expect(refOf(burnArgs().rateBeaconUtxo)).toBe(RATE_REF);
  });

  it("CẶP (b): cùng epoch (cap_epoch = e) ⟹ buildConsumeTx KHÔNG nhận rateBeaconUtxo", async () => {
    const h = harness({ capEpoch: EPOCH });
    const r = await handle(post(), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const a = consumeArgs();
    expect(a.vaultKind).toBe("instant");
    expect("rateBeaconUtxo" in a).toBe(false);
    expect("wakemeVaultUtxo" in a).toBe(false);
    expect(burnArgs().rateBeaconUtxo).toBeUndefined();
  });

  it("wakeme_link khác rỗng + wakeme_vault_ref ⟹ buildConsumeTx nhận cả beacon ρ lẫn két Wakeme", async () => {
    const h = harness({ capEpoch: EPOCH - 1n, wakemeLink: OWNER_COMMIT });
    const r = await handle(post({ wakeme_vault_ref: WAKEME_REF }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const a = consumeArgs();
    expect(refOf(a.rateBeaconUtxo)).toBe(RATE_REF);
    expect(refOf(a.wakemeVaultUtxo)).toBe(WAKEME_REF);
  });
});

describe("SdkTxBuilder.consume — `pairs` đi `requiredFromBeaconPairs` + `buildConsumeManyTx`", () => {
  const TWO = [{ opType: 1, opCount: 2n }, { opType: 3, opCount: 1n }];

  it("2 cặp ⟹ required từ `requiredFromBeaconPairs(pp, pairs)`, dựng bằng `buildConsumeManyTx({pairs})`, KHÔNG gọi bản đơn", async () => {
    const h = harness({ capEpoch: EPOCH });
    vi.mocked(buildConsumeManyTx).mockResolvedValue(
      { tx: { toCBOR: () => consumeTxCbor(false, h.thread, TWO) } } as unknown as Awaited<ReturnType<typeof buildConsumeManyTx>>);
    const r = await handle(post({ op_type: undefined, op_count: undefined, pairs: [{ op_type: 1, op_count: "2" }, { op_type: 3, op_count: "1" }] }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(vi.mocked(requiredFromBeaconPairs)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(requiredFromBeaconPairs).mock.calls[0]![1]).toEqual(TWO);
    expect(vi.mocked(requiredFromBeacon)).not.toHaveBeenCalled();
    expect(vi.mocked(buildConsumeTx)).not.toHaveBeenCalled();
    expect((vi.mocked(buildConsumeManyTx).mock.calls[0]![0] as unknown as { pairs: unknown }).pairs).toEqual(TWO);
    expect((r.body as { summary: { consume: { redeemer: string } } }).summary.consume.redeemer).toBe("ConsumeMany");
  });

  it("CẶP: một cặp ⟹ `requiredFromBeacon` + `buildConsumeTx`, KHÔNG gọi bản nhiều cặp", async () => {
    const h = harness({ capEpoch: EPOCH });
    const r = await handle(post(), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(vi.mocked(requiredFromBeacon)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(requiredFromBeaconPairs)).not.toHaveBeenCalled();
    expect(vi.mocked(buildConsumeManyTx)).not.toHaveBeenCalled();
  });
});
