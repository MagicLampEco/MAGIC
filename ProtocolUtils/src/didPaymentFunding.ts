// src/didPaymentFunding.ts — nạp LAMP cho một giao dịch từ ví Phoenix (script `did_payment`).
//
// Ví Phoenix giữ tài sản ở một địa chỉ SCRIPT: payment credential = `Script(h)` với h là
// `did_payment` đã apply `(anchor_nft_policy, blake2b_256(utf8(did)))` — cùng bộ tham số với
// `did_stake`. Dữ kiện do nhà Phoenix cung cấp và đã xác nhận (2026-09-26); kho này KHÔNG giữ
// mã nguồn validator đó:
//
//   · h = blake2b_224(0x03 ‖ cbor). Tệp này KHÔNG apply tham số — nó nhận CBOR đã apply, BĂM
//     LẠI và so với payment credential của địa chỉ khai. Lệch ⟹ `FUNDING_SCRIPT_MISMATCH`.
//   · Redeemer `Spend` = `Constr 0 []` (CBOR `d87980`), mỗi UTxO chi một redeemer.
//   · Script đính INLINE (Preprod không có ref-script cho `did_payment`).
//   · UTxO anchor DID là REFERENCE input, Active; `required_signers` = controller + MỘT khoá
//     thiết bị — cùng bộ với `did_stake`.
//
// Hai điều ở đây là HÌNH DẠNG, không phải con số:
//
//   (1) Tài sản chi từ `did_payment` chỉ đi vào hai chỗ: output đích (ở đây: vault) và MỘT
//       output thối về CHÍNH địa chỉ `did_payment`. Không về ví trả phí. Nên phần thối được
//       trả TƯỜNG MINH ở đây, không để bộ cân bằng của thư viện dồn vào "địa chỉ đổi tiền
//       thừa" — địa chỉ đó là của ví trả phí.
//   (2) Chọn đúng số UTxO cần: sắp theo LAMP giảm dần rồi lấy tiền tố ngắn nhất đủ trả. Với
//       RIÊNG vế LAMP, tiền tố của dãy giảm dần là tập ÍT UTxO nhất đạt ngưỡng. Khi vế ADA
//       (min-ADA của output thối) cũng ràng buộc thì đây là tham lam, không bảo đảm tối ưu
//       — nói ra để không ai đọc "tối thiểu" thành "tối ưu".
//
// Gói này không phụ thuộc Lucid (xem `ownerAuth.ts`): băm script, đọc credential của địa chỉ
// và tính min-ADA đi vào qua `DidPaymentPorts` (MagicSDK ▸ `didPaymentLucidPorts`).

/** Redeemer `Spend` của `did_payment` = `Constr 0 []`. */
export const DID_PAYMENT_SPEND_REDEEMER = "d87980";

/** Trần hạn dùng của giao dịch có ví trả phí bên thứ ba (mô hình Feecover): ≤ 1 giờ. */
export const FUNDING_MAX_VALIDITY_MS = 3_600_000n;

export type FundingErrorCode =
  | "FUNDING_SHAPE"
  | "FUNDING_SCRIPT_MISMATCH"
  | "FUNDING_INSUFFICIENT"
  | "FUNDING_WITNESS_MISMATCH"
  | "FUNDING_FEE_PAYER_INVALID";

/** Lỗi có mã — tầng API ánh xạ thẳng từ `code`, không đoán từ câu chữ. */
export class FundingError extends Error {
  readonly code: FundingErrorCode;
  readonly details: Record<string, unknown>;
  constructor(code: FundingErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(`${code}: ${message}`);
    this.name = "FundingError";
    this.code = code;
    this.details = details;
  }
}

/** Hình dạng UTxO tệp này đọc — trùng tên trường với `UTxO` của Lucid. */
export interface FundingUtxoLike {
  txHash: string;
  outputIndex: number;
  assets: Record<string, bigint>;
  datum?: string | null;
  datumHash?: string | null;
}

export interface DidPaymentPorts {
  /** blake2b_224(0x03 ‖ cbor) — hash của script PlutusV3. */
  scriptHashOf(scriptCbor: string): string;
  /** Payment credential của địa chỉ bech32. Không đọc được ⟹ NÉM. */
  paymentCredentialOf(address: string): { type: "Key" | "Script"; hash: string };
  /** min-ADA (lovelace) của một output không datum mang `assets` (không tính lovelace) tại `address`. */
  minLovelaceFor(address: string, assets: Record<string, bigint>): bigint;
}

const CBOR_HEX = /^(?:[0-9a-f]{2})+$/;
const HASH28 = /^[0-9a-f]{56}$/;

/**
 * `did_payment_script_cbor` phải băm ra đúng payment credential `Script(h)` của `address`.
 * Trả về h. Địa chỉ có payment credential là KHOÁ ⟹ cũng là lệch (nó không phải ví Phoenix).
 */
export function assertDidPaymentAddress(scriptCbor: string, address: string, ports: DidPaymentPorts): string {
  const cbor = typeof scriptCbor === "string" ? scriptCbor.toLowerCase() : "";
  if (!CBOR_HEX.test(cbor)) {
    throw new FundingError("FUNDING_SHAPE", `did_payment_script_cbor phải là hex số ký tự chẵn, khác rỗng.`);
  }
  let cred: { type: "Key" | "Script"; hash: string };
  try {
    cred = ports.paymentCredentialOf(address);
  } catch {
    throw new FundingError("FUNDING_SHAPE", `funding.address không phải địa chỉ Cardano đọc được.`);
  }
  const got = ports.scriptHashOf(cbor);
  if (!HASH28.test(got)) {
    throw new FundingError("FUNDING_SHAPE", `hash của did_payment_script_cbor không phải 28 byte.`);
  }
  if (cred.type !== "Script" || cred.hash !== got) {
    throw new FundingError(
      "FUNDING_SCRIPT_MISMATCH",
      `did_payment_script_cbor băm ra ${got} nhưng payment credential của funding.address là ` +
        `${cred.type}:${cred.hash}. Script này không giữ tài sản ở địa chỉ đó — thường do apply sai ` +
        `DID hoặc sai anchor_nft_policy.`,
      { script_hash: got, address_credential: `${cred.type}:${cred.hash}` },
    );
  }
  return got;
}

export interface DidPaymentPlanInput<U extends FundingUtxoLike> {
  /** Mọi UTxO đang ở địa chỉ `did_payment`. */
  utxos: U[];
  /** Lượng output đích phải nhận từ `did_payment`: `lovelace` + từng unit, mỗi giá trị > 0. */
  need: Record<string, bigint>;
  /** Unit xếp hạng chính (LAMP). */
  primaryUnit: string;
  /** Địa chỉ nhận phần thối = chính địa chỉ `did_payment`. */
  returnAddress: string;
  /** Lovelace vào giao dịch thuộc về CHỦ DID ngoài UTxO (mục rút `did_stake`). Nó cũng thối
   *  về `returnAddress`, không về ví trả phí. Mặc định 0. */
  extraLovelace?: bigint;
}

export interface DidPaymentPlan<U> {
  selected: U[];
  /** Tổng giá trị các UTxO đã chọn. */
  spent: Record<string, bigint>;
  /** Output thối về `returnAddress`; `null` khi chi vừa khít (không có gì để thối). */
  returned: Record<string, bigint> | null;
  /** UTxO bị loại vì mang datum hash không kèm datum (không chi được nếu thiếu tiền ảnh). */
  skipped: U[];
}

function add(a: Record<string, bigint>, b: Record<string, bigint>): Record<string, bigint> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0n) + v;
  return out;
}

/** Chọn UTxO `did_payment` đủ trả `need` + min-ADA của output thối. Thiếu ⟹ `FUNDING_INSUFFICIENT`. */
export function planDidPaymentFunding<U extends FundingUtxoLike>(
  input: DidPaymentPlanInput<U>,
  ports: DidPaymentPorts,
): DidPaymentPlan<U> {
  for (const [unit, q] of Object.entries(input.need)) {
    if (typeof q !== "bigint" || q <= 0n) {
      throw new FundingError("FUNDING_SHAPE", `need[${unit}] phải là bigint > 0.`);
    }
  }
  const extra = input.extraLovelace ?? 0n;
  if (typeof extra !== "bigint" || extra < 0n) throw new FundingError("FUNDING_SHAPE", `extraLovelace phải ≥ 0.`);

  const skipped = input.utxos.filter(u => u.datumHash != null && u.datum == null);
  const pool = input.utxos
    .filter(u => !(u.datumHash != null && u.datum == null))
    .sort((a, b) => {
      const pa = a.assets[input.primaryUnit] ?? 0n;
      const pb = b.assets[input.primaryUnit] ?? 0n;
      if (pa !== pb) return pb > pa ? 1 : -1;
      const la = a.assets.lovelace ?? 0n;
      const lb = b.assets.lovelace ?? 0n;
      if (la !== lb) return lb > la ? 1 : -1;
      if (a.txHash !== b.txHash) return a.txHash < b.txHash ? -1 : 1;
      return a.outputIndex - b.outputIndex;
    });

  const selected: U[] = [];
  let spent: Record<string, bigint> = {};
  for (const u of pool) {
    selected.push(u);
    spent = add(spent, u.assets);
    const rem = add(add(spent, { lovelace: extra }), Object.fromEntries(
      Object.entries(input.need).map(([k, v]) => [k, -v]),
    ));
    if (Object.values(rem).some(v => v < 0n)) continue;
    const tokens = Object.fromEntries(Object.entries(rem).filter(([k, v]) => k !== "lovelace" && v > 0n));
    const lovelace = rem.lovelace ?? 0n;
    if (Object.keys(tokens).length === 0 && lovelace === 0n) {
      return { selected, spent, returned: null, skipped };
    }
    if (lovelace >= ports.minLovelaceFor(input.returnAddress, tokens)) {
      return { selected, spent, returned: { lovelace, ...tokens }, skipped };
    }
  }
  const have = add(add(spent, {}), { lovelace: extra });
  throw new FundingError(
    "FUNDING_INSUFFICIENT",
    `ví did_payment không đủ: cần ${input.need[input.primaryUnit] ?? 0n} ${input.primaryUnit.slice(0, 12)}… + ` +
      `${input.need.lovelace ?? 0n} lovelace cho output đích, cộng min-ADA của output thối; có ` +
      `${have[input.primaryUnit] ?? 0n} và ${have.lovelace ?? 0n} lovelace trên ${pool.length} UTxO chi được.`,
    {
      need_primary: String(input.need[input.primaryUnit] ?? 0n),
      need_lovelace: String(input.need.lovelace ?? 0n),
      have_primary: String(have[input.primaryUnit] ?? 0n),
      have_lovelace: String(have.lovelace ?? 0n),
      spendable_utxos: pool.length,
      skipped_datum_hash_utxos: skipped.length,
    },
  );
}
