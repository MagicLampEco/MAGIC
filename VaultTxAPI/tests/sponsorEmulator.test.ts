// VaultTxAPI/tests/sponsorEmulator.test.ts — hành trình tài trợ consume đầu đi trọn open-vault → fund-vault → draw-magic → first-consume
// qua CHÍNH route HTTP (`http.ts` ▸ `handle` → `sponsor.ts` ▸ `SponsorTxService`), trên Lucid
// Emulator, đánh giá UPLC THẬT (blueprint `ConsumeMAGIC/onchain/plutus.json` +
// `PrepaidGen/onchain/plutus.json`, do `aiken build` sinh).
//
// Khuôn dựng nền chép từ `MagicSDK/tests/sponsorJourney.test.ts`; khác ở hai chỗ:
//
//   1. Dịch vụ dựng tx, bài chỉ KÝ và NỘP — vai của app + ví người dùng + bên tài trợ. Dịch vụ không
//      cầm khoá nào: `lucidForWallet` chỉ chọn ví CHỈ-ĐỌC (`fromAddress`), đúng như `txBuilder.ts`.
//   2. `noSigningMaterial.test.ts` quét CẢ thư mục tests/, nên bài không dùng đường ký của lucid. Ba
//      khoá thử (ví trả phí, chủ, bên tài trợ) là cặp ed25519 sinh TRONG BỘ NHỚ bằng `node:crypto`,
//      chết theo tiến trình; chữ ký ghép vào tx bằng `assemble` như một ví ngoài trả nhân chứng về.
//      Phép quét kia đo theo TÊN, nên nó không nhìn thấy dạng này — xem "chốt không ghim" ở cuối tệp.
//
// Chủ là KHOÁ (không `did_stake`): nhánh chủ script cần nhân chứng PhoenixKey thật, bài SDK phủ nó.

import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { bech32 } from "bech32";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CML,
  Constr,
  Data,
  Emulator,
  Lucid,
  PROTOCOL_PARAMETERS_DEFAULT,
  applyParamsToScript,
  credentialToAddress,
  scriptFromNative,
  validatorToAddress,
  validatorToScriptHash,
  type EmulatorAccount,
  type LucidEvolution,
  type TxBuilder,
  type UTxO,
  type Validator,
} from "@lucid-evolution/lucid";
import { encodePriceParam } from "@magiclamp/consumemagic";
import { buildSponsorT1OpenPrepaid } from "@magiclamp/sdk";
import {
  PrepaidVaultRedeemerSchema,
  addMintPaidFund,
  computeFundId,
  decodeFundDatum,
  plutusDataToCbor,
  decodeVaultDatum,
  derivePrepaidScripts,
  encodeVaultDatum,
  parMagicFromCarp,
  withRefScripts,
  type PrepaidScripts,
  type PrepaidBlueprint,
  type PrepaidVaultRedeemer, addSettleLine, maxClaimable } from "@magiclamp/prepaidgen-sdk";
import { msPerEpoch, wakemeVaultHash, windowOriginMs } from "@magiclamp/protocol-utils";
import { beforeAll, describe, expect, it } from "vitest";

import type { ChainReader } from "../src/chain.js";
import { parseDeployment, PREPAID_VAULT_TYPE } from "../src/config.js";
import { handle, type RouterDeps } from "../src/http.js";
import { IssuedTxRegistry, OwnerLockTable } from "../src/locks.js";
import type { VaultTxService } from "../src/service.js";
import { createPlatformSigner } from "../src/platformSigner.js";
import { SponsorTxService, checkSponsorFeePayerTx, type SponsorFeePayerCheckContext } from "../src/sponsor.js";
import { LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID } from "./fixtures/preview.js";

// ── Lưới + hằng ───────────────────────────────────────────────────────────────

const NET = "Preprod" as const;
const P = msPerEpoch(NET);
const O = windowOriginMs(NET);
const E0 = 330n;
const CARP = 1_000_000_000n;
const CARP_POLICY = "22".repeat(28);
const CARP_NAME = "5a".repeat(28);
const CARP_UNIT = CARP_POLICY + CARP_NAME;
const PREPAID_BURN_CONSTR = 2n;
const MAX_PRICE_STALE = 2n;
const PRICE_NFT_NAME = "5052494345";
// Mỗi DID một quỹ tài trợ (`sponsorFund.ts`) ⟹ mỗi chủ một DID riêng: chủ · chủ thứ hai · người mới.
const DID_COMMIT = "d1".repeat(32);
const DID_COMMIT2 = "d2".repeat(32);
const DID_NEW = "d3".repeat(32);
const DID_OPEN = "d4".repeat(32); // người mới của hành trình open-fund: CHƯA có quỹ nào lúc dựng nền
const DID_CO = "d5".repeat(32);   // người mới của hành trình open-vault CHỞ genesis quỹ (dịch vụ ký platform)
const DID_NOKEY = "d6".repeat(32); // cấu hình đủ ghim nhưng dịch vụ KHÔNG có khoá platform ⟹ 501
/** `beneficiary_datum` ghim ở cấu hình open-fund: `InboxDatum { refund = Key(7a…) }`, CBOR mảng không-định-độ-dài. */
const OPEN_BEN_DATUM = `d8799fd8799f581c${"7a".repeat(28)}ffff`;
const SLOW = 900_000;

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const CM_BP = here("../../ConsumeMAGIC/onchain/plutus.json");
const PG_BP = here("../../PrepaidGen/onchain/plutus.json");

// ── Khoá thử trong bộ nhớ ─────────────────────────────────────────────────────

interface TestKey { pkh: string; address: string; pub: Uint8Array; sec: KeyObject }

function newKey(): TestKey {
  const pair = Object.values(generateKeyPairSync("ed25519")) as KeyObject[];
  const pubObj = pair.find(k => k.type === "public")!;
  const sec = pair.find(k => k.type !== "public")!;
  const der = pubObj.export({ format: "der", type: "spki" });
  const pub = new Uint8Array(der.subarray(der.length - 32));
  const pkh = CML.PublicKey.from_bytes(pub).hash().to_hex();
  return { pkh, address: credentialToAddress(NET, { type: "Key", hash: pkh }), pub, sec };
}

/** Khoá thử dạng bech32 `ed25519_sk…` — đúng hình dạng giá trị của biến khoá platform (32 byte cuối của PKCS#8). */
function skBech32(k: TestKey): string {
  const der = k.sec.export({ format: "der", type: "pkcs8" });
  return bech32.encode("ed25519_sk", bech32.toWords(new Uint8Array(der.subarray(der.length - 32))), 1000);
}

/** Bộ nhân chứng vkey của `keys` trên đúng thân tx `txCbor` (CBOR hex của witness set). */
function witnessSet(txCbor: string, keys: TestKey[]): string {
  const body = CML.Transaction.from_cbor_hex(txCbor).body();
  const msg = CML.hash_transaction(body).to_raw_bytes();
  const list = CML.VkeywitnessList.new();
  for (const k of keys) {
    list.add(CML.Vkeywitness.new(
      CML.PublicKey.from_bytes(k.pub),
      CML.Ed25519Signature.from_raw_bytes(new Uint8Array(edSign(null, msg, k.sec))),
    ));
  }
  const ws = CML.TransactionWitnessSet.new();
  ws.set_vkeywitnesses(list);
  return ws.to_cbor_hex();
}

/** tx mang ĐÚNG MỘT vkey witness: của platform, chữ ký đúng trên hash thân tx (cực đối: lệch một bit ⟹ false). */
function expectPlatformWitnessOnly(txCbor: string): void {
  const tx = CML.Transaction.from_cbor_hex(txCbor);
  const vk = tx.witness_set().vkeywitnesses();
  expect(vk?.len()).toBe(1);
  const w = vk!.get(0);
  expect(w.vkey().hash().to_hex()).toBe(platformKey.pkh);
  const msg = CML.hash_transaction(tx.body()).to_raw_bytes();
  expect(w.vkey().verify(msg, w.ed25519_signature())).toBe(true);
  const other = new Uint8Array(msg);
  other[0] = other[0]! ^ 1;
  expect(w.vkey().verify(other, w.ed25519_signature())).toBe(false);
}

/** Số đo một tx: byte CBOR, phí, Σ mem / Σ steps của mọi redeemer (đọc thẳng CBOR). */
function measureTx(txCbor: string): { bytes: number; fee: string; mem: string; steps: string } {
  const tx = CML.Transaction.from_cbor_hex(txCbor);
  let mem = 0n;
  let steps = 0n;
  const rd = tx.witness_set().redeemers();
  const legacy = rd?.as_arr_legacy_redeemer();
  for (let i = 0; legacy !== undefined && i < legacy.len(); i++) {
    const u = legacy.get(i).ex_units();
    mem += u.mem(); steps += u.steps();
  }
  const map = rd?.as_map_redeemer_key_to_redeemer_val();
  const ks = map?.keys();
  for (let i = 0; ks !== undefined && i < ks.len(); i++) {
    const u = map!.get(ks.get(i))!.ex_units();
    mem += u.mem(); steps += u.steps();
  }
  return { bytes: txCbor.length / 2, fee: tx.body().fee().toString(), mem: mem.toString(), steps: steps.toString() };
}

// ── Trạng thái dùng chung ─────────────────────────────────────────────────────

let emulator: Emulator;
let lucid: LucidEvolution;
let fee: TestKey;     // ví khoá của người mới: phí + thế chấp + tiền thừa
let owner: TestKey;   // chủ két (chủ khoá)
let sponsor: TestKey; // bên tài trợ: giữ CARP, platform của quỹ
let owner2: TestKey;  // chủ thứ hai — chỉ để đo khoá `utxo:` (hai chủ, hai quỹ, chung UTxO bên tài trợ)
let attacker: TestKey; // kẻ gọi: có ADA + CARP riêng, tự đúc một quỹ KHÔNG ghim
let feecover: TestKey; // ví trả phí bên thứ ba (Feecover) của hành trình `fee_payer`: chỉ có ADA
let poorFp: TestKey;   // ví trả phí chỉ có MỘT UTxO 4 ADA — không đủ ứng min-ADA két + thread
let newcomer: TestKey; // người mới của hành trình `fee_payer`: KHÔNG có UTxO nào (0 ADA) suốt hành trình
let sponsorBaseAddr = ""; // cùng KHOÁ bên tài trợ, khác phần stake — ví trả phí "giả khác"
let platformKey: TestKey;    // khoá platform THỬ (sinh trong bài, không phải khoá thật) — vai Feecover ký genesis quỹ
let opener: TestKey;         // chủ của hành trình open-fund (DID_OPEN)
let beneficiaryKey: TestKey; // đích nhận CARP ghim ở cấu hình open-fund (≠ platform, ≠ bên tài trợ)
let feecover2: TestKey;      // ví trả phí bên thứ ba của tx open-fund
let svcOpen: SponsorTxService;     // cấu hình open-fund: platform_pkhs + beneficiary, KHÔNG fund_units
let svcSetClosed: SponsorTxService; // cấu hình có cả fund_units ⟹ open-fund 501 SPONSOR_FUND_SET_CLOSED
let svcOtherBen: SponsorTxService;  // cùng cấu hình open-fund, beneficiary ghim KHÁC ⟹ quỹ open-fund tạo thành foreign_beneficiary
let svcOpenNoKey: SponsorTxService; // cùng ghim với svcOpen, KHÔNG hàm ký platform ⟹ route cần tạo quỹ trả 501
let pgScripts: PrepaidScripts; // bộ script Prepaid có ref-script (SettleLine dựng bằng SDK ở bài claim)
let coOwner: TestKey;  // chủ của hành trình open-vault chở genesis quỹ (DID_CO)
let coOwner2: TestKey; // chủ thứ hai cùng DID_CO: open-vault khi DID đã có quỹ ⟹ không genesis thứ hai
/** Số lần hàm ký platform được gọi (bọc quanh `createPlatformSigner` của svcOpen/svcSetClosed). */
let platformSignCalls = 0;
/** Mở két "kiểu cũ" (trước khi open-vault chở quỹ): dựng thẳng bằng SDK, không qua route. Trả NFT két. */
let legacyOpenVault: (did: string, who: TestKey, payer: TestKey) => Promise<string>;
let svcOpenTwo: SponsorTxService;   // cấu hình open-fund với HAI ví bên tài trợ ghim [sponsor, attacker] — quỹ ghi addresses[0]
let CPB = 0n;                       // coinsPerUtxoByte của Emulator — trần khoản ứng ở checkSponsorFeePayerTx
let openLocks: OwnerLockTable;
let deploymentNoDid = "";
let svc: SponsorTxService;
let svcNoDid: SponsorTxService;
let svcStakeEngage: SponsorTxService;
let locks: OwnerLockTable;
let fundAddress = "";
let fundUnit = "";
let fundId = "";
let fundId2 = "";       // quỹ tài trợ của DID_COMMIT2 (chủ thứ hai), ĐÃ ghim
let fundIdNew = "";     // quỹ tài trợ của DID_NEW (người mới của hành trình fee_payer), ĐÃ ghim
let fundUnitNew = "";
let fundIdNone = "";    // quỹ CHUNG (sponsorship = None), ĐÃ ghim — hành trình tài trợ không bao giờ dùng
// Quỹ do kẻ gọi đúc bằng `addMintPaidFund`, KHÔNG ghim: ghi đúng ví bên tài trợ + DID của chủ (genesis
// chỉ đòi chữ ký platform = kẻ gọi) — đúng ca mà việc quét địa chỉ quỹ theo `sponsor` sẽ nhận nhầm.
let attackerFundId = "";
let vaultUnit = "";
let threadUnit = "";
let anchorRef = "";
let drawEpoch = 0;
let epochEndMs = 0n;

const refStr = (u: { txHash: string; outputIndex: number }) => `${u.txHash}#${u.outputIndex}`;
const nowMs = () => BigInt(emulator.now());

function describeError(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause;
    return `${e.name}: ${e.message}${cause === undefined ? "" : ` | cause: ${typeof cause === "string" ? cause : JSON.stringify(cause)}`}`;
  }
  return typeof e === "string" ? e : JSON.stringify(e);
}

/** Ký bằng `keys` rồi nộp; trả hash. Hỏng ⟹ NÉM kèm lý do của Emulator. */
async function signAndSubmit(txCbor: string, keys: TestKey[]): Promise<string> {
  const signed = await lucid.fromTx(txCbor).assemble([witnessSet(txCbor, keys)]).complete();
  const h = await signed.submit();
  emulator.awaitBlock(1);
  return h;
}

/** Dựng nền do ví `k` trả: ví chỉ-đọc mang UTxO hiện tại của `k`. */
async function asWallet(k: TestKey, build: (l: LucidEvolution) => TxBuilder): Promise<string> {
  lucid.selectWallet.fromAddress(k.address, await emulator.getUtxos(k.address));
  const c = await build(lucid).completeSafe();
  if (c._tag === "Left") throw new Error(describeError(c.left));
  return signAndSubmit(c.right.toCBOR(), [k]);
}
const asSponsor = (build: (l: LucidEvolution) => TxBuilder) => asWallet(sponsor, build);

async function only(unit: string): Promise<UTxO> {
  const u = (await emulator.getUtxoByUnit(unit)) as UTxO | undefined;
  if (!u) throw new Error(`không có UTxO nào mang ${unit}`);
  return u;
}

function unspent(): UTxO[] {
  return Object.values(emulator.ledger).filter(e => !e.spent).map(e => e.utxo);
}

/** ChainReader ảo trên Emulator — cùng hợp đồng với `chain.ts` (scriptRef đi kèm UTxO). */
function emulatorChain(): ChainReader {
  return {
    label: "emulator",
    utxosAt: a => emulator.getUtxos(a),
    utxosByOutRef: r => emulator.getUtxosByOutRef(r),
    utxosByUnit: async u => unspent().filter(x => (x.assets[u] ?? 0n) > 0n),
    tip: async () => ({ blockHeight: emulator.blockHeight, blockHash: "00".repeat(32), blockTimePosixMs: nowMs() }),
    submitTx: c => emulator.submitTx(c),
    rewardAccount: async () => { throw new Error("bài chủ khoá không đọc tài khoản thưởng"); },
    txStatus: async () => { throw new Error("hành trình tài trợ không tra trạng thái tx"); },
  };
}

function routerDeps(s: SponsorTxService): RouterDeps {
  return {
    service: {} as unknown as VaultTxService, // đường /tx/sponsor/* không chạm dịch vụ cũ
    deploymentSource: "emulator",
    vaultScopes: [],
    network: NET,
    chainLabel: "emulator",
    changeAddressStrategy: "owner-enterprise",
    token: "",
    logInternal: (ref, cause) => { throw new Error(`lỗi nội bộ ${ref}: ${describeError(cause)}`); },
    sponsor: s,
    sponsorToken: SPONSOR_ROLE_TOKEN,
  };
}

type Body = Record<string, unknown>;
/** fund-vault chỉ mở bằng thẻ vai sponsor (`http.ts` ▸ `requireRole`); các route khác giữ thẻ thường (rỗng ở đây). */
const SPONSOR_ROLE_TOKEN = "vai-sponsor-emu";
/**
 * Sample transactions for fee-payer integrators. OFF in a default run: only when `VTA_SAMPLE_TX_DIR` is set by
 * hand does this write `<name>.cbor.hex` (the tx exactly as the route returns it, platform witness attached) and
 * `<name>.tx_hash`. The files are Emulator transactions, not chain records; do not commit them.
 */
function dumpSampleTx(name: string, b: Body): void {
  const dir = process.env.VTA_SAMPLE_TX_DIR;
  if (dir === undefined || dir === "") return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${name}.cbor.hex`, `${b.tx_cbor as string}\n`);
  writeFileSync(`${dir}/${name}.tx_hash`, `${b.tx_hash as string}\n`);
}

async function post(path: string, body: Body, s: SponsorTxService = svc): Promise<{ status: number; body: Body }> {
  const headers = path === "/tx/sponsor/fund-vault" || path === "/tx/sponsor/claim"
    ? { authorization: `Bearer ${SPONSOR_ROLE_TOKEN}` } : {};
  return handle({ method: "POST", url: path, headers, body }, routerDeps(s));
}
const errCode = (r: { body: Body }) => (r.body.error as { code: string } | undefined)?.code;
const ownerBody = () => ({ owner: { type: "key", hash: owner.pkh }, change_address: fee.address });

/** Đáp ứng 200 của một bước, hoặc NÉM kèm lỗi máy chủ trả. */
async function step(path: string, body: Body): Promise<Body> {
  const r = await post(path, body);
  if (r.status !== 200) throw new Error(`${path} ⟹ ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

/** Vai ký: đúng thứ tự `planSponsorJourney`; mỗi `required_signers` phải thuộc một vai. */
function expectSigners(b: Body, roles: string[], want: Record<string, string[]>): void {
  const signers = b.signers as Array<{ role: string; key_hashes: string[] }>;
  expect(signers.map(s => s.role)).toEqual(roles);
  for (const s of signers) expect(s.key_hashes).toEqual(want[s.role]);
  const all = new Set(signers.flatMap(s => s.key_hashes));
  for (const r of b.required_signers as string[]) expect(all.has(r)).toBe(true);
  expect(b.required_signers).toContain(owner.pkh);
  expect(typeof b.tx_hash).toBe("string");
  expect(CML.hash_transaction(CML.Transaction.from_cbor_hex(b.tx_cbor as string).body()).to_hex()).toBe(b.tx_hash);
}

function applyConsumeParams(bp: { validators: Array<{ title: string; compiledCode: string; parameters?: Array<{ title: string }> }> }, p: {
  priceNftPolicy: string; priceNftName: string; vaultScriptHash: string; priceParamScriptHash: string;
}): Validator {
  const v = bp.validators.find(x => x.title === "consume.consume.spend");
  if (!v) throw new Error("blueprint ConsumeMAGIC thiếu consume.consume.spend — chạy `aiken build ConsumeMAGIC/onchain`");
  const want = [
    "price_nft_policy", "price_nft_name", "vault_script_hash", "burn_batch_constr",
    "max_price_stale", "ms_per_epoch", "price_param_script_hash", "window_origin_ms",
  ];
  const got = (v.parameters ?? []).map(x => x.title);
  if (got.join(",") !== want.join(",")) throw new Error(`apply-param consume trong blueprint là [${got}], bài này biết [${want}]`);
  return {
    type: "PlutusV3",
    script: applyParamsToScript(v.compiledCode, [
      p.priceNftPolicy, p.priceNftName, p.vaultScriptHash, PREPAID_BURN_CONSTR,
      MAX_PRICE_STALE, P, p.priceParamScriptHash, O,
    ]),
  };
}

// ── Dựng nền ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
  for (const p of [CM_BP, PG_BP]) {
    if (!existsSync(p)) throw new Error(`không thấy blueprint ${p} — chạy \`aiken build\` của module đó`);
  }
  const cmBp = JSON.parse(readFileSync(CM_BP, "utf8"));
  const pgBp: PrepaidBlueprint = JSON.parse(readFileSync(PG_BP, "utf8"));

  fee = newKey();
  owner = newKey();
  sponsor = newKey();
  owner2 = newKey();
  attacker = newKey();
  feecover = newKey();
  poorFp = newKey();
  newcomer = newKey();
  platformKey = newKey();
  opener = newKey();
  beneficiaryKey = newKey();
  feecover2 = newKey();
  coOwner = newKey();
  coOwner2 = newKey();
  sponsorBaseAddr = credentialToAddress(NET, { type: "Key", hash: sponsor.pkh }, { type: "Key", hash: attacker.pkh });
  const acct = (address: string, assets: Record<string, bigint>) => ({ address, assets }) as unknown as EmulatorAccount;
  emulator = new Emulator([
    acct(sponsor.address, { lovelace: 5_000_000_000n, [CARP_UNIT]: 100n * CARP }),
    acct(fee.address, { lovelace: 1_000_000_000n }),
    acct(fee.address, { lovelace: 1_000_000_000n }),
    acct(owner.address, { lovelace: 20_000_000n }),
    acct(owner2.address, { lovelace: 20_000_000n }),
    // Kẻ gọi có CARP THẬT (cùng unit): ca "UTxO CARP của kẻ gọi" phải chết ở ghim địa chỉ, không ở "không có CARP".
    acct(attacker.address, { lovelace: 1_000_000_000n, [CARP_UNIT]: 5n * CARP }),
    // Hành trình `fee_payer`: người mới KHÔNG có tài khoản nào ở đây — 0 ADA.
    acct(feecover.address, { lovelace: 200_000_000n }),
    acct(poorFp.address, { lovelace: 4_000_000n }),
    acct(poorFp.address, { lovelace: 1_500_000n }), // first-consume: dưới lượng thế chấp tường minh (3 ADA)
    acct(sponsorBaseAddr, { lovelace: 50_000_000n }),
    // Hành trình open-fund: chủ (`opener`) chỉ có ADA cho open-vault/bind-did; Feecover thứ hai trả phí tx tạo quỹ.
    acct(opener.address, { lovelace: 20_000_000n }),
    acct(feecover2.address, { lovelace: 100_000_000n }),
  ], { ...PROTOCOL_PARAMETERS_DEFAULT, maxTxSize: 16_384, maxTxExMem: 16_500_000n, maxTxExSteps: 10_000_000_000n });
  // Lucid đặt lưới slot "Custom" theo `emulator.now()` LÚC KHỞI TẠO ⟹ đặt giờ trước. Đỉnh cách biên kỳ 60 s.
  emulator.time = Number(O + E0 * P + 60_000n);
  lucid = await Lucid(emulator, "Custom");

  // `wakemeVaultHash(NET)`: cùng nguồn dịch vụ dùng ở `SponsorTxService.prepare` — lệch nguồn
  // ⟹ hash quỹ lệch cấu hình ⟹ 501 SCRIPTS_MISMATCH.
  const base = derivePrepaidScripts(pgBp, NET, {
    carpPolicyId: CARP_POLICY, carpAssetName: CARP_NAME, msPerEpoch: P, windowOriginMs: O,
    wakemeVaultHash: wakemeVaultHash(NET),
  });

  // Một địa chỉ khoá giữ beacon / anchor / ref-script (native sig của bên tài trợ).
  const lockNative = scriptFromNative({ type: "sig", keyHash: sponsor.pkh });
  const lockHash = validatorToScriptHash(lockNative);
  const lockAddr = validatorToAddress(NET, lockNative);
  const priceNative = scriptFromNative({ type: "sig", keyHash: sponsor.pkh });
  const pricePolicy = validatorToScriptHash(priceNative);
  const beaconUnit = pricePolicy + PRICE_NFT_NAME;
  const consumeScript = applyConsumeParams(cmBp, {
    priceNftPolicy: pricePolicy, priceNftName: PRICE_NFT_NAME, vaultScriptHash: base.vault.hash, priceParamScriptHash: lockHash,
  });

  await asSponsor(l => l.newTx()
    .mintAssets({ [beaconUnit]: 1n })
    .attach.MintingPolicy(priceNative)
    .pay.ToContract(lockAddr, {
      kind: "inline",
      value: encodePriceParam({
        op_prices: [{ op_type: 1n, base_price: 10_000_000n, demand_mult: 1_000_000_000n }],
        m_min: 500_000_000n, m_max: 2_000_000_000n, epoch: E0,
      }),
    }, { lovelace: 3_000_000n, [beaconUnit]: 1n }));

  // Anchor DID của người mới: NFT tên = owner_commit = did_commit của két; policy native đứng thay.
  const anchorNative = scriptFromNative({ type: "all", scripts: [{ type: "sig", keyHash: sponsor.pkh }] });
  const anchorPolicy = validatorToScriptHash(anchorNative);
  // Ba DID, ba anchor, CHUNG một output ⟹ `anchor_ref` của mọi hành trình là cùng một tham chiếu.
  const anchors = Object.fromEntries([DID_COMMIT, DID_COMMIT2, DID_NEW, DID_OPEN, DID_CO].map(d => [anchorPolicy + d, 1n]));
  const ah = await asSponsor(l => l.newTx()
    .mintAssets(anchors)
    .attach.MintingPolicy(anchorNative)
    .pay.ToAddress(lockAddr, { lovelace: 5_000_000n, ...anchors }));
  anchorRef = `${ah}#0`;

  const ch = await asSponsor(l => l.newTx().pay.ToAddressWithData(lockAddr, undefined, { lovelace: 30_000_000n }, consumeScript));
  const vh = await asSponsor(l => l.newTx().pay.ToAddressWithData(lockAddr, undefined, { lovelace: 40_000_000n }, base.vault.script));
  const fh = await asSponsor(l => l.newTx().pay.ToAddressWithData(lockAddr, undefined, { lovelace: 40_000_000n }, base.paidFund.script));
  const [vaultRef, fundRef] = await emulator.getUtxosByOutRef([{ txHash: vh, outputIndex: 0 }, { txHash: fh, outputIndex: 0 }]);
  const scripts = withRefScripts(base, { vault: vaultRef!, paidFund: fundRef! });
  pgScripts = scripts;

  // Quỹ do ví `k` đúc (platform = `k`, bên hưởng = chủ — không quan trọng cho hành trình). `did` có ⟹
  // quỹ TÀI TRỢ của DID đó, bên tài trợ = ví `sponsor`; vắng ⟹ quỹ chung (sponsorship = None).
  const mintFund = async (k: TestKey, did?: string): Promise<{ nftUnit: string; fundId: string }> => {
    const seedH = await asWallet(k, l => l.newTx().pay.ToAddress(k.address, { lovelace: 10_000_000n }));
    const seedUtxo = (await emulator.getUtxosByOutRef([{ txHash: seedH, outputIndex: 0 }]))[0]!;
    let minted: { nftUnit: string; fundId: string } | undefined;
    await asWallet(k, l => {
      const f = addMintPaidFund(l.newTx(), {
        scripts, seedUtxo, platformPkh: k.pkh,
        beneficiary: { payment_credential: { VerificationKey: [owner.pkh] }, stake_credential: null },
        beneficiaryDatum: null, bufferBps: 1_500n, collectSeed: true,
        ...(did === undefined ? {} : {
          sponsorship: { sponsor: { payment_credential: { VerificationKey: [sponsor.pkh] }, stake_credential: null }, owner_commit: did },
          validity: { fromMs: nowMs() - 1_000n, toMs: nowMs() + 600_000n },
        }),
      });
      minted = f;
      return f.tx;
    });
    return minted!;
  };
  // Bốn quỹ ĐÃ ghim (bên tài trợ đúc: ba quỹ tài trợ theo DID + một quỹ chung) + một quỹ kẻ gọi tự đúc
  // — cùng script quỹ, cùng địa chỉ quỹ.
  const f1 = await mintFund(sponsor, DID_COMMIT);
  fundUnit = f1.nftUnit;
  fundId = f1.fundId;
  const f2 = await mintFund(sponsor, DID_COMMIT2);
  fundId2 = f2.fundId;
  const fNew = await mintFund(sponsor, DID_NEW);
  fundIdNew = fNew.fundId;
  fundUnitNew = fNew.nftUnit;
  const fNone = await mintFund(sponsor);
  fundIdNone = fNone.fundId;
  attackerFundId = (await mintFund(attacker, DID_COMMIT)).fundId;
  fundAddress = base.paidFund.address;
  // Tách CARP bên tài trợ thành HAI UTxO (ca khoá `utxo:` cần hai bộ ref khác nhau). Lượt CUỐI của bên
  // tài trợ trong dựng nền: lượt sau có thể gộp lại hai UTxO này qua chọn-coin.
  await asSponsor(l => l.newTx().pay.ToAddress(sponsor.address, { lovelace: 2_000_000n, [CARP_UNIT]: 10n * CARP }));

  const pinnedSponsor = {
    fund_units: [fundUnit, f2.nftUnit, fNew.nftUnit, fNone.nftUnit], addresses: [sponsor.address],
    max_carp_amount: CARP.toString(),
    // Đệm của các quỹ dựng nền (`mintFund`) — fund-vault ghim đệm = cấu hình (#161-4).
    buffer_bps: "1500",
  };
  const deployment = (
    withDid: boolean, engageAddress = validatorToAddress(NET, consumeScript), sponsorPins: Record<string, unknown> = pinnedSponsor,
  ) => JSON.stringify({
    source: "Emulator của phép kiểm — không phải một lần deploy thật",
    lamp: { policy_id: LAMP_POLICY_ID, asset_name_hex: LAMP_ASSET_NAME_HEX },
    consume: {
      engage_address: engageAddress,
      price_beacon_address: lockAddr,
      price_beacon_nft_unit: beaconUnit,
      max_price_stale: Number(MAX_PRICE_STALE),
    },
    ...(withDid ? { did_stake: { anchor_nft_policy: anchorPolicy } } : {}),
    vaults: [{ vault_type: PREPAID_VAULT_TYPE, address: validatorToAddress(NET, base.vault.script) }],
    paid_fund: {
      address: base.paidFund.address, carp_unit: CARP_UNIT,
      // Ghim của fund-vault (mặc định): chỉ bốn quỹ bên tài trợ đúc, chỉ ví bên tài trợ, trần một lượt = CARP.
      sponsor: sponsorPins,
    },
    ref_script_utxos: { vault: `${vh}#0`, paid_fund: `${fh}#0`, consume: `${ch}#0` },
  });
  deploymentNoDid = deployment(false);

  // Khoá platform THỬ của dịch vụ: đúng hình dạng sản xuất (bech32 → `createPlatformSigner`), bọc bộ đếm lượt gọi.
  const platformSignRaw = createPlatformSigner({
    keyBech32: skBech32(platformKey), expectedPkh: platformKey.pkh, paidFundPolicy: base.paidFund.hash,
    tokenValues: [SPONSOR_ROLE_TOKEN],
    network: NET, carpUnit: CARP_UNIT, beneficiary: { address: beneficiaryKey.address, datumCbor: OPEN_BEN_DATUM },
  });
  const platformSign: typeof platformSignRaw = r => { platformSignCalls += 1; return platformSignRaw(r); };
  // Két mở TRƯỚC bản open-vault chở quỹ: chỉ két + thread, dựng thẳng bằng SDK (bước bù open-fund phủ ca này).
  const consumeRefUtxo = (await emulator.getUtxosByOutRef([{ txHash: ch, outputIndex: 0 }]))[0]!;
  legacyOpenVault = async (did, who, payer) => {
    const utxos = await emulator.getUtxos(payer.address);
    lucid.selectWallet.fromAddress(payer.address, utxos);
    const seed = utxos.find(u => Object.keys(u.assets).every(k => k === "lovelace"))!;
    const r = await buildSponsorT1OpenPrepaid({
      lucid, prepaidScripts: scripts, consumeScript, consumeRefUtxo, seedUtxo: seed,
      owner: { type: "key", hash: who.pkh }, ownerAuth: { kind: "key", pkh: who.pkh }, didCommit: did, network: NET,
    });
    await signAndSubmit(r.txCbor, [payer, who]);
    return r.summary.vaultUnit;
  };

  const mk = (json: string, l: OwnerLockTable, sign?: ReturnType<typeof createPlatformSigner>) => new SponsorTxService({
    network: NET,
    deployment: parseDeployment(json, NET),
    chain: emulatorChain(),
    locks: l,
    issued: new IssuedTxRegistry(),
    lockTtlMs: 60_000,
    now: () => emulator.now(),
    prepaidBlueprint: pgBp,
    lucidForWallet: async (address, utxos) => { lucid.selectWallet.fromAddress(address, utxos); return lucid; },
    // Chủ KHOÁ cho bài này (nhánh chủ Script cần nhân chứng PhoenixKey thật); `server.ts` không truyền cờ này.
    allowKeyOwner: true,
    // Lucid ở đây chạy lưới slot "Custom" (gốc = giờ Emulator) ⟹ `ttl` phải đọc trên cùng lưới đó.
    slotNetwork: "Custom",
    ...(sign === undefined ? {} : { platformSign: sign }),
  });
  locks = new OwnerLockTable(60_000);
  svc = mk(deployment(true), locks);
  svcNoDid = mk(deploymentNoDid, new OwnerLockTable(60_000));
  // open-fund: gốc tin cậy = khoá platform (quét địa chỉ quỹ), KHÔNG tập quỹ đóng. Mọi quỹ dựng nền ở trên
  // mang platform = sponsor/attacker ⟹ bị loại ở bước quét (foreign_platform), DID_OPEN bắt đầu với 0 quỹ.
  const openPins = {
    platform_pkhs: [platformKey.pkh], addresses: [sponsor.address], max_carp_amount: CARP.toString(),
    beneficiary: beneficiaryKey.address,
    // Datum đích dạng `InboxDatum { refund }` (Constr0[Constr0[key28]]): đi qua đường `plutusDataFromCbor` của open-fund
    // và phép so datum của ghim beneficiary ở fund-vault.
    beneficiary_datum: OPEN_BEN_DATUM,
  };
  openLocks = new OwnerLockTable(60_000);
  svcOpen = mk(deployment(true, undefined, openPins), openLocks, platformSign);
  svcOpenNoKey = mk(deployment(true, undefined, openPins), new OwnerLockTable(60_000));
  svcSetClosed = mk(deployment(true, undefined, { ...openPins, fund_units: [fundUnit] }), new OwnerLockTable(60_000), platformSign);
  svcOtherBen = mk(deployment(true, undefined, { ...openPins, beneficiary: opener.address }), new OwnerLockTable(60_000));
  // #161-1: hai ví bên tài trợ ghim; quỹ open-fund ghi addresses[0] = sponsor. Chung khoá với svcOpen.
  svcOpenTwo = mk(deployment(true, undefined, { ...openPins, addresses: [sponsor.address, attacker.address] }), openLocks);
  CPB = BigInt(lucid.config().protocolParameters!.coinsPerUtxoByte);
  // Cùng script consume, địa chỉ engage KHÁC (thêm phần stake): cổng script chỉ so HASH nên cho qua;
  // tx do SDK dựng gửi thread tới địa chỉ không-stake ⟹ chỉ phép đọc-lại output (`nftOutput`) chặn được.
  svcStakeEngage = mk(deployment(true, credentialToAddress(NET,
    { type: "Script", hash: validatorToScriptHash(consumeScript) }, { type: "Key", hash: sponsor.pkh })), new OwnerLockTable(60_000));
}, SLOW);

/** Nộp xong ⟹ nhả khoá chủ theo hash (máy chủ thật nhả ở `/tx/submit` hoặc khi hết TTL). */
async function submitStep(b: Body, keys: TestKey[]): Promise<string> {
  const h = await signAndSubmit(b.tx_cbor as string, keys);
  expect(h).toBe(b.tx_hash);
  locks.releaseByTxHash(h);
  return h;
}

/**
 * Gắn DID cho két Prepaid qua route `/tx/sponsor/bind-did` (bộ dựng `@magiclamp/prepaidgen-sdk` ▸
 * `addSetDidCommit`, nhánh `SetDidCommit` constr 5) — bước bắt buộc trước fund-vault: `validate_lock` ▸
 * khối `sponsorship` đòi `did_commit` của KÉT == `owner_commit`, mà két đúc ra với `did_commit` rỗng.
 * `payer` trả phí + thế chấp; `who` (chủ) ký. Validator THẬT chấp nhận tx ⟹ datum két mang đúng `did`.
 */
async function bindVaultDid(unit: string, did: string, who: TestKey, payer: TestKey): Promise<void> {
  expect(decodeVaultDatum((await only(unit)).datum!).did_commit).toBe("");
  const b = await step("/tx/sponsor/bind-did", { owner: { type: "key", hash: who.pkh }, change_address: payer.address });
  expect(b.step).toBe("bind-did");
  expect((b.summary as Body).did_commit).toBe(did);
  expect((b.signers as Array<{ role: string }>).map(s => s.role)).toEqual(["fee-wallet", "owner"]);
  expect(b.required_signers).toContain(who.pkh);
  await submitStep(b, [payer, who]);
  expect(decodeVaultDatum((await only(unit)).datum!).did_commit).toBe(did);
}

// ── Hành trình qua route ──────────────────────────────────────────────────────

describe("hành trình tài trợ qua route HTTP — script thật trên Emulator", () => {
  it("open-vault XANH: /tx/sponsor/open-vault ⟹ một tx đúc két + thread; vai ký = ví phí · chủ; nộp được", async () => {
    const b = await step("/tx/sponsor/open-vault", { ...ownerBody(), did_commit: DID_COMMIT });
    expect(b.step).toBe("open-vault");
    expectSigners(b, ["fee-wallet", "owner"], { "fee-wallet": [fee.pkh], owner: [owner.pkh] });
    const s = b.summary as Body;
    expect(s.did_commit).toBe(DID_COMMIT);
    vaultUnit = s.vault_unit as string;
    threadUnit = s.thread_unit as string;
    await submitStep(b, [fee, owner]);
    expect(refStr(await only(vaultUnit))).toBe(s.vault_out_ref);
    expect(refStr(await only(threadUnit))).toBe(s.thread_out_ref);
    // did_commit nằm ở THREAD (trường 3), két genesis giữ rỗng — chỗ fund-vault phải đọc để định vị anchor.
    expect(decodeVaultDatum((await only(vaultUnit)).datum!).did_commit).toBe("");
    expect((Data.from((await only(threadUnit)).datum!) as Constr<Data>).fields[3]).toBe(DID_COMMIT);
  }, SLOW);

  it("open-vault ĐỎ (cực đối): chủ đã có két ⟹ 409 VAULT_ALREADY_EXISTS, không dựng két thứ hai", async () => {
    const r = await post("/tx/sponsor/open-vault", { ...ownerBody(), did_commit: DID_COMMIT });
    expect(r.status).toBe(409);
    expect(errCode(r)).toBe("VAULT_ALREADY_EXISTS");
  }, SLOW);

  it("open-vault ĐỎ: thread rơi ngoài engage_address đã cấu hình (khác phần stake) ⟹ 422 SPONSOR_TX_MISMATCH, không phát tx", async () => {
    const other = newKey(); // chủ khác, chưa có két — để không chết sớm ở VAULT_ALREADY_EXISTS
    const r = await post("/tx/sponsor/open-vault",
      { owner: { type: "key", hash: other.pkh }, change_address: fee.address, did_commit: DID_COMMIT }, svcStakeEngage);
    expect(r.status).toBe(422);
    expect(errCode(r)).toBe("SPONSOR_TX_MISMATCH");
    expect(JSON.stringify(r.body)).toContain("thread");
  }, SLOW);

  /** UTxO mang CARP của ví `k`, xếp theo lượng CARP tăng dần (UTxO tách 10·CARP đứng đầu). */
  const carpRefs = async (k: TestKey): Promise<string[]> => (await emulator.getUtxos(k.address))
    .filter(u => (u.assets[CARP_UNIT] ?? 0n) > 0n)
    .sort((a, b) => (a.assets[CARP_UNIT]! < b.assets[CARP_UNIT]! ? -1 : 1))
    .map(refStr);
  // Thân fund-vault KHÔNG có `sponsor.change_address`: phần thối suy từ địa chỉ chung của `utxo_refs`.
  // `fund: null` ⟹ KHÔNG gửi `fund_id` (dịch vụ tìm quỹ của DID).
  const fundBody = async (o: { refs?: string[]; fund?: string | null; carp?: bigint; who?: TestKey } = {}): Promise<Body> => ({
    owner: { type: "key", hash: (o.who ?? owner).pkh }, change_address: fee.address,
    ...(o.fund === null ? {} : { fund_id: o.fund ?? fundId }), carp_amount: (o.carp ?? CARP).toString(),
    sponsor: { utxo_refs: o.refs ?? await carpRefs(sponsor) },
  });

  it("fund-vault ĐỎ: bản deploy khớp script mà thiếu did_stake ⟹ 501 CONFIG_MISSING nêu did_stake.anchor_nft_policy", async () => {
    const r = await post("/tx/sponsor/fund-vault", await fundBody(), svcNoDid);
    expect(r.status).toBe(501);
    expect(errCode(r)).toBe("CONFIG_MISSING");
    expect(JSON.stringify(r.body)).toContain("did_stake.anchor_nft_policy");
  }, SLOW);

  it("fund-vault ĐỎ: két chưa gắn DID ⟹ 409 SPONSOR_VAULT_DID_UNSET, không dựng; CẶP: gắn DID (SetDidCommit) rồi đi tiếp", async () => {
    const r = await post("/tx/sponsor/fund-vault", await fundBody({ fund: null }));
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(errCode(r)).toBe("SPONSOR_VAULT_DID_UNSET");
    expect(locks.peek(owner.pkh, emulator.now())).toBeNull();
    await bindVaultDid(vaultUnit, DID_COMMIT, owner, fee);
  }, SLOW);

  it("fund-vault ĐỎ: fund_id là quỹ tài trợ của DID KHÁC ⟹ 422 SPONSOR_FUND_DID_MISMATCH; quỹ chung ⟹ 422 SPONSOR_FUND_NOT_ALLOWED", async () => {
    const other = await post("/tx/sponsor/fund-vault", await fundBody({ fund: fundId2 }));
    expect(other.status, JSON.stringify(other.body)).toBe(422);
    expect(errCode(other)).toBe("SPONSOR_FUND_DID_MISMATCH");
    const pooled = await post("/tx/sponsor/fund-vault", await fundBody({ fund: fundIdNone }));
    expect(pooled.status).toBe(422);
    expect(errCode(pooled)).toBe("SPONSOR_FUND_NOT_ALLOWED");
    expect(JSON.stringify(pooled.body)).toContain("not_sponsored");
  }, SLOW);

  // Ca âm của các ghim fund-vault. Cặp xanh của (a)–(d) là "fund-vault XANH" ngay dưới: cùng thân bài, khác ĐÚNG một khoá.
  it("fund-vault ĐỎ (a): thân bài gửi sponsor.change_address (đích thối của kẻ gọi) ⟹ 400 SPONSOR_REQUEST_SHAPE", async () => {
    const b = await fundBody();
    const r = await post("/tx/sponsor/fund-vault",
      { ...b, sponsor: { ...(b.sponsor as Body), change_address: attacker.address } });
    expect(r.status).toBe(400);
    expect(errCode(r)).toBe("SPONSOR_REQUEST_SHAPE");
    expect(JSON.stringify(r.body)).toContain("sponsor.change_address");
  }, SLOW);

  it("fund-vault ĐỎ (b): quỹ do kẻ gọi tự đúc bằng addMintPaidFund (cùng script quỹ) ⟹ 422 SPONSOR_FUND_NOT_ALLOWED", async () => {
    expect(await only(`${fundUnit.slice(0, 56)}${attackerFundId}`)).toBeDefined(); // quỹ đó CÓ THẬT trên chuỗi
    const r = await post("/tx/sponsor/fund-vault", await fundBody({ fund: attackerFundId }));
    expect(r.status).toBe(422);
    expect(errCode(r)).toBe("SPONSOR_FUND_NOT_ALLOWED");
  }, SLOW);

  it("fund-vault ĐỎ (c): utxo_refs là UTxO CARP của ví kẻ gọi ⟹ 422 SPONSOR_UTXO_NOT_ALLOWED", async () => {
    const refs = await carpRefs(attacker);
    expect(refs.length).toBeGreaterThan(0);
    const r = await post("/tx/sponsor/fund-vault", await fundBody({ refs }));
    expect(r.status).toBe(422);
    expect(errCode(r)).toBe("SPONSOR_UTXO_NOT_ALLOWED");
  }, SLOW);

  it("fund-vault ĐỎ (d): carp_amount = trần + 1 ⟹ 422 SPONSOR_CARP_ABOVE_CAP", async () => {
    const r = await post("/tx/sponsor/fund-vault", await fundBody({ carp: CARP + 1n }));
    expect(r.status).toBe(422);
    expect(errCode(r)).toBe("SPONSOR_CARP_ABOVE_CAP");
  }, SLOW);

  it("open-vault XANH (chủ thứ hai): mở két cho owner2 — nền cho ca khoá utxo:", async () => {
    const b = await step("/tx/sponsor/open-vault",
      { owner: { type: "key", hash: owner2.pkh }, change_address: fee.address, did_commit: DID_COMMIT2 });
    await submitStep(b, [fee, owner2]);
    await bindVaultDid((b.summary as Body).vault_unit as string, DID_COMMIT2, owner2, fee);
  }, SLOW);

  it("fund-vault (e): hai chủ, hai quỹ ghim, CHUNG utxo_refs ⟹ lượt sau THAY lượt trước, không 409 (đổi từ OWNER_TX_IN_FLIGHT, 2026-10-03); CẶP: đổi bộ ref ⟹ dựng được", async () => {
    const [refA, refB] = await carpRefs(sponsor);
    expect(refA).toBeDefined();
    expect(refB).toBeDefined();
    // Lượt 1 dựng xong, KHÔNG nộp — giữ khoá owner · fund:<quỹ 1> · utxo:<refA>.
    const b1 = await step("/tx/sponsor/fund-vault", await fundBody({ refs: [refA!] }));
    try {
      // Khác chủ, khác quỹ ⟹ chỉ khoá `utxo:` trùng. Lượt sau giành khoá `utxo:<refA>`, khoá phụ của
      // b1 nhả; b1 KHÔNG bị đánh dấu thay ở sổ — chỉ một lượt NỘP mới thay được nó (`locks.ts`).
      const r2 = await post("/tx/sponsor/fund-vault", await fundBody({ refs: [refA!], fund: fundId2, who: owner2 }));
      expect(r2.status, JSON.stringify(r2.body)).toBe(200);
      expect(locks.peek(`utxo:${refA!}`, emulator.now())?.txHash).toBe(r2.body.tx_hash);
      expect(locks.peek(owner.pkh, emulator.now())).toBeNull();
      locks.releaseByTxHash(r2.body.tx_hash as string);
      // CẶP: cùng chủ thứ hai + quỹ 2, bộ ref KHÁC ⟹ qua khoá và dựng được.
      const r3 = await post("/tx/sponsor/fund-vault", await fundBody({ refs: [refB!], fund: fundId2, who: owner2 }));
      expect(r3.status).toBe(200);
      expect((r3.body.summary as Body).sponsor_change_address).toBe(sponsor.address);
      locks.releaseByTxHash(r3.body.tx_hash as string);
    } finally {
      locks.releaseByTxHash(b1.tx_hash as string);
    }
  }, SLOW);

  it("fund-vault XANH (không gửi fund_id): dịch vụ tìm quỹ tài trợ CỦA DID; CARP chỉ tới quỹ đó + thối bên tài trợ; anchor ở reference_inputs; thiếu chữ ký bên tài trợ ⟹ chuỗi từ chối", async () => {
    const fundCarpBefore = (await only(fundUnit)).assets[CARP_UNIT] ?? 0n;
    const carpTotal = unspent().reduce((a, u) => a + (u.assets[CARP_UNIT] ?? 0n), 0n);
    const req2 = await fundBody({ fund: null });
    expect(req2.fund_id).toBeUndefined();
    const b = await step("/tx/sponsor/fund-vault", req2);
    // Tập ghim có quỹ của DID khác (chủ thứ hai, người mới) và quỹ chung: dịch vụ chọn ĐÚNG quỹ của DID này.
    expect((b.summary as Body).fund_selection).toBe("did_lookup");
    expect((b.summary as Body).fund_id).toBe(fundId);
    expect(b.step).toBe("fund-vault");
    expectSigners(b, ["fee-wallet", "sponsor", "owner"], { "fee-wallet": [fee.pkh], sponsor: [sponsor.pkh], owner: [owner.pkh] });
    const s = b.summary as Body;
    expect(s.anchor_ref).toBe(anchorRef);
    expect(s.owner_commit).toBe(DID_COMMIT);
    expect(s.fund_unit).toBe(fundUnit);
    expect(s.sponsor_signers).toEqual([sponsor.pkh]);
    // Đích thối do dịch vụ SUY từ địa chỉ chung của utxo_refs, không do thân bài viết.
    expect(s.sponsor_change_address).toBe(sponsor.address);
    expect((req2.sponsor as Body).change_address).toBeUndefined();

    // Đo độc lập với phép kiểm của dịch vụ/SDK: đọc thẳng thân tx bằng CML.
    const refs = CML.Transaction.from_cbor_hex(b.tx_cbor as string).body().reference_inputs();
    const refKeys: string[] = [];
    for (let i = 0; i < (refs?.len() ?? 0); i++) refKeys.push(`${refs!.get(i).transaction_id().to_hex()}#${refs!.get(i).index()}`);
    expect(refKeys).toContain(anchorRef);

    // Chữ ký bên tài trợ là BẮT BUỘC: thiếu nó thì chuỗi từ chối, trạng thái không đổi.
    await expect(signAndSubmit(b.tx_cbor as string, [fee, owner])).rejects.toThrow(`Missing vkey witness. Key hash: ${sponsor.pkh}`);
    await submitStep(b, [fee, sponsor, owner]);

    expect((await only(fundUnit)).assets[CARP_UNIT]).toBe(fundCarpBefore + CARP);
    // CARP của kẻ gọi (dựng nền) nằm yên ở ví kẻ gọi — đo riêng, rồi loại khỏi tập địa chỉ.
    expect(unspent().filter(u => u.address === attacker.address).reduce((a, u) => a + (u.assets[CARP_UNIT] ?? 0n), 0n)).toBe(5n * CARP);
    const carpAt = new Set(unspent().filter(u => (u.assets[CARP_UNIT] ?? 0n) > 0n && u.address !== attacker.address).map(u => u.address));
    expect([...carpAt].sort()).toEqual([fundAddress, sponsor.address].sort());
    expect(unspent().reduce((a, u) => a + (u.assets[CARP_UNIT] ?? 0n), 0n)).toBe(carpTotal);
    expect((await only(fundUnit)).address).toBe(fundAddress);
    expect(decodeVaultDatum((await only(vaultUnit)).datum!).prepaid_credits.length).toBe(1);
    expect(refStr(await only(vaultUnit))).toBe(s.vault_out_ref);
  }, SLOW);

  it("draw-magic XANH: PrepaidDraw ⟹ một lô MAGIC kỳ e; epoch_end_ms là biên kỳ sau", async () => {
    const b = await step("/tx/sponsor/draw-magic", { ...ownerBody(), fund_id: fundId, carp_amount: CARP.toString() });
    expectSigners(b, ["fee-wallet", "owner"], { "fee-wallet": [fee.pkh], owner: [owner.pkh] });
    const s = b.summary as Body;
    expect(s.magic_nanogic).toBe(parMagicFromCarp(CARP).toString());
    drawEpoch = s.epoch as number;
    epochEndMs = BigInt(s.epoch_end_ms as string);
    expect(BigInt(drawEpoch)).toBe((nowMs() - O) / P);
    expect(epochEndMs).toBe(O + (BigInt(drawEpoch) + 1n) * P);
    expect((b.witness_notes as string[]).join(" ")).toContain(epochEndMs.toString());
    await submitStep(b, [fee, owner]);
    const vd = decodeVaultDatum((await only(vaultUnit)).datum!);
    expect(vd.magic_batches.at(-1)!.created_epoch).toBe(BigInt(drawEpoch));
  }, SLOW);

  const firstConsumeBody = (de: number): Body => ({ ...ownerBody(), op_type: 1, op_count: "1", draw_epoch: de });

  it("first-consume ĐỎ: draw_epoch lệch kỳ hiện tại ⟹ 409 SPONSOR_EPOCH_MISMATCH; khoá chủ được nhả", async () => {
    const r = await post("/tx/sponsor/first-consume", firstConsumeBody(drawEpoch - 1));
    expect(r.status).toBe(409);
    expect(errCode(r)).toBe("SPONSOR_EPOCH_MISMATCH");
    expect(locks.peek(owner.pkh, emulator.now())).toBeNull();
  }, SLOW);

  it("first-consume XANH (cực đối, cùng kỳ draw-magic, trước epoch_end_ms): consume đầu + BurnBatch; thread [2,3,4] = [e, did_commit, required]", async () => {
    expect(nowMs()).toBeLessThan(epochEndMs);
    const b = await step("/tx/sponsor/first-consume", firstConsumeBody(drawEpoch));
    expectSigners(b, ["fee-wallet", "owner"], { "fee-wallet": [fee.pkh], owner: [owner.pkh] });
    const s = b.summary as Body;
    expect(s.epoch).toBe(drawEpoch);
    expect(s.thread_unit).toBe(threadUnit);
    expect(s.required_nanogic).toBe("10000000");
    await submitStep(b, [fee, owner]);
    const d = Data.from((await only(threadUnit)).datum!) as Constr<Data>;
    expect(d.fields[2]).toBe(BigInt(drawEpoch));
    expect(d.fields[3]).toBe(DID_COMMIT);
    expect(d.fields[4]).toBe(10_000_000n);
    const vd = decodeVaultDatum((await only(vaultUnit)).datum!);
    expect(vd.magic_batches[0]!.current_amount).toBe(parMagicFromCarp(CARP) - 10_000_000n);
  }, SLOW);
});

// ── Hành trình `fee_payer`: người mới 0 ADA, Feecover trả hết ─────────────────

describe("hành trình fee_payer — người mới 0 ADA, ví trả phí bên thứ ba trả phí + min-ADA", () => {
  type Fp = { utxo: string; address: string };
  /** UTxO thuần ADA LỚN NHẤT ở `address` — hình dạng `fee_payer` của thân bài. */
  const fpAt = async (address: string): Promise<Fp> => {
    const us = (await emulator.getUtxos(address)).filter(u => Object.keys(u.assets).every(x => x === "lovelace"));
    us.sort((a, b) => (a.assets.lovelace! > b.assets.lovelace! ? -1 : 1));
    if (us.length === 0) throw new Error(`${address.slice(0, 20)}… không có UTxO thuần ADA`);
    return { utxo: refStr(us[0]!), address };
  };
  const outRef = (r: string) => ({ txHash: r.split("#")[0]!, outputIndex: Number(r.split("#")[1]!) });
  const utxoOf = async (r: string): Promise<UTxO> => (await emulator.getUtxosByOutRef([outRef(r)]))[0]!;
  const nb = (extra: Body, fp: Fp): Body => ({ owner: { type: "key", hash: newcomer.pkh }, fee_payer: fp, ...extra });
  /** Đo ĐỘC LẬP với dịch vụ: input tx đọc thẳng bằng CML, tra từ Emulator (gọi TRƯỚC khi nộp). */
  const inputsOf = async (txCbor: string): Promise<UTxO[]> => {
    const ins = CML.Transaction.from_cbor_hex(txCbor).body().inputs();
    const refs: Array<{ txHash: string; outputIndex: number }> = [];
    for (let i = 0; i < ins.len(); i++) refs.push({ txHash: ins.get(i).transaction_id().to_hex(), outputIndex: Number(ins.get(i).index()) });
    const got = await emulator.getUtxosByOutRef(refs);
    expect(got.length).toBe(refs.length);
    return got;
  };
  /** Vai ký: ví trả phí = Feecover, chủ = người mới; chủ có trong `required_signers`. */
  const expectFpSigners = (b: Body, roles: string[]) => {
    const signers = b.signers as Array<{ role: string; key_hashes: string[]; how: string }>;
    expect(signers.map(x => x.role)).toEqual(roles);
    expect(signers[0]!.key_hashes).toEqual([feecover.pkh]);
    expect(signers[0]!.how).toContain("fee_payer");
    expect(signers.at(-1)!.key_hashes).toEqual([newcomer.pkh]);
    expect(b.required_signers).toContain(newcomer.pkh);
  };
  /** Input của Feecover = ĐÚNG UTxO đã khai; người mới không góp input nào; tóm tắt fee_payer khớp. */
  const expectFeeFromFeecoverOnly = async (b: Body, fp: Fp): Promise<Body> => {
    const ins = await inputsOf(b.tx_cbor as string);
    expect(ins.filter(u => u.address === feecover.address).map(refStr)).toEqual([fp.utxo]);
    expect(ins.some(u => u.address === newcomer.address)).toBe(false);
    const s = (b.summary as Body).fee_payer as Body;
    expect(s.utxo).toBe(fp.utxo);
    expect(s.address).toBe(feecover.address);
    // Thối về Feecover chỉ ADA (đọc thẳng CBOR).
    const outs = CML.Transaction.from_cbor_hex(b.tx_cbor as string).body().outputs();
    for (let i = 0; i < outs.len(); i++) {
      const o = outs.get(i);
      if (o.address().to_bech32(undefined) === feecover.address) expect(o.amount().multi_asset().policy_count()).toBe(0);
    }
    return s;
  };
  let nVault = "";
  let nThread = "";
  let nDrawEpoch = 0;

  it("open-vault ĐỎ: fee_payer + change_address ⟹ 400 FEE_PAYER_CHANGE_ADDRESS_CONFLICT; funding ⟹ 400 SPONSOR_REQUEST_SHAPE", async () => {
    const fp = await fpAt(feecover.address);
    const a = await post("/tx/sponsor/open-vault", nb({ did_commit: DID_COMMIT, change_address: feecover.address }, fp));
    expect(a.status).toBe(400);
    expect(errCode(a)).toBe("FEE_PAYER_CHANGE_ADDRESS_CONFLICT");
    const f = await post("/tx/sponsor/open-vault",
      { owner: { type: "key", hash: newcomer.pkh }, did_commit: DID_COMMIT, funding: { fee_payer: fp } });
    expect(f.status).toBe(400);
    expect(errCode(f)).toBe("SPONSOR_REQUEST_SHAPE");
    expect(JSON.stringify(f.body)).toContain("funding");
  }, SLOW);

  it("open-vault ĐỎ: fee_payer.utxo không phải UTxO chưa tiêu ⟹ 400 FEE_PAYER_INVALID (không 500)", async () => {
    const r = await post("/tx/sponsor/open-vault", nb({ did_commit: DID_COMMIT }, { utxo: `${"ee".repeat(32)}#0`, address: feecover.address }));
    expect(r.status).toBe(400);
    expect(errCode(r)).toBe("FEE_PAYER_INVALID");
  }, SLOW);

  it("open-vault ĐỎ: ví trả phí chỉ có 4 ADA (không đủ ứng min-ADA két + thread + thế chấp) ⟹ 422 có mã, không 500", async () => {
    const other = newKey();
    const r = await post("/tx/sponsor/open-vault",
      { owner: { type: "key", hash: other.pkh }, fee_payer: await fpAt(poorFp.address), did_commit: DID_COMMIT });
    expect(r.status).toBe(422);
    expect(errCode(r)).toBe("SPONSOR_BUILD_FAILED");
    expect(locks.peek(other.pkh, emulator.now())).toBeNull();
  }, SLOW);

  it("open-vault XANH: người mới 0 ADA; tx tiêu ĐÚNG UTxO Feecover; két + thread do Feecover ứng; thối ADA về Feecover", async () => {
    expect(await emulator.getUtxos(newcomer.address)).toEqual([]);
    const fp = await fpAt(feecover.address);
    const b = await step("/tx/sponsor/open-vault", nb({ did_commit: DID_NEW }, fp));
    expectFpSigners(b, ["fee-wallet", "owner"]);
    const fs = await expectFeeFromFeecoverOnly(b, fp);
    const s = b.summary as Body;
    nVault = s.vault_unit as string;
    nThread = s.thread_unit as string;
    // Khoản ứng = Σ lovelace output không về Feecover (két + thread), đọc thẳng CBOR.
    const outs = CML.Transaction.from_cbor_hex(b.tx_cbor as string).body().outputs();
    let scriptLovelace = 0n;
    const scriptAddrs = new Set<string>();
    for (let i = 0; i < outs.len(); i++) {
      const addr = outs.get(i).address().to_bech32(undefined);
      if (addr !== feecover.address) { scriptLovelace += outs.get(i).amount().coin(); scriptAddrs.add(addr); }
    }
    expect([...scriptAddrs].sort()).toEqual([s.vault_address as string, s.thread_address as string].sort());
    expect(fs.fronted_lovelace).toBe(scriptLovelace.toString());
    expect(BigInt(fs.fronted_lovelace as string)).toBeGreaterThan(0n);
    expect(BigInt(fs.valid_to_posix_ms as string)).toBeLessThanOrEqual(nowMs() + 3_600_000n);

    // Đọc lại (cực đối của tập output ĐÓNG): bỏ một địa chỉ luồng ⟹ FEE_PAYER_TX_MISMATCH.
    const ctx: SponsorFeePayerCheckContext = {
      network: NET, tipPosixMs: nowMs(), feePayer: { utxoRef: outRef(fp.utxo), address: feecover.address },
      feePayerUtxo: await utxoOf(fp.utxo), maxCollateralLovelace: 3_000_000n, otherInputs: [],
      scriptAddresses: [...scriptAddrs], passAddresses: [], coinsPerUtxoByte: CPB,
    };
    expect(checkSponsorFeePayerTx(b.tx_cbor as string, ctx).fronted_lovelace).toBe(fs.fronted_lovelace);
    for (const drop of scriptAddrs) {
      expect(() => checkSponsorFeePayerTx(b.tx_cbor as string, { ...ctx, scriptAddresses: [...scriptAddrs].filter(a => a !== drop) }))
        .toThrow(/ngoài ví trả phí và các địa chỉ của luồng/);
    }
    // Red-team 1 — trần khoản ứng. Tx thật ở trên (két + thread sàn 2 ADA) qua trần (cực đối ngay dưới). Tx tổng hợp
    // (KHÔNG nộp): cùng UTxO Feecover đặt 50 ADA vào địa chỉ thread — đúng hình dạng thread_lovelace lớn — ⟹ 422.
    lucid.selectWallet.fromAddress(feecover.address, [ctx.feePayerUtxo]);
    const fatC = await lucid.newTx().collectFrom([ctx.feePayerUtxo])
      .pay.ToAddress(s.thread_address as string, { lovelace: 50_000_000n }).completeSafe();
    if (fatC._tag === "Left") throw new Error(describeError(fatC.left));
    expect(() => checkSponsorFeePayerTx(fatC.right.toCBOR(), ctx))
      .toThrow(expect.objectContaining({ httpStatus: 422, code: "FEE_PAYER_FRONTING_ABOVE_MAX" }));
    // Thân bài: thread_lovelace đi cùng fee_payer ⟹ 400 trước mọi lượt dựng.
    const tl = await post("/tx/sponsor/open-vault", nb({ did_commit: DID_NEW, thread_lovelace: "50000000" }, fp));
    expect([tl.status, errCode(tl)]).toEqual([400, "SPONSOR_THREAD_LOVELACE_WITH_FEE_PAYER"]);

    await submitStep(b, [feecover, newcomer]);
    expect(await emulator.getUtxos(newcomer.address)).toEqual([]);
    expect((Data.from((await only(nThread)).datum!) as Constr<Data>).fields[3]).toBe(DID_NEW);
    // Gắn DID cho két (chưa có route — `bindVaultDid`); ví `fee` trả phí, người mới chỉ KÝ ⟹ vẫn 0 ADA.
    await bindVaultDid(nVault, DID_NEW, newcomer, fee);
    expect(await emulator.getUtxos(newcomer.address)).toEqual([]);
  }, SLOW);

  const fundBodyVia = async (fp: Fp, extra: Body = {}): Promise<Body> => ({
    ...nb({ fund_id: fundIdNew, carp_amount: CARP.toString(), sponsor: { utxo_refs: await carpRefs(sponsor) } }, fp), ...extra,
  });
  /** UTxO mang CARP của ví `k`, xếp theo lượng CARP tăng dần. */
  const carpRefs = async (k: TestKey): Promise<string[]> => (await emulator.getUtxos(k.address))
    .filter(u => (u.assets[CARP_UNIT] ?? 0n) > 0n)
    .sort((a, b) => (a.assets[CARP_UNIT]! < b.assets[CARP_UNIT]! ? -1 : 1))
    .map(refStr);

  it("fund-vault ĐỎ: ví trả phí CÙNG KHOÁ bên tài trợ (khác phần stake) ⟹ 422 SPONSOR_FEE_WALLET_IS_SPONSOR", async () => {
    const r = await post("/tx/sponsor/fund-vault", await fundBodyVia(await fpAt(sponsorBaseAddr)));
    expect(r.status).toBe(422);
    expect(errCode(r)).toBe("SPONSOR_FEE_WALLET_IS_SPONSOR");
    expect(JSON.stringify(r.body)).toContain("fee_payer.address");
  }, SLOW);

  it("fund-vault ĐỎ: change_address = ĐÚNG địa chỉ bên tài trợ ⟹ 422 SPONSOR_FEE_WALLET_IS_SPONSOR", async () => {
    const b = await fundBodyVia(await fpAt(feecover.address));
    delete b.fee_payer;
    const r = await post("/tx/sponsor/fund-vault", { ...b, change_address: sponsor.address });
    expect(r.status).toBe(422);
    expect(errCode(r)).toBe("SPONSOR_FEE_WALLET_IS_SPONSOR");
  }, SLOW);

  it("fund-vault XANH: ghim cũ giữ nguyên; Feecover chỉ trả phí; khoá utxo:<fee_payer>; đọc lại chặn ADA chảy sang bên tài trợ", async () => {
    const fp = await fpAt(feecover.address);
    const fundCarpBefore = (await only(fundUnitNew)).assets[CARP_UNIT] ?? 0n;
    const b = await step("/tx/sponsor/fund-vault", await fundBodyVia(fp));
    try {
      expectFpSigners(b, ["fee-wallet", "sponsor", "owner"]);
      expect((b.signers as Array<{ key_hashes: string[] }>)[1]!.key_hashes).toEqual([sponsor.pkh]);
      const fs = await expectFeeFromFeecoverOnly(b, fp);
      const s = b.summary as Body;
      expect(s.sponsor_change_address).toBe(sponsor.address);
      expect(s.anchor_ref).toBe(anchorRef);
      // fund-vault không mở output script mới: két + quỹ đã có min-ADA ⟹ Feecover ứng ≥ 0, đúng bằng phần tăng.
      expect(BigInt(fs.fronted_lovelace as string)).toBeGreaterThanOrEqual(0n);

      // Khoá `utxo:<fee_payer>`: chủ KHÁC, cùng UTxO trả phí, khi tx kia chưa nộp ⟹ KHÔNG còn 409
      // (đổi từ OWNER_TX_IN_FLIGHT, 2026-10-03): lượt sau giành khoá; tx kia vẫn nộp được (bên dưới)
      // vì lượt sau không được nộp — chỉ lượt NỘP mới thay được một tx (`locks.ts`).
      const r2 = await post("/tx/sponsor/draw-magic",
        { owner: { type: "key", hash: owner2.pkh }, fee_payer: fp, fund_id: fundId2, carp_amount: CARP.toString() });
      expect(errCode(r2)).not.toBe("OWNER_TX_IN_FLIGHT");
      expect(r2.status).not.toBe(409);
      if (typeof r2.body.tx_hash === "string") locks.releaseByTxHash(r2.body.tx_hash);

      // Đọc lại trên CBOR thật: bỏ bên tài trợ khỏi tập luồng ⟹ input của họ thành input lạ.
      const ins = await inputsOf(b.tx_cbor as string);
      const ctx: SponsorFeePayerCheckContext = {
        network: NET, tipPosixMs: nowMs(), feePayer: { utxoRef: outRef(fp.utxo), address: feecover.address },
        feePayerUtxo: await utxoOf(fp.utxo), maxCollateralLovelace: 3_000_000n,
        otherInputs: ins.filter(u => refStr(u) !== fp.utxo),
        scriptAddresses: [(await only(vaultUnit)).address, fundAddress], passAddresses: [sponsor.address],
        coinsPerUtxoByte: CPB,
      };
      expect(() => checkSponsorFeePayerTx(b.tx_cbor as string, ctx)).not.toThrow();
      expect(() => checkSponsorFeePayerTx(b.tx_cbor as string, { ...ctx, passAddresses: [] }))
        .toThrow(/ngoài UTxO trả phí và các UTxO của luồng/);

      // Tx tổng hợp (KHÔNG nộp) trên cùng UTxO Feecover + một UTxO CARP bên tài trợ: ba cách rò.
      const sp = (await emulator.getUtxos(sponsor.address)).filter(u => (u.assets[CARP_UNIT] ?? 0n) > 0n)
        .sort((x, y) => (x.assets.lovelace! > y.assets.lovelace! ? -1 : 1))[0]!;
      const synth = async (build: (t: TxBuilder) => TxBuilder): Promise<string> => {
        lucid.selectWallet.fromAddress(feecover.address, [ctx.feePayerUtxo]);
        // Thu UTxO Feecover TƯỜNG MINH: không thì Lucid trả phí bằng ADA của `sp` và tx không có nó.
        const c = await build(lucid.newTx().collectFrom([ctx.feePayerUtxo, sp])).completeSafe();
        if (c._tag === "Left") throw new Error(describeError(c.left));
        return c.right.toCBOR();
      };
      const sctx = { ...ctx, otherInputs: [sp], scriptAddresses: [] as string[] };
      const carp = sp.assets[CARP_UNIT]!;
      // (a) token của bên tài trợ thối sang Feecover.
      const leakToken = await synth(t => t
        .pay.ToAddress(sponsor.address, { ...sp.assets, [CARP_UNIT]: carp - 1n })
        .pay.ToAddress(feecover.address, { lovelace: 2_000_000n, [CARP_UNIT]: 1n }));
      expect(() => checkSponsorFeePayerTx(leakToken, sctx)).toThrow(/về ví trả phí mang token/);
      // (b) ADA của Feecover chảy sang bên tài trợ.
      const leakAda = await synth(t => t.pay.ToAddress(sponsor.address, { ...sp.assets, lovelace: sp.assets.lovelace! + 1_000_000n }));
      expect(() => checkSponsorFeePayerTx(leakAda, sctx)).toThrow(/bên tài trợ góp/);
      // (c) ADA của một UTxO "luồng" chảy VỀ Feecover (khoản ứng âm): coi địa chỉ bên tài trợ là script luồng.
      const drain = await synth(t => t.pay.ToAddress(sponsor.address, { lovelace: 3_000_000n, [CARP_UNIT]: carp }));
      expect(() => checkSponsorFeePayerTx(drain, { ...sctx, scriptAddresses: [sponsor.address], passAddresses: [] }))
        .toThrow(/không khớp/);
    } catch (e) {
      locks.releaseByTxHash(b.tx_hash as string);
      throw e;
    }
    await submitStep(b, [feecover, sponsor, newcomer]);
    expect((await only(fundUnitNew)).assets[CARP_UNIT]).toBe(fundCarpBefore + CARP);
    expect(decodeVaultDatum((await only(nVault)).datum!).prepaid_credits.length).toBe(1);
    expect(await emulator.getUtxos(newcomer.address)).toEqual([]);
  }, SLOW);

  it("draw-magic XANH: PrepaidDraw qua fee_payer; Feecover chỉ trả phí", async () => {
    const fp = await fpAt(feecover.address);
    const b = await step("/tx/sponsor/draw-magic", nb({ fund_id: fundIdNew, carp_amount: CARP.toString() }, fp));
    expectFpSigners(b, ["fee-wallet", "owner"]);
    await expectFeeFromFeecoverOnly(b, fp);
    nDrawEpoch = (b.summary as Body).epoch as number;
    await submitStep(b, [feecover, newcomer]);
    expect(decodeVaultDatum((await only(nVault)).datum!).magic_batches.at(-1)!.created_epoch).toBe(BigInt(nDrawEpoch));
    expect(await emulator.getUtxos(newcomer.address)).toEqual([]);
  }, SLOW);

  it("first-consume ĐỎ: UTxO trả phí 1,5 ADA (dưới thế chấp tường minh) ⟹ 422 SPONSOR_BUILD_FAILED, không 500; khoá được nhả", async () => {
    const small = (await emulator.getUtxos(poorFp.address)).find(u => u.assets.lovelace === 1_500_000n)!;
    const r = await post("/tx/sponsor/first-consume",
      nb({ op_type: 1, op_count: "1", draw_epoch: nDrawEpoch }, { utxo: refStr(small), address: poorFp.address }));
    expect(r.status).toBe(422);
    expect(errCode(r)).toBe("SPONSOR_BUILD_FAILED");
    expect(locks.peek(newcomer.pkh, emulator.now())).toBeNull();
  }, SLOW);

  it("first-consume XANH: consume đầu qua fee_payer; người mới vẫn 0 ADA sau trọn hành trình", async () => {
    const fp = await fpAt(feecover.address);
    const b = await step("/tx/sponsor/first-consume", nb({ op_type: 1, op_count: "1", draw_epoch: nDrawEpoch }, fp));
    expectFpSigners(b, ["fee-wallet", "owner"]);
    await expectFeeFromFeecoverOnly(b, fp);
    await submitStep(b, [feecover, newcomer]);
    const d = Data.from((await only(nThread)).datum!) as Constr<Data>;
    expect(d.fields[2]).toBe(BigInt(nDrawEpoch));
    expect(d.fields[4]).toBe(10_000_000n);
    expect(decodeVaultDatum((await only(nVault)).datum!).magic_batches[0]!.current_amount).toBe(parMagicFromCarp(CARP) - 10_000_000n);
    expect(await emulator.getUtxos(newcomer.address)).toEqual([]);
  }, SLOW);
});

// ── open-fund (bước BÙ): quỹ tài trợ CỦA DID có két mở trước bản này; VTA ký platform, Feecover trả phí ─────────

describe("open-fund — bước bù: genesis quỹ tài trợ theo DID; VTA ký platform; rồi fund-vault tìm thấy quỹ đó", () => {
  const ownerO = { type: "key", hash: "" };
  const ob = (extra: Body = {}): Body => ({ owner: { ...ownerO, hash: opener.pkh }, ...extra });
  const fpOf = async (k: TestKey): Promise<{ utxo: string; address: string }> => {
    const us = (await emulator.getUtxos(k.address)).filter(u => Object.keys(u.assets).every(x => x === "lovelace"));
    us.sort((a, b) => (a.assets.lovelace! > b.assets.lovelace! ? -1 : 1));
    return { utxo: refStr(us[0]!), address: k.address };
  };
  let oVault = "";
  let oFundUnit = "";
  let openFundTxCbor = ""; // tx open-fund CHƯA KÝ đúng như route trả — vector hình dạng cho bên ký

  it("open-fund ĐỎ: cấu hình chỉ có fund_units (thiếu platform_pkhs + beneficiary) và dịch vụ không khoá ⟹ 501 CONFIG_MISSING nêu đủ ba thứ", async () => {
    const r = await post("/tx/sponsor/open-fund", ob({ change_address: fee.address }));
    expect(r.status).toBe(501);
    expect(errCode(r)).toBe("CONFIG_MISSING");
    expect((r.body.error as { details: { missing: string[] } }).details.missing)
      .toEqual(["paid_fund.sponsor.platform_pkhs", "paid_fund.sponsor.beneficiary", "VAULT_TX_API_PLATFORM_KEY"]);
  });

  it("open-fund ĐỎ: cấu hình có platform_pkhs + beneficiary NHƯNG còn fund_units (tập đóng) ⟹ 501 SPONSOR_FUND_SET_CLOSED", async () => {
    const r = await post("/tx/sponsor/open-fund", ob({ change_address: fee.address }), svcSetClosed);
    expect(r.status).toBe(501);
    expect(errCode(r)).toBe("SPONSOR_FUND_SET_CLOSED");
  });

  it("nền: két + thread mở KIỂU CŨ (SDK, không quỹ) + bind-did cho DID_OPEN", async () => {
    oVault = await legacyOpenVault(DID_OPEN, opener, fee);
    await bindVaultDid(oVault, DID_OPEN, opener, fee);
  }, SLOW);

  it("open-fund ĐỎ: thân bài gửi did_commit ⟹ 400 SPONSOR_REQUEST_SHAPE (DID chỉ lấy từ thread)", async () => {
    const r = await post("/tx/sponsor/open-fund", ob({ fee_payer: await fpOf(feecover2), did_commit: DID_COMMIT }), svcOpen);
    expect(r.status).toBe(400);
    expect(errCode(r)).toBe("SPONSOR_REQUEST_SHAPE");
  });

  it("open-fund XANH: fee_payer Feecover; required_signers ∋ platform, ∋ chủ; VTA ĐÃ ký platform; Feecover ký ví trả phí, chủ ký ⟹ validator nhận; datum đúng DID", async () => {
    // Trước open-fund: DID_OPEN chưa có quỹ nào dưới platform đã ghim (quỹ dựng nền mang platform khác ⟹ bị loại).
    expect((await handle({ method: "GET", url: "/sponsor/funds", headers: {}, body: undefined }, routerDeps(svcOpen)))
      .body.pinned_funds).toBe(0);
    const fp = await fpOf(feecover2);
    const b = await (async () => {
      const r = await post("/tx/sponsor/open-fund", ob({ fee_payer: fp }), svcOpen);
      if (r.status !== 200) throw new Error(`open-fund ⟹ ${r.status} ${JSON.stringify(r.body)}`);
      return r.body;
    })();
    openFundTxCbor = b.tx_cbor as string;
    dumpSampleTx("open-fund", b);
    // NỘP TRƯỚC mọi phép so hình dạng: đột biến gỡ platform khỏi required_signers phải đỏ ở VALIDATOR (hành vi),
    // không ở một expect hình dạng. Bên ngoài ký ví trả phí + chủ (#161-5) — witness platform do dịch vụ gắn sẵn.
    const h = await signAndSubmit(b.tx_cbor as string, [feecover2, opener]);
    expect(h).toBe(b.tx_hash);
    openLocks.releaseByTxHash(h);

    expect(b.step).toBe("open-fund");
    const signers = b.signers as Array<{ role: string; key_hashes: string[] }>;
    expect(signers.map(s => s.role)).toEqual(["fee-wallet", "platform", "owner"]);
    expect(signers[0]!.key_hashes).toEqual([feecover2.pkh]);
    expect(signers[1]!.key_hashes).toEqual([platformKey.pkh]);
    expect(signers[2]!.key_hashes).toEqual([opener.pkh]);
    expect(b.required_signers).toContain(platformKey.pkh);
    // #161-5: chủ KÝ open-fund (chủ khoá ⟹ khoá trong required_signers; chủ script ⟹ một mục rút did_stake).
    expect(b.required_signers).toContain(opener.pkh);
    expect((b.summary as Body).withdrawals).toBe(0);
    expect((b.signers as Array<{ how: string }>)[1]!.how).toBe("service");
    // Dịch vụ trả tx mang ĐÚNG MỘT vkey: platform, chữ ký đúng trên thân tx.
    expectPlatformWitnessOnly(b.tx_cbor as string);
    expect(typeof b.expires_at).toBe("string");
    const s = b.summary as Body;
    oFundUnit = s.fund_unit as string;
    expect(s.owner_commit).toBe(DID_OPEN);
    expect(s.platform_pkh).toBe(platformKey.pkh);
    expect((s.fee_payer as Body).utxo).toBe(fp.utxo);

    // Datum đọc thẳng từ CHUỖI, không từ tóm tắt.
    const fundUtxo = await only(oFundUnit);
    expect(fundUtxo.address).toBe(fundAddress);
    const d = decodeFundDatum(fundUtxo.datum!);
    expect(d.platform).toBe(platformKey.pkh);
    expect(d.carp_locked).toBe(0n);
    expect(d.sponsorship!.owner_commit).toBe(DID_OPEN);
    expect(d.sponsorship!.sponsor).toEqual({ payment_credential: { VerificationKey: [sponsor.pkh] }, stake_credential: null });
    expect(d.beneficiary).toEqual({ payment_credential: { VerificationKey: [beneficiaryKey.pkh] }, stake_credential: null });
    expect(plutusDataToCbor(d.beneficiary_datum!)).toBe(OPEN_BEN_DATUM);
    const epochNow = (nowMs() - O) / P;
    expect(d.sponsorship!.reclaim_after_epoch).toBeGreaterThanOrEqual(epochNow + 200n);
    expect(d.sponsorship!.reclaim_after_epoch.toString()).toBe(s.reclaim_after_epoch);
    // Người dùng không góp input nào; ví của chủ không đổi.
    expect((await emulator.getUtxos(opener.address)).length).toBeGreaterThan(0);
  }, SLOW);

  // Vector in ra ĐÚNG MỘT dòng có tiền tố `OPENFUND_VECTOR ` (JSON). Không đọc biến môi trường: tập biến môi
  // trường của gói là danh sách đóng (`noSigningMaterial.test.ts`).
  it("vector open-fund: CBOR tx — 1 vkey (platform, dịch vụ ký), required_signers ∋ platform ∋ chủ, có mint quỹ; in một dòng OPENFUND_VECTOR", () => {
    expect(openFundTxCbor).not.toBe("");
    const tx = CML.Transaction.from_cbor_hex(openFundTxCbor);
    expect(tx.witness_set().vkeywitnesses()!.len()).toBe(1);
    const rs = tx.body().required_signers();
    const req: string[] = [];
    for (let i = 0; i < (rs?.len() ?? 0); i++) req.push(rs!.get(i).to_hex());
    expect(req).toContain(platformKey.pkh);
    expect(req).toContain(opener.pkh);
    expect(tx.body().mint()).toBeDefined();
    console.log("OPENFUND_VECTOR " + JSON.stringify({
      what: "open-fund tx with the service platform witness (Emulator, test keys)", platform_pkh: platformKey.pkh, fee_payer_pkh: feecover2.pkh,
      required_signers: req, tx_hash: CML.hash_transaction(tx.body()).to_hex(), cbor_bytes: openFundTxCbor.length / 2,
      fee_lovelace: tx.body().fee().toString(), tx_cbor: openFundTxCbor,
    }));
  });

  it("GET /sponsor/funds thấy quỹ của DID_OPEN (dùng được); open-fund lần hai ⟹ 409 SPONSOR_FUND_ALREADY_OPEN", async () => {
    const st = await handle({ method: "GET", url: "/sponsor/funds", headers: {}, body: undefined }, routerDeps(svcOpen));
    expect(st.status).toBe(200);
    const funds = st.body.funds as Array<{ fund_unit: string; owner_commit: string | null; problem: string | null }>;
    expect(funds).toEqual([expect.objectContaining({ fund_unit: oFundUnit, owner_commit: DID_OPEN, problem: null })]);
    const again = await post("/tx/sponsor/open-fund", ob({ fee_payer: await fpOf(feecover2) }), svcOpen);
    expect(again.status).toBe(409);
    expect(errCode(again)).toBe("SPONSOR_FUND_ALREADY_OPEN");
  }, SLOW);

  it("ghim beneficiary qua route: CÙNG quỹ trên chuỗi, cấu hình ghim đích KHÁC ⟹ GET thấy foreign_beneficiary, fund-vault 409 NOT_OPENED", async () => {
    // Quỹ open-fund vừa tạo do khoá platform ĐÃ GHIM ký — chỉ đích nhận CARP lệch với ghim của dịch vụ này.
    const st = await handle({ method: "GET", url: "/sponsor/funds", headers: {}, body: undefined }, routerDeps(svcOtherBen));
    const funds = st.body.funds as Array<{ fund_unit: string; owner_commit: string | null; problem: string | null }>;
    expect(funds).toEqual([expect.objectContaining({ fund_unit: oFundUnit, owner_commit: DID_OPEN, problem: "foreign_beneficiary" })]);
    const refs = (await emulator.getUtxos(sponsor.address)).filter(u => (u.assets[CARP_UNIT] ?? 0n) >= CARP).map(refStr).slice(0, 1);
    const r = await post("/tx/sponsor/fund-vault",
      ob({ change_address: fee.address, carp_amount: CARP.toString(), sponsor: { utxo_refs: refs } }), svcOtherBen);
    expect(r.status).toBe(409);
    expect(errCode(r)).toBe("SPONSOR_FUND_NOT_OPENED");
  }, SLOW);

  it("#161-1 ĐỎ: hai ví bên tài trợ ghim, quỹ ghi ví thứ nhất, UTxO CARP ở ví thứ hai ⟹ 422 SPONSOR_UTXO_NOT_FUND_SPONSOR", async () => {
    const refs = (await emulator.getUtxos(attacker.address)).filter(u => (u.assets[CARP_UNIT] ?? 0n) > 0n).map(refStr).slice(0, 1);
    expect(refs.length).toBe(1);
    const r = await post("/tx/sponsor/fund-vault",
      ob({ change_address: fee.address, carp_amount: "1", sponsor: { utxo_refs: refs } }), svcOpenTwo);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(errCode(r)).toBe("SPONSOR_UTXO_NOT_FUND_SPONSOR");
    expect(openLocks.peek(opener.pkh, emulator.now())).toBeNull();
  }, SLOW);

  it("#161-1 CỰC ĐỐI: cùng cấu hình hai ví, UTxO ở ví ghi trong datum ⟹ 200; vai sponsor ký bằng khoá TRONG DATUM", async () => {
    const refs = (await emulator.getUtxos(sponsor.address)).filter(u => (u.assets[CARP_UNIT] ?? 0n) >= CARP).map(refStr).slice(0, 1);
    const r = await post("/tx/sponsor/fund-vault",
      ob({ change_address: fee.address, carp_amount: CARP.toString(), sponsor: { utxo_refs: refs } }), svcOpenTwo);
    if (r.status !== 200) throw new Error(`fund-vault ⟹ ${r.status} ${JSON.stringify(r.body)}`);
    const signers = r.body.signers as Array<{ role: string; key_hashes: string[] }>;
    expect(signers.find(x => x.role === "sponsor")!.key_hashes).toEqual([sponsor.pkh]);
    expect((r.body.summary as Body).sponsor_signers).toEqual([sponsor.pkh]);
    expect(r.body.required_signers).toContain(sponsor.pkh);
    // Không nộp: nhả khoá để bài kế tiếp dựng lại trên cùng quỹ.
    openLocks.releaseByTxHash(r.body.tx_hash as string);
  }, SLOW);

  it("fund-vault XANH (không fund_id) qua cấu hình open-fund: tìm đúng quỹ vừa tạo, nạp CARP, chuỗi nhận", async () => {
    const refs = (await emulator.getUtxos(sponsor.address)).filter(u => (u.assets[CARP_UNIT] ?? 0n) >= CARP).map(refStr).slice(0, 1);
    const r = await post("/tx/sponsor/fund-vault",
      ob({ change_address: fee.address, carp_amount: CARP.toString(), sponsor: { utxo_refs: refs } }), svcOpen);
    if (r.status !== 200) throw new Error(`fund-vault ⟹ ${r.status} ${JSON.stringify(r.body)}`);
    const h = await signAndSubmit(r.body.tx_cbor as string, [fee, sponsor, opener]);
    openLocks.releaseByTxHash(h);
    expect((await only(oFundUnit)).assets[CARP_UNIT]).toBe(CARP);
    expect(decodeFundDatum((await only(oFundUnit)).datum!).carp_locked).toBe(CARP);
  }, SLOW);
});

// ── open-vault CHỞ genesis quỹ: VTA ký platform trong CHÍNH tx mở két; hành trình đi trọn ─────────────────

describe("open-vault kèm quỹ — VTA ký platform; chủ + ví trả phí ký thêm; rồi bind-did → fund-vault → draw-magic → first-consume", () => {
  const cb = (who: TestKey, extra: Body = {}): Body => ({ owner: { type: "key", hash: who.pkh }, ...extra });
  const fpOf = async (k: TestKey): Promise<{ utxo: string; address: string }> => {
    const us = (await emulator.getUtxos(k.address)).filter(u => Object.keys(u.assets).every(x => x === "lovelace"));
    us.sort((a, b) => (a.assets.lovelace! > b.assets.lovelace! ? -1 : 1));
    return { utxo: refStr(us[0]!), address: k.address };
  };
  const ok = async (path: string, body: Body, s: SponsorTxService = svcOpen): Promise<Body> => {
    const r = await post(path, body, s);
    if (r.status !== 200) throw new Error(`${path} ⟹ ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const submitOpen = async (b: Body, keys: TestKey[]): Promise<void> => {
    const h = await signAndSubmit(b.tx_cbor as string, keys);
    expect(h).toBe(b.tx_hash);
    openLocks.releaseByTxHash(h);
  };
  const keyAddr = (h: string) => ({ payment_credential: { VerificationKey: [h] }, stake_credential: null });
  let coVault = "";
  let coThread = "";
  let coFundUnit = "";
  let coFundId = "";

  it("open-vault ĐỎ (cực đối của ca XANH dưới): cùng ghim, dịch vụ KHÔNG có khoá platform ⟹ 501 CONFIG_MISSING nêu đúng tên biến", async () => {
    const before = platformSignCalls;
    const r = await post("/tx/sponsor/open-vault", cb(coOwner, { change_address: fee.address, did_commit: DID_NOKEY }), svcOpenNoKey);
    expect(r.status).toBe(501);
    expect(errCode(r)).toBe("CONFIG_MISSING");
    expect((r.body.error as { details: { missing: string[] } }).details.missing).toEqual(["VAULT_TX_API_PLATFORM_KEY"]);
    expect(platformSignCalls).toBe(before);
  }, SLOW);

  it("#162-1 ĐỎ: ví trả phí = địa chỉ khoá platform (change_address · fee_payer · base cùng khoá) ⟹ 422 SPONSOR_FEE_WALLET_IS_PLATFORM, hàm ký không được gọi; CẶP: ca XANH ngay dưới (ví khác) ⟹ 200", async () => {
    const before = platformSignCalls;
    const platformBase = credentialToAddress(NET, { type: "Key", hash: platformKey.pkh }, { type: "Key", hash: sponsor.pkh });
    for (const extra of [
      { change_address: platformKey.address },
      { change_address: platformBase },
      { fee_payer: { utxo: `${"ee".repeat(32)}#0`, address: platformKey.address } },
    ]) {
      const r = await post("/tx/sponsor/open-vault", cb(coOwner, { ...extra, did_commit: DID_CO }), svcOpen);
      expect(r.status).toBe(422);
      expect(errCode(r)).toBe("SPONSOR_FEE_WALLET_IS_PLATFORM");
    }
    expect(platformSignCalls).toBe(before);
  }, SLOW);

  it("open-vault XANH kèm quỹ: fee_payer Feecover; MỘT tx đúc két + thread + quỹ; VTA đã ký platform; Feecover + chủ ký ⟹ chuỗi nhận; datum quỹ đúng DID", async () => {
    const before = platformSignCalls;
    const fp = await fpOf(feecover2);
    const b = await ok("/tx/sponsor/open-vault", cb(coOwner, { fee_payer: fp, did_commit: DID_CO }));
    dumpSampleTx("open-vault", b);
    // NỘP TRƯỚC mọi phép so hình dạng: bỏ witness platform phải đỏ ở Emulator (hành vi), không ở một expect.
    await submitOpen(b, [feecover2, coOwner]);
    expect(platformSignCalls).toBe(before + 1);

    const signers = b.signers as Array<{ role: string; key_hashes: string[]; how: string }>;
    expect(signers.map(x => x.role)).toEqual(["fee-wallet", "owner", "platform"]);
    expect(signers[0]!.key_hashes).toEqual([feecover2.pkh]);
    expect(signers[1]!.key_hashes).toEqual([coOwner.pkh]);
    expect(signers[2]).toEqual({ role: "platform", key_hashes: [platformKey.pkh], how: "service" });
    // Ví trả phí ký vì tiêu input của nó (không nằm trong required_signers); chủ + platform nằm trong đó.
    expect(b.required_signers).toEqual(expect.arrayContaining([coOwner.pkh, platformKey.pkh]));
    expectPlatformWitnessOnly(b.tx_cbor as string);

    const s = b.summary as Body;
    const f = s.fund as Body;
    expect(f.status).toBe("created");
    coVault = s.vault_unit as string;
    coThread = s.thread_unit as string;
    coFundUnit = f.fund_unit as string;
    coFundId = f.fund_id as string;
    // Seed one-shot của quỹ = UTxO ví trả phí bị tiêu; fund_id = computeFundId(seed).
    expect(f.seed_ref).toBe(fp.utxo);
    const [seedHash, seedIdx] = fp.utxo.split("#") as [string, string];
    expect(coFundId).toBe(computeFundId(seedHash, BigInt(seedIdx)));
    expect(f.owner_commit).toBe(DID_CO);

    // Khoản ứng = Σ lovelace output tới két + thread + quỹ (đọc thẳng CBOR, không qua tóm tắt).
    const outs = CML.Transaction.from_cbor_hex(b.tx_cbor as string).body().outputs();
    let flow = 0n;
    let fundLovelace = 0n;
    const flowAddrs = new Set<string>();
    for (let i = 0; i < outs.len(); i++) {
      const addr = outs.get(i).address().to_bech32(undefined);
      if (addr === feecover2.address) continue;
      flow += outs.get(i).amount().coin();
      flowAddrs.add(addr);
      if (addr === fundAddress) fundLovelace += outs.get(i).amount().coin();
    }
    expect([...flowAddrs].sort()).toEqual([s.vault_address as string, s.thread_address as string, fundAddress].sort());
    const fs = s.fee_payer as Body;
    expect(fs.fronted_lovelace).toBe(flow.toString());
    expect(fundLovelace).toBeGreaterThan(0n);

    // Datum quỹ đọc thẳng từ CHUỖI.
    const fu = await only(coFundUnit);
    expect(fu.address).toBe(fundAddress);
    const d = decodeFundDatum(fu.datum!);
    expect(d.platform).toBe(platformKey.pkh);
    expect(d.carp_locked).toBe(0n);
    expect(d.sponsorship!.owner_commit).toBe(DID_CO);
    expect(d.sponsorship!.sponsor).toEqual(keyAddr(sponsor.pkh));
    expect(d.beneficiary).toEqual(keyAddr(beneficiaryKey.pkh));
    expect(plutusDataToCbor(d.beneficiary_datum!)).toBe(OPEN_BEN_DATUM);
    expect(d.sponsorship!.reclaim_after_epoch.toString()).toBe(f.reclaim_after_epoch);
    // owner_commit của quỹ = did_commit của thread đúc trong CHÍNH tx này.
    expect((Data.from((await only(coThread)).datum!) as Constr<Data>).fields[3]).toBe(DID_CO);
    console.log("COSIGN_MEASURE " + JSON.stringify({
      what: "open-vault + per-DID fund genesis, service platform witness (Emulator, fee_payer, key owner)",
      ...measureTx(b.tx_cbor as string), fronted_lovelace: fs.fronted_lovelace, fund_lovelace: fundLovelace.toString(),
    }));
  }, SLOW);

  it("open-vault khi DID ĐÃ có quỹ (chủ thứ hai cùng DID): KHÔNG genesis quỹ thứ hai, không gọi hàm ký, summary.fund = existing", async () => {
    const before = platformSignCalls;
    const b = await ok("/tx/sponsor/open-vault", cb(coOwner2, { change_address: fee.address, did_commit: DID_CO }));
    try {
      expect(platformSignCalls).toBe(before);
      expect((b.signers as Array<{ role: string }>).map(x => x.role)).toEqual(["fee-wallet", "owner"]);
      const tx = CML.Transaction.from_cbor_hex(b.tx_cbor as string);
      expect(tx.body().mint()?.get_assets(CML.ScriptHash.from_hex(coFundUnit.slice(0, 56)))).toBeUndefined();
      expect(tx.witness_set().vkeywitnesses()).toBeUndefined();
      expect((b.summary as Body).fund).toEqual({
        status: "existing", funds: [expect.objectContaining({ fund_unit: coFundUnit, fund_id: coFundId })],
      });
    } finally {
      openLocks.releaseByTxHash(b.tx_hash as string);
    }
  }, SLOW);

  it("bind-did → fund-vault → draw-magic → first-consume XANH trên quỹ open-vault vừa tạo; hàm ký platform KHÔNG được gọi ở bước nào", async () => {
    const before = platformSignCalls;
    const bd = await ok("/tx/sponsor/bind-did", cb(coOwner, { change_address: fee.address }));
    await submitOpen(bd, [fee, coOwner]);
    expect(decodeVaultDatum((await only(coVault)).datum!).did_commit).toBe(DID_CO);

    // fund-vault KHÔNG gửi fund_id: dịch vụ tìm quỹ của DID — chính quỹ open-vault vừa tạo.
    const refs = (await emulator.getUtxos(sponsor.address)).filter(u => (u.assets[CARP_UNIT] ?? 0n) >= CARP).map(refStr).slice(0, 1);
    const fv = await ok("/tx/sponsor/fund-vault",
      cb(coOwner, { change_address: fee.address, carp_amount: CARP.toString(), sponsor: { utxo_refs: refs } }));
    await submitOpen(fv, [fee, sponsor, coOwner]);
    expect(decodeFundDatum((await only(coFundUnit)).datum!).carp_locked).toBe(CARP);

    const dm = await ok("/tx/sponsor/draw-magic", cb(coOwner, { change_address: fee.address, fund_id: coFundId, carp_amount: CARP.toString() }));
    const coDrawEpoch = (dm.summary as Body).epoch as number;
    await submitOpen(dm, [fee, coOwner]);

    const fc = await ok("/tx/sponsor/first-consume",
      cb(coOwner, { change_address: fee.address, op_type: 1, op_count: "1", draw_epoch: coDrawEpoch }));
    await submitOpen(fc, [fee, coOwner]);
    const td = Data.from((await only(coThread)).datum!) as Constr<Data>;
    expect(td.fields[2]).toBe(BigInt(coDrawEpoch));
    expect(td.fields[4]).toBe(10_000_000n);
    expect(decodeVaultDatum((await only(coVault)).datum!).magic_batches[0]!.current_amount).toBe(parMagicFromCarp(CARP) - 10_000_000n);
    expect(platformSignCalls).toBe(before);
  }, SLOW);

  it("claim ĐỎ (E = 0, trước SettleLine) ⟹ 409 SPONSOR_FUND_NOTHING_TO_CLAIM, hàm ký không được gọi", async () => {
    const before = platformSignCalls;
    const r = await post("/tx/sponsor/claim", { fund_id: coFundId, change_address: fee.address }, svcOpen);
    expect(r.status).toBe(409);
    expect(errCode(r)).toBe("SPONSOR_FUND_NOTHING_TO_CLAIM");
    expect(platformSignCalls).toBe(before);
  }, SLOW);

  it("SettleLine (SDK, không phải route): MAGIC đã tiêu của két vào magic_settled của quỹ ⟹ E > 0", async () => {
    const validity = { fromMs: nowMs(), toMs: nowMs() + 300_000n };
    const vaultUtxo = await only(coVault);
    const fundUtxo = await only(coFundUnit);
    await asWallet(fee, l => addSettleLine(l.newTx(), { scripts: pgScripts, vaultUtxo, fundUtxo, validity }).tx);
    const d = decodeFundDatum((await only(coFundUnit)).datum!);
    expect(d.magic_settled).toBe(10_000_000n);
    expect(maxClaimable(d)).toBeGreaterThan(0n);
  }, SLOW);

  it("claim ĐỎ: fee_payer ở địa chỉ khoá platform ⟹ 422 SPONSOR_FEE_WALLET_IS_PLATFORM; change_address = beneficiary ⟹ 422 SPONSOR_FEE_WALLET_IS_BENEFICIARY; amount > E ⟹ 422; owner trong thân ⟹ 400", async () => {
    const before = platformSignCalls;
    const max = maxClaimable(decodeFundDatum((await only(coFundUnit)).datum!));
    const cases: Array<[Body, number, string]> = [
      [{ fund_id: coFundId, fee_payer: { utxo: `${"ee".repeat(32)}#0`, address: platformKey.address } }, 422, "SPONSOR_FEE_WALLET_IS_PLATFORM"],
      [{ fund_id: coFundId, change_address: platformKey.address }, 422, "SPONSOR_FEE_WALLET_IS_PLATFORM"],
      [{ fund_id: coFundId, change_address: beneficiaryKey.address }, 422, "SPONSOR_FEE_WALLET_IS_BENEFICIARY"],
      [{ fund_id: coFundId, change_address: fee.address, amount: (max + 1n).toString() }, 422, "SPONSOR_CLAIM_ABOVE_MAX"],
      [{ fund_id: coFundId, change_address: fee.address, beneficiary: fee.address }, 400, "SPONSOR_REQUEST_SHAPE"],
    ];
    for (const [body, status, code] of cases) {
      const r = await post("/tx/sponsor/claim", body, svcOpen);
      expect([r.status, errCode(r)]).toEqual([status, code]);
    }
    expect(platformSignCalls).toBe(before);
  }, SLOW);

  it("claim XANH: fee_payer Feecover; VTA đã ký platform; Feecover ký ⟹ chuỗi nhận; CARP = E tới ĐÚNG beneficiary (datum ghim); datum quỹ đọc lại", async () => {
    const before = platformSignCalls;
    const fundBefore = decodeFundDatum((await only(coFundUnit)).datum!);
    const max = maxClaimable(fundBefore);
    const benBefore = (await emulator.getUtxos(beneficiaryKey.address)).length;
    const fp = await fpOf(feecover2);
    const b = await ok("/tx/sponsor/claim", { fund_id: coFundId, fee_payer: fp });
    dumpSampleTx("claim", b);
    expect(platformSignCalls).toBe(before + 1);
    expect((b.signers as Array<{ role: string; key_hashes: string[] }>).map(x => [x.role, x.key_hashes]))
      .toEqual([["fee-wallet", [feecover2.pkh]], ["platform", [platformKey.pkh]]]);
    expect(b.required_signers).toEqual([platformKey.pkh]);
    expectPlatformWitnessOnly(b.tx_cbor as string);
    const s = b.summary as Body;
    expect(s.amount).toBe(max.toString());
    expect(s.closing).toBe(false);
    await submitOpen(b, [feecover2]);
    // CARP tới đúng địa chỉ ghim, đúng datum ghim — đọc thẳng từ chuỗi.
    const benUtxos = await emulator.getUtxos(beneficiaryKey.address);
    expect(benUtxos.length).toBe(benBefore + 1);
    const paid = benUtxos.find(u => (u.assets[CARP_UNIT] ?? 0n) > 0n && refStr(u).startsWith(b.tx_hash as string))!;
    expect(paid.assets[CARP_UNIT]).toBe(max);
    expect(paid.datum).toBe(OPEN_BEN_DATUM);
    const after = decodeFundDatum((await only(coFundUnit)).datum!);
    expect(after.provider_claimed).toBe(fundBefore.provider_claimed + max);
    expect(after.carp_locked).toBe(fundBefore.carp_locked - max);
    expect(after.beneficiary).toEqual(fundBefore.beneficiary);
    expect(maxClaimable(after)).toBe(0n);
  }, SLOW);

  it("#162-3 ĐỎ: hai open-vault chở genesis cho CÙNG DID trong khe chưa vào khối ⟹ lượt hai 409 SPONSOR_DID_GENESIS_IN_FLIGHT; CẶP: DID khác ⟹ 200", async () => {
    const DID_HOLD = "d7".repeat(32);
    const DID_HOLD2 = "d8".repeat(32);
    const o1 = newKey();
    const o2 = newKey();
    const o3 = newKey();
    const first = await ok("/tx/sponsor/open-vault", cb(o1, { change_address: fee.address, did_commit: DID_HOLD }));
    try {
      expect(((first.summary as Body).fund as Body).status).toBe("created");
      const second = await post("/tx/sponsor/open-vault", cb(o2, { change_address: fee.address, did_commit: DID_HOLD }), svcOpen);
      expect(second.status).toBe(409);
      expect(errCode(second)).toBe("SPONSOR_DID_GENESIS_IN_FLIGHT");
      expect((second.body.error as { details: Body }).details.tx_hash).toBe(first.tx_hash);
      // /tx/submit nhả khoá CHỦ theo hash (mô phỏng ở đây); khoá DID vẫn giữ tới hết hạn tx.
      openLocks.releaseByTxHash(first.tx_hash as string);
      const third = await post("/tx/sponsor/open-vault", cb(o2, { change_address: fee.address, did_commit: DID_HOLD }), svcOpen);
      expect(errCode(third)).toBe("SPONSOR_DID_GENESIS_IN_FLIGHT");
      const other = await ok("/tx/sponsor/open-vault", cb(o3, { change_address: fee.address, did_commit: DID_HOLD2 }));
      openLocks.releaseByTxHash(other.tx_hash as string);
    } finally {
      openLocks.releaseByTxHash(first.tx_hash as string);
    }
  }, SLOW);

  it("/fee/sign không chạm hàm ký platform (router mang dịch vụ tài trợ CÓ khoá)", async () => {
    const before = platformSignCalls;
    const r = await handle({ method: "POST", url: "/fee/sign", headers: {}, body: { tx_cbor: "84a0a0f5f6" } }, routerDeps(svcOpen));
    expect(r.status).not.toBe(200);
    expect(platformSignCalls).toBe(before);
  });
});

// Chốt bài này KHÔNG ghim được:
//   · nhánh chủ SCRIPT (`did_stake`) qua route — cần nhân chứng PhoenixKey; bài SDK phủ phần dựng tx;
//   · `noSigningMaterial.test.ts` đo theo TÊN: ký bằng ed25519 của `node:crypto` (như ở đây) không
//     khớp mẫu nào, nên một đường ký kiểu này trong src/ cũng sẽ đi lọt phép quét đó;
//   · first-consume sang kỳ sau với lô đã hết hạn — bài SDK phủ (`goToEpoch`); ở đây chỉ phủ draw_epoch lệch.
