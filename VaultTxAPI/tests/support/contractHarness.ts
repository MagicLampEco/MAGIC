// VaultTxAPI/tests/support/contractHarness.ts — khung dựng ROUTER THẬT cho bài khớp-hợp-đồng (`moduleContract.test.ts`).
//
// Cùng khuôn với `feeProxy.test.ts` ▸ `harness` (cùng fixtures, cùng Feecover giả tiêm vào `FetchLike`): lời đáp
// ở đây đi qua `http.ts` ▸ `handle` thật, tức qua đúng các hàm `toBuildBody`, `toSubmitBody`, `toTxStatusBody`,
// `FeeProxy.utxo/sign` mà dịch vụ thật dùng. Không lời đáp nào được viết tay.

import {
  unixTimeToSlot, type UTxO,
} from "@lucid-evolution/lucid";

import { RecordedChainReader, type ChainReader, type ChainTip } from "../../src/chain.js";
import { parseDeployment, type Deployment } from "../../src/config.js";
import { FeeProxy, type FetchLike } from "../../src/feeProxy.js";
import { handle, type RouterDeps } from "../../src/http.js";
import { IssuedTxRegistry, OwnerLockTable } from "../../src/locks.js";
import { VaultTxService } from "../../src/service.js";
import { txBodyHash } from "../../src/summary.js";
import { RecordedTxBuilder, enterpriseAddressOf } from "../../src/txBuilder.js";
import { withConsumeLeg } from "../fixtures/consume.js";
import { ENGAGE_ADDRESS, threadUtxo } from "../fixtures/engage.js";
import { GEN_V2_REF_SCRIPTS, genV2Chain, genV2Json } from "../fixtures/genV2.js";
import {
  INPUT_TX_HASH, LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID, LAMP_UNIT, OWNER_PKH,
  SHARD_ADDRESS, VAULT_ADDRESS, VAULT_ID_UNIT, datumHex,
} from "../fixtures/preview.js";
import { buildTxCbor, fakeWitnessSetCbor, type TxOutputSpec } from "../fixtures/tx.js";

export const NOW = 1_789_100_703_000;
export const TTL = 180_000;
export const TIP: ChainTip = { blockHeight: 1, blockHash: "14".repeat(32), blockTimePosixMs: BigInt(NOW) };
export const MAGIC_TOKEN = "magic-app-token-for-tests-" + "q".repeat(24);
/** Thẻ bài VTA của bộ định tuyến (vắng = chạy không thẻ trên loopback). */
export const VTA_TOKEN = "vta-shared-token-for-tests-" + "v".repeat(20);
const KEY_OWNER = { type: "key" as const, hash: OWNER_PKH };
const FEE_ADDRESS = enterpriseAddressOf("Preview", "fe".repeat(28));

const FEE_BATCH = { id: "fb".repeat(16), createdEpoch: 20_707n, amountNanogic: 5_000_000_000n };
const CONSUME_BURN = 1_000_000_000n;
const CONSUME_FEE = 178_000n;

const utxo = (txHash: string, outputIndex: number, address: string, assets: Record<string, bigint>, datum?: string): UTxO =>
  ({ txHash, outputIndex, address, assets, datum }) as UTxO;
const ref = (u: { txHash: string; outputIndex: number }) => ({ txHash: u.txHash, outputIndex: u.outputIndex });

export const VAULT_UTXO = utxo(INPUT_TX_HASH, 0, VAULT_ADDRESS,
  { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
  datumHex({ lampLockedOildrop: 2_000_000n, batches: [FEE_BATCH] }));
export const FEE_UTXO = utxo("fa".repeat(32), 0, FEE_ADDRESS, { lovelace: 10_000_000n });
export const FEE_PAYER = { utxo: `${FEE_UTXO.txHash}#0`, address: FEE_ADDRESS };

const FEECOVER_BLOCK = {
  url: "https://feecover.example/",
  timeout_ms: 200,
  apps: { magic: { purposes: { consume: "consume_magic" } } },
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
  feecover: FEECOVER_BLOCK,
}), "Preview");

/** Tx tiêu MAGIC có ví trả phí: két đốt `CONSUME_BURN` + vế thread (khuôn `feeProxy.test.ts` ▸ `consumeTx`). */
function consumeTx(): string {
  const outputs: TxOutputSpec[] = [
    {
      address: VAULT_ADDRESS,
      assets: { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
      inlineDatumHex: datumHex({
        lampLockedOildrop: 23_000_000n, genScheduleCount: 1,
        batches: [{ ...FEE_BATCH, amountNanogic: FEE_BATCH.amountNanogic - CONSUME_BURN }],
        consumedCreditNanogic: CONSUME_BURN,
      }),
    },
    { address: FEE_ADDRESS, assets: { lovelace: 10_000_000n - CONSUME_FEE } },
  ];
  const spec = {
    inputs: [ref(VAULT_UTXO), ref(FEE_UTXO)],
    feeLovelace: CONSUME_FEE,
    outputs,
    requiredSigners: [OWNER_PKH],
    collateralInputs: [ref(FEE_UTXO)],
    collateralReturn: { address: FEE_ADDRESS, assets: { lovelace: 7_000_000n } },
    ttlSlot: BigInt(unixTimeToSlot("Preview", NOW + 600_000)),
  };
  return buildTxCbor(withConsumeLeg(spec, {
    thread: threadUtxo(KEY_OWNER, "7e".repeat(32)), vaultRef: ref(VAULT_UTXO),
    pairs: [{ opType: 1, opCount: 2n }], requiredNanogic: CONSUME_BURN,
  }));
}

export type Reply = { status: number; body: unknown } | "throw";

export interface Call { url: string; method: string; headers: Record<string, string>; body?: Record<string, unknown> }

export interface HarnessOpts {
  /** Câu trả lời của Feecover giả cho `/v1/utxo`. */
  utxoReply?: Reply;
  /** Không dựng proxy Feecover ⟹ `/fee/*` trả 501. */
  noProxy?: boolean;
  /** Thẻ bài của bộ định tuyến. */
  token?: string;
  /** Nút chuỗi: `submitTx` thất bại / trả hash khác. */
  chain?: (inner: RecordedChainReader) => ChainReader;
}

export function consumeHarness(opts: HarnessOpts = {}) {
  const clock = { t: NOW };
  const cbor = consumeTx();
  const hash = txBodyHash(cbor);
  const recorded = new RecordedChainReader(
    {
      [VAULT_ADDRESS]: [VAULT_UTXO],
      [ENGAGE_ADDRESS]: [threadUtxo(KEY_OWNER, "7e".repeat(32))],
      ...genV2Chain("Preview", { epoch: 20_707n }),
    },
    TIP,
    [VAULT_UTXO, FEE_UTXO, threadUtxo(KEY_OWNER, "7e".repeat(32))],
    undefined,
    hash,
  );
  const chain: ChainReader = opts.chain === undefined ? recorded : opts.chain(recorded);
  const issued = new IssuedTxRegistry();
  const service = new VaultTxService({
    network: "Preview", deployment: DEPLOYMENT, chain,
    builder: new RecordedTxBuilder({ consume: cbor }, VAULT_ID_UNIT),
    locks: new OwnerLockTable(TTL), issued, lockTtlMs: TTL, now: () => clock.t,
    // Chữ ký thật đo ở `witnessCheck.test.ts`; bài này đo hình dạng lời đáp.
    witnessCheck: () => {},
  });

  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url, method: init.method, headers: init.headers, body });
    const reply: Reply = url.includes("/v1/utxo")
      ? (opts.utxoReply ?? {
        status: 200,
        body: {
          address: FEE_ADDRESS,
          utxo: { txHash: FEE_UTXO.txHash, outputIndex: 0, lovelace: "10000000" },
          reserved_until: new Date(NOW + 600_000).toISOString(),
        },
      })
      : {
        status: 200,
        body: { txHash: txBodyHash(body!.tx_cbor_hex as string), witnessSet: "a100", netLovelace: "178000", feeLovelace: "178000" },
      };
    if (reply === "throw") throw new TypeError("fetch failed");
    const r = reply;
    return { status: r.status, text: async () => JSON.stringify(r.body) };
  };

  const router: RouterDeps = {
    service, deploymentSource: DEPLOYMENT.source, vaultScopes: DEPLOYMENT.vaults, network: "Preview",
    chainLabel: "recorded", changeAddressStrategy: "enterprise_from_owner_pkh", token: opts.token ?? "",
    logInternal: () => {},
    ...(opts.noProxy === true ? {} : {
      feeProxy: new FeeProxy({ settings: DEPLOYMENT.feecover!, magicToken: MAGIC_TOKEN, issued, fetch, now: () => clock.t }),
    }),
  };

  const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
    handle({ method, url, headers, body }, router);

  return { router, call, calls, clock, cbor, hash, issued, chain: recorded, witnessCbor: fakeWitnessSetCbor() };
}

/** Thân `/tx/consume` hợp lệ cho `consumeHarness` (gắn `fee_payer` do `/fee/utxo` trả). */
export const consumeBody = (feePayer: unknown = FEE_PAYER, over: Record<string, unknown> = {}) =>
  ({ owner_pkh: OWNER_PKH, op_type: 1, op_count: "2", fee_payer: feePayer, ...over });
