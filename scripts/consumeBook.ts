// scripts/consumeBook.ts — bộ khoá consume trong sổ trạng thái, TÁCH THEO LOẠI VAULT.
//
// ── VÌ SAO TỆP NÀY TỒN TẠI ──────────────────────────────────────────────────
// `consume` được apply-param bằng hash của MỘT loại vault (BOUNDARIES.md ▸ "Apply-param
// được phép thay đổi theo LOẠI script"). Hai loại vault sinh MAGIC ⟹ hai bản `consume`,
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

export type VaultKind = "schedule" | "instant";

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
  if (v === "schedule" || v === "instant") return v;
  throw new Error(
    `${source} phải là "schedule" hoặc "instant" (nhận: "${raw ?? ""}"). ` +
      `Không có mặc định: mỗi loại vault có bản consume riêng, đoán sai thì tx chết ở phase-1.`,
  );
}

export function consumeKey(name: ConsumeKeyName, kind: VaultKind): string {
  return `${name}_${kind.toUpperCase()}`;
}

/** Hash vault mà bản consume của `kind` được apply-param bằng — đọc từ sổ. */
export function vaultHashKey(kind: VaultKind): string {
  return kind === "schedule" ? "VAULT_SCHEDULE_HASH" : "VAULT_INSTANT_HASH";
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
