// MagicSDK/src/sponsorJourney.ts — hành trình tài trợ consume đầu của người mới, trên két PrepaidGen.
//
// Bốn giao dịch, mỗi hàm trả một tx đã `complete()` CHƯA KÝ + bản tóm tắt:
//   T1  người mới ký   — đúc két Prepaid + đúc thread consume trong MỘT tx; `did_commit` ghi lúc đúc;
//                        chủ script ⟹ đúng MỘT mục rút `did_stake` phủ cả hai cổng `owner_authorized`.
//   T2  bên tài trợ + người mới ký — PrepaidLock + FundLock: CARP từ UTxO của bên tài trợ vào ĐÚNG
//                        quỹ đã ghim; mở dòng mới ⟹ chủ két chứng minh quyền; tx mang reference input
//                        anchor DID của người mới (tên NFT = owner_commit) để bên tài trợ đối chiếu.
//   T3  người mới ký   — PrepaidDraw ⟹ một lô MAGIC sống đúng kỳ e.
//   T4  người mới ký   — Consume + BurnBatch trên két Prepaid, CÙNG kỳ e với T3.
// Mọi tx: ví đang chọn trong `lucid` (ví khoá) trả phí và thế chấp. Ví trả phí bên thứ ba (Feecover)
// đòi hai thứ mà bộ dựng phải nhận từ người gọi, không tự đoán: lượng thế chấp TƯỜNG MINH
// (`collateralLovelace`, cả bốn bước) và hạn dùng ≤ 1 giờ (`validToMs` ở T1 — T2/T3 đã có cửa sổ
// `validityInEpoch` 10 phút, T4 có `epochValidityWindow` ≤ 1 giờ).
//
// SDK KHÔNG làm chính sách tài trợ (mỗi DID một lần, hạn mức): đó là việc của bên tài trợ. SDK chỉ
// ép HÌNH DẠNG giao dịch mà bên tài trợ đòi, và ném tường minh khi hình dạng đó không dựng được.
//
// Bộ dựng thật nằm ở module gốc, tệp này chỉ ghép: `@magiclamp/prepaidgen-sdk` ▸ `addMintPrepaidVault`,
// `addPrepaidLock`, `addPrepaidDraw`, `planPrepaidBurns`, `prepaidBurnFor`, `epochOfValidity`,
// `validityInEpoch`; `@magiclamp/consumemagic` ▸ `addMintEngage`, `buildConsumeTx`.

import {
  CML,
  getAddressDetails,
  validatorToScriptHash,
  valueToAssets,
  type Assets,
  type LucidEvolution,
  type TxBuilder,
  type TxSignBuilder,
  type UTxO,
  type Validator,
} from "@lucid-evolution/lucid";
import {
  applyOwnerAuth,
  collateralCompleteOptions,
  epochValidityWindow,
  msPerEpoch as networkMsPerEpoch,
  resolveOwnerAuth,
  windowOriginMs as networkWindowOriginMs,
  type Network,
  type OwnerAuth,
  type OwnerRef,
} from "@magiclamp/protocol-utils";
import {
  addMintEngage,
  buildConsumeTx,
  decodePriceParam,
  requiredFromBeacon,
} from "@magiclamp/consumemagic";
import {
  addMintPrepaidVault,
  addPrepaidDraw,
  addPrepaidLock,
  decodeVaultDatum,
  epochOfValidity,
  planPrepaidBurns,
  prepaidBurnFor,
  readFundUtxo,
  validityInEpoch,
  type PrepaidScripts,
  type TxValidity,
} from "@magiclamp/prepaidgen-sdk";

// ── Lỗi ───────────────────────────────────────────────────────────────────────

export type SponsorJourneyErrorCode =
  | "SPONSOR_DID_COMMIT_LENGTH"
  | "SPONSOR_VALIDITY_SPANS_EPOCHS"
  | "SPONSOR_EPOCH_MISMATCH"
  | "SPONSOR_GRID_MISMATCH"
  | "SPONSOR_ANCHOR_REF_MISSING"
  | "SPONSOR_ANCHOR_REF_WRONG"
  | "SPONSOR_FUND_NOT_PINNED"
  | "SPONSOR_CARP_INSUFFICIENT"
  | "SPONSOR_CARP_OUTPUT_UNPINNED"
  | "SPONSOR_WITHDRAW_COUNT"
  | "SPONSOR_BUILD_FAILED";

/** Mã lỗi có tên — tầng API ánh xạ thẳng từ `code`, không đoán từ câu chữ. */
export class SponsorJourneyError extends Error {
  constructor(readonly code: SponsorJourneyErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "SponsorJourneyError";
  }
}

const fail = (code: SponsorJourneyErrorCode, message: string): never => {
  throw new SponsorJourneyError(code, message);
};

// ── Kiểu dùng chung ───────────────────────────────────────────────────────────

export interface SponsorTxOutput {
  index: number;
  address: string;
  assets: Assets;
}

export interface SponsorTxResult<S> {
  /** Tx đã `complete()`, CHƯA KÝ. */
  tx: TxSignBuilder;
  /** CBOR của đúng tx đó (chưa có chữ ký). */
  txCbor: string;
  summary: S;
}

/** Anchor DID của người mới — đọc REFERENCE ở T2. Tên NFT = `owner_commit` = blake2b_256(utf8(did)). */
export interface NewcomerAnchorRef {
  utxo: UTxO;
  /** Policy NFT anchor của hệ danh tính, 28 byte hex. */
  anchorNftPolicyId: string;
  /** `owner_commit`, ĐÚNG 32 byte hex. */
  ownerCommit: string;
}

const HEX28 = /^[0-9a-f]{56}$/;
const HEX32 = /^[0-9a-f]{64}$/;

/** `did_commit` của hành trình: ĐÚNG 32 byte hex. Rỗng KHÔNG hợp lệ — hành trình tài trợ đòi DID. */
export function assertSponsorDidCommit(didCommit: unknown, what = "did_commit"): string {
  if (typeof didCommit !== "string" || !/^(?:[0-9a-fA-F]{2})*$/.test(didCommit)) {
    fail("SPONSOR_DID_COMMIT_LENGTH", `${what} phải là chuỗi hex, nhận ${JSON.stringify(didCommit)}`);
  }
  const s = (didCommit as string).toLowerCase();
  if (!HEX32.test(s)) {
    fail(
      "SPONSOR_DID_COMMIT_LENGTH",
      `${what} dài ${s.length / 2} byte; hành trình tài trợ đòi ĐÚNG 32 byte (blake2b_256(utf8(did))).`,
    );
  }
  return s;
}

/** Lưới kỳ của bộ script Prepaid phải TRÙNG lưới mạng mà `consume` và đồng hồ dùng. */
function assertGrid(scripts: PrepaidScripts, network: Network): { P: bigint; O: bigint } {
  const P = networkMsPerEpoch(network);
  const O = networkWindowOriginMs(network);
  if (scripts.params.msPerEpoch !== P || scripts.params.windowOriginMs !== O) {
    fail(
      "SPONSOR_GRID_MISMATCH",
      `bộ script Prepaid apply (ms_per_epoch=${scripts.params.msPerEpoch}, window_origin_ms=` +
        `${scripts.params.windowOriginMs}) nhưng mạng ${network} là (${P}, ${O}). Lệch lưới ⟹ kỳ của ` +
        `két và kỳ của consume khác nhau.`,
    );
  }
  return { P, O };
}

/** Kỳ của cặp cận; vắt hai kỳ ⟹ NÉM `SPONSOR_VALIDITY_SPANS_EPOCHS` trước khi dựng. */
function epochOrThrow(v: TxValidity, P: bigint, O: bigint): bigint {
  try {
    return epochOfValidity(v, P, O);
  } catch (e) {
    return fail(
      "SPONSOR_VALIDITY_SPANS_EPOCHS",
      `validity [${v.fromMs}, ${v.toMs}] không nằm gọn trong một kỳ: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function validityFor(nowMs: bigint, validity: TxValidity | undefined, P: bigint, O: bigint, ttlMs?: bigint) {
  let v: TxValidity;
  if (validity !== undefined) {
    v = validity;
  } else {
    try {
      v = ttlMs === undefined ? validityInEpoch(nowMs, P, O) : validityInEpoch(nowMs, P, O, ttlMs);
    } catch (e) {
      return fail("SPONSOR_VALIDITY_SPANS_EPOCHS", e instanceof Error ? e.message : String(e));
    }
  }
  return { validity: v, epoch: epochOrThrow(v, P, O) };
}

async function completeOrThrow(
  tx: TxBuilder, step: string, collateralLovelace?: bigint,
): Promise<{ tx: TxSignBuilder; txCbor: string }> {
  // Vắng `collateralLovelace` ⟹ mặc định của Lucid (hành vi cũ). Có ⟹ đúng lượng đó (luật hình dạng ở
  // `collateralCompleteOptions`, ném khi ≤ 0).
  const c = await tx.completeSafe(collateralCompleteOptions(collateralLovelace));
  if (c._tag === "Left") {
    const err = c.left as { message?: unknown; cause?: unknown };
    const cause = err?.cause === undefined ? "" : ` | cause: ${typeof err.cause === "string" ? err.cause : JSON.stringify(err.cause)}`;
    fail("SPONSOR_BUILD_FAILED", `${step}: Lucid không dựng được tx — ${String(err?.message ?? c.left)}${cause}`);
  }
  const signBuilder = (c as { right: TxSignBuilder }).right;
  return { tx: signBuilder, txCbor: signBuilder.toCBOR() };
}

/**
 * Lỗi `complete()` của Lucid ném ra từ bộ dựng module gốc (`buildConsumeTx` gọi `complete()`, không
 * `completeSafe()`) ⟹ `SPONSOR_BUILD_FAILED`, cùng mã với nhánh `Left` của `completeOrThrow` (T1–T3).
 * Lucid bọc lỗi trong `FiberFailure` nên không so được bằng `instanceof`; nhận diện theo TÊN lớp
 * `TxBuilderError` trong `name`/`message`. Lỗi có `code` (CONSUME-0xx, OWNER_*) và mọi lỗi khác (lỗi
 * lập trình) đi NGUYÊN — tên lớp Lucid đổi thì ca này rơi về 500 có `reference_code`, ồn chứ không im.
 */
function lucidBuildFailure(e: unknown, step: string): unknown {
  if (!(e instanceof Error)) return e;
  if (typeof (e as { code?: unknown }).code === "string") return e;
  if (!/TxBuilderError/.test(`${e.name} ${e.message}`)) return e;
  return new SponsorJourneyError("SPONSOR_BUILD_FAILED", `${step}: Lucid không dựng được tx — ${e.message}`);
}

// ── Đọc thân tx (CBOR) ────────────────────────────────────────────────────────

/** Các output của tx — địa chỉ bech32 + value. */
export function txOutputsOf(txCbor: string): SponsorTxOutput[] {
  const outs = CML.Transaction.from_cbor_hex(txCbor).body().outputs();
  const r: SponsorTxOutput[] = [];
  for (let i = 0; i < outs.len(); i++) {
    const o = outs.get(i);
    r.push({ index: i, address: o.address().to_bech32(undefined), assets: valueToAssets(o.amount()) });
  }
  return r;
}

/** `reference_inputs` của thân tx; vắng trường ⟹ rỗng. */
export function txReferenceInputsOf(txCbor: string): Array<{ txHash: string; outputIndex: number }> {
  const ins = CML.Transaction.from_cbor_hex(txCbor).body().reference_inputs();
  const r: Array<{ txHash: string; outputIndex: number }> = [];
  if (ins === undefined) return r;
  for (let i = 0; i < ins.len(); i++) {
    r.push({ txHash: ins.get(i).transaction_id().to_hex(), outputIndex: Number(ins.get(i).index()) });
  }
  return r;
}

/** Số mục rút trong thân tx (map theo credential — ledger không có khoá trùng). */
export function txWithdrawalCountOf(txCbor: string): number {
  const w = CML.Transaction.from_cbor_hex(txCbor).body().withdrawals();
  return w === undefined ? 0 : w.len();
}

/** Chủ script ⟹ đúng MỘT mục rút; chủ khoá ⟹ không mục rút nào do SDK thêm. */
function assertWithdrawals(txCbor: string, owner: OwnerRef, step: string): number {
  const n = txWithdrawalCountOf(txCbor);
  const want = owner.type === "script" ? 1 : 0;
  if (n !== want) {
    fail(
      "SPONSOR_WITHDRAW_COUNT",
      `${step}: tx có ${n} mục rút, chủ ${owner.type} đòi ĐÚNG ${want} (một mục rút did_stake phủ mọi cổng chủ).`,
    );
  }
  return n;
}

// ── T1 — mở két Prepaid + đúc thread consume ─────────────────────────────────

export interface SponsorT1Params {
  /** Ví đang chọn = ví khoá của người mới: trả phí, thế chấp. */
  lucid: LucidEvolution;
  prepaidScripts: PrepaidScripts;
  /** `consume` ĐÃ apply 8 tham số — vừa là policy thread, vừa là địa chỉ thread. */
  consumeScript: Validator;
  consumeRefUtxo?: UTxO;
  /** UTxO one-shot dùng CHUNG cho NFT két và NFT thread; tiêu đúng một lần. */
  seedUtxo: UTxO;
  /** Chủ két = chủ thread. Người dùng PersonDID: `{ type: "script", hash: did_stake }`. */
  owner: OwnerRef;
  /** Nhân chứng chủ; nhánh script gắn mục rút ĐÚNG một lần cho cả tx. */
  ownerAuth: OwnerAuth<TxBuilder>;
  /** `blake2b_256(utf8(did))`, ĐÚNG 32 byte hex. */
  didCommit: string;
  /** Mạng của lưới kỳ (apply-param `ms_per_epoch`/`window_origin_ms`). */
  network: Network;
  /** Lovelace của thread; vắng ⟹ mặc định của ConsumeMAGIC (2 ADA). */
  threadLovelace?: bigint;
  /** Cận trên hạn dùng (POSIX ms). Vắng ⟹ không đặt (hành vi cũ). Ví trả phí bên thứ ba đòi ≤ 1 giờ. */
  validToMs?: bigint;
  /** Lượng thế chấp tường minh (lovelace). Vắng ⟹ mặc định của Lucid. */
  collateralLovelace?: bigint;
  /**
   * Thêm phần dựng vào CÙNG tx trước khi hoàn tất (sau nhân chứng chủ, trước `validTo`). Dùng để chở genesis
   * quỹ tài trợ của DID trong tx mở két (`@magiclamp/prepaidgen-sdk` ▸ `planMintPaidFund` + `applyPlan`, cùng
   * `seedUtxo` với `collectSeed: false`). Vắng ⟹ tx như cũ.
   */
  extend?: (tx: TxBuilder) => TxBuilder;
}

export interface SponsorT1Summary {
  step: "T1";
  vaultUnit: string;
  vaultAddress: string;
  threadUnit: string;
  threadAddress: string;
  didCommit: string;
  owner: OwnerRef;
  withdrawals: number;
  outputs: SponsorTxOutput[];
}

export async function buildSponsorT1OpenPrepaid(p: SponsorT1Params): Promise<SponsorTxResult<SponsorT1Summary>> {
  const didCommit = assertSponsorDidCommit(p.didCommit);
  assertGrid(p.prepaidScripts, p.network);
  // Nhân chứng sai chủ ⟹ NÉM trước khi chạm Lucid.
  const auth = resolveOwnerAuth(p.owner, p.ownerAuth);

  const v = addMintPrepaidVault(p.lucid.newTx(), {
    scripts: p.prepaidScripts, seedUtxo: p.seedUtxo, owner: p.owner, collectSeed: true,
    ownerProof: { mode: "deferred" },
  });
  const th = addMintEngage(v.tx, {
    consumeScript: p.consumeScript, seedUtxo: p.seedUtxo, collectSeed: false, owner: p.owner,
    ownerProof: { mode: "deferred" }, didCommit, network: p.network, consumeRefUtxo: p.consumeRefUtxo,
    ...(p.threadLovelace === undefined ? {} : { lovelace: p.threadLovelace }),
  });
  let t1 = applyOwnerAuth(th.tx, auth);
  if (p.extend !== undefined) t1 = p.extend(t1);
  if (p.validToMs !== undefined) t1 = t1.validTo(Number(p.validToMs));
  const built = await completeOrThrow(t1, "T1", p.collateralLovelace);
  const withdrawals = assertWithdrawals(built.txCbor, p.owner, "T1");
  return {
    ...built,
    summary: {
      step: "T1",
      vaultUnit: v.nftUnit,
      vaultAddress: p.prepaidScripts.vault.address,
      threadUnit: th.engageNftUnit,
      threadAddress: th.engageAddress,
      didCommit,
      owner: p.owner,
      withdrawals,
      outputs: txOutputsOf(built.txCbor),
    },
  };
}

// ── T2 — PrepaidLock + FundLock, CARP từ bên tài trợ ────────────────────────

export interface SponsorT2Params {
  /** Ví đang chọn = ví khoá trả phí; KHÔNG phải ví bên tài trợ. */
  lucid: LucidEvolution;
  prepaidScripts: PrepaidScripts;
  vaultUtxo: UTxO;
  fundUtxo: UTxO;
  /** NFT của quỹ tài trợ đã ghim (`paid_fund hash ‖ fund_id`). `fundUtxo` phải mang nó. */
  pinnedFundUnit: string;
  /** carpdrop vào quỹ (≥ 1 CARP, luật ở PrepaidGen). */
  carpAmount: bigint;
  /** UTxO của bên tài trợ chứa CARP — tiêu hết; phần dư về `sponsorChangeAddress`. */
  sponsorCarpUtxos: UTxO[];
  sponsorChangeAddress: string;
  /** Anchor DID của người mới — BẮT BUỘC; thiếu ⟹ NÉM. */
  newcomerAnchor: NewcomerAnchorRef | undefined;
  /** Mở dòng mới ⟹ chủ két chứng minh quyền. */
  ownerAuth: OwnerAuth<TxBuilder>;
  network: Network;
  /** Thời điểm hiện tại (POSIX ms) để dựng validity gọn trong kỳ. */
  nowMs: bigint;
  /** Cặp cận tự chọn; vắng ⟹ `validityInEpoch(nowMs)`. Vắt hai kỳ ⟹ NÉM. */
  validity?: TxValidity;
  /** Hạn cận trên tính từ `nowMs` khi KHÔNG có `validity` (ms; vẫn kẹp vào cuối kỳ). Vắng ⟹ 10 phút
   *  (mặc định của `validityInEpoch`). Bên dựng hộ người dùng đặt nó bằng hạn ký của mình. */
  validityTtlMs?: bigint;
  /** Lượng thế chấp tường minh (lovelace). Vắng ⟹ mặc định của Lucid. */
  collateralLovelace?: bigint;
}

export interface SponsorT2Summary {
  step: "T2";
  epoch: bigint;
  fundId: string;
  fundUnit: string;
  carpAmount: bigint;
  opensNewLine: boolean;
  anchorRef: { txHash: string; outputIndex: number };
  /** pkh khoá của các UTxO bên tài trợ đã tiêu — bên tài trợ phải ký bằng chúng. */
  sponsorSigners: string[];
  withdrawals: number;
  outputs: SponsorTxOutput[];
}

function assertAnchor(a: NewcomerAnchorRef | undefined): NewcomerAnchorRef {
  if (a === undefined || a === null || typeof a !== "object" || a.utxo === undefined || a.utxo === null) {
    return fail(
      "SPONSOR_ANCHOR_REF_MISSING",
      `T2 phải mang reference input anchor DID của người mới (tên NFT = owner_commit); không có anchor.`,
    );
  }
  const policy = String(a.anchorNftPolicyId).toLowerCase();
  if (!HEX28.test(policy)) fail("SPONSOR_ANCHOR_REF_WRONG", `anchorNftPolicyId phải là 28 byte hex, nhận "${a.anchorNftPolicyId}"`);
  const commit = assertSponsorDidCommit(a.ownerCommit, "owner_commit");
  const unit = policy + commit;
  if ((a.utxo.assets[unit] ?? 0n) !== 1n) {
    fail(
      "SPONSOR_ANCHOR_REF_WRONG",
      `UTxO anchor ${a.utxo.txHash}#${a.utxo.outputIndex} không mang đúng 1 NFT ${unit}.`,
    );
  }
  return { utxo: a.utxo, anchorNftPolicyId: policy, ownerCommit: commit };
}

export interface SponsorCarpExpect {
  carpUnit: string;
  fundAddress: string;
  fundUnit: string;
  fundCarpOut: bigint;
  sponsorChangeAddress: string;
  sponsorChangeCarp: bigint;
}

/**
 * Mọi output mang CARP của T2 phải là (a) UTxO quỹ đã ghim với ĐÚNG số CARP sau nạp, hoặc (b) phần
 * thối của bên tài trợ với ĐÚNG số dư. Output CARP nào khác ⟹ NÉM `SPONSOR_CARP_OUTPUT_UNPINNED`.
 * Ví trả phí có CARP riêng mà chọn-coin kéo vào thì cũng bị chặn ở đây — fail-closed: dùng ví trả
 * phí không giữ CARP.
 */
export function assertSponsorCarpOutputs(txCbor: string, e: SponsorCarpExpect): void {
  let fundSeen = 0;
  let changeCarp = 0n;
  for (const o of txOutputsOf(txCbor)) {
    const carp = o.assets[e.carpUnit] ?? 0n;
    if (o.address === e.fundAddress && (o.assets[e.fundUnit] ?? 0n) === 1n) {
      fundSeen++;
      if (carp !== e.fundCarpOut) {
        fail("SPONSOR_CARP_OUTPUT_UNPINNED", `output #${o.index} (quỹ đã ghim) mang ${carp} CARP, cần ${e.fundCarpOut}.`);
      }
      continue;
    }
    if (carp === 0n) continue;
    if (o.address === e.sponsorChangeAddress) {
      changeCarp += carp;
      continue;
    }
    fail(
      "SPONSOR_CARP_OUTPUT_UNPINNED",
      `output #${o.index} gửi ${carp} CARP tới ${o.address} — ngoài UTxO quỹ đã ghim và phần thối bên tài trợ.`,
    );
  }
  if (fundSeen !== 1) fail("SPONSOR_CARP_OUTPUT_UNPINNED", `tx có ${fundSeen} output quỹ ${e.fundUnit}, cần ĐÚNG 1.`);
  if (changeCarp !== e.sponsorChangeCarp) {
    fail("SPONSOR_CARP_OUTPUT_UNPINNED", `phần thối bên tài trợ mang ${changeCarp} CARP, cần ${e.sponsorChangeCarp}.`);
  }
}

function sumAssets(us: UTxO[]): Assets {
  const out: Assets = {};
  for (const u of us) for (const [k, q] of Object.entries(u.assets)) out[k] = (out[k] ?? 0n) + q;
  return out;
}

export async function buildSponsorT2Fund(p: SponsorT2Params): Promise<SponsorTxResult<SponsorT2Summary>> {
  const anchor = assertAnchor(p.newcomerAnchor);
  const { P, O } = assertGrid(p.prepaidScripts, p.network);
  const { validity, epoch } = validityFor(p.nowMs, p.validity, P, O, p.validityTtlMs);

  const scripts = p.prepaidScripts;
  const fundUnit = p.pinnedFundUnit.toLowerCase();
  if (!fundUnit.startsWith(scripts.paidFund.hash) || (p.fundUtxo.assets[fundUnit] ?? 0n) !== 1n) {
    fail(
      "SPONSOR_FUND_NOT_PINNED",
      `fundUtxo ${p.fundUtxo.txHash}#${p.fundUtxo.outputIndex} không mang NFT quỹ đã ghim ${fundUnit} ` +
        `(policy quỹ ${scripts.paidFund.hash}).`,
    );
  }
  const fund = readFundUtxo(scripts, p.fundUtxo);

  const carpUnit = scripts.carpUnit;
  if (p.sponsorCarpUtxos.length === 0) fail("SPONSOR_CARP_INSUFFICIENT", `không có UTxO CARP nào của bên tài trợ.`);
  const sponsorIn = sumAssets(p.sponsorCarpUtxos);
  const sponsorCarp = sponsorIn[carpUnit] ?? 0n;
  if (sponsorCarp < p.carpAmount) {
    fail("SPONSOR_CARP_INSUFFICIENT", `UTxO bên tài trợ có ${sponsorCarp} CARP, cần ${p.carpAmount}.`);
  }
  const change: Assets = { ...sponsorIn };
  if (sponsorCarp === p.carpAmount) delete change[carpUnit];
  else change[carpUnit] = sponsorCarp - p.carpAmount;

  const sponsorSigners: string[] = [];
  for (const u of p.sponsorCarpUtxos) {
    const c = getAddressDetails(u.address).paymentCredential;
    if (c?.type !== "Key") fail("SPONSOR_CARP_INSUFFICIENT", `UTxO bên tài trợ ${u.txHash}#${u.outputIndex} không do khoá giữ.`);
    if (!sponsorSigners.includes(c!.hash)) sponsorSigners.push(c!.hash);
  }

  const r = addPrepaidLock(
    p.lucid.newTx().collectFrom(p.sponsorCarpUtxos).pay.ToAddress(p.sponsorChangeAddress, change),
    {
      scripts, vaultUtxo: p.vaultUtxo, fundUtxo: p.fundUtxo, amount: p.carpAmount, validity, by: "owner",
      ownerProof: { mode: "deferred" },
    },
  );
  if (r.plan.owner === null) fail("SPONSOR_BUILD_FAILED", `T2: kế hoạch Lock không đòi chủ — trái nhánh mở dòng.`);
  const owner = r.plan.owner as OwnerRef;
  const auth = resolveOwnerAuth(owner, p.ownerAuth);
  // Anchor DID của người mới: reference input bên tài trợ đòi. Lucid khử trùng `readFrom` theo
  // outref, nên nhân chứng `did_stake` đã gắn cùng anchor thì tx vẫn có đúng một mục.
  const tx = applyOwnerAuth(r.tx.readFrom([anchor.utxo]), auth);
  const built = await completeOrThrow(tx, "T2", p.collateralLovelace);

  const refs = txReferenceInputsOf(built.txCbor);
  if (!refs.some((x) => x.txHash === anchor.utxo.txHash && x.outputIndex === anchor.utxo.outputIndex)) {
    fail(
      "SPONSOR_ANCHOR_REF_MISSING",
      `T2 vừa dựng không có anchor ${anchor.utxo.txHash}#${anchor.utxo.outputIndex} trong reference_inputs.`,
    );
  }
  assertSponsorCarpOutputs(built.txCbor, {
    carpUnit,
    fundAddress: p.fundUtxo.address,
    fundUnit,
    fundCarpOut: (p.fundUtxo.assets[carpUnit] ?? 0n) + p.carpAmount,
    sponsorChangeAddress: p.sponsorChangeAddress,
    sponsorChangeCarp: sponsorCarp - p.carpAmount,
  });
  const withdrawals = assertWithdrawals(built.txCbor, owner, "T2");
  return {
    ...built,
    summary: {
      step: "T2",
      epoch,
      fundId: fund.fundId,
      fundUnit,
      carpAmount: p.carpAmount,
      opensNewLine: r.opensNewLine,
      anchorRef: { txHash: anchor.utxo.txHash, outputIndex: anchor.utxo.outputIndex },
      sponsorSigners,
      withdrawals,
      outputs: txOutputsOf(built.txCbor),
    },
  };
}

// ── T3 — PrepaidDraw ─────────────────────────────────────────────────────────

export interface SponsorT3Params {
  lucid: LucidEvolution;
  prepaidScripts: PrepaidScripts;
  vaultUtxo: UTxO;
  fundId: string;
  /** carpdrop rút khỏi hạn mức; MAGIC sinh = par(amount). */
  carpAmount: bigint;
  ownerAuth: OwnerAuth<TxBuilder>;
  network: Network;
  nowMs: bigint;
  validity?: TxValidity;
  /** Như `SponsorT2Params.validityTtlMs`. */
  validityTtlMs?: bigint;
  /** Lượng thế chấp tường minh (lovelace). Vắng ⟹ mặc định của Lucid. */
  collateralLovelace?: bigint;
}

export interface SponsorT3Summary {
  step: "T3";
  /** Kỳ của lô MAGIC — T4 PHẢI chạy trong đúng kỳ này. */
  epoch: bigint;
  batchId: string;
  magicNanogic: bigint;
  withdrawals: number;
  outputs: SponsorTxOutput[];
}

export async function buildSponsorT3Draw(p: SponsorT3Params): Promise<SponsorTxResult<SponsorT3Summary>> {
  const { P, O } = assertGrid(p.prepaidScripts, p.network);
  const { validity, epoch } = validityFor(p.nowMs, p.validity, P, O, p.validityTtlMs);
  const r = addPrepaidDraw(p.lucid.newTx(), {
    scripts: p.prepaidScripts, vaultUtxo: p.vaultUtxo, fundId: p.fundId, amount: p.carpAmount, validity,
    ownerProof: { mode: "deferred" },
  });
  const owner = r.plan.owner as OwnerRef;
  const built = await completeOrThrow(applyOwnerAuth(r.tx, resolveOwnerAuth(owner, p.ownerAuth)), "T3", p.collateralLovelace);
  const withdrawals = assertWithdrawals(built.txCbor, owner, "T3");
  return {
    ...built,
    summary: {
      step: "T3",
      epoch,
      batchId: r.batch.batch_id,
      magicNanogic: r.batch.current_amount,
      withdrawals,
      outputs: txOutputsOf(built.txCbor),
    },
  };
}

// ── T4 — consume đầu + BurnBatch trên két Prepaid ───────────────────────────

export interface SponsorT4Params {
  lucid: LucidEvolution;
  prepaidScripts: PrepaidScripts;
  consumeScript: Validator;
  consumeRefUtxo?: UTxO;
  /** Ref-script két; vắng ⟹ dùng `prepaidScripts.vault.refUtxo` nếu có. */
  vaultRefUtxo?: UTxO;
  engageUtxo: UTxO;
  vaultUtxo: UTxO;
  priceBeaconUtxo: UTxO;
  opType: number;
  opCount: bigint;
  ownerAuth: OwnerAuth<TxBuilder>;
  network: Network;
  tipPosixMs: bigint;
  /** Kỳ T3 đã rút (`SponsorT3Summary.epoch`). T4 khác kỳ ⟹ NÉM. */
  drawEpoch: bigint;
  maxPriceStale?: bigint;
  collateralLovelace?: bigint;
  /** Trần cận trên tính từ tip (ms) cho cửa sổ của `buildConsumeTx` (vẫn kẹp cuối epoch). Vắng ⟹ 1 giờ. */
  validityMaxAheadMs?: bigint;
}

export interface SponsorT4Summary {
  step: "T4";
  epoch: bigint;
  requiredNanogic: bigint;
  burns: Array<[string, bigint]>;
  threadUnit: string;
  withdrawals: number;
  outputs: SponsorTxOutput[];
}

export async function buildSponsorT4FirstConsume(p: SponsorT4Params): Promise<SponsorTxResult<SponsorT4Summary>> {
  const { P, O } = assertGrid(p.prepaidScripts, p.network);
  // Cùng cửa sổ mà `buildConsumeTx` sẽ ghi (epochValidityWindow trên tip + mạng).
  const win = p.validityMaxAheadMs === undefined
    ? epochValidityWindow(p.tipPosixMs, p.network)
    : epochValidityWindow(p.tipPosixMs, p.network, 0n, p.validityMaxAheadMs);
  const epoch = epochOrThrow({ fromMs: BigInt(win.lowerMs), toMs: BigInt(win.upperMs) }, P, O);
  if (epoch !== p.drawEpoch) {
    fail(
      "SPONSOR_EPOCH_MISMATCH",
      `T4 rơi vào kỳ ${epoch} nhưng T3 rút MAGIC ở kỳ ${p.drawEpoch}; lô Prepaid chỉ sống đúng kỳ rút ` +
        `(T3, T4 cùng kỳ). Dựng lại từ T3 ở kỳ mới.`,
    );
  }
  if (!p.priceBeaconUtxo.datum) fail("SPONSOR_BUILD_FAILED", `beacon giá thiếu inline datum.`);
  const required = requiredFromBeacon(decodePriceParam(p.priceBeaconUtxo.datum!), p.opType, p.opCount);
  if (!p.vaultUtxo.datum) fail("SPONSOR_BUILD_FAILED", `két Prepaid thiếu inline datum.`);
  const vd = decodeVaultDatum(p.vaultUtxo.datum!);
  const burns = planPrepaidBurns(vd, required, epoch);
  const pb = prepaidBurnFor(p.prepaidScripts, p.vaultUtxo, burns, epoch);

  // Lỗi có mã của ConsumeMAGIC (CONSUME-0xx, OWNER_*) đi nguyên.
  const r = await buildConsumeTx({
      lucid: p.lucid,
      engageUtxo: p.engageUtxo,
      vaultUtxo: p.vaultUtxo,
      priceBeaconUtxo: p.priceBeaconUtxo,
      consumeScript: p.consumeScript,
      vaultScript: p.prepaidScripts.vault.script as Validator,
      opType: p.opType,
      opCount: p.opCount,
      vaultBurnRedeemerCbor: pb.vaultBurnRedeemerCbor,
      vaultOutDatumCbor: pb.vaultOutDatumCbor,
      vaultOutAssets: pb.vaultOutAssets,
      vaultKind: "prepaid",
      ownerAuth: p.ownerAuth,
      consumeRefUtxo: p.consumeRefUtxo,
      vaultRefUtxo: p.vaultRefUtxo ?? p.prepaidScripts.vault.refUtxo,
      network: p.network,
      tipPosixMs: p.tipPosixMs,
      ...(p.validityMaxAheadMs === undefined ? {} : { validityMaxAheadMs: p.validityMaxAheadMs }),
      ...(p.maxPriceStale === undefined ? {} : { maxPriceStale: p.maxPriceStale }),
      ...(p.collateralLovelace === undefined ? {} : { collateralLovelace: p.collateralLovelace }),
  }).catch((e: unknown) => { throw lucidBuildFailure(e, "T4"); });
  if (r.currentEpoch !== p.drawEpoch) {
    fail("SPONSOR_EPOCH_MISMATCH", `buildConsumeTx ghi kỳ ${r.currentEpoch}, T3 ở kỳ ${p.drawEpoch}.`);
  }
  const txCbor = r.tx.toCBOR();
  const withdrawals = assertWithdrawals(txCbor, pb.owner as OwnerRef, "T4");
  // policy thread = hash `consume`; `buildConsumeTx` đã ép ĐÚNG một NFT dưới policy đó.
  const threadPolicy = validatorToScriptHash(p.consumeScript);
  const threadUnit = Object.keys(p.engageUtxo.assets).find((u) => u.startsWith(threadPolicy))!;
  return {
    tx: r.tx,
    txCbor,
    summary: {
      step: "T4",
      epoch,
      requiredNanogic: r.requiredNanogic,
      burns,
      threadUnit,
      withdrawals,
      outputs: txOutputsOf(txCbor),
    },
  };
}

// ── Kế hoạch: ai ký tx nào ───────────────────────────────────────────────────

export interface SponsorJourneyPlanInput {
  /** Chủ két/thread của người mới. */
  owner: OwnerRef;
  /** pkh bên tài trợ (giữ UTxO CARP). */
  sponsorPkh: string;
}

export interface SponsorJourneyStep {
  step: "T1" | "T2" | "T3" | "T4";
  action: string;
  /** Ai phải ký, theo vai. `owner` = chứng minh quyền chủ (khoá ký, hoặc mục rút did_stake). */
  signers: Array<{ role: "fee-wallet" | "owner" | "sponsor"; how: string }>;
  /** Điều kiện hình dạng SDK ép. */
  requires: string[];
}

export interface SponsorJourneyPlan {
  steps: SponsorJourneyStep[];
  /** Các bước phải nằm trong CÙNG một kỳ. T5 (genesis Wakeme) nằm ở kho khác, cùng kỳ với T3/T4. */
  sameEpoch: Array<"T3" | "T4" | "T5">;
}

/** Hàm thuần: nói rõ ai ký tx nào trong hành trình. Không I/O, không chính sách tài trợ. */
export function planSponsorJourney(i: SponsorJourneyPlanInput): SponsorJourneyPlan {
  if (!HEX28.test(String(i.owner?.hash).toLowerCase())) fail("SPONSOR_BUILD_FAILED", `owner.hash phải là 28 byte hex.`);
  if (!HEX28.test(String(i.sponsorPkh).toLowerCase())) fail("SPONSOR_BUILD_FAILED", `sponsorPkh phải là 28 byte hex.`);
  const owner = i.owner.type === "script"
    ? { role: "owner" as const, how: `một mục rút Script(${i.owner.hash}) (did_stake: controller + thiết bị ký)` }
    : { role: "owner" as const, how: `chữ ký khoá ${i.owner.hash}` };
  const fee = { role: "fee-wallet" as const, how: "ví khoá đang chọn trong lucid: phí + thế chấp" };
  return {
    steps: [
      {
        step: "T1", action: "đúc két Prepaid + thread consume (một tx)", signers: [fee, owner],
        requires: ["did_commit đúng 32 byte", "chủ script ⟹ đúng một mục rút"],
      },
      {
        step: "T2", action: "PrepaidLock + FundLock: CARP bên tài trợ vào quỹ đã ghim",
        signers: [fee, { role: "sponsor", how: `chữ ký khoá ${i.sponsorPkh} (chi UTxO CARP)` }, owner],
        requires: [
          "reference input anchor DID của người mới (tên NFT = owner_commit)",
          "CARP ra chỉ ở UTxO quỹ đã ghim hoặc phần thối bên tài trợ",
          "validity gọn trong một kỳ",
        ],
      },
      { step: "T3", action: "PrepaidDraw ⟹ lô MAGIC kỳ e", signers: [fee, owner], requires: ["validity gọn trong một kỳ"] },
      {
        step: "T4", action: "consume đầu + BurnBatch trên két Prepaid", signers: [fee, owner],
        requires: ["cùng kỳ với T3"],
      },
    ],
    sameEpoch: ["T3", "T4", "T5"],
  };
}
