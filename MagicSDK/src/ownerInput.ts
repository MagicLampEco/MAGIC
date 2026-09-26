// MagicSDK/src/ownerInput.ts — đọc chủ từ tham số của người gọi: `owner` (Credential dạng
// JSON) hoặc bí danh cũ `ownerPkh` (= `{ type: "key" }`).
//
// Một chỗ duy nhất cho quy tắc này, vì ba đường dùng nó (createVault, buildInitialVaultDatum,
// listVaultsForOwner) và ba bản chép sẽ lệch nhau ở đúng ca khó: người gọi truyền CẢ HAI.
//
//   · chỉ `owner`       ⟹ dùng nó (hash được kiểm 28 byte).
//   · chỉ `ownerPkh`    ⟹ `{ type: "key", hash: ownerPkh }`.
//   · cả hai, cùng chủ  ⟹ chấp nhận.
//   · cả hai, KHÁC chủ  ⟹ NÉM `OWNER_AUTH_MISMATCH`. Chọn một bên là đoán ý người gọi, và
//                         đoán sai là tạo vault cho một chủ khác.
//   · không có gì       ⟹ NÉM `OWNER_CREDENTIAL_SHAPE`.

import {
  OwnerAuthError, ownerCredential, ownerRefOf, sameOwner, ownerRefToString,
  type OwnerRef,
} from "@magiclamp/protocol-utils";

const PKH_RE = /^[0-9a-fA-F]{56}$/;

export function resolveOwnerInput(
  p: { owner?: OwnerRef; ownerPkh?: string },
  where: string,
): OwnerRef {
  let fromAlias: OwnerRef | undefined;
  if (p.ownerPkh !== undefined) {
    if (typeof p.ownerPkh !== "string" || !PKH_RE.test(p.ownerPkh)) {
      throw new OwnerAuthError(
        "OWNER_HASH_INVALID",
        `${where}: ownerPkh must be 28-byte hex (got "${String(p.ownerPkh).slice(0, 80)}")`,
      );
    }
    fromAlias = { type: "key", hash: p.ownerPkh.toLowerCase() };
  }
  let fromOwner: OwnerRef | undefined;
  if (p.owner !== undefined) {
    const o = p.owner as unknown;
    if (o === null || typeof o !== "object") {
      throw new OwnerAuthError("OWNER_CREDENTIAL_SHAPE", `${where}: owner phải là { type, hash }.`);
    }
    const { type, hash } = o as { type?: unknown; hash?: unknown };
    if (type !== "key" && type !== "script") {
      throw new OwnerAuthError(
        "OWNER_CREDENTIAL_SHAPE",
        `${where}: owner.type phải là "key" hoặc "script", nhận ${JSON.stringify(type)}.`,
      );
    }
    fromOwner = ownerRefOf(ownerCredential(type, hash as string));
  }
  if (fromOwner && fromAlias) {
    if (!sameOwner(fromOwner, fromAlias)) {
      throw new OwnerAuthError(
        "OWNER_AUTH_MISMATCH",
        `${where}: owner = ${ownerRefToString(fromOwner)} nhưng ownerPkh = ` +
          `${ownerRefToString(fromAlias)}. Hai trường cùng có thì phải chỉ cùng một chủ.`,
      );
    }
    return fromOwner;
  }
  const r = fromOwner ?? fromAlias;
  if (r === undefined) {
    throw new OwnerAuthError("OWNER_CREDENTIAL_SHAPE", `${where}: thiếu owner (hoặc bí danh ownerPkh).`);
  }
  return r;
}
