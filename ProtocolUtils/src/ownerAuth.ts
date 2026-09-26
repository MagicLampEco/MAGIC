// src/ownerAuth.ts — chủ vault / chủ thread là một `Credential`, không còn là pkh trần.
//
// Nguồn on-chain (theo TÊN HÀM, không theo số dòng):
//   `InstantGen|ScheduleGen|PrepaidGen/onchain/lib/magiclamp/protocol/owner_auth.ak`
//   và `ConsumeMAGIC/onchain/lib/magiclamp/consume/owner_auth.ak` ▸ `owner_authorized`:
//
//     VerificationKey(pkh) ⟹ pkh ∈ tx.extra_signatories
//     Script(h)            ⟹ tx.withdrawals có khoá Script(h) — validator KHÔNG ép lượng;
//                             ledger ép lượng == số dư thưởng hiện có (xem `OwnerAuth`)
//
// Mã hoá Plutus Data — blueprint `cardano/address/Credential` (đối chiếu `plutus.json` của
// bốn module sau `aiken build`, 2026-09-26):
//     VerificationKey(h) = Constr 0 [bytes 28]
//     Script(h)          = Constr 1 [bytes 28]
//
// Gói này cố ý KHÔNG phụ thuộc Lucid (xem khối chú thích trên `assertRefScriptsCover` ở
// `index.ts`). Nên ở đây chỉ có KIỂU và CHÍNH SÁCH: hình dạng `OwnerCredential` trùng
// đúng `Data.Static` của lược đồ Lucid mà mỗi gói tự khai (`OwnerCredentialSchema`), và
// phép mã hoá thành bytes nằm ở gói đó — mỗi gói có cặp ca so bytes với hằng đã đối chiếu
// blueprint.
//
// ⚠ PrepaidGen/offchain KHÔNG phụ thuộc gói này, nên nó giữ một BẢN SAO có nhãn của phần
//   thân bên dưới dấu `── THÂN ──`: `PrepaidGen/offchain/src/ownerAuth.ts`. Bài
//   `PrepaidGen/tests/ownerAuth.test.ts` so HAI THÂN theo từng ký tự — sửa một bên mà
//   quên bên kia thì bài đó đỏ.

// ── THÂN ──────────────────────────────────────────────────────────────────────

/** Hai nhánh của chủ. Không có nhánh thứ ba — on-chain cũng không có. */
export type OwnerKind = "key" | "script";

/**
 * `Credential` ở dạng `Data.Static` của lược đồ Lucid
 * `Data.Enum([Data.Object({ VerificationKey: Data.Tuple([Data.Bytes()]) }),
 *             Data.Object({ Script: Data.Tuple([Data.Bytes()]) })])`.
 * Đây là thứ nằm ở trường 0 của datum vault / Engage sau `Data.from`.
 */
export type OwnerCredential =
  | { VerificationKey: [string] }
  | { Script: [string] };

/** Dạng đi ra ngoài (JSON / API): tag + 28 byte hex, chữ thường. */
export interface OwnerRef {
  type: OwnerKind;
  hash: string;
}

/**
 * Cách bộ dựng giao dịch chứng minh quyền chủ.
 *
 *   · `key`    — bộ dựng gọi `addSignerKey(pkh)`.
 *   · `script` — bộ dựng gọi `attachWithdraw(tx)` ĐÚNG MỘT LẦN và dùng giao dịch nó trả về.
 *                Bộ dựng KHÔNG tự bịa redeemer hay ref-script cho stake-script của chủ:
 *                thứ đó do bên ví (Phoenix) biết, và nó phải tự thêm mục rút
 *                `Script(hash)` kèm chứng từ của script đó.
 *
 *                ⚠ Validator không ép lượng rút, nhưng LEDGER thì ép: mục rút phải bằng
 *                ĐÚNG số dư thưởng hiện có của tài khoản `Script(hash)`, và tài khoản đó
 *                phải đã ĐĂNG KÝ. "Rút 0" chỉ đúng khi số dư đang là 0 (DID đã uỷ thác
 *                pool thì số dư > 0). Bên cung cấp `attachWithdraw` phải tra số dư rồi rút
 *                đúng số đó; chưa đăng ký ⟹ `OWNER_STAKE_NOT_REGISTERED`, không dựng tx.
 */
export type OwnerAuth<Tx = unknown> =
  | { kind: "key"; pkh: string }
  | { kind: "script"; hash: string; attachWithdraw: (tx: Tx) => Tx };

/** Mã lỗi có tên — tầng API ánh xạ thẳng từ `code`, không đoán từ câu chữ. */
export type OwnerAuthErrorCode =
  | "OWNER_HASH_INVALID"
  | "OWNER_CREDENTIAL_SHAPE"
  | "OWNER_AUTH_MISMATCH"
  | "OWNER_SCRIPT_WITNESS_UNAVAILABLE"
  | "OWNER_STAKE_NOT_REGISTERED"
  | "OWNER_WITHDRAW_RETURNED_NOTHING";

export class OwnerAuthError extends Error {
  readonly code: OwnerAuthErrorCode;
  constructor(code: OwnerAuthErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "OwnerAuthError";
    this.code = code;
  }
}

const HASH28 = /^[0-9a-f]{56}$/;

/** 28 byte hex → chữ thường; sai hình dạng thì NÉM (không đệm, không cắt). */
export function assertHash28(hex: unknown, what: string): string {
  if (typeof hex !== "string" || !HASH28.test(hex.toLowerCase())) {
    throw new OwnerAuthError(
      "OWNER_HASH_INVALID",
      `${what} phải là hex đúng 28 byte (56 ký tự), nhận ${JSON.stringify(hex)?.slice(0, 80)}`,
    );
  }
  return hex.toLowerCase();
}

/** Dựng `Credential` từ tag + hash. */
export function ownerCredential(kind: OwnerKind, hash: string): OwnerCredential {
  const h = assertHash28(hash, kind === "key" ? "pkh của chủ" : "script hash của chủ");
  if (kind === "key") return { VerificationKey: [h] };
  if (kind === "script") return { Script: [h] };
  throw new OwnerAuthError("OWNER_CREDENTIAL_SHAPE", `kind lạ: ${JSON.stringify(kind)}`);
}

/** `OwnerAuth` (hoặc `OwnerRef`) → `Credential` ghi vào datum. */
export function ownerCredentialOf(
  auth: OwnerAuth<any> | OwnerRef,
): OwnerCredential {
  if ("kind" in auth) {
    return auth.kind === "key"
      ? ownerCredential("key", auth.pkh)
      : ownerCredential("script", auth.hash);
  }
  return ownerCredential(auth.type, auth.hash);
}

/** `Credential` (đã `Data.from`) → `OwnerRef`. Hình dạng lạ thì NÉM. */
export function ownerRefOf(c: unknown): OwnerRef {
  if (c !== null && typeof c === "object" && !Array.isArray(c)) {
    const o = c as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1) {
      const tag = keys[0]!;
      const v = o[tag];
      if (Array.isArray(v) && v.length === 1) {
        if (tag === "VerificationKey") return { type: "key", hash: assertHash28(v[0], "VerificationKey") };
        if (tag === "Script") return { type: "script", hash: assertHash28(v[0], "Script") };
      }
    }
  }
  throw new OwnerAuthError(
    "OWNER_CREDENTIAL_SHAPE",
    `không phải Credential ({VerificationKey:[h]} | {Script:[h]}): ` +
      `${JSON.stringify(c, (_k, x) => (typeof x === "bigint" ? `${x}n` : x))?.slice(0, 120)}`,
  );
}

/**
 * Trường 0 đọc THÔ bằng `Data.from(cbor)` (không lược đồ) → `OwnerRef`.
 * Nhận hình dạng cấu trúc của `Constr` Lucid (`{ index, fields }`), nên gói này không cần
 * import Lucid. Gương của `expect vault_owner: Credential = owner_data` ở
 * `consume.ak` ▸ `all_vault_owners_are`: tag 0/1, đúng một trường, 28 byte.
 */
export function ownerRefFromPlutusData(d: unknown): OwnerRef {
  if (d !== null && typeof d === "object" && "index" in d && "fields" in d) {
    const { index, fields } = d as { index: unknown; fields: unknown };
    if (Array.isArray(fields) && fields.length === 1 && (index === 0 || index === 1)) {
      return {
        type: index === 0 ? "key" : "script",
        hash: assertHash28(fields[0], index === 0 ? "VerificationKey" : "Script"),
      };
    }
  }
  throw new OwnerAuthError(
    "OWNER_CREDENTIAL_SHAPE",
    `trường owner không phải Credential (Constr 0|1 [bytes 28]). ` +
      `Datum dựng theo lược đồ cũ (owner = pkh trần) không đọc được bằng validator hiện hành.`,
  );
}

/** 28 byte BÊN TRONG credential (pkh hoặc script hash). */
export function ownerInnerHash(c: OwnerCredential): string {
  return ownerRefOf(c).hash;
}

/** Cùng tag VÀ cùng 28 byte — đúng phép `==` trên `Credential` ở on-chain. */
export function sameOwner(a: OwnerRef, b: OwnerRef): boolean {
  return a.type === b.type && a.hash.toLowerCase() === b.hash.toLowerCase();
}

/** Dạng người đọc: `key:<hash>` / `script:<hash>`. */
export function ownerRefToString(r: OwnerRef): string {
  return `${r.type}:${r.hash}`;
}

/**
 * Chọn cách chứng minh quyền chủ cho một datum đang tiêu.
 *
 *   · Không truyền `auth`, chủ là khoá  ⟹ nhánh `key` với pkh lấy thẳng từ datum.
 *   · Không truyền `auth`, chủ là script ⟹ NÉM `OWNER_SCRIPT_WITNESS_UNAVAILABLE` — không bịa.
 *   · Có `auth` mà khác chủ (khác tag hoặc khác hash) ⟹ NÉM `OWNER_AUTH_MISMATCH`: giao dịch
 *     như thế dựng được, ký được, và chết trên chuỗi.
 */
export function resolveOwnerAuth<Tx>(
  owner: OwnerRef,
  auth?: OwnerAuth<Tx>,
): OwnerAuth<Tx> {
  if (auth === undefined) {
    if (owner.type === "key") return { kind: "key", pkh: owner.hash };
    throw new OwnerAuthError(
      "OWNER_SCRIPT_WITNESS_UNAVAILABLE",
      `chủ là script ${owner.hash}; phải truyền OwnerAuth { kind: "script", attachWithdraw } ` +
        `do ví cung cấp (redeemer + chứng từ của stake-script chủ). Bộ dựng không tự bịa.`,
    );
  }
  const got = ownerRefOf(ownerCredentialOf(auth));
  if (!sameOwner(got, owner)) {
    throw new OwnerAuthError(
      "OWNER_AUTH_MISMATCH",
      `OwnerAuth trỏ ${ownerRefToString(got)} nhưng chủ trong datum là ` +
        `${ownerRefToString(owner)}. On-chain so CẢ tag lẫn hash; khoá và script trùng ` +
        `28 byte vẫn là hai chủ khác nhau.`,
    );
  }
  return auth;
}

/**
 * Gắn chứng minh quyền chủ vào giao dịch đang dựng.
 *
 *   · `key`    ⟹ `tx.addSignerKey(pkh)`; KHÔNG chạm mục rút.
 *   · `script` ⟹ `attachWithdraw(tx)` đúng một lần; KHÔNG `addSignerKey(hash)` — một script
 *                hash không ký được, và 28 byte trùng h trong danh sách ký là khoá của ai
 *                đó khác (xem `owner_auth.ak`).
 */
export function applyOwnerAuth<Tx extends { addSignerKey(keyHash: string): Tx }>(
  tx: Tx,
  auth: OwnerAuth<Tx>,
): Tx {
  if (auth.kind === "key") return tx.addSignerKey(assertHash28(auth.pkh, "pkh của chủ"));
  assertHash28(auth.hash, "script hash của chủ");
  const out = auth.attachWithdraw(tx);
  if (out === undefined || out === null) {
    throw new OwnerAuthError(
      "OWNER_WITHDRAW_RETURNED_NOTHING",
      `attachWithdraw của script ${auth.hash} trả về ${String(out)} thay vì giao dịch. ` +
        `Bộ dựng không đoán giao dịch nào đã được gắn mục rút.`,
    );
  }
  return out;
}
