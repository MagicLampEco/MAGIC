// scripts/farmers/src/vaultGenesis.ts — mở vault (genesis) cho một nông dân.
//
// Mở vault = chạy tiến trình con `scripts/deploy/05_create_instant_vault.ts` (Instant) hoặc
// `scripts/deploy/07_create_schedule_vault.ts` (Schedule) bằng ví CỦA NÔNG DÂN, rồi đọc dòng
// `RESULT` cuối stdout. Bộ dựng tx thật — đúc NFT danh tính cùng tx (BOUNDARIES §2 ▸
// INV-VAULT-IDENTITY), owner = Credential của ví ký — nằm ở tệp con, KHÔNG ở đây. Tệp này chỉ:
// dựng env, đọc + kiểm RESULT, và tra UTxO SỐNG của vault cho các bước sau.
//
// Hợp đồng tiến trình con (nhánh owner-cred; nguồn: `scripts/runResult.ts` ▸ `resultLine` và
// khối chú thích đầu hai tệp 05/07):
//   env   LAMP_DEPOSIT (LAMP nguyên, dương) · PROFILE · DRY_RUN · WRITE_STATE_BOOK ("0" cho nông dân)
//   thành công ⟹ dòng CUỐI stdout:
//     RESULT {"vault_outref":"<tx>#<i>","vault_nft":"<unit>","owner":{"type":"key","hash":"<56 hex>"},"dry_run":<bool>}
//   hỏng ⟹ không có RESULT, thoát 1.
// Tệp con chưa mang hợp đồng đó (dấu `resultLine` vắng) ⟹ executor trả `skip
// child-contract-missing`; không bới log để đoán.
//
// Vì sao bước sau tra vault theo NFT chứ không dùng lại `vault_outref`: mỗi tx tiêu vault (sinh,
// cam kết, fire, consume) tiêu-rồi-tạo-lại UTxO vault, nên outref lúc mở chỉ đúng tới lượt tiêu
// đầu tiên. NFT danh tính thì đi theo vault suốt đời.
//
// Ràng buộc còn nguyên: INV-ONE-PERSON-ONE-VAULT chưa ép ở cổng genesis (BOUNDARIES §2) ⟹ chỉ
// testnet; không bước nào ở đây tra ngược vault → DID.

import type { Network, UTxO } from "@lucid-evolution/lucid";

import { scriptEnterpriseAddress } from "./chain.ts";
import { TX_HASH_RE, interpretChild, malformed, type ChildRun } from "./childResult.ts";
import { sameOwner } from "./owner.ts";
import type { GeneratorKind } from "./plan.ts";
import type { Mode, Outcome } from "./runner.ts";

/** Tệp con theo loại vault — đường tương đối gốc `scripts/`. */
export const VAULT_OPEN_SCRIPT: Record<GeneratorKind, string> = {
  instant: "deploy/05_create_instant_vault.ts",
  schedule: "deploy/07_create_schedule_vault.ts",
};

/** Dấu hợp đồng RESULT trong tệp con (hàm in dòng RESULT, `scripts/runResult.ts`). */
export const VAULT_OPEN_CONTRACT_MARKER = "resultLine";

const OUTREF_RE = /^([0-9a-f]{64})#(0|[1-9][0-9]{0,5})$/;
/** Unit NFT danh tính vault: policy (= script hash vault, 56 hex) + blake2b_256(seed) (64 hex). */
const VAULT_NFT_RE = /^[0-9a-f]{56}[0-9a-f]{64}$/;
const OILDROP_PER_LAMP = 1_000_000n;

export interface VaultOpenResult {
  vault_outref: string;
  vault_nft: string;
  owner: { type: "key" | "script"; hash: string };
  dry_run: boolean;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };
const no = <T>(reason: string): Parsed<T> => ({ ok: false, reason });

function hasExactKeys(o: object, keys: readonly string[]): boolean {
  const got = Object.keys(o).sort();
  const want = [...keys].sort();
  return got.length === want.length && got.every((k, i) => k === want[i]);
}

/** Kế hoạch giữ oildrop; tệp con nhận LAMP NGUYÊN. Không chia hết thì từ chối, không làm tròn. */
export function lampDepositOf(oildrop: string | undefined): Parsed<string> {
  if (oildrop === undefined || !/^[1-9][0-9]*$/.test(oildrop)) return no(`params.lampOildrop phải là số nguyên dương, nhận "${oildrop ?? ""}"`);
  const o = BigInt(oildrop);
  if (o % OILDROP_PER_LAMP !== 0n) return no(`params.lampOildrop ${oildrop} không chia hết 10^6 — LAMP_DEPOSIT chỉ nhận LAMP nguyên`);
  return { ok: true, value: (o / OILDROP_PER_LAMP).toString() };
}

/** Đọc dòng RESULT — phải là dòng KHÔNG RỖNG CUỐI CÙNG của stdout, đúng bộ khoá, đúng hình dạng. */
export function parseVaultOpenResult(stdout: string): Parsed<VaultOpenResult> {
  const lines = stdout.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() !== "");
  const last = lines.at(-1);
  if (last === undefined) return no("stdout rỗng — không có dòng RESULT");
  if (!last.startsWith("RESULT ")) return no(`dòng cuối stdout không phải RESULT: "${last.slice(0, 120)}"`);
  let j: unknown;
  try {
    j = JSON.parse(last.slice("RESULT ".length));
  } catch (e) {
    return no(`RESULT không phải JSON: ${(e as Error).message}`);
  }
  if (typeof j !== "object" || j === null || Array.isArray(j)) return no("RESULT không phải object");
  const r = j as Record<string, unknown>;
  if (!hasExactKeys(r, ["vault_outref", "vault_nft", "owner", "dry_run"])) return no(`RESULT có bộ khoá lạ: [${Object.keys(r).join(",")}]`);
  if (typeof r.vault_outref !== "string" || !OUTREF_RE.test(r.vault_outref)) return no(`vault_outref sai hình dạng: ${JSON.stringify(r.vault_outref)}`);
  if (typeof r.vault_nft !== "string" || !VAULT_NFT_RE.test(r.vault_nft)) return no(`vault_nft sai hình dạng (cần 56+64 hex): ${JSON.stringify(r.vault_nft)}`);
  const o = r.owner;
  if (typeof o !== "object" || o === null || Array.isArray(o) || !hasExactKeys(o, ["type", "hash"])) return no(`owner sai hình dạng: ${JSON.stringify(o)}`);
  const ow = o as Record<string, unknown>;
  if (ow.type !== "key" && ow.type !== "script") return no(`owner.type lạ: ${JSON.stringify(ow.type)}`);
  if (typeof ow.hash !== "string" || !/^[0-9a-f]{56}$/.test(ow.hash)) return no(`owner.hash sai hình dạng: ${JSON.stringify(ow.hash)}`);
  if (typeof r.dry_run !== "boolean") return no(`dry_run không phải boolean: ${JSON.stringify(r.dry_run)}`);
  return {
    ok: true,
    value: { vault_outref: r.vault_outref, vault_nft: r.vault_nft, owner: { type: ow.type, hash: ow.hash }, dry_run: r.dry_run },
  };
}

/** RESULT đúng hình dạng nhưng có khớp NÔNG DÂN và CHẾ ĐỘ không. `null` = khớp. */
export function checkVaultOpen(r: VaultOpenResult, expected: { pkh: string; mode: Mode }): { reason: string; detail: string } | null {
  if (!sameOwner({ type: r.owner.type, hash: r.owner.hash }, { type: "key", hash: expected.pkh })) {
    return { reason: "child-owner-mismatch", detail: `vault mở ra thuộc ${r.owner.type}:${r.owner.hash}, không phải khoá nông dân key:${expected.pkh}` };
  }
  if (r.dry_run !== (expected.mode === "dry")) {
    return { reason: "child-result-malformed", detail: `RESULT dry_run=${r.dry_run} lệch chế độ ${expected.mode}` };
  }
  return null;
}

/** Kết cục của tiến trình con 05/07 theo hợp đồng RESULT. */
export function interpretVaultOpen(run: ChildRun, mode: Mode, pkh: string): Outcome {
  const text = `${run.stdout}\n${run.stderr}`;
  if (run.timedOut) return interpretChild(run.status, text, mode, true);
  if (run.status !== 0) {
    if (/^RESULT /m.test(run.stdout)) return malformed(`thoát ${String(run.status)} mà stdout CÓ dòng RESULT — hợp đồng nói hỏng thì không có RESULT`);
    return interpretChild(run.status, text, mode, false);
  }
  const p = parseVaultOpenResult(run.stdout);
  if (!p.ok) return malformed(`RESULT: ${p.reason}`);
  const bad = checkVaultOpen(p.value, { pkh, mode });
  if (bad) return { kind: "error", reason: bad.reason, detail: bad.detail };
  const { vault_outref, vault_nft } = p.value;
  const artifacts = { vault_outref, vault_nft };
  if (mode === "dry") return { kind: "built", fee: null, detail: `vault ${vault_outref} (thân tx chưa gửi)`, artifacts };
  const txHash = vault_outref.slice(0, 64);
  const printed = TX_HASH_RE.exec(run.stdout)?.[1];
  if (printed !== undefined && printed !== txHash) return malformed(`"TX hash: ${printed}" ≠ tx của vault_outref ${vault_outref}`);
  // 05/07 chờ `awaitTx` TRƯỚC khi in RESULT ở đường live ⟹ RESULT live = đã vào khối.
  return { kind: "confirmed", txHash, fee: null, detail: `vault ${vault_outref}`, artifacts };
}

/** Địa chỉ vault suy từ NFT danh tính: policy NFT = script hash vault (INV-VAULT-IDENTITY). */
export function vaultAddressOf(network: Network, vaultNft: string): string {
  if (!VAULT_NFT_RE.test(vaultNft)) throw new Error(`vault_nft sai hình dạng: "${vaultNft}"`);
  return scriptEnterpriseAddress(network, vaultNft.slice(0, 56));
}

/** Chọn UTxO SỐNG của vault trong kết quả tra theo NFT. 0 ⟹ chưa lên chuỗi; >1 hoặc lượng ≠ 1 ⟹ lỗi. */
export function pickVaultUtxo(utxos: readonly UTxO[], vaultNft: string): { ok: true; txHash: string; outRef: string } | { ok: false; outcome: Outcome } {
  const holders = utxos.filter((u) => (u.assets[vaultNft] ?? 0n) > 0n);
  if (holders.length === 0) {
    return { ok: false, outcome: { kind: "prereq-missing", detail: `không có UTxO sống mang NFT vault ${vaultNft}` } };
  }
  if (holders.length > 1 || holders[0]!.assets[vaultNft] !== 1n) {
    const where = holders.map((u) => `${u.txHash}#${u.outputIndex}×${String(u.assets[vaultNft])}`).join(", ");
    return { ok: false, outcome: { kind: "error", reason: "vault-nft-not-unique", detail: `NFT vault ${vaultNft} không duy nhất: ${where}` } };
  }
  const u = holders[0]!;
  return { ok: true, txHash: u.txHash, outRef: `${u.txHash}#${u.outputIndex}` };
}
