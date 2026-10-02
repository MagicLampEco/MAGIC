// scripts/consumeBook.ts — bộ khoá consume trong sổ trạng thái, TÁCH THEO LOẠI VAULT.
//
// ── VÌ SAO TỆP NÀY TỒN TẠI ──────────────────────────────────────────────────
// `consume` được apply-param bằng hash của MỘT loại vault (BOUNDARIES.md ▸ "Apply-param
// được phép thay đổi theo LOẠI script"). Ba loại vault giữ MAGIC ⟹ ba bản `consume`,
// mỗi bản một price NFT, một beacon, một luồng Engage, một ref-script.
//
// Sổ trạng thái từng giữ MỘT bộ khoá không hậu tố (`CONSUME_SCRIPT_HASH`, `PRICE_*`,
// `ENGAGE_*`, `REF_CONSUME_UTXO`, …). Hệ quả, đo trên cụm Preprod dựng lại 2026-09-23:
//   · bước 09 tự chọn `VAULT_SCHEDULE_HASH` khi sổ có cả hai vault; chạy lần hai cho
//     InstantGen thì ĐÈ bộ khoá của ScheduleGen (sổ nạp theo thứ tự, dòng sau thắng);
//   · `run_consume_e2e.sh` (đường InstantGen) gọi `consume_only.ts` không đặt loại vault
//     ⟹ tiêu trên vault ScheduleGen;
//   · `gen_vault_tx_api_deployment.ts --vault Instant` ghép vault InstantGen với bộ khoá
//     consume của ScheduleGen ⟹ `VaultTxAPI` dựng tx tiêu chết trên chuỗi.
// Không chỗ nào kêu lúc chạy, vì mỗi giá trị đều là một định danh CÓ THẬT.
//
// Nay mỗi khoá mang hậu tố loại vault: `CONSUME_SCRIPT_HASH_SCHEDULE`,
// `CONSUME_SCRIPT_HASH_INSTANT`, … Bộ khoá không hậu tố KHÔNG được đọc nữa ở đây —
// nó không tự khai nó thuộc loại nào, nên đọc nó là đoán.

// "prepaid" thêm 2026-09-28: PrepaidGen cũng tiêu MAGIC qua `BurnBatch` constr 2, nên nó
// cần một bản `consume` riêng apply-param bằng `VAULT_PREPAID_HASH` (bước 10).
export type VaultKind = "schedule" | "instant" | "prepaid";

/** Các khoá bước 09 in ra cho MỘT bản `consume`. Thứ tự = thứ tự in. */
export const CONSUME_KEY_NAMES = [
  "CONSUME_SCRIPT_HASH",
  "CONSUME_ADDRESS",
  "PRICE_NFT_POLICY",
  "PRICE_NFT_UNIT",
  "PRICE_PARAM_HASH",
  "PRICE_BEACON_UTXO",
  "ENGAGE_NFT_POLICY",
  "ENGAGE_NFT_UNIT",
  "ENGAGE_UTXO",
  "MAX_PRICE_STALE",
  "REF_CONSUME_UTXO",
] as const;
export type ConsumeKeyName = (typeof CONSUME_KEY_NAMES)[number];

/** Không có mặc định: loại vault chọn SAI thì mọi giá trị sau đó đều có thật và đều sai. */
export function parseVaultKind(raw: string | undefined, source = "VAULT_KIND"): VaultKind {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "schedule" || v === "instant" || v === "prepaid") return v;
  throw new Error(
    `${source} phải là "schedule", "instant" hoặc "prepaid" (nhận: "${raw ?? ""}"). ` +
      `Không có mặc định: mỗi loại vault có bản consume riêng, đoán sai thì tx chết ở phase-1.`,
  );
}

export function consumeKey(name: ConsumeKeyName, kind: VaultKind): string {
  return `${name}_${kind.toUpperCase()}`;
}

/** Hash vault mà bản consume của `kind` được apply-param bằng — đọc từ sổ. */
export function vaultHashKey(kind: VaultKind): string {
  switch (kind) {
    case "schedule": return "VAULT_SCHEDULE_HASH";
    case "instant":  return "VAULT_INSTANT_HASH";
    case "prepaid":  return "VAULT_PREPAID_HASH";
  }
}

/** Bước deploy dựng ra vault của `kind` (ghi `vaultHashKey(kind)` vào sổ). */
export function vaultDeployStep(kind: VaultKind): string {
  switch (kind) {
    case "schedule": return "bước 07";
    case "instant":  return "bước 05";
    case "prepaid":  return "bước 10";
  }
}

/** Khoá sổ của ref-script vault mà tx consume trên `kind` đọc làm chân thứ hai, kèm bước ghi nó. */
export function vaultRefKey(kind: VaultKind): { key: string; step: string } {
  switch (kind) {
    case "schedule": return { key: "REF_VAULT_SCHEDULE_UTXO", step: "bước 06" };
    case "instant":  return { key: "REF_VAULT_INSTANT_UTXO",  step: "bước 05" };
    case "prepaid":  return { key: "REF_VAULT_PREPAID_UTXO",  step: "bước 10" };
  }
}

/**
 * Hash vault mà bản `consume` của `kind` sẽ được apply-param bằng — đọc từ sổ, fail-closed.
 *
 * Ném khi: khoá vắng / còn giá trị giữ chỗ · không phải 56 hex thường · `VAULT_HASH` đặt mà
 * khác (không còn là đường ghi đè) · với `prepaid`: hash trong sổ ≠ hash dựng lại từ đời
 * CARP hiện hành (`derivedPrepaidVaultHash`).
 *
 * Vì sao `prepaid` đòi thêm phép đối chiếu: hash `prepaid_vault` phụ thuộc ĐỜI CARP
 * (apply-param `carp_policy_id`/`carp_asset_name`). Đúc lại CARP mà sổ còn hash đời cũ thì
 * bản `consume` dựng ra vẫn hợp lệ, vẫn deploy êm, và phục vụ một két không ai mở được nữa.
 * Không truyền `derivedPrepaidVaultHash` cho `prepaid` ⟹ NÉM: phép đối chiếu là bắt buộc,
 * không phải tuỳ chọn người gọi quên được.
 */
export function requireConsumeVaultHash(
  env: Record<string, string | undefined>,
  kind: VaultKind,
  derivedPrepaidVaultHash?: string,
): string {
  const key = vaultHashKey(kind);
  const v = env[key];
  if (!v || v === "FILL_AFTER_AIKEN_BUILD") {
    throw new Error(
      `Thiếu ${key} — hash vault ${kind} mà bản consume này phục vụ (${vaultDeployStep(kind)} in ra).`,
    );
  }
  if (!/^[0-9a-f]{56}$/.test(v)) {
    throw new Error(`${key}="${v}" không phải script hash 28 byte dạng hex thường.`);
  }
  if (env.VAULT_HASH && env.VAULT_HASH !== v) {
    throw new Error(
      `VAULT_HASH (${env.VAULT_HASH}) ≠ ${key} (${v}). ` +
      `VAULT_HASH không còn là đường ghi đè: bỏ nó đi, hoặc chọn đúng VAULT_KIND.`,
    );
  }
  if (kind === "prepaid") {
    if (derivedPrepaidVaultHash === undefined) {
      throw new Error(
        `VAULT_KIND=prepaid đòi đối chiếu ${key} với hash dựng lại từ đời CARP hiện hành — ` +
        `người gọi chưa truyền hash dựng lại.`,
      );
    }
    if (derivedPrepaidVaultHash !== v) {
      throw new Error(
        `${key}=${v} ≠ hash prepaid_vault dựng lại từ đời CARP hiện hành (${derivedPrepaidVaultHash}).\n` +
        `  Sổ ghi két của một đời CARP khác (hoặc blueprint PrepaidGen đã đổi). Bản consume dựng ` +
        `bằng hash cũ phục vụ một két không ai mở được nữa — chạy lại bước 10 trước.`,
      );
    }
  }
  return v;
}

/**
 * Chép bộ khoá có hậu tố của `kind` vào tên không hậu tố trong `env`, để mã đọc tên cũ
 * chạy tiếp mà không đọc nhầm loại. Khoá không hậu tố có sẵn bị XOÁ trước khi chép:
 * một giá trị cũ còn sót mà khoá có hậu tố tương ứng không có sẽ lọt qua nếu để yên.
 *
 * `required` = các khoá phải có. Thiếu ⟹ ném, câu lỗi nêu đúng tên khoá có hậu tố, và
 * nói rõ khi sổ chỉ có bản không hậu tố (sổ viết trước khi tách).
 */
export function selectConsumeBook(
  env: Record<string, string | undefined>,
  kind: VaultKind,
  required: readonly ConsumeKeyName[],
): void {
  const missing: string[] = [];
  const legacyOnly: string[] = [];
  for (const name of CONSUME_KEY_NAMES) {
    const legacy = env[name];
    delete env[name];
    const v = env[consumeKey(name, kind)];
    if (v) {
      env[name] = v;
    } else if (required.includes(name)) {
      missing.push(consumeKey(name, kind));
      if (legacy) legacyOnly.push(name);
    }
  }
  if (missing.length === 0) return;
  let msg =
    `Sổ trạng thái thiếu bộ khoá consume của vault ${kind}: ${missing.join(", ")}.\n` +
    `  Dựng bằng: VAULT_KIND=${kind} npx tsx deploy/09_deploy_consume.ts (ghi lên chuỗi).`;
  if (legacyOnly.length > 0) {
    msg +=
      `\n  Sổ CÓ bản không hậu tố (${legacyOnly.join(", ")}) — sổ viết trước khi tách theo loại ` +
      `vault. Bản đó KHÔNG được đọc vì nó không tự khai thuộc loại nào: kiểm ` +
      `\`consume_only.ts\` dựng lại ra đúng CONSUME_SCRIPT_HASH với ${vaultHashKey(kind)} ` +
      `rồi mới chép sang tên có hậu tố _${kind.toUpperCase()}.`;
  }
  throw new Error(msg);
}
