// VaultTxAPI/src/sponsorFund.ts — quỹ tài trợ của MỘT DID: đọc tập quỹ đã ghim, tìm quỹ của DID cho
// `/tx/sponsor/fund-vault`, và bảng tình trạng cho `GET /sponsor/funds`.
//
// ── MỖI DID MỘT QUỸ TÀI TRỢ ─────────────────────────────────────────────────────
// CARP bên tài trợ nạp cho một người mới được THU HỒI về bên tài trợ cùng đợt `ReclaimEpoch` của két
// Wakeme của người đó. Validator chỉ cho thu hồi khi quỹ gắn đúng MỘT DID: quỹ mang
// `sponsorship = Some { sponsor, owner_commit, reclaim_after_epoch }`, và `PrepaidLock` đòi két mang
// đúng `owner_commit` đó (`PrepaidGen/onchain/validators/prepaid.ak` ▸ khối
// `when fund_in.sponsorship is { Some(s) -> … }` trong `validate_lock`). Quỹ `sponsorship = None`
// (quỹ chung) không có đường thu hồi nào về bên tài trợ ⟹ hành trình tài trợ KHÔNG BAO GIỜ dùng nó.
// Hệ quả phụ: hai DID không bao giờ tranh nhau một UTxO quỹ.
//
// ── GỐC TIN CẬY CỦA QUỸ: TẬP GHIM, HOẶC KHOÁ PLATFORM GHIM ──────────────────────
// Genesis quỹ chỉ đòi chữ ký `platform` (`PrepaidGen/offchain/src/prepaid.ts` ▸ `assertFundGenesis`
// trả `[fund.platform]`), KHÔNG đòi chữ ký bên tài trợ. Ai cũng đúc được một quỹ ghi
// `sponsorship.sponsor` = ví bên tài trợ, `owner_commit` = DID nạn nhân, bên hưởng = ví mình — với
// `platform` = khoá CỦA KẺ ĐÓ. Quét địa chỉ quỹ rồi chỉ lọc theo `sponsor` là chi CARP bên tài trợ vào
// quỹ đó. Hai gốc tin cậy, đều là thứ người gọi không viết được (cấu hình `paid_fund.sponsor`):
//   · `fund_units` — tập quỹ ghim nguyên văn; dịch vụ tra từng NFT.
//   · `platform_pkhs` — khoá platform được tin; vắng `fund_units` ⟹ dịch vụ QUÉT địa chỉ quỹ và chỉ giữ quỹ
//     có `datum.platform` thuộc tập này (quỹ platform lạ bị bỏ ngay ở bước quét, không hiện ở bảng tình trạng).
// Có cả hai ⟹ quỹ phải thoả cả hai (quỹ ghim mà platform lạ ⟹ `foreign_platform`).
//
// ── ĐÍCH NHẬN CARP: GHIM `beneficiary` ──────────────────────────────────────────
// Ghim platform chặn kẻ KHÔNG giữ khoá platform. Nó không chặn người GIỮ khoá đó (hoặc kẻ lấy được khoá):
// người đó đúc được quỹ mang đúng ví bên tài trợ + đúng DID nạn nhân, nhưng `beneficiary` = ví của mình;
// fund-vault chi CARP bên tài trợ vào quỹ, rồi `FundClaim` (platform ký) đưa CARP tới ví đó. Đích thật
// của MỌI quỹ tài trợ là một địa chỉ cố định ở cấu hình (`paid_fund.sponsor.beneficiary` + `beneficiary_datum`)
// — đúng thứ `/tx/sponsor/open-fund` ghi vào quỹ. Có ghim ⟹ quỹ lệch địa chỉ HOẶC lệch datum mang
// `foreign_beneficiary`. Quét theo `platform_pkhs` mà không có `fund_units` thì ghim này BẮT BUỘC
// (`config.ts` ▸ `parseSponsorPins` từ chối khởi động): ở đường quét, mọi quỹ do khoá platform đúc đều được tin.

import type { UTxO } from "@lucid-evolution/lucid";
import {
  bufferFloor, decodeFundDatum, maxClaimable, outstandingEffective, plutusAddressToBech32, plutusDataFromCbor,
  plutusDataToCbor, type PaidFundDatum,
} from "@magiclamp/prepaidgen-sdk";

import { CodedApiError } from "./errors.js";
import { refStr } from "./feePayer.js";

/**
 * Vì sao một quỹ trong tập ghim KHÔNG dùng được cho hành trình tài trợ:
 *   missing          không có UTxO chưa tiêu nào mang NFT quỹ ở địa chỉ `paid_fund`
 *   ambiguous        hơn một UTxO mang NFT đó — bất khả trên sổ cái đã lắng, không chọn đại
 *   undecodable      datum không giải mã được bằng lược đồ hiện hành, hoặc `fund_id` trong datum ≠ tên NFT
 *   foreign_platform `datum.platform` không thuộc `platform_pkhs` đã ghim (chỉ khi khoá đó có mặt)
 *   wrong_vault      datum trỏ script két khác két mà bản deploy phục vụ
 *   not_sponsored    `sponsorship = None` — quỹ chung, không thu hồi được về bên tài trợ
 *   foreign_sponsor  `sponsorship.sponsor` không thuộc tập địa chỉ bên tài trợ đã ghim
 *   foreign_beneficiary `beneficiary` khác địa chỉ đã ghim, hoặc `beneficiary_datum` khác datum đã ghim (vắng ⟺
 *                    vắng; có thì CBOR chuẩn hoá khớp từng byte) — chỉ khi `beneficiary` có mặt ở cấu hình
 */
export type SponsorFundProblem =
  "missing" | "ambiguous" | "undecodable" | "foreign_platform" | "wrong_vault" | "not_sponsored" | "foreign_sponsor"
  | "foreign_beneficiary";

/**
 * CBOR chuẩn hoá của một datum Plutus: giải mã rồi mã hoá lại bằng đúng bộ mã hoá mà open-fund dùng khi ghi
 * quỹ (`plutusDataFromCbor` cấu hình → `encodeFundDatum`). Hai cách viết CBOR khác nhau của cùng một giá trị
 * Plutus Data cho cùng chuỗi ở đây — validator so GIÁ TRỊ, nên phép so ở dịch vụ cũng phải so giá trị. Đi qua
 * codec của PrepaidGen SDK, không qua `Data` của gói này: datum đọc từ quỹ là `Constr` của bản lucid bên SDK.
 */
export function canonicalDatumCbor(cbor: string): string {
  return plutusDataToCbor(plutusDataFromCbor(cbor));
}

/** Vì sao một quỹ đang bận: khoá mềm của một lượt dựng còn sống · input vừa nộp chưa vào khối. */
export type SponsorFundBusyReason = "in_flight" | "pending_submit";

export interface SponsorFundEntry {
  unit: string;
  fundId: string;
  /** Có ⟹ đúng MỘT UTxO mang NFT quỹ ở địa chỉ quỹ. */
  utxo?: UTxO;
  /** Có ⟹ datum giải mã được (kể cả khi `problem` là `wrong_vault`/`not_sponsored`/`foreign_sponsor`). */
  datum?: PaidFundDatum;
  /** `sponsorship.owner_commit` — DID mà quỹ phục vụ. Vắng ⟹ quỹ không phải quỹ tài trợ. */
  ownerCommit?: string;
  /** `sponsorship.sponsor` dạng bech32 trên mạng của dịch vụ. */
  sponsorAddress?: string;
  problem?: SponsorFundProblem;
}

/**
 * Tập quỹ ứng viên → mỗi quỹ một dòng, theo ĐÚNG thứ tự `units`.
 * `utxosOfUnit` = mọi UTxO chưa tiêu mang `unit` (ở mọi địa chỉ); lọc theo `fundAddress` ở đây.
 * `platformPkhs` có ⟹ quỹ có `datum.platform` ngoài tập này mang `foreign_platform`.
 * `beneficiary` có ⟹ quỹ có đích nhận CARP khác (địa chỉ hoặc datum) mang `foreign_beneficiary`.
 */
export function classifySponsorFunds(p: {
  units: readonly string[]; fundScriptHash: string; fundAddress: string; vaultScriptHash: string;
  sponsorAddresses: readonly string[]; network: Parameters<typeof plutusAddressToBech32>[0];
  utxosOfUnit: ReadonlyMap<string, readonly UTxO[]>;
  platformPkhs?: readonly string[];
  beneficiary?: { address: string; datumCbor?: string };
}): SponsorFundEntry[] {
  // Chuẩn hoá MỘT lần; `config.ts` đã kiểm datum giải mã được lúc khởi động.
  const ben = p.beneficiary === undefined ? undefined : {
    address: p.beneficiary.address,
    datum: p.beneficiary.datumCbor === undefined ? null : canonicalDatumCbor(p.beneficiary.datumCbor),
  };
  return p.units.map(unit => {
    const fundId = unit.slice(p.fundScriptHash.length);
    const hits = (p.utxosOfUnit.get(unit) ?? []).filter(u => u.address === p.fundAddress && (u.assets[unit] ?? 0n) === 1n);
    if (hits.length === 0) return { unit, fundId, problem: "missing" as const };
    if (hits.length > 1) return { unit, fundId, problem: "ambiguous" as const };
    const utxo = hits[0]!;
    let datum: PaidFundDatum;
    try {
      if (typeof utxo.datum !== "string") throw new Error("không có datum nội tuyến");
      datum = decodeFundDatum(utxo.datum);
    } catch {
      return { unit, fundId, utxo, problem: "undecodable" as const };
    }
    if (datum.fund_id !== fundId) return { unit, fundId, utxo, problem: "undecodable" as const };
    // Ghim platform: gỡ vế này ⟹ quỹ do platform lạ đúc lọt qua (bài "platform lạ" ở sponsorFund.test.ts đỏ).
    if (p.platformPkhs !== undefined && !p.platformPkhs.includes(datum.platform.toLowerCase())) {
      return { unit, fundId, utxo, datum, problem: "foreign_platform" as const };
    }
    if (datum.vault_hash !== p.vaultScriptHash) return { unit, fundId, utxo, datum, problem: "wrong_vault" as const };
    const s = datum.sponsorship;
    if (s === null) return { unit, fundId, utxo, datum, problem: "not_sponsored" as const };
    const ownerCommit = s.owner_commit;
    let sponsorAddress: string | undefined;
    try {
      sponsorAddress = plutusAddressToBech32(p.network, s.sponsor);
    } catch {
      // Stake Pointer: không đổi được ra bech32 ⟹ không khớp được địa chỉ ghim nào.
      return { unit, fundId, utxo, datum, ownerCommit, problem: "foreign_sponsor" as const };
    }
    if (!p.sponsorAddresses.includes(sponsorAddress)) {
      return { unit, fundId, utxo, datum, ownerCommit, sponsorAddress, problem: "foreign_sponsor" as const };
    }
    // Ghim đích nhận CARP: đặt SAU `foreign_sponsor` để dòng lệch vẫn mang owner_commit + sponsor_address —
    // đủ cho người vận hành biết quỹ nào, của DID nào, đang hút CARP của bên tài trợ nào.
    if (ben !== undefined && !beneficiaryMatches(p.network, datum, ben)) {
      return { unit, fundId, utxo, datum, ownerCommit, sponsorAddress, problem: "foreign_beneficiary" as const };
    }
    return { unit, fundId, utxo, datum, ownerCommit, sponsorAddress };
  });
}

/**
 * Đích nhận CARP của quỹ có đúng đích đã ghim không — HAI vế, cả hai phải khớp:
 *   · địa chỉ: `datum.beneficiary` đổi ra bech32 trên mạng dịch vụ == địa chỉ ghim (dạng chính tắc, `config.ts`);
 *     không đổi được (Stake Pointer) ⟹ không khớp;
 *   · datum: vắng ⟺ ghim vắng; có ⟹ CBOR chuẩn hoá bằng nhau.
 * Cùng địa chỉ mà khác datum vẫn là đích khác: với beneficiary là script (`fee_inbox`), datum là dòng sổ bên
 * nhận dùng để nhận ra khoản tiền (`InboxDatum.refund`), nên datum lạ = CARP vào sổ của người khác.
 */
function beneficiaryMatches(
  network: Parameters<typeof plutusAddressToBech32>[0], d: PaidFundDatum, ben: { address: string; datum: string | null },
): boolean {
  let addr: string;
  try {
    addr = plutusAddressToBech32(network, d.beneficiary);
  } catch {
    return false;
  }
  if (addr !== ben.address) return false;
  const got = d.beneficiary_datum === null ? null : plutusDataToCbor(d.beneficiary_datum);
  return got === ben.datum;
}

/** Một quỹ có thuộc DID `didCommit` không: quỹ tài trợ dùng được VÀ `owner_commit` khớp. */
function servesDid(e: SponsorFundEntry, didCommit: string): boolean {
  return e.problem === undefined && e.ownerCommit === didCommit;
}

/**
 * Quỹ tài trợ của DID `didCommit` cho fund-vault.
 *
 * `callerFundId` có ⟹ quỹ đó phải dùng được VÀ thuộc đúng DID, không thì NÉM trước khi dựng:
 *   - không nằm trong tập ghim ⟹ đã chặn sớm hơn (`sponsor.ts` ▸ `assertFundPinnedInputs`, 422);
 *   - có `problem` ⟹ 422 `SPONSOR_FUND_NOT_ALLOWED` kèm `problem`;
 *   - thuộc DID khác ⟹ 422 `SPONSOR_FUND_DID_MISMATCH`.
 * Vắng ⟹ dịch vụ tìm trong tập ghim:
 *   - 0 quỹ ⟹ 409 `SPONSOR_FUND_NOT_OPENED` (DID chưa có quỹ tài trợ; người vận hành tạo rồi gọi lại);
 *   - >1 quỹ ⟹ 409 `SPONSOR_FUND_AMBIGUOUS` (không chọn đại: mỗi DID MỘT quỹ là quy ước, lệch là việc của
 *     người vận hành).
 */
export function resolveSponsorFund(
  entries: readonly SponsorFundEntry[], didCommit: string, callerFundId?: string,
): { entry: SponsorFundEntry; selection: "caller" | "did_lookup" } {
  if (callerFundId !== undefined) {
    const e = entries.find(x => x.fundId === callerFundId);
    if (e === undefined) {
      throw new CodedApiError(422, "SPONSOR_FUND_NOT_ALLOWED",
        `"fund_id" không thuộc tập quỹ bên tài trợ đã ghim ở cấu hình dịch vụ.`, { fund_id: callerFundId });
    }
    if (e.problem !== undefined) {
      throw new CodedApiError(422, "SPONSOR_FUND_NOT_ALLOWED",
        `Quỹ ${callerFundId} không dùng được cho hành trình tài trợ (${e.problem}).` +
        (e.problem === "not_sponsored" ? ` Quỹ chung (sponsorship = None) không thu hồi được CARP về bên tài trợ.` : "") +
        (e.problem === "foreign_beneficiary"
          ? ` Đích nhận CARP của quỹ khác đích đã ghim (paid_fund.sponsor.beneficiary) — quỹ đúc bằng khoá platform nhưng ` +
            `trả CARP đi nơi khác; báo người vận hành.` : ""),
        { fund_id: callerFundId, problem: e.problem });
    }
    if (!servesDid(e, didCommit)) {
      throw new CodedApiError(422, "SPONSOR_FUND_DID_MISMATCH",
        `Quỹ ${callerFundId} là quỹ tài trợ của DID khác (owner_commit ${e.ownerCommit!.slice(0, 16)}…), không phải ` +
        `DID của két này (${didCommit.slice(0, 16)}…). Bỏ "fund_id" để dịch vụ tìm quỹ của DID.`,
        { fund_id: callerFundId, owner_commit: e.ownerCommit, did_commit: didCommit });
    }
    return { entry: e, selection: "caller" };
  }
  const mine = entries.filter(e => servesDid(e, didCommit));
  if (mine.length === 0) {
    throw new CodedApiError(409, "SPONSOR_FUND_NOT_OPENED",
      `DID ${didCommit.slice(0, 16)}… chưa có quỹ tài trợ trong gốc tin cậy. Tạo quỹ tài trợ cho DID này ` +
      `(/tx/sponsor/open-fund) trước bước fund-vault.`,
      { did_commit: didCommit, pinned_funds: entries.length });
  }
  if (mine.length > 1) {
    throw new CodedApiError(409, "SPONSOR_FUND_AMBIGUOUS",
      `DID ${didCommit.slice(0, 16)}… có ${mine.length} quỹ tài trợ trong tập ghim; mỗi DID MỘT quỹ. Gửi "fund_id" ` +
      `để chỉ đích danh, hoặc báo người vận hành gỡ quỹ thừa khỏi cấu hình.`,
      { did_commit: didCommit, fund_ids: mine.map(e => e.fundId) });
  }
  return { entry: mine[0]!, selection: "did_lookup" };
}

// ── bảng tình trạng (GET /sponsor/funds) ────────────────────────────────────────

/** Số kế toán của một quỹ, đọc từ datum. Số lớn là CHUỖI chữ số như mọi số tiền của API. */
export function fundAccountingJson(d: PaidFundDatum, carpHeld: bigint): Record<string, unknown> {
  const outstanding = outstandingEffective(d.credit_issued, d.sponsor_reclaimed, d.magic_settled);
  // `outstanding < 0` là trạng thái validator không cho tạo (kế toán quyết toán quá hạn-mức). Báo
  // thẳng, không tính sàn đệm trên một số âm (`bufferFloor` từ chối số âm).
  const ok = outstanding >= 0n && d.buffer_bps >= 0n;
  return {
    credit_issued: d.credit_issued.toString(),
    magic_settled: d.magic_settled.toString(),
    sponsor_reclaimed: d.sponsor_reclaimed.toString(),
    provider_claimed: d.provider_claimed.toString(),
    carp_locked: d.carp_locked.toString(),
    carp_held: carpHeld.toString(),
    buffer_bps: d.buffer_bps.toString(),
    outstanding: outstanding.toString(),
    buffer_floor: ok ? bufferFloor(outstanding, d.buffer_bps).toString() : null,
    claimable_carp: ok ? maxClaimable(d).toString() : null,
    ...(ok ? {} : { accounting_anomaly: outstanding < 0n ? "outstanding_negative" : "buffer_bps_negative" }),
  };
}

export interface SponsorWalletView { address: string; utxos: readonly UTxO[] }

/** Thân `GET /sponsor/funds`. Cộng tổng chỉ trên quỹ tài trợ dùng được (`problem` vắng). */
export function sponsorFundsStatusBody(p: {
  entries: readonly SponsorFundEntry[]; carpUnit: string; busyOf: (e: SponsorFundEntry) => SponsorFundBusyReason | null;
  wallets: readonly SponsorWalletView[]; maxCarpAmount: bigint; nowMs: number;
}): Record<string, unknown> {
  const sum = { credit_issued: 0n, magic_settled: 0n, carp_locked: 0n, sponsor_reclaimed: 0n };
  let busy = 0;
  let usable = 0;
  let unusable = 0;
  const funds = p.entries.map(e => {
    const reason = e.utxo === undefined ? null : p.busyOf(e);
    if (e.problem !== undefined) unusable++;
    else usable++;
    if (reason !== null) busy++;
    if (e.problem === undefined && e.datum !== undefined) {
      sum.credit_issued += e.datum.credit_issued;
      sum.magic_settled += e.datum.magic_settled;
      sum.carp_locked += e.datum.carp_locked;
      sum.sponsor_reclaimed += e.datum.sponsor_reclaimed;
    }
    const s = e.datum?.sponsorship ?? null;
    return {
      fund_id: e.fundId,
      fund_unit: e.unit,
      utxo_ref: e.utxo === undefined ? null : refStr(e.utxo),
      problem: e.problem ?? null,
      owner_commit: e.ownerCommit ?? null,
      sponsor_address: e.sponsorAddress ?? null,
      reclaim_after_epoch: s === null ? null : s.reclaim_after_epoch.toString(),
      busy: reason !== null,
      busy_reason: reason,
      accounting: e.datum === undefined ? null : fundAccountingJson(e.datum, e.utxo!.assets[p.carpUnit] ?? 0n),
    };
  });
  let walletCarp = 0n;
  const wallets = p.wallets.map(w => {
    const carp = w.utxos.reduce((a, u) => a + (u.assets[p.carpUnit] ?? 0n), 0n);
    walletCarp += carp;
    return {
      address: w.address,
      carp: carp.toString(),
      utxo_count: w.utxos.length,
      carp_utxo_count: w.utxos.filter(u => (u.assets[p.carpUnit] ?? 0n) > 0n).length,
    };
  });
  return {
    as_of: new Date(p.nowMs).toISOString(),
    pinned_funds: p.entries.length,
    usable,
    unusable,
    busy,
    funds,
    totals: {
      credit_issued: sum.credit_issued.toString(),
      magic_settled: sum.magic_settled.toString(),
      carp_locked: sum.carp_locked.toString(),
      sponsor_reclaimed: sum.sponsor_reclaimed.toString(),
    },
    // CARP còn ở ví bên tài trợ — thứ cạn được của hành trình. `max_carp_amount` là trần một lượt
    // fund-vault đã ghim.
    sponsor_wallets: wallets,
    sponsor_carp_total: walletCarp.toString(),
    max_carp_amount: p.maxCarpAmount.toString(),
  };
}
