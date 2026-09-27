// VaultTxAPI/tests/feeQuote.test.ts — `POST /tx/quote` (`feeQuote.ts`), mỗi cổng một CẶP ca.
//
// Bộ dựng ở đây KHÔNG phải `RecordedTxBuilder`: báo giá dựng trên UTxO trả phí do chính nó chọn
// (tổng hợp, hoặc UTxO ở địa chỉ chủ), nên CBOR phải đi theo UTxO đó — nếu không, cổng đọc lại
// `checkFeePayerTx` đỏ ngay ở vế "UTxO trả phí không phải input". `FeeModelBuilder` dựng CBOR
// thật (CML) với phí phụ thuộc ĐỘ DÀI địa chỉ ví trả phí, để hai nguồn ra hai con số khác nhau
// và phép kiểm biết con số nào đến từ lượt dựng nào.
//
// Chuỗi ghi sẵn (`RecordedChainReader`) NÉM khi bị hỏi một tham chiếu nó không có — UTxO tổng
// hợp không có trong đó, nên một lượt đọc chuỗi cho nó là một bài đỏ, không phải một số lặng lẽ.

import {
  PROTOCOL_PARAMETERS_DEFAULT, credentialToAddress, getAddressDetails, unixTimeToSlot, type UTxO,
} from "@lucid-evolution/lucid";
import { describe, expect, it, vi } from "vitest";

import { RecordedChainReader, type ChainTip } from "../src/chain.js";
import { parseDeployment, type Deployment } from "../src/config.js";
import { FeeProxy, type FetchLike } from "../src/feeProxy.js";
import { handle, type RouterDeps } from "../src/http.js";
import { IssuedTxRegistry, OwnerLockTable } from "../src/locks.js";
import { VaultTxService } from "../src/service.js";
import {
  enterpriseAddressOf,
  type BuildContext, type BuiltCreateVault, type BuiltOpenThread, type BuiltTx, type TxBuilderPort,
} from "../src/txBuilder.js";
import { ENGAGE_ADDRESS, threadUtxo } from "./fixtures/engage.js";
import {
  INPUT_TX_HASH, LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID, LAMP_UNIT, OTHER_OWNER_PKH, OWNER_PKH,
  SHARD_ADDRESS, VAULT_ADDRESS, VAULT_ID_UNIT, datumHex,
} from "./fixtures/preview.js";
import { buildTxCbor } from "./fixtures/tx.js";

const TTL = 180_000;
const NOW = 1_789_100_703_000;
const TIP: ChainTip = { blockHeight: 1, blockHash: "14".repeat(32), blockTimePosixMs: BigInt(NOW) };
const KEY_OWNER = { type: "key" as const, hash: OWNER_PKH };
/** Địa chỉ khoá (enterprise) của chính chủ — nguồn `owner_address`. */
const OWNER_FEE_ADDRESS = enterpriseAddressOf("Preview", OWNER_PKH);
const COLLATERAL = 3_000_000n;
const VALID_TO_MS = NOW + 1_800_000;

const utxo = (txHash: string, outputIndex: number, address: string, assets: Record<string, bigint>, datum?: string): UTxO =>
  ({ txHash, outputIndex, address, assets, datum });

const VAULT_UTXO = utxo(INPUT_TX_HASH, 0, VAULT_ADDRESS,
  { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n }, datumHex({ lampLockedOildrop: 2_000_000n }));

/** Phí của mô hình: 170 000 + 44 × (byte địa chỉ ví trả phí) × 2 (thối + collateral_return).
 *  Enterprise 29 byte ⟹ 172 552; base 57 byte ⟹ 175 016. Chỉ để phân biệt hai lượt dựng. */
function modelFee(address: string): bigint {
  const d = getAddressDetails(address);
  return 170_000n + 44n * BigInt(d.address.hex.length / 2) * 2n;
}
const FEE_ENTERPRISE = 172_552n;
const FEE_BASE = 175_016n;

/** Bộ dựng dựng CBOR theo UTxO trả phí trong `ctx`, đếm lượt gọi, ghi UTxO đã thấy. */
class FeeModelBuilder implements TxBuilderPort {
  seen: UTxO[] = [];
  /** Phí CỘNG THÊM cho đúng một UTxO (`txHash#idx`): giả lập một trục phí mà lượt tổng hợp chưa đo. */
  extraFee = new Map<string, bigint>();
  coinsPerUtxoByteValue = PROTOCOL_PARAMETERS_DEFAULT.coinsPerUtxoByte;

  private feeTx(ctx: BuildContext): BuiltTx {
    const fp = ctx.feePayerUtxo;
    if (fp === undefined || ctx.collateralLovelace === undefined) {
      throw new Error("[FeeModelBuilder] chỉ dựng đường có ví trả phí.");
    }
    this.seen.push(fp);
    const u = fp.assets.lovelace!;
    const fee = modelFee(fp.address) + (this.extraFee.get(`${fp.txHash}#${fp.outputIndex}`) ?? 0n);
    return {
      txCbor: buildTxCbor({
        inputs: [{ txHash: VAULT_UTXO.txHash, outputIndex: 0 }, { txHash: fp.txHash, outputIndex: fp.outputIndex }],
        feeLovelace: fee,
        outputs: [
          {
            address: VAULT_ADDRESS,
            assets: { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
            inlineDatumHex: datumHex({ lampLockedOildrop: 23_000_000n, genScheduleCount: 1 }),
          },
          { address: fp.address, assets: { lovelace: u - fee } },
        ],
        requiredSigners: [OWNER_PKH],
        collateralInputs: [{ txHash: fp.txHash, outputIndex: fp.outputIndex }],
        collateralReturn: { address: fp.address, assets: { lovelace: u - ctx.collateralLovelace } },
        ttlSlot: BigInt(unixTimeToSlot("Preview", VALID_TO_MS)),
      }),
    };
  }

  async scheduleCommit(ctx: BuildContext): Promise<BuiltTx> { return this.feeTx(ctx); }
  async scheduleFire(ctx: BuildContext): Promise<BuiltTx> { return this.feeTx(ctx); }
  async consume(ctx: BuildContext): Promise<BuiltTx> { return this.feeTx(ctx); }
  async instantGen(ctx: BuildContext): Promise<BuiltTx> { return this.feeTx(ctx); }
  async createVault(): Promise<BuiltCreateVault> { throw new Error("[FeeModelBuilder] createVault không dựng ở đây."); }
  async openThread(): Promise<BuiltOpenThread> { throw new Error("[FeeModelBuilder] openThread không dựng ở đây."); }
  async coinsPerUtxoByte(): Promise<bigint> { return this.coinsPerUtxoByteValue; }
}

const BASE_DEPLOYMENT = {
  source: "Preview, bản dựng thử của phép kiểm — không phải một lần deploy thật",
  lamp: { policy_id: LAMP_POLICY_ID, asset_name_hex: LAMP_ASSET_NAME_HEX },
  vaults: [{ vault_type: "Schedule", address: VAULT_ADDRESS }],
  shard_address: SHARD_ADDRESS,
  ref_script_utxos: {
    vault: `${"11".repeat(32)}#0`, shard: `${"22".repeat(32)}#1`, consume: `${"33".repeat(32)}#2`,
  },
  consume: {
    engage_address: ENGAGE_ADDRESS,
    price_beacon_address: VAULT_ADDRESS,
    price_beacon_nft_unit: `${"55".repeat(28)}cafe`,
  },
};

/** `apps.magic` có mục đích cho `consume` nhưng KHÔNG cho `schedule-commit`. */
const FEECOVER_MAGIC = { url: "https://feecover.example", apps: { magic: { purposes: { consume: "consume_magic" } } } };
/** Không có ứng dụng mặc định `magic`. */
const FEECOVER_NO_MAGIC = {
  url: "https://feecover.example",
  apps: { orilife: { token_sha256: "ab".repeat(32), purposes: { consume: "orilife_consume_magic" } } },
};

interface HarnessOpts {
  feecover?: Record<string, unknown>;
  ownerUtxos?: UTxO[];
  /** UTxO ở các địa chỉ khác (ví chủ thứ hai, …), theo địa chỉ. */
  addressUtxos?: Record<string, UTxO[]>;
  /** UTxO chuỗi ghi sẵn trả được THEO THAM CHIẾU — đường dựng thật đọc UTxO trả phí kiểu đó. */
  refUtxos?: UTxO[];
}

function harness(o: HarnessOpts = {}) {
  const deployment: Deployment = parseDeployment(JSON.stringify({
    ...BASE_DEPLOYMENT, ...(o.feecover === undefined ? {} : { feecover: o.feecover }),
  }), "Preview");
  const chain = new RecordedChainReader(
    {
      [VAULT_ADDRESS]: [VAULT_UTXO],
      [ENGAGE_ADDRESS]: [threadUtxo(KEY_OWNER, "7e".repeat(32))],
      [OWNER_FEE_ADDRESS]: o.ownerUtxos ?? [],
      ...(o.addressUtxos ?? {}),
    },
    TIP,
    [VAULT_UTXO, ...(o.refUtxos ?? [])],
  );
  const builder = new FeeModelBuilder();
  const issued = new IssuedTxRegistry(TTL * 4);
  const locks = new OwnerLockTable(TTL);
  const record = vi.spyOn(issued, "record");
  const acquire = vi.spyOn(locks, "acquire");
  const fetchCalls: string[] = [];
  const fetch: FetchLike = async (url) => { fetchCalls.push(url); return { status: 500, text: async () => "" }; };
  const service = new VaultTxService({
    network: "Preview", deployment, chain, builder, locks, issued, lockTtlMs: TTL, now: () => NOW,
  });
  const feeProxy = deployment.feecover === undefined ? undefined : new FeeProxy({
    settings: deployment.feecover, magicToken: "magic-app-token-for-tests-" + "q".repeat(24), issued, fetch,
    now: () => NOW,
  });
  const router: RouterDeps = {
    service, deploymentSource: deployment.source, vaultScopes: deployment.vaults, network: "Preview",
    chainLabel: "recorded", changeAddressStrategy: "enterprise_from_owner_pkh", token: "", logInternal: () => {},
    ...(feeProxy === undefined ? {} : { feeProxy }),
  };
  return { builder, router, issued, locks, record, acquire, fetchCalls };
}

const post = (url: string, body: unknown) => ({ method: "POST", url, headers: {}, body });
const codeOf = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;
const CONSUME = { owner_pkh: OWNER_PKH, op_type: 1, op_count: "2" };
const COMMIT = { owner_pkh: OWNER_PKH, schedule_length: "3", lamp_per_epoch: "7000000" };
const quote = (body: Record<string, unknown>) => post("/tx/quote", body);

interface QuoteBody {
  feecover: { fee_lovelace: string; available: boolean; reason?: string };
  owner_address: {
    fee_lovelace: string; available: boolean; needed_lovelace: string; collateral_lovelace: string;
    fee_payer?: { utxo: string; address: string }; reason?: string;
  };
  valid_until: string;
}
const bodyOf = (r: { status: number; body: unknown }): QuoteBody => {
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as QuoteBody;
};

/** needed với ví enterprise của chủ: max(phí 172 552, thế chấp 3 000 000) + min-ADA(base) 969 750.
 *  Cùng con số lucid 0.4.30 dựng được (needed) và từ chối (needed − 1) trong lượt đo ở `feeQuote.ts`. */
const OWNER_NEEDED = 3_969_750n;
const ownerAda = (lovelace: bigint, idx = 0) => utxo("0e".repeat(32), idx, OWNER_FEE_ADDRESS, { lovelace });
/** Ví khoá thứ hai (enterprise, khoá khác, cùng độ dài ⟹ cùng phí + cùng ngưỡng với ví thứ nhất). */
const OWNER2_FEE_ADDRESS = enterpriseAddressOf("Preview", OTHER_OWNER_PKH);
/** Ví base của chủ: dài hơn enterprise ⟹ phí FEE_BASE, ngưỡng vẫn OWNER_NEEDED (min-ADA đã lấy dạng base). */
const OWNER_BASE_FEE_ADDRESS = credentialToAddress("Preview",
  { type: "Key", hash: OWNER_PKH }, { type: "Key", hash: OTHER_OWNER_PKH });
const COLLATERAL_STR = String(COLLATERAL);
const refOf = (u: UTxO) => `${u.txHash}#${u.outputIndex}`;
/** `owner_address` khi chọn được `u` (ví enterprise). */
const ownerPicked = (u: UTxO) => ({
  fee_lovelace: String(FEE_ENTERPRISE), available: true, needed_lovelace: String(OWNER_NEEDED),
  collateral_lovelace: COLLATERAL_STR, fee_payer: { utxo: refOf(u), address: u.address },
});

// ── hình dạng thân báo giá ─────────────────────────────────────────────────────

describe("/tx/quote — thân bài", () => {
  it("dương: consume, đủ ba khối, hạn = min(validTo, expires_at)", async () => {
    const h = harness({ feecover: FEECOVER_MAGIC, ownerUtxos: [ownerAda(50_000_000n)] });
    const b = bodyOf(await handle(quote({ route: "consume", params: CONSUME, owner_fee_addresses: [OWNER_FEE_ADDRESS] }), h.router));
    expect(b.feecover).toEqual({ fee_lovelace: String(FEE_BASE), available: true });
    expect(b.owner_address).toEqual(ownerPicked(ownerAda(50_000_000n)));
    // expires_at = NOW + TTL (180 s) < validTo = NOW + 30 phút ⟹ lấy cái NGẮN hơn.
    expect(b.valid_until).toBe(new Date(NOW + TTL).toISOString());
  });

  it("CẶP: route lạ ⟹ 400 FEE_QUOTE_ROUTE_UNKNOWN; trường lạ ⟹ 400 FEE_QUOTE_SHAPE; bộ dựng không bị gọi", async () => {
    const h = harness();
    const a = await handle(quote({ route: "submit", params: CONSUME }), h.router);
    expect(a.status).toBe(400);
    expect(codeOf(a)).toBe("FEE_QUOTE_ROUTE_UNKNOWN");
    const b = await handle(quote({ route: "consume", params: CONSUME, fee: "1" }), h.router);
    expect(codeOf(b)).toBe("FEE_QUOTE_SHAPE");
    const c = await handle(quote({ route: "consume", params: "x" }), h.router);
    expect(codeOf(c)).toBe("FEE_QUOTE_SHAPE");
    expect(h.builder.seen).toHaveLength(0);
  });
});

// ── params mang ví trả phí ─────────────────────────────────────────────────────

describe("/tx/quote — params KHÔNG được mang ví trả phí", () => {
  it("params.fee_payer ⟹ 400 FEE_QUOTE_FEE_PAYER_IN_PARAMS, bộ dựng không bị gọi", async () => {
    const h = harness();
    const r = await handle(quote({
      route: "consume", params: { ...CONSUME, fee_payer: { utxo: `${"fa".repeat(32)}#0`, address: OWNER_FEE_ADDRESS } },
    }), h.router);
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe("FEE_QUOTE_FEE_PAYER_IN_PARAMS");
    expect(h.builder.seen).toHaveLength(0);
  });

  it("create-vault: params.funding.fee_payer ⟹ 400 FEE_QUOTE_FEE_PAYER_IN_PARAMS; vắng funding ⟹ 400 FEE_QUOTE_FUNDING_REQUIRED", async () => {
    const h = harness();
    const funding = { type: "did_payment", did_payment_script_cbor: "aa", address: OWNER_FEE_ADDRESS };
    const cv = { owner_pkh: OWNER_PKH, kind: "schedule", lamp_amount: "1000000" };
    const a = await handle(quote({
      route: "create-vault", params: { ...cv, funding: { ...funding, fee_payer: { utxo: `${"fa".repeat(32)}#0`, address: OWNER_FEE_ADDRESS } } },
    }), h.router);
    expect(codeOf(a)).toBe("FEE_QUOTE_FEE_PAYER_IN_PARAMS");
    expect((a.body as { error: { details: { field: string } } }).error.details.field).toBe("params.funding.fee_payer");
    const b = await handle(quote({ route: "create-vault", params: { ...cv, change_address: OWNER_FEE_ADDRESS } }), h.router);
    expect(codeOf(b)).toBe("FEE_QUOTE_FUNDING_REQUIRED");
  });

  it("create-vault: params.funding.fee_source = did_payment ⟹ 400 FEE_QUOTE_SELF_FUNDED; CẶP fee_source = fee_payer ⟹ KHÔNG mã đó", async () => {
    const h = harness();
    const funding = { type: "did_payment", did_payment_script_cbor: "aa", address: OWNER_FEE_ADDRESS };
    const cv = { owner_pkh: OWNER_PKH, kind: "schedule", lamp_amount: "1000000" };
    const a = await handle(quote({ route: "create-vault", params: { ...cv, funding: { ...funding, fee_source: "did_payment" } } }), h.router);
    expect(a.status).toBe(400);
    expect(codeOf(a)).toBe("FEE_QUOTE_SELF_FUNDED");
    expect((a.body as { error: { details: { field: string } } }).error.details.field).toBe("params.funding.fee_source");
    expect(h.builder.seen).toHaveLength(0);
    const b = await handle(quote({ route: "create-vault", params: { ...cv, funding: { ...funding, fee_source: "fee_payer" } } }), h.router);
    expect(codeOf(b)).not.toBe("FEE_QUOTE_SELF_FUNDED");
  });

  it("CẶP: cùng params, bỏ fee_payer ⟹ 200", async () => {
    const h = harness();
    bodyOf(await handle(quote({ route: "consume", params: CONSUME }), h.router));
  });
});

// ── lỗi của params giữ ĐÚNG mã đường dựng ─────────────────────────────────────

describe("/tx/quote — lỗi của params mang mã của đường dựng", () => {
  const same = async (route: string, params: Record<string, unknown>, direct: Record<string, unknown>) => {
    const h = harness();
    const viaRoute = await handle(post(`/tx/${route}`, direct), h.router);
    const viaQuote = await handle(quote({ route, params }), h.router);
    expect(viaRoute.status).not.toBe(200);
    expect({ status: viaQuote.status, code: codeOf(viaQuote) }).toEqual({ status: viaRoute.status, code: codeOf(viaRoute) });
    return codeOf(viaQuote);
  };

  it("số JSON cho op_count ⟹ BAD_REQUEST, như /tx/consume", async () => {
    expect(await same("consume", { ...CONSUME, op_count: 2 }, { ...CONSUME, op_count: 2 })).toBe("BAD_REQUEST");
  });

  it("chủ chưa có vault ⟹ 404 VAULT_NOT_FOUND, như /tx/schedule-commit (lỗi trạng thái chuỗi)", async () => {
    const p = { ...COMMIT, owner_pkh: OTHER_OWNER_PKH };
    expect(await same("schedule-commit", p, p)).toBe("VAULT_NOT_FOUND");
  });

  it("change_address trong params ⟹ FEE_PAYER_CHANGE_ADDRESS_CONFLICT, như đường dựng khi có fee_payer", async () => {
    const fp = { utxo: `${"fa".repeat(32)}#0`, address: OWNER_FEE_ADDRESS };
    const p = { ...COMMIT, change_address: OWNER_FEE_ADDRESS };
    expect(await same("schedule-commit", p, { ...p, fee_payer: fp })).toBe("FEE_PAYER_CHANGE_ADDRESS_CONFLICT");
  });

  it("open-thread ⟹ 422 FEE_PAYER_DEPOSIT_UNSOURCED, như /tx/open-thread với fee_payer; không giành khoá", async () => {
    const fp = { utxo: `${"fa".repeat(32)}#0`, address: OWNER_FEE_ADDRESS };
    const p = { owner_pkh: OWNER_PKH };
    const h = harness();
    expect(await same("open-thread", p, { ...p, fee_payer: fp })).toBe("FEE_PAYER_DEPOSIT_UNSOURCED");
    const r = await handle(quote({ route: "open-thread", params: p }), h.router);
    expect(codeOf(r)).toBe("FEE_PAYER_DEPOSIT_UNSOURCED");
    expect(h.acquire).not.toHaveBeenCalled();
  });

  it("CẶP: params đúng ⟹ 200 ở cả hai (schedule-commit)", async () => {
    const h = harness();
    bodyOf(await handle(quote({ route: "schedule-commit", params: COMMIT }), h.router));
  });
});

// ── nguồn Feecover ─────────────────────────────────────────────────────────────

describe("/tx/quote — feecover.available", () => {
  it("bản deploy không khai feecover ⟹ false, FEE_QUOTE_FEECOVER_UNCONFIGURED; phí vẫn có", async () => {
    const h = harness();
    const b = bodyOf(await handle(quote({ route: "consume", params: CONSUME }), h.router));
    expect(b.feecover).toEqual({ fee_lovelace: String(FEE_BASE), available: false, reason: "FEE_QUOTE_FEECOVER_UNCONFIGURED" });
  });

  it("app mặc định không có mục đích cho route ⟹ false, FEE_QUOTE_FEECOVER_PURPOSE_UNMAPPED", async () => {
    const h = harness({ feecover: FEECOVER_MAGIC });
    const b = bodyOf(await handle(quote({ route: "schedule-commit", params: COMMIT }), h.router));
    expect(b.feecover.available).toBe(false);
    expect(b.feecover.reason).toBe("FEE_QUOTE_FEECOVER_PURPOSE_UNMAPPED");
  });

  it("feecover khai mà không có app mặc định ⟹ false, FEE_QUOTE_FEECOVER_NO_DEFAULT_APP", async () => {
    const h = harness({ feecover: FEECOVER_NO_MAGIC });
    const b = bodyOf(await handle(quote({ route: "consume", params: CONSUME }), h.router));
    expect(b.feecover).toEqual({ fee_lovelace: String(FEE_BASE), available: false, reason: "FEE_QUOTE_FEECOVER_NO_DEFAULT_APP" });
  });

  it("CẶP: app mặc định có mục đích cho consume ⟹ true, không reason", async () => {
    const h = harness({ feecover: FEECOVER_MAGIC });
    const b = bodyOf(await handle(quote({ route: "consume", params: CONSUME }), h.router));
    expect(b.feecover).toEqual({ fee_lovelace: String(FEE_BASE), available: true });
  });

  it("UTxO tổng hợp: địa chỉ base (dài hơn enterprise), khoá khác chủ, KHÔNG đọc chuỗi cho nó", async () => {
    const h = harness();
    bodyOf(await handle(quote({ route: "consume", params: CONSUME }), h.router));
    const synth = h.builder.seen[0]!;
    const d = getAddressDetails(synth.address);
    expect(d.type).toBe("Base");
    expect(d.paymentCredential?.hash).not.toBe(OWNER_PKH);
    // Mã hoá rộng nhất ở hai trục còn lại: lượng ≥ 2³² (9 byte), chỉ số lớn nhất OUTREF nhận.
    expect(synth.assets.lovelace! >= 2n ** 32n).toBe(true);
    expect(synth.outputIndex).toBe(99_999);
    // Chuỗi ghi sẵn chỉ biết VAULT_UTXO theo tham chiếu và NÉM với tham chiếu lạ: 200 ở trên là
    // bằng chứng không lượt nào đọc chuỗi cho UTxO tổng hợp.
  });
});

// ── nguồn chủ ──────────────────────────────────────────────────────────────────

describe("/tx/quote — owner_address.available", () => {
  const q = (h: ReturnType<typeof harness>, owner_fee_addresses?: unknown) => handle(quote({
    route: "consume", params: CONSUME, ...(owner_fee_addresses === undefined ? {} : { owner_fee_addresses }),
  }), h.router);

  it("không gửi owner_fee_addresses ⟹ false, FEE_QUOTE_OWNER_ADDRESSES_ABSENT, số của ví tổng hợp, không fee_payer", async () => {
    const h = harness();
    const b = bodyOf(await q(h));
    expect(b.owner_address).toEqual({
      fee_lovelace: String(FEE_BASE), available: false, needed_lovelace: String(OWNER_NEEDED),
      collateral_lovelace: COLLATERAL_STR, reason: "FEE_QUOTE_OWNER_ADDRESSES_ABSENT",
    });
    expect("fee_payer" in b.owner_address).toBe(false);
  });

  it("CẶP: mảng rỗng ⟹ cùng kết quả như vắng (ABSENT), không đọc UTxO của chủ", async () => {
    const h = harness({ ownerUtxos: [ownerAda(50_000_000n)] });
    const b = bodyOf(await q(h, []));
    expect(b.owner_address.reason).toBe("FEE_QUOTE_OWNER_ADDRESSES_ABSENT");
    expect(b.owner_address.available).toBe(false);
    expect(h.builder.seen).toHaveLength(1);
  });

  it("gửi trường cũ owner_fee_address (số ít) ⟹ 400 FEE_QUOTE_SHAPE, bộ dựng không bị gọi", async () => {
    const h = harness();
    const r = await handle(quote({ route: "consume", params: CONSUME, owner_fee_address: OWNER_FEE_ADDRESS }), h.router);
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe("FEE_QUOTE_SHAPE");
    expect(h.builder.seen).toHaveLength(0);
  });

  it("owner_fee_addresses là chuỗi thay vì mảng ⟹ 400 FEE_QUOTE_SHAPE", async () => {
    const h = harness();
    expect(codeOf(await q(h, OWNER_FEE_ADDRESS))).toBe("FEE_QUOTE_SHAPE");
    expect(h.builder.seen).toHaveLength(0);
  });

  it("11 địa chỉ ⟹ 400 FEE_QUOTE_OWNER_ADDRESSES_TOO_MANY; CẶP: 10 địa chỉ ⟹ 200", async () => {
    const addrs = Array.from({ length: 11 }, (_, i) => enterpriseAddressOf("Preview", (i + 16).toString(16).repeat(28)));
    const h = harness();
    const r = await q(h, addrs);
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe("FEE_QUOTE_OWNER_ADDRESSES_TOO_MANY");
    expect(h.builder.seen).toHaveLength(0);
    const ok = bodyOf(await q(harness(), addrs.slice(0, 10)));
    expect(ok.owner_address.reason).toBe("FEE_QUOTE_OWNER_NO_ADA_UTXO");
  });

  it("địa chỉ trùng ⟹ 400 FEE_QUOTE_OWNER_ADDRESSES_DUPLICATE; CẶP: hai địa chỉ khác nhau ⟹ 200", async () => {
    const h = harness();
    const r = await q(h, [OWNER_FEE_ADDRESS, OWNER2_FEE_ADDRESS, OWNER_FEE_ADDRESS]);
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe("FEE_QUOTE_OWNER_ADDRESSES_DUPLICATE");
    expect(h.builder.seen).toHaveLength(0);
    bodyOf(await q(harness(), [OWNER_FEE_ADDRESS, OWNER2_FEE_ADDRESS]));
  });

  it("địa chỉ không có UTxO thuần ADA (chỉ UTxO mang token) ⟹ false, FEE_QUOTE_OWNER_NO_ADA_UTXO, không fee_payer", async () => {
    const tokenOnly = utxo("0d".repeat(32), 0, OWNER_FEE_ADDRESS, { lovelace: 90_000_000n, [LAMP_UNIT]: 5n });
    const h = harness({ ownerUtxos: [tokenOnly] });
    const b = bodyOf(await q(h, [OWNER_FEE_ADDRESS]));
    expect(b.owner_address).toEqual({
      fee_lovelace: String(FEE_ENTERPRISE), available: false, needed_lovelace: String(OWNER_NEEDED),
      collateral_lovelace: COLLATERAL_STR, reason: "FEE_QUOTE_OWNER_NO_ADA_UTXO",
    });
    expect("fee_payer" in b.owner_address).toBe(false);
  });

  it("UTxO mang token NHỎ HƠN bị bỏ qua, chọn UTxO thuần ADA lớn hơn", async () => {
    const token = utxo("0d".repeat(32), 0, OWNER_FEE_ADDRESS, { lovelace: 5_000_000n, [LAMP_UNIT]: 5n });
    const pure = ownerAda(50_000_000n);
    const b = bodyOf(await q(harness({ ownerUtxos: [token, pure] }), [OWNER_FEE_ADDRESS]));
    expect(b.owner_address).toEqual(ownerPicked(pure));
  });

  it("CẶP đối chứng: cùng 5 ADA nhưng thuần ADA ⟹ được chọn (nhỏ nhất đủ)", async () => {
    const small = utxo("0d".repeat(32), 0, OWNER_FEE_ADDRESS, { lovelace: 5_000_000n });
    const b = bodyOf(await q(harness({ ownerUtxos: [small, ownerAda(50_000_000n)] }), [OWNER_FEE_ADDRESS]));
    expect(b.owner_address).toEqual(ownerPicked(small));
  });

  it("chọn UTxO NHỎ NHẤT còn ≥ needed: bỏ UTxO needed − 1, không lấy UTxO lớn; không dựng với UTxO dưới ngưỡng", async () => {
    const below = ownerAda(OWNER_NEEDED - 1n, 0);
    const big = ownerAda(50_000_000n, 1);
    const mid = ownerAda(10_000_000n, 2);
    const large = ownerAda(20_000_000n, 3);
    const h = harness({ ownerUtxos: [below, big, mid, large] });
    const b = bodyOf(await q(h, [OWNER_FEE_ADDRESS]));
    expect(b.owner_address).toEqual(ownerPicked(mid));
    expect(h.builder.seen.map(refOf)).not.toContain(refOf(below));
    expect(h.builder.seen.map(refOf)).not.toContain(refOf(big));
  });

  it("CẶP: UTxO thuần ADA = needed đúng ⟹ được chọn; dựng với ĐÚNG UTxO đó, phí lấy từ lượt dựng ấy", async () => {
    const exact = ownerAda(OWNER_NEEDED);
    const h = harness({ ownerUtxos: [ownerAda(1_000_000n, 1), exact, ownerAda(50_000_000n, 2)] });
    const b = bodyOf(await q(h, [OWNER_FEE_ADDRESS]));
    expect(b.owner_address).toEqual(ownerPicked(exact));
    expect(refOf(h.builder.seen[h.builder.seen.length - 1]!)).toBe(refOf(exact));
  });

  it("lượt dựng thật cho needed cao hơn ngưỡng tổng hợp ⟹ bỏ UTxO đó, thử UTxO kế tiếp (lớn hơn)", async () => {
    // Trục phí chưa đo: phí thật của `small` cao hơn 4 ADA ⟹ needed thật = 4 172 552 + 969 750 > 5 ADA.
    // CẶP đối chứng của ca "cùng 5 ADA nhưng thuần ADA ⟹ được chọn" ở trên: chỉ khác phí cộng thêm.
    const small = utxo("0d".repeat(32), 0, OWNER_FEE_ADDRESS, { lovelace: 5_000_000n });
    const next = ownerAda(10_000_000n);
    const h = harness({ ownerUtxos: [small, next] });
    h.builder.extraFee.set(refOf(small), 4_000_000n);
    const b = bodyOf(await q(h, [OWNER_FEE_ADDRESS]));
    expect(b.owner_address).toEqual(ownerPicked(next));
    expect(h.builder.seen.map(refOf)).toContain(refOf(small));
  });

  it("UTxO thuần ADA lớn nhất = needed − 1 ⟹ false, FEE_QUOTE_OWNER_INSUFFICIENT; không dựng với UTxO thật", async () => {
    const h = harness({ ownerUtxos: [ownerAda(OWNER_NEEDED - 1n), ownerAda(1_000_000n, 1)] });
    const b = bodyOf(await q(h, [OWNER_FEE_ADDRESS]));
    expect(b.owner_address).toEqual({
      fee_lovelace: String(FEE_ENTERPRISE), available: false, needed_lovelace: String(OWNER_NEEDED),
      collateral_lovelace: COLLATERAL_STR, reason: "FEE_QUOTE_OWNER_INSUFFICIENT",
    });
    expect(h.builder.seen.some(u => u.txHash === "0e".repeat(32))).toBe(false);
  });

  it("hoà lovelace giữa hai địa chỉ ⟹ địa chỉ đứng TRƯỚC trong mảng thắng, kể cả khi txHash của nó lớn hơn", async () => {
    const at2 = utxo("0f".repeat(32), 0, OWNER2_FEE_ADDRESS, { lovelace: 10_000_000n });
    const at1 = ownerAda(10_000_000n);
    const opts = { ownerUtxos: [at1], addressUtxos: { [OWNER2_FEE_ADDRESS]: [at2] } };
    const a = bodyOf(await q(harness(opts), [OWNER2_FEE_ADDRESS, OWNER_FEE_ADDRESS]));
    expect(a.owner_address).toEqual(ownerPicked(at2));
    // CẶP: đảo thứ tự mảng ⟹ đảo lựa chọn.
    const b = bodyOf(await q(harness(opts), [OWNER_FEE_ADDRESS, OWNER2_FEE_ADDRESS]));
    expect(b.owner_address).toEqual(ownerPicked(at1));
  });

  it("nhỏ nhất thắng thứ tự địa chỉ: UTxO nhỏ hơn ở địa chỉ thứ hai được chọn", async () => {
    const at2 = utxo("0f".repeat(32), 0, OWNER2_FEE_ADDRESS, { lovelace: 8_000_000n });
    const opts = { ownerUtxos: [ownerAda(10_000_000n)], addressUtxos: { [OWNER2_FEE_ADDRESS]: [at2] } };
    const b = bodyOf(await q(harness(opts), [OWNER_FEE_ADDRESS, OWNER2_FEE_ADDRESS]));
    expect(b.owner_address).toEqual(ownerPicked(at2));
  });

  it("hoà trong một địa chỉ ⟹ txHash nhỏ hơn, rồi chỉ số output theo SỐ (#9 trước #10)", async () => {
    const i10 = ownerAda(10_000_000n, 10);
    const i9 = ownerAda(10_000_000n, 9);
    const a = bodyOf(await q(harness({ ownerUtxos: [i10, i9] }), [OWNER_FEE_ADDRESS]));
    expect(a.owner_address).toEqual(ownerPicked(i9));
    // CẶP: txHash xếp trước chỉ số — "0d…#50" thắng "0e…#9".
    const h50 = utxo("0d".repeat(32), 50, OWNER_FEE_ADDRESS, { lovelace: 10_000_000n });
    const b = bodyOf(await q(harness({ ownerUtxos: [i9, h50] }), [OWNER_FEE_ADDRESS]));
    expect(b.owner_address).toEqual(ownerPicked(h50));
  });

  it("không chọn được ⟹ fee/needed là số LỚN NHẤT qua mọi địa chỉ, không phụ thuộc thứ tự mảng", async () => {
    for (const order of [[OWNER_FEE_ADDRESS, OWNER_BASE_FEE_ADDRESS], [OWNER_BASE_FEE_ADDRESS, OWNER_FEE_ADDRESS]]) {
      const b = bodyOf(await q(harness(), order));
      expect(b.owner_address).toEqual({
        fee_lovelace: String(FEE_BASE), available: false, needed_lovelace: String(OWNER_NEEDED),
        collateral_lovelace: COLLATERAL_STR, reason: "FEE_QUOTE_OWNER_NO_ADA_UTXO",
      });
    }
  });

  it("một phần tử là địa chỉ script / sai mạng ⟹ 400 FEE_QUOTE_OWNER_ADDRESS_INVALID, bộ dựng không bị gọi", async () => {
    const h = harness();
    const a = await q(h, [OWNER_FEE_ADDRESS, VAULT_ADDRESS]);
    expect(a.status).toBe(400);
    expect(codeOf(a)).toBe("FEE_QUOTE_OWNER_ADDRESS_INVALID");
    const mainnet = credentialToAddress("Mainnet", { type: "Key", hash: OWNER_PKH });
    const b = await q(h, [mainnet]);
    expect(codeOf(b)).toBe("FEE_QUOTE_OWNER_ADDRESS_INVALID");
    expect(h.builder.seen).toHaveLength(0);
  });
});

// ── không giữ chỗ gì ───────────────────────────────────────────────────────────

describe("/tx/quote — không ghi sổ phát-hành, không giành khoá, không gọi Feecover", () => {
  const OWNER_FEE_UTXO = ownerAda(50_000_000n);
  const FP = { utxo: `${OWNER_FEE_UTXO.txHash}#0`, address: OWNER_FEE_ADDRESS };

  it("báo giá đủ ba lượt dựng ⟹ sổ rỗng, khoá không bị giành, Feecover 0 lượt; /tx/consume ngay sau vẫn 200", async () => {
    const h = harness({ feecover: FEECOVER_MAGIC, ownerUtxos: [OWNER_FEE_UTXO], refUtxos: [OWNER_FEE_UTXO] });
    bodyOf(await handle(quote({ route: "consume", params: CONSUME, owner_fee_addresses: [OWNER_FEE_ADDRESS] }), h.router));
    expect(h.builder.seen).toHaveLength(3);
    expect(h.record).not.toHaveBeenCalled();
    expect(h.issued.size()).toBe(0);
    expect(h.acquire).not.toHaveBeenCalled();
    expect(h.fetchCalls).toHaveLength(0);
    // Khoá của chủ còn trống: đường dựng thật chạy được ngay, và CHỈ nó ghi sổ.
    const direct = await handle(post("/tx/consume", { ...CONSUME, fee_payer: FP }), h.router);
    expect(direct.status, JSON.stringify(direct.body)).toBe(200);
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.fetchCalls).toHaveLength(0);
  });

  it("CẶP đối chứng: đường dựng thật ghi sổ + giành khoá; lượt thứ hai cùng chủ ⟹ 409", async () => {
    const h = harness({ refUtxos: [OWNER_FEE_UTXO] });
    const first = await handle(post("/tx/consume", { ...CONSUME, fee_payer: FP }), h.router);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.acquire).toHaveBeenCalledTimes(1);
    const again = await handle(post("/tx/consume", { ...CONSUME, fee_payer: FP }), h.router);
    expect(again.status).toBe(409);
  });
});
