// VaultTxAPI/src/sponsor.ts — hành trình tài trợ consume đầu (T1–T4) trên két PrepaidGen, ở dạng route.
//
//   POST /tx/sponsor/plan              { owner, sponsor_pkh }                         — thuần, không chạm chuỗi
//   POST /tx/sponsor/t1-open           { owner, [owner_witness], [change_address], did_commit, [thread_lovelace] }
//   POST /tx/sponsor/t2-fund           { owner, …, fund_id, carp_amount, sponsor: { utxo_refs, change_address }, [vault_ref] }
//   POST /tx/sponsor/t3-draw           { owner, …, fund_id, carp_amount, [vault_ref] }
//   POST /tx/sponsor/t4-first-consume  { owner, …, op_type, op_count, draw_epoch, [vault_ref], [engage_ref] }
//
// ── VÌ SAO MỖI BƯỚC MỘT ROUTE ───────────────────────────────────────────────────
// Mỗi bước tiêu output của bước trước (két, thread, lô MAGIC), nên tx bước sau chỉ dựng được khi tx
// bước trước ĐÃ vào khối. Và T2 có người ký khác (bên tài trợ). Một route "dựng cả bốn" sẽ phải dựng
// trên trạng thái chưa tồn tại — ra bốn tx mà ba cái sau chết sau khi người dùng đã ký.
//
// ── MAGIC KHÔNG GIỮ CHÍNH SÁCH TÀI TRỢ ──────────────────────────────────────────
// Một-lần-mỗi-DID, hạn mức: việc của Feecover (bên vận hành tài trợ), đếm theo `owner_commit` qua
// anchor DID ở reference input của T2. Dịch vụ này chỉ dựng HÌNH DẠNG tx; bộ dựng là
// `@magiclamp/sdk` ▸ `buildSponsorT*`, không phải một bản thứ hai.
//
// ── KHÔNG GIỮ KHOÁ ─────────────────────────────────────────────────────────────
// T2 nhận UTxO của bên tài trợ dưới dạng THAM CHIẾU (`sponsor.utxo_refs`), đọc lại từ chuỗi, và trả
// tx CHƯA KÝ. Bên tài trợ ký bằng khoá của chính họ, ngoài dịch vụ.
//
// ── `fee_payer` KHÔNG HỖ TRỢ (501) ──────────────────────────────────────────────
// Ví trả phí bên thứ ba đòi hạn dùng ≤ 1 giờ và thế chấp tường minh (`feePayer.ts`). T1 không đặt
// validity nào; T2/T3 của SDK không nhận lượng thế chấp. Ví trả phí của hành trình là ví KHOÁ ở
// `change_address` — Feecover muốn trả phí thì đưa địa chỉ khoá của chính họ vào đó và ký như ví trả phí.

import {
  CML, getAddressDetails, validatorToAddress, validatorToScriptHash,
  type Assets, type LucidEvolution, type Script, type TxBuilder, type UTxO, type Validator,
} from "@lucid-evolution/lucid";
import {
  OwnerAuthError, WindowOriginError, msPerEpoch, sameOwner, windowOriginMs, windowStartMs,
  type Network, type OwnerAuth, type OwnerRef,
} from "@magiclamp/protocol-utils";
import {
  SponsorJourneyError, buildSponsorT1OpenPrepaid, buildSponsorT2Fund, buildSponsorT3Draw,
  buildSponsorT4FirstConsume, planSponsorJourney, type SponsorJourneyErrorCode, type SponsorTxOutput,
} from "@magiclamp/sdk";
import {
  derivePrepaidScripts, readVaultUtxo, withRefScripts,
  type PrepaidBlueprint, type PrepaidScripts,
} from "@magiclamp/prepaidgen-sdk";

import { ownerReq, reqBigint, reqSmallInt } from "./buildRequest.js";
import type { ChainReader, ChainTip } from "./chain.js";
import { PREPAID_VAULT_TYPE, type Deployment, type VaultScope } from "./config.js";
import { didCommitOf, parseDidCommit, parseEngageRef, pickEngageThread } from "./engage.js";
import {
  ChainUnavailableError, CodedApiError, ConfigMissingError, TxApiError, TxBuildRejectedError,
  VaultAmbiguousError, VaultDatumUndecodableError, VaultNotFoundError, ownerApiErrorOf,
} from "./errors.js";
import { refStr, type OutRefLike } from "./feePayer.js";
import { pickByNft } from "./genV2.js";
import { IssuedTxRegistry, OwnerLockTable, PendingSpends, type SponsorRoute } from "./locks.js";
import { ownerLockKey, type OwnerWitnessProvider, type ResolvedOwnerWitness } from "./owner.js";
import type { OwnerRequest } from "./service.js";
import { txBodyHash } from "./summary.js";
import { assertChangeAddress, enterpriseAddressOf } from "./txBuilder.js";

// ── Bảng mã lỗi SDK → HTTP ─────────────────────────────────────────────────────

/**
 * `SponsorJourneyError.code` → mã HTTP. `Record` trên ĐÚNG kiểu mã của SDK ⟹ SDK thêm một mã mà bảng
 * chưa có thì `tsc` đỏ ở đây, không lọt thành 500 im lặng.
 *
 *   "internal" ⟹ 500 `INTERNAL` + `reference_code` (nhật ký giữ nguyên nhân). Hai mã đó chỉ nổ khi
 *   CHÍNH dịch vụ dựng sai: lưới kỳ do dịch vụ apply từ mạng (`GRID_MISMATCH`), và anchor dịch vụ
 *   luôn truyền — SDK báo thiếu nghĩa là tx dựng ra mất reference input (`ANCHOR_REF_MISSING`).
 *   Thiếu anchor ở phía người gọi đã chặn trước bằng 404 `SPONSOR_ANCHOR_NOT_FOUND`.
 */
export const SPONSOR_ERROR_STATUS: Readonly<Record<SponsorJourneyErrorCode, number | "internal">> = {
  SPONSOR_DID_COMMIT_LENGTH: 400,
  SPONSOR_VALIDITY_SPANS_EPOCHS: 422,
  SPONSOR_EPOCH_MISMATCH: 409,
  SPONSOR_GRID_MISMATCH: "internal",
  SPONSOR_ANCHOR_REF_MISSING: "internal",
  SPONSOR_ANCHOR_REF_WRONG: 422,
  SPONSOR_FUND_NOT_PINNED: 422,
  SPONSOR_CARP_INSUFFICIENT: 422,
  SPONSOR_CARP_OUTPUT_UNPINNED: 422,
  SPONSOR_WITHDRAW_COUNT: 422,
  SPONSOR_BUILD_FAILED: 422,
};

/** `SponsorJourneyError` → lỗi API có mã (giữ NGUYÊN `code`), hoặc chính lỗi đó khi là lỗi nội bộ. */
export function sponsorApiErrorOf(e: SponsorJourneyError): TxApiError | SponsorJourneyError {
  const status = SPONSOR_ERROR_STATUS[e.code];
  if (status === "internal") return e;
  const prefix = `[${e.code}] `;
  const message = e.message.startsWith(prefix) ? e.message.slice(prefix.length) : e.message;
  return new CodedApiError(status, e.code, message);
}

/**
 * Lỗi bộ dựng (SDK, PrepaidGen, ConsumeMAGIC) → lỗi API. Lỗi lập trình (`TypeError`…) đi NGUYÊN để
 * thành 500 + mã tham chiếu: gộp nó vào 422 là bảo người dùng "giao thức từ chối" khi thật ra mã hỏng.
 */
export function asSponsorApiError(e: unknown): unknown {
  if (e instanceof TxApiError) return e;
  if (e instanceof SponsorJourneyError) return sponsorApiErrorOf(e);
  if (e instanceof WindowOriginError) return networkUnsupported(e.code);
  // Hai lớp `OwnerAuthError` (protocol-utils, và bản riêng của PrepaidGen) cùng tên + cùng `code`.
  if (e instanceof OwnerAuthError || (e instanceof Error && e.name === "OwnerAuthError" && typeof (e as { code?: unknown }).code === "string")) {
    return ownerApiErrorOf(e as unknown as { code: string; message: string });
  }
  if (e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError || e instanceof SyntaxError) return e;
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return new TxBuildRejectedError(e.message, { thrown_by: e.name, ...(typeof code === "string" ? { rule_code: code } : {}) });
  }
  return e;
}

function networkUnsupported(causeCode: string): CodedApiError {
  return new CodedApiError(501, "SPONSOR_NETWORK_UNSUPPORTED",
    `Mạng này chưa có gốc cửa sổ kỳ (window_origin_ms): két Prepaid ép mọi validity gọn trong một kỳ theo ` +
    `gốc đó, nên hành trình tài trợ không dựng được ở đây.`, { cause_code: causeCode });
}

// ── Yêu cầu ───────────────────────────────────────────────────────────────────

export type SponsorStep = "T1" | "T2" | "T3" | "T4";

/** Đường → bước. Một bảng, đọc ở router và ở README. */
export const SPONSOR_STEP_OF_PATH: Readonly<Record<string, SponsorStep>> = {
  "/tx/sponsor/t1-open": "T1",
  "/tx/sponsor/t2-fund": "T2",
  "/tx/sponsor/t3-draw": "T3",
  "/tx/sponsor/t4-first-consume": "T4",
};

const ISSUED_ROUTE_OF_STEP: Readonly<Record<SponsorStep, SponsorRoute>> = {
  T1: "sponsor-t1-open", T2: "sponsor-t2-fund", T3: "sponsor-t3-draw", T4: "sponsor-t4-first-consume",
};

export interface SponsorT1Request extends OwnerRequest { didCommit: string; threadLovelace?: bigint }
export interface SponsorT2Request extends OwnerRequest {
  vaultRef?: OutRefLike;
  fundId: string;
  carpAmount: bigint;
  sponsorUtxoRefs: OutRefLike[];
  sponsorChangeAddress: string;
}
export interface SponsorT3Request extends OwnerRequest { vaultRef?: OutRefLike; fundId: string; carpAmount: bigint }
export interface SponsorT4Request extends OwnerRequest {
  vaultRef?: OutRefLike;
  engageRef?: OutRefLike;
  opType: number;
  opCount: bigint;
  drawEpoch: bigint;
}

const OUTREF = /^([0-9a-f]{64})#(0|[1-9][0-9]{0,4})$/;
const HEX28 = /^[0-9a-f]{56}$/;
const FUND_ID = /^(?:[0-9a-f]{2}){1,32}$/;
/** Trần số UTxO bên tài trợ một lượt: đủ cho mọi ví thật, chặn thân bài phình. */
const MAX_SPONSOR_UTXOS = 20;

function shape(message: string, details: Record<string, unknown> = {}): CodedApiError {
  return new CodedApiError(400, "SPONSOR_REQUEST_SHAPE", message, details);
}

function outRefOf(v: unknown, field: string): OutRefLike {
  const m = typeof v === "string" ? OUTREF.exec(v) : null;
  if (m === null) throw shape(`"${field}" phải là chuỗi "<tx_hash 64 hex>#<index>".`, { field });
  return { txHash: m[1]!, outputIndex: Number(m[2]!) };
}

function optOutRef(body: Record<string, unknown>, field: string): OutRefLike | undefined {
  return body[field] === undefined ? undefined : outRefOf(body[field], field);
}

function fundIdOf(body: Record<string, unknown>): string {
  const v = body.fund_id;
  if (typeof v !== "string" || !FUND_ID.test(v)) {
    throw shape(`"fund_id" phải là hex thường 1–32 byte (tên NFT quỹ dưới policy paid_fund).`, { field: "fund_id" });
  }
  return v;
}

/** Thân bài một bước → yêu cầu của dịch vụ. Sai ⟹ 400 có mã. */
export function parseSponsorRequest(step: "T1", body: Record<string, unknown>): SponsorT1Request;
export function parseSponsorRequest(step: "T2", body: Record<string, unknown>): SponsorT2Request;
export function parseSponsorRequest(step: "T3", body: Record<string, unknown>): SponsorT3Request;
export function parseSponsorRequest(step: "T4", body: Record<string, unknown>): SponsorT4Request;
export function parseSponsorRequest(
  step: SponsorStep, body: Record<string, unknown>,
): SponsorT1Request | SponsorT2Request | SponsorT3Request | SponsorT4Request {
  const base = ownerReq(body);
  const vaultRef = optOutRef(body, "vault_ref");
  const withVaultRef = vaultRef === undefined ? {} : { vaultRef };
  switch (step) {
    case "T1":
      return {
        ...base,
        didCommit: parseDidCommit(body.did_commit),
        ...(body.thread_lovelace === undefined ? {} : { threadLovelace: reqBigint(body, "thread_lovelace") }),
      } satisfies SponsorT1Request;
    case "T2": {
      const sp = body.sponsor;
      if (sp === null || typeof sp !== "object" || Array.isArray(sp)) {
        throw shape(`"sponsor" phải là đối tượng { utxo_refs, change_address } của bên tài trợ.`, { field: "sponsor" });
      }
      const s = sp as Record<string, unknown>;
      if (!Array.isArray(s.utxo_refs) || s.utxo_refs.length === 0 || s.utxo_refs.length > MAX_SPONSOR_UTXOS) {
        throw shape(`"sponsor.utxo_refs" phải là mảng 1–${MAX_SPONSOR_UTXOS} tham chiếu UTxO chứa CARP của bên tài trợ.`,
          { field: "sponsor.utxo_refs" });
      }
      const refs = s.utxo_refs.map((r, i) => outRefOf(r, `sponsor.utxo_refs[${i}]`));
      if (new Set(refs.map(refStr)).size !== refs.length) {
        throw shape(`"sponsor.utxo_refs" có tham chiếu trùng.`, { field: "sponsor.utxo_refs" });
      }
      if (typeof s.change_address !== "string" || s.change_address === "") {
        throw shape(`"sponsor.change_address" phải là địa chỉ bech32 nhận phần CARP/ADA thối của bên tài trợ.`,
          { field: "sponsor.change_address" });
      }
      return {
        ...base,
        ...withVaultRef,
        fundId: fundIdOf(body),
        carpAmount: reqBigint(body, "carp_amount"),
        sponsorUtxoRefs: refs,
        sponsorChangeAddress: s.change_address,
      } satisfies SponsorT2Request;
    }
    case "T3":
      return {
        ...base,
        ...withVaultRef,
        fundId: fundIdOf(body),
        carpAmount: reqBigint(body, "carp_amount"),
      } satisfies SponsorT3Request;
    case "T4": {
      const de = body.draw_epoch;
      if (typeof de !== "number" || !Number.isSafeInteger(de) || de < 0) {
        throw shape(`"draw_epoch" phải là số nguyên ≥ 0 — đúng \`summary.epoch\` mà T3 trả.`, { field: "draw_epoch" });
      }
      const engageRef = parseEngageRef(body.engage_ref);
      return {
        ...base,
        ...withVaultRef,
        ...(engageRef === undefined ? {} : { engageRef }),
        opType: reqSmallInt(body, "op_type"),
        opCount: reqBigint(body, "op_count"),
        drawEpoch: BigInt(de),
      } satisfies SponsorT4Request;
    }
  }
}

// ── Đáp ứng ───────────────────────────────────────────────────────────────────

export interface SponsorSigner {
  role: "fee-wallet" | "sponsor" | "owner";
  /** Khoá băm phải ký theo vai này. Chủ script: controller + thiết bị của `did_stake`. */
  keyHashes: string[];
  how: string;
}

export interface SponsorBuildResponse {
  step: SponsorStep;
  txCbor: string;
  txHash: string;
  /** `required_signers` đọc từ CHÍNH CBOR vừa dựng. */
  requiredSigners: string[];
  /** Ai ký, theo vai và theo thứ tự `planSponsorJourney`. */
  signers: SponsorSigner[];
  witnessNotes: string[];
  summary: Record<string, unknown>;
  expiresAt: string;
}

export function toSponsorBody(r: SponsorBuildResponse): Record<string, unknown> {
  return {
    step: r.step,
    tx_cbor: r.txCbor,
    tx_hash: r.txHash,
    required_signers: r.requiredSigners,
    signers: r.signers.map(s => ({ role: s.role, key_hashes: s.keyHashes, how: s.how })),
    witness_notes: r.witnessNotes,
    summary: r.summary,
    expires_at: r.expiresAt,
  };
}

function assetsJson(a: Assets): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, q] of Object.entries(a)) out[k] = q.toString();
  return out;
}

function outputsJson(outs: SponsorTxOutput[]): Array<Record<string, unknown>> {
  return outs.map(o => ({ index: o.index, address: o.address, assets: assetsJson(o.assets) }));
}

// ── Kế hoạch (thuần) ──────────────────────────────────────────────────────────

/** `POST /tx/sponsor/plan` — ai ký tx nào, đường của từng bước. Không chạm chuỗi, không cấu hình. */
export function sponsorPlanBody(body: Record<string, unknown>): Record<string, unknown> {
  const owner = ownerReq(body).owner;
  const sponsorPkh = body.sponsor_pkh;
  if (typeof sponsorPkh !== "string" || !HEX28.test(sponsorPkh)) {
    throw shape(`"sponsor_pkh" phải là 56 ký tự hex thường (khoá băm của bên tài trợ ký T2).`, { field: "sponsor_pkh" });
  }
  const plan = planSponsorJourney({ owner, sponsorPkh });
  const pathOf = Object.fromEntries(Object.entries(SPONSOR_STEP_OF_PATH).map(([p, s]) => [s, p]));
  return {
    steps: plan.steps.map(s => ({
      step: s.step, path: pathOf[s.step], action: s.action,
      signers: s.signers.map(x => ({ role: x.role, how: x.how })), requires: s.requires,
    })),
    same_epoch: plan.sameEpoch,
  };
}

// ── Dịch vụ ───────────────────────────────────────────────────────────────────

/** Lucid với ví CHỈ-ĐỌC mang đúng các UTxO đã cho. Dịch vụ thật: `SdkTxBuilder.lucidForWallet`. */
export type LucidForWallet = (walletAddress: string, walletUtxos: UTxO[]) => Promise<LucidEvolution>;

export interface SponsorTxServiceDeps {
  network: Network;
  deployment: Deployment;
  /** Đọc két, quỹ, anchor, thread, beacon, UTxO bên tài trợ (bản gốc — để trả 409 PREVIOUS_TX_PENDING có tên). */
  chain: ChainReader;
  /** Đọc UTxO ví trả phí — bản lọc input vừa nộp. Vắng ⟹ `chain`. */
  walletChain?: ChainReader;
  locks: OwnerLockTable;
  issued: IssuedTxRegistry;
  pending?: PendingSpends;
  lockTtlMs: number;
  now?: () => number;
  /** Nhân chứng chủ script (`did_stake`). Vắng ⟹ chủ script nhận 501 `OWNER_SCRIPT_WITNESS_UNAVAILABLE`. */
  ownerWitness?: OwnerWitnessProvider;
  /** Blueprint PrepaidGen (`aiken build PrepaidGen/onchain`) — ở khối Prepaid đó là tệp
   *  `VAULT_TX_API_VAULT_PLUTUS_JSON`. Dịch vụ apply tham số rồi đối chiếu hash với cấu hình. */
  prepaidBlueprint: PrepaidBlueprint;
  lucidForWallet: LucidForWallet;
}

interface Prepared {
  scope: VaultScope;
  scripts: PrepaidScripts;
  consumeScript: Validator;
  consumeRef: UTxO;
  P: bigint;
  O: bigint;
}

interface StepCtx {
  owner: OwnerRef;
  ownerAuth: OwnerAuth<TxBuilder>;
  witness?: ResolvedOwnerWitness;
  feeAddress: string;
  feeKeyHash: string;
  tip: ChainTip;
}

export class SponsorTxService {
  private readonly now: () => number;
  private derived: PrepaidScripts | undefined;

  constructor(private readonly deps: SponsorTxServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** T1 — đúc két Prepaid + thread consume trong MỘT tx. */
  async t1Open(req: SponsorT1Request): Promise<SponsorBuildResponse> {
    return this.run("T1", req, [], async (p, ctx) => {
      const scope = p.scope;
      // Lưới an toàn của DỊCH VỤ (bấm hai lần, app gửi lại) — KHÔNG phải chính sách một-lần-mỗi-DID:
      // việc đó Feecover đếm. Két thứ hai cùng chủ làm mọi bước sau rơi vào 409 `VAULT_AMBIGUOUS`.
      const existing = this.prepaidVaultsOf(await this.deps.chain.utxosAt(scope.address), p.scripts, ctx.owner);
      if (existing.length > 0) {
        throw new CodedApiError(409, "VAULT_ALREADY_EXISTS",
          `Chủ ${ctx.owner.type}:${ctx.owner.hash.slice(0, 12)}… đã có két Prepaid — không dựng két thứ hai. ` +
          `Đi tiếp từ T2 với két đang có.`,
          { vault_type: PREPAID_VAULT_TYPE, existing: existing.map(v => ({ vault_ref: refStr(v.utxo), vault_nft: v.nftUnit })) });
      }
      const wallet = await this.walletUtxos(ctx.feeAddress);
      const sorted = [...wallet].sort((a, b) =>
        a.txHash === b.txHash ? a.outputIndex - b.outputIndex : a.txHash < b.txHash ? -1 : 1);
      const seedUtxo = sorted.find(u => Object.keys(u.assets).every(k => k === "lovelace")) ?? sorted[0]!;
      const lucid = await this.deps.lucidForWallet(ctx.feeAddress, wallet);
      const r = await buildSponsorT1OpenPrepaid({
        lucid, prepaidScripts: p.scripts, consumeScript: p.consumeScript, consumeRefUtxo: p.consumeRef,
        seedUtxo, owner: ctx.owner, ownerAuth: ctx.ownerAuth, didCommit: req.didCommit, network: this.deps.network,
        ...(req.threadLovelace === undefined ? {} : { threadLovelace: req.threadLovelace }),
      });
      const s = r.summary;
      const vaultOut = this.nftOutput(s.outputs, s.vaultUnit, scope.address, "két Prepaid", "T1");
      const threadOut = this.nftOutput(s.outputs, s.threadUnit, this.deps.deployment.consume.engageAddress, "thread", "T1");
      if (!s.vaultUnit.startsWith(scope.scriptHash) || !s.threadUnit.startsWith(this.deps.deployment.consume.engageScriptHash)) {
        throw txMismatch("T1", `NFT két/thread không nằm dưới policy đã cấu hình.`, { vault_unit: s.vaultUnit, thread_unit: s.threadUnit });
      }
      const txHash = txBodyHash(r.txCbor);
      return {
        txCbor: r.txCbor,
        summary: {
          step: "T1",
          vault_unit: s.vaultUnit, vault_address: s.vaultAddress, vault_out_ref: `${txHash}#${vaultOut}`,
          thread_unit: s.threadUnit, thread_address: s.threadAddress, thread_out_ref: `${txHash}#${threadOut}`,
          did_commit: s.didCommit, owner: { type: s.owner.type, hash: s.owner.hash },
          withdrawals: s.withdrawals, outputs: outputsJson(s.outputs),
        },
      };
    });
  }

  /** T2 — PrepaidLock + FundLock: CARP từ UTxO bên tài trợ vào quỹ đã ghim; anchor DID ở reference input. */
  async t2Fund(req: SponsorT2Request): Promise<SponsorBuildResponse> {
    const sponsorChange = sponsorChangeAddressOf(this.deps.network, req.sponsorChangeAddress);
    const prepaid = this.requirePrepaid("T2");
    const fundUnit = prepaid.fundScriptHash + req.fundId;
    return this.run("T2", req, [`fund:${fundUnit}`], async (p, ctx) => {
      const anchorPolicy = this.deps.deployment.didStake?.anchorNftPolicy;
      if (anchorPolicy === undefined) {
        throw new ConfigMissingError(
          `T2 phải mang anchor DID của người mới ở reference input, mà bản deploy không khai policy anchor.`,
          { missing: ["did_stake.anchor_nft_policy"], route: "/tx/sponsor/t2-fund" });
      }
      const vault = await this.pickVault(p, ctx.owner, req.vaultRef);
      // `did_commit` của hành trình nằm ở THREAD consume, không ở két: két Prepaid genesis bắt buộc
      // `did_commit == #""` (`PrepaidGen/offchain/src/tx/builders.ts` ▸ `planMintPrepaidVault`). Bản trước đọc
      // ở két ⟹ mọi két mở bằng T1 chết ở đây với 422 — bài Emulator qua route bắt được.
      const d = this.deps.deployment.consume;
      const thread = await pickEngageThread(this.deps.chain, d.engageAddress, d.engageScriptHash, ctx.owner,
        undefined, "/tx/sponsor/t2-fund");
      const didCommit = didCommitOf(thread);
      if (!/^[0-9a-f]{64}$/.test(didCommit)) {
        throw new CodedApiError(422, "SPONSOR_THREAD_DID_INVALID",
          `Thread ${refStr(thread.utxo)} mang did_commit dài ${didCommit.length / 2} byte; T2 cần đúng 32 byte để định ` +
          `vị anchor DID của người mới. Thread này không mở bằng T1.`, { engage_ref: refStr(thread.utxo) });
      }
      const anchor = await this.uniqueByUnit(anchorPolicy + didCommit, undefined, "SPONSOR_ANCHOR",
        `anchor DID của người mới (owner_commit ${didCommit.slice(0, 16)}…)`);
      const fund = await this.uniqueByUnit(fundUnit, prepaid.fundAddress, "SPONSOR_FUND", `quỹ tài trợ ${req.fundId}`);
      this.assertNotPendingSpent(fund, "quỹ tài trợ này");
      const sponsorUtxos = await this.deps.chain.utxosByOutRef(req.sponsorUtxoRefs);
      for (const u of sponsorUtxos) {
        this.assertNotPendingSpent(u, "UTxO bên tài trợ này");
        if (getAddressDetails(u.address).paymentCredential?.type !== "Key") {
          throw new CodedApiError(400, "SPONSOR_UTXO_NOT_KEY",
            `UTxO bên tài trợ ${refStr(u)} không do khoá giữ — bên tài trợ phải ký được để chi nó.`, { utxo_ref: refStr(u) });
        }
      }
      // Ví trả phí KHÔNG được góp CARP: chọn-coin kéo CARP của ví đó vào thì nó thành output CARP
      // ngoài quỹ (SDK ném `SPONSOR_CARP_OUTPUT_UNPINNED`). Chỉ đưa cho Lucid các UTxO không CARP.
      const wallet = (await this.walletUtxos(ctx.feeAddress)).filter(u => (u.assets[p.scripts.carpUnit] ?? 0n) === 0n);
      if (wallet.length === 0) throw noWalletUtxo(ctx.feeAddress, "không giữ CARP");
      const lucid = await this.deps.lucidForWallet(ctx.feeAddress, wallet);
      const r = await buildSponsorT2Fund({
        lucid, prepaidScripts: p.scripts, vaultUtxo: vault.utxo, fundUtxo: fund, pinnedFundUnit: fundUnit,
        carpAmount: req.carpAmount, sponsorCarpUtxos: sponsorUtxos, sponsorChangeAddress: sponsorChange,
        newcomerAnchor: { utxo: anchor, anchorNftPolicyId: anchorPolicy, ownerCommit: didCommit },
        ownerAuth: ctx.ownerAuth, network: this.deps.network, nowMs: ctx.tip.blockTimePosixMs,
      });
      const s = r.summary;
      const txHash = txBodyHash(r.txCbor);
      const vaultOut = this.nftOutput(s.outputs, vault.nftUnit, p.scope.address, "két Prepaid", "T2");
      return {
        txCbor: r.txCbor,
        sponsorSigners: s.sponsorSigners,
        summary: {
          step: "T2", epoch: Number(s.epoch), epoch_end_ms: windowStartMs(s.epoch + 1n, p.P, p.O).toString(),
          vault_out_ref: `${txHash}#${vaultOut}`, fund_id: s.fundId, fund_unit: s.fundUnit,
          carp_amount: s.carpAmount.toString(), opens_new_line: s.opensNewLine,
          anchor_ref: refStr(s.anchorRef), owner_commit: didCommit, sponsor_signers: s.sponsorSigners,
          withdrawals: s.withdrawals, outputs: outputsJson(s.outputs),
        },
      };
    });
  }

  /** T3 — PrepaidDraw ⟹ một lô MAGIC sống ĐÚNG kỳ e. */
  async t3Draw(req: SponsorT3Request): Promise<SponsorBuildResponse> {
    return this.run("T3", req, [], async (p, ctx) => {
      const vault = await this.pickVault(p, ctx.owner, req.vaultRef);
      const wallet = await this.walletUtxos(ctx.feeAddress);
      const lucid = await this.deps.lucidForWallet(ctx.feeAddress, wallet);
      const r = await buildSponsorT3Draw({
        lucid, prepaidScripts: p.scripts, vaultUtxo: vault.utxo, fundId: req.fundId, carpAmount: req.carpAmount,
        ownerAuth: ctx.ownerAuth, network: this.deps.network, nowMs: ctx.tip.blockTimePosixMs,
      });
      const s = r.summary;
      const txHash = txBodyHash(r.txCbor);
      const vaultOut = this.nftOutput(s.outputs, vault.nftUnit, p.scope.address, "két Prepaid", "T3");
      return {
        txCbor: r.txCbor,
        notes: [`T4 (và T5 genesis Wakeme) PHẢI chạy trong kỳ ${s.epoch}, trước mốc ${windowStartMs(s.epoch + 1n, p.P, p.O)} ms — ` +
          `lô MAGIC Prepaid chỉ sống đúng kỳ rút.`],
        summary: {
          step: "T3", epoch: Number(s.epoch), epoch_end_ms: windowStartMs(s.epoch + 1n, p.P, p.O).toString(),
          vault_out_ref: `${txHash}#${vaultOut}`, batch_id: s.batchId, magic_nanogic: s.magicNanogic.toString(),
          withdrawals: s.withdrawals, outputs: outputsJson(s.outputs),
        },
      };
    });
  }

  /** T4 — consume đầu + BurnBatch trên két Prepaid, CÙNG kỳ với T3. */
  async t4FirstConsume(req: SponsorT4Request): Promise<SponsorBuildResponse> {
    return this.run("T4", req, [], async (p, ctx) => {
      const d = this.deps.deployment.consume;
      const vault = await this.pickVault(p, ctx.owner, req.vaultRef);
      const thread = await pickEngageThread(this.deps.chain, d.engageAddress, d.engageScriptHash, ctx.owner,
        req.engageRef, "/tx/sponsor/t4-first-consume");
      this.assertNotPendingSpent(thread.utxo, "thread này");
      const beacon = pickByNft(await this.deps.chain.utxosAt(d.priceBeaconAddress), d.priceBeaconNftUnit, "beacon PriceParam");
      const wallet = await this.walletUtxos(ctx.feeAddress);
      const lucid = await this.deps.lucidForWallet(ctx.feeAddress, wallet);
      const r = await buildSponsorT4FirstConsume({
        lucid, prepaidScripts: p.scripts, consumeScript: p.consumeScript, consumeRefUtxo: p.consumeRef,
        engageUtxo: thread.utxo, vaultUtxo: vault.utxo, priceBeaconUtxo: beacon,
        opType: req.opType, opCount: req.opCount, ownerAuth: ctx.ownerAuth, network: this.deps.network,
        tipPosixMs: ctx.tip.blockTimePosixMs, drawEpoch: req.drawEpoch,
        ...(d.maxPriceStale === undefined ? {} : { maxPriceStale: d.maxPriceStale }),
      });
      const s = r.summary;
      this.nftOutput(s.outputs, vault.nftUnit, p.scope.address, "két Prepaid", "T4");
      this.nftOutput(s.outputs, s.threadUnit, d.engageAddress, "thread", "T4");
      return {
        txCbor: r.txCbor,
        summary: {
          step: "T4", epoch: Number(s.epoch), required_nanogic: s.requiredNanogic.toString(),
          burns: s.burns.map(([batchId, n]) => ({ batch_id: batchId, nanogic: n.toString() })),
          thread_unit: s.threadUnit, withdrawals: s.withdrawals, outputs: outputsJson(s.outputs),
        },
      };
    });
  }

  // ── khung chung của bốn bước ────────────────────────────────────────────────

  /**
   * Thứ tự như `service.ts` ▸ `buildOne`: kiểm hình dạng + cấu hình TRƯỚC khi giữ khoá (yêu cầu hỏng
   * không chiếm chỗ của chủ) · giữ khoá · đọc đỉnh chuỗi · dựng · đọc lại CBOR · ghi sổ phát-hành ·
   * hỏng ở đâu thì NHẢ mọi khoá đã giữ.
   */
  private async run(
    step: SponsorStep,
    req: OwnerRequest,
    extraLockKeys: string[],
    build: (p: Prepared, ctx: StepCtx) => Promise<{
      txCbor: string; summary: Record<string, unknown>; sponsorSigners?: string[]; notes?: string[];
    }>,
  ): Promise<SponsorBuildResponse> {
    const owner = assertOwner(req.owner);
    this.requireNetworkGrid();
    this.requirePrepaid(step);
    if (req.feePayer !== undefined) {
      throw new CodedApiError(501, "SPONSOR_FEE_PAYER_UNSUPPORTED",
        `"fee_payer" chưa hỗ trợ ở hành trình tài trợ: T1 không đặt hạn dùng, T2/T3 không nhận lượng thế ` +
        `chấp tường minh — hai thứ ví trả phí bên thứ ba đòi. Gửi "change_address" là địa chỉ KHOÁ của ví trả ` +
        `phí (ví đó ký như ví trả phí).`, { step });
    }
    const feeAddress = this.feeAddressFor(req);
    this.assertWitnessShape(req);
    const startedAt = this.now();
    const keys = [ownerLockKey(owner), ...extraLockKeys];
    const gens: Array<[string, number]> = [];
    try {
      for (const k of keys) gens.push([k, this.deps.locks.acquire(k, startedAt)]);
      const p = await this.prepare();
      const tip = await this.deps.chain.tip();
      const witness = owner.type === "key" ? undefined : await this.deps.ownerWitness!.resolve(owner, req.ownerWitness!);
      const ownerAuth: OwnerAuth<TxBuilder> = witness?.auth ?? { kind: "key", pkh: owner.hash };
      const ctx: StepCtx = {
        owner, ownerAuth, ...(witness === undefined ? {} : { witness }),
        feeAddress, feeKeyHash: getAddressDetails(feeAddress).paymentCredential!.hash, tip,
      };
      const out = await build(p, ctx);
      const txHash = txBodyHash(out.txCbor);
      for (const [k, g] of gens) this.deps.locks.bindTxHash(k, txHash, g);
      this.deps.issued.record(txHash, this.now(), { route: ISSUED_ROUTE_OF_STEP[step] });
      return {
        step,
        txCbor: out.txCbor,
        txHash,
        requiredSigners: requiredSignersOf(out.txCbor),
        signers: signersFor(step, ctx, out.sponsorSigners ?? []),
        witnessNotes: [
          ...(owner.type === "key" ? [`Chủ khoá: ký bằng khoá ${owner.hash}.`] : (witness?.notes ?? [])),
          `Ví trả phí: input phí + tài sản thế chấp lấy từ ${feeAddress}; khoá thanh toán ${ctx.feeKeyHash} phải ký.`,
          ...(step === "T2"
            ? [`Bên tài trợ ký bằng ${(out.sponsorSigners ?? []).join(", ")} (chi các UTxO CARP đã đưa); phần thối về ${sponsorChangeOf(req)}.`]
            : []),
          ...(out.notes ?? []),
          `Thứ tự: thân giao dịch này là bản CHỐT — mọi bên ký trên đúng tx_hash trả về; đổi bất kỳ byte nào ` +
            `của thân thì mọi chữ ký đã có mất hiệu lực.`,
        ],
        summary: out.summary,
        expiresAt: new Date(startedAt + this.deps.lockTtlMs).toISOString(),
      };
    } catch (e) {
      for (const [k, g] of gens) this.deps.locks.release(k, g);
      throw asSponsorApiError(e);
    }
  }

  private requireNetworkGrid(): void {
    try {
      windowOriginMs(this.deps.network);
      msPerEpoch(this.deps.network);
    } catch (e) {
      if (e instanceof WindowOriginError) throw networkUnsupported(e.code);
      throw e;
    }
  }

  private requirePrepaid(step: SponsorStep): NonNullable<Deployment["prepaid"]> & { carpUnit: string } {
    const d = this.deps.deployment;
    if (d.prepaid === undefined || d.vaults.length !== 1 || d.vaults[0]!.vaultType !== PREPAID_VAULT_TYPE) {
      throw new CodedApiError(501, "SPONSOR_PREPAID_UNAVAILABLE",
        `Bản deploy này không phục vụ két ${PREPAID_VAULT_TYPE} (khối "paid_fund" + vaults[].vault_type ` +
        `"${PREPAID_VAULT_TYPE}") — hành trình tài trợ chạy trên két Prepaid.`,
        { vault_types: d.vaults.map(v => v.vaultType), step });
    }
    if (d.prepaid.carpUnit === undefined) {
      throw new ConfigMissingError(
        `Hành trình tài trợ cần CARP của bộ script Prepaid, mà bản deploy không khai "paid_fund.carp_unit".`,
        { missing: ["paid_fund.carp_unit"], route: `/tx/sponsor/${step.toLowerCase()}` });
    }
    if (d.refScriptUtxos.paidFund === undefined) {
      throw new ConfigMissingError(`Bản deploy Prepaid thiếu "ref_script_utxos.paid_fund".`,
        { missing: ["ref_script_utxos.paid_fund"], route: `/tx/sponsor/${step.toLowerCase()}` });
    }
    return d.prepaid as NonNullable<Deployment["prepaid"]> & { carpUnit: string };
  }

  /**
   * Bộ script Prepaid: apply `(carp, ms_per_epoch, window_origin_ms)` của MẠNG vào blueprint, rồi đòi
   * hash/địa chỉ trùng cấu hình — lệch ⟹ 501 `SPONSOR_PREPAID_SCRIPTS_MISMATCH` (cấu hình và blueprint
   * nói về hai lần deploy khác nhau; dựng tiếp là dựng tx chết trên chuỗi). Ref-script của két + quỹ +
   * consume đọc từ chuỗi và phải băm ra đúng script đó.
   */
  private async prepare(): Promise<Prepared> {
    const d = this.deps.deployment;
    const prepaid = d.prepaid!;
    const scope = d.vaults[0]!;
    const P = msPerEpoch(this.deps.network);
    const O = windowOriginMs(this.deps.network);
    if (this.derived === undefined) {
      const carp = prepaid.carpUnit!;
      let base: PrepaidScripts;
      try {
        base = derivePrepaidScripts(this.deps.prepaidBlueprint, this.deps.network, {
          carpPolicyId: carp.slice(0, 56), carpAssetName: carp.slice(56), msPerEpoch: P, windowOriginMs: O,
        });
      } catch (e) {
        throw scriptsMismatch(`không apply được blueprint PrepaidGen: ${e instanceof Error ? e.message : String(e)}`, {});
      }
      const want = { vault_hash: scope.scriptHash, fund_hash: prepaid.fundScriptHash, vault_address: scope.address };
      const got = {
        vault_hash: base.vault.hash, fund_hash: base.paidFund.hash,
        vault_address: validatorToAddress(this.deps.network, base.vault.script),
      };
      if (got.vault_hash !== want.vault_hash || got.fund_hash !== want.fund_hash || got.vault_address !== want.vault_address) {
        throw scriptsMismatch(
          `blueprint + (paid_fund.carp_unit, lưới mạng ${this.deps.network}) cho ra script khác địa chỉ đã cấu hình.`,
          { configured: want, derived: got });
      }
      this.derived = base;
    }
    const [vaultRef, fundRef, consumeRef] = await this.deps.chain.utxosByOutRef([
      d.refScriptUtxos.vault, d.refScriptUtxos.paidFund!, d.refScriptUtxos.consume,
    ]);
    let scripts: PrepaidScripts;
    try {
      scripts = withRefScripts(this.derived, { vault: vaultRef!, paidFund: fundRef! });
    } catch (e) {
      throw new ChainUnavailableError(
        `ref_script_utxos của két/quỹ không mang đúng script đã cấu hình: ${e instanceof Error ? e.message : String(e)}`,
        { what: "ref_script_utxos.vault|paid_fund" });
    }
    const consumeScript = scriptOfRef(consumeRef, "consume");
    const consumeHash = validatorToScriptHash(consumeScript);
    if (consumeHash !== d.consume.engageScriptHash) {
      throw new ChainUnavailableError(
        `Script tham chiếu của consume băm ra ${consumeHash.slice(0, 16)}… nhưng engage_address có script hash ` +
        `${d.consume.engageScriptHash.slice(0, 16)}…. ref_script_utxos.consume trỏ vào một lần deploy khác.`,
        { what: "consume", script_hash_from_chain: consumeHash, script_hash_from_address: d.consume.engageScriptHash });
    }
    return { scope, scripts, consumeScript: consumeScript as Validator, consumeRef: consumeRef!, P, O };
  }

  private feeAddressFor(req: OwnerRequest): string {
    if (req.changeAddress !== undefined) return assertChangeAddress(this.deps.network, req.changeAddress);
    if (req.owner.type === "key") return enterpriseAddressOf(this.deps.network, req.owner.hash);
    throw new CodedApiError(400, "CHANGE_ADDRESS_REQUIRED",
      `Chủ script không có địa chỉ ví suy được — gửi "change_address": địa chỉ KHOÁ của ví trả phí ` +
      `(phí + thế chấp + tiền thừa).`);
  }

  /** Cùng luật với `service.ts` ▸ `assertWitnessShapeFor` — kiểm TRƯỚC khi giữ khoá. */
  private assertWitnessShape(req: OwnerRequest): void {
    if (req.owner.type === "key" && req.ownerWitness !== undefined) {
      throw new CodedApiError(400, "OWNER_WITNESS_UNEXPECTED",
        `"owner_witness" chỉ dành cho chủ script; chủ khoá chứng minh quyền bằng chữ ký.`);
    }
    if (req.owner.type === "script") {
      if (this.deps.ownerWitness === undefined) {
        throw new CodedApiError(501, "OWNER_SCRIPT_WITNESS_UNAVAILABLE",
          `Dịch vụ chưa được cấu hình nhân chứng chủ script (thiếu mục \`did_stake\` trong bản deploy).`,
          { missing: "deployment.did_stake" });
      }
      if (req.ownerWitness === undefined) {
        throw new CodedApiError(400, "OWNER_SCRIPT_WITNESS_UNAVAILABLE",
          `Chủ là script: yêu cầu phải kèm "owner_witness" (did_stake_script_cbor, anchor_ref, ` +
          `controller_pkh, device_key_hash).`, { missing: "owner_witness" });
      }
    }
  }

  private async walletUtxos(address: string): Promise<UTxO[]> {
    const utxos = await (this.deps.walletChain ?? this.deps.chain).utxosAt(address);
    if (utxos.length === 0) throw noWalletUtxo(address, "");
    return utxos;
  }

  private assertNotPendingSpent(u: UTxO, subject: string): void {
    const ref = refStr(u);
    if (this.deps.pending?.has(ref, this.now())) {
      throw new CodedApiError(409, "PREVIOUS_TX_PENDING",
        `Giao dịch trước của ${subject} đã nộp nhưng chưa vào khối — UTxO ${ref} đang bị nó tiêu. ` +
        `Thử lại sau khi giao dịch đó vào khối.`, { utxo_ref: ref });
    }
  }

  /**
   * Két Prepaid của `owner` ở scope. UTxO mang NFT dưới policy két mà không đọc được ⟹ NÉM 502
   * (lược đồ trôi), không bỏ qua im lặng — cùng luật `vaultLookup.ts` ▸ `findVaultsAtScope`.
   */
  private prepaidVaultsOf(utxos: UTxO[], scripts: PrepaidScripts, owner: OwnerRef): PrepaidVault[] {
    const out: PrepaidVault[] = [];
    for (const u of utxos) {
      if (!Object.keys(u.assets).some(k => k !== "lovelace" && k.startsWith(scripts.vault.hash))) continue;
      let v: ReturnType<typeof readVaultUtxo>;
      try {
        v = readVaultUtxo(scripts, u);
      } catch (e) {
        throw new VaultDatumUndecodableError(refStr(u), e instanceof Error ? e.message : String(e));
      }
      const o = v.datum.owner as { VerificationKey?: [string]; Script?: [string] };
      const vOwner: OwnerRef = o.VerificationKey !== undefined
        ? { type: "key", hash: o.VerificationKey[0] }
        : { type: "script", hash: o.Script![0] };
      if (sameOwner(vOwner, owner)) out.push({ utxo: u, nftUnit: v.nftUnit, datum: { did_commit: v.datum.did_commit } });
    }
    return out;
  }

  private async pickVault(p: Prepared, owner: OwnerRef, vaultRef?: OutRefLike): Promise<PrepaidVault> {
    const mine = this.prepaidVaultsOf(await this.deps.chain.utxosAt(p.scope.address), p.scripts, owner);
    let v: PrepaidVault;
    if (vaultRef !== undefined) {
      const hit = mine.find(x => refStr(x.utxo) === refStr(vaultRef));
      if (hit === undefined) {
        throw new CodedApiError(400, "SPONSOR_VAULT_REF_MISMATCH",
          `"vault_ref" ${refStr(vaultRef).slice(0, 16)}… không phải két Prepaid chưa tiêu của chủ này.`,
          { vault_ref: refStr(vaultRef) });
      }
      v = hit;
    } else if (mine.length === 0) {
      throw new VaultNotFoundError(ownerLockKey(owner), [p.scope.address]);
    } else if (mine.length > 1) {
      throw new VaultAmbiguousError(ownerLockKey(owner), PREPAID_VAULT_TYPE, mine.map(x => refStr(x.utxo)));
    } else {
      v = mine[0]!;
    }
    this.assertNotPendingSpent(v.utxo, "két này");
    return v;
  }

  /** ĐÚNG MỘT UTxO chưa tiêu mang `unit` (tuỳ chọn: ở `address`). 0 ⟹ 404 `<prefix>_NOT_FOUND`; >1 ⟹ 409 `<prefix>_AMBIGUOUS`. */
  private async uniqueByUnit(unit: string, address: string | undefined, prefix: string, what: string): Promise<UTxO> {
    const hits = (await this.deps.chain.utxosByUnit(unit))
      .filter(u => (u.assets[unit] ?? 0n) === 1n && (address === undefined || u.address === address));
    if (hits.length === 0) {
      throw new CodedApiError(404, `${prefix}_NOT_FOUND`, `Không có UTxO chưa tiêu nào mang ${what}.`, { unit });
    }
    if (hits.length > 1) {
      throw new CodedApiError(409, `${prefix}_AMBIGUOUS`,
        `Có ${hits.length} UTxO cùng mang ${what} — bất khả trên sổ cái đã lắng; từ chối chọn đại.`,
        { unit, utxo_refs: hits.map(refStr) });
    }
    return hits[0]!;
  }

  /** Chỉ số output mang ĐÚNG 1 `unit` ở `address`, đọc từ CBOR (qua `summary.outputs` của SDK). */
  private nftOutput(outs: SponsorTxOutput[], unit: string, address: string, what: string, step: SponsorStep): number {
    const hits = outs.filter(o => (o.assets[unit] ?? 0n) === 1n);
    if (hits.length !== 1 || hits[0]!.address !== address) {
      throw txMismatch(step, `tx vừa dựng không có đúng một output ${what} (${unit.slice(0, 20)}…) ở ${address.slice(0, 24)}….`,
        { unit, expected_address: address, outputs_with_unit: hits.map(o => ({ index: o.index, address: o.address })) });
    }
    return hits[0]!.index;
  }
}

interface PrepaidVault { utxo: UTxO; nftUnit: string; datum: { did_commit: string } }

// ── phụ trợ ────────────────────────────────────────────────────────────────────

function assertOwner(o: OwnerRef): OwnerRef {
  if (o === null || typeof o !== "object" || (o.type !== "key" && o.type !== "script")) {
    throw new CodedApiError(400, "OWNER_CREDENTIAL_SHAPE", `"owner.type" phải là "key" hoặc "script".`);
  }
  if (typeof o.hash !== "string" || !HEX28.test(o.hash)) {
    throw new CodedApiError(400, "OWNER_HASH_INVALID", `"owner.hash" phải là 56 ký tự hex thường.`);
  }
  return { type: o.type, hash: o.hash };
}

function sponsorChangeAddressOf(network: Network, address: string): string {
  try {
    return assertChangeAddress(network, address);
  } catch (e) {
    if (e instanceof CodedApiError && e.code === "CHANGE_ADDRESS_INVALID") {
      throw new CodedApiError(400, "SPONSOR_CHANGE_ADDRESS_INVALID",
        `"sponsor.change_address" phải là địa chỉ bech32 của mạng ${network} với phần thanh toán là KHOÁ.`, e.details);
    }
    throw e;
  }
}

function scriptsMismatch(reason: string, details: Record<string, unknown>): CodedApiError {
  return new CodedApiError(501, "SPONSOR_PREPAID_SCRIPTS_MISMATCH",
    `Bộ script Prepaid của dịch vụ lệch cấu hình: ${reason}`, details);
}

function txMismatch(step: SponsorStep, reason: string, details: Record<string, unknown>): CodedApiError {
  return new CodedApiError(422, "SPONSOR_TX_MISMATCH", `${step}: ${reason}`, { step, ...details });
}

function noWalletUtxo(address: string, qualifier: string): TxBuildRejectedError {
  return new TxBuildRejectedError(
    `Ví trả phí ${address.slice(0, 20)}… không có UTxO nào${qualifier === "" ? "" : ` ${qualifier}`} để trả phí và làm ` +
    `tài sản thế chấp.`, { change_address: address });
}

function scriptOfRef(u: UTxO | undefined, what: string): Script {
  if (u === undefined || u.scriptRef === undefined || u.scriptRef === null) {
    throw new ChainUnavailableError(`UTxO script tham chiếu của ${what} không mang scriptRef.`, { what });
  }
  return u.scriptRef;
}

function requiredSignersOf(txCbor: string): string[] {
  const rs = CML.Transaction.from_cbor_hex(txCbor).body().required_signers();
  const out: string[] = [];
  for (let i = 0; rs !== undefined && i < rs.len(); i++) out.push(rs.get(i).to_hex());
  return out;
}

/** Vai ký theo thứ tự `planSponsorJourney`: T2 = ví trả phí · bên tài trợ · chủ; còn lại = ví trả phí · chủ. */
function signersFor(step: SponsorStep, ctx: StepCtx, sponsorSigners: string[]): SponsorSigner[] {
  const fee: SponsorSigner = {
    role: "fee-wallet", keyHashes: [ctx.feeKeyHash], how: `ví khoá ${ctx.feeAddress}: phí + thế chấp + tiền thừa`,
  };
  const owner: SponsorSigner = ctx.owner.type === "key"
    ? { role: "owner", keyHashes: [ctx.owner.hash], how: `chữ ký khoá ${ctx.owner.hash}` }
    : {
        role: "owner", keyHashes: ctx.witness?.requiredSigners ?? [],
        how: `một mục rút Script(${ctx.owner.hash}) (did_stake: controller + thiết bị ký)`,
      };
  if (step !== "T2") return [fee, owner];
  return [fee, { role: "sponsor", keyHashes: sponsorSigners, how: "chi các UTxO CARP đã đưa trong sponsor.utxo_refs" }, owner];
}


function sponsorChangeOf(req: OwnerRequest): string {
  const a = (req as Partial<SponsorT2Request>).sponsorChangeAddress;
  return a === undefined ? "sponsor.change_address" : a;
}

/**
 * Bộ định tuyến của `/tx/sponsor/*` (http.ts gọi sau khi đã kiểm thẻ bài + POST + thân JSON).
 * `plan` thuần, chạy cả khi dịch vụ tài trợ vắng; bốn bước còn lại cần `svc`.
 */
export async function sponsorRoute(
  path: string, body: Record<string, unknown>, svc: SponsorTxService | undefined,
): Promise<Record<string, unknown>> {
  if (path === "/tx/sponsor/plan") return sponsorPlanBody(body);
  const step = SPONSOR_STEP_OF_PATH[path];
  if (step === undefined) {
    throw new CodedApiError(404, "NOT_FOUND", `Không có đường "${path}".`,
      { known: ["/tx/sponsor/plan", ...Object.keys(SPONSOR_STEP_OF_PATH)] });
  }
  if (svc === undefined) {
    throw new CodedApiError(501, "SPONSOR_UNAVAILABLE",
      `Dịch vụ này chưa bật hành trình tài trợ (bản deploy không phục vụ két ${PREPAID_VAULT_TYPE}, hoặc thiếu ` +
      `blueprint PrepaidGen).`, { step });
  }
  switch (step) {
    case "T1": return toSponsorBody(await svc.t1Open(parseSponsorRequest("T1", body)));
    case "T2": return toSponsorBody(await svc.t2Fund(parseSponsorRequest("T2", body)));
    case "T3": return toSponsorBody(await svc.t3Draw(parseSponsorRequest("T3", body)));
    case "T4": return toSponsorBody(await svc.t4FirstConsume(parseSponsorRequest("T4", body)));
  }
}
