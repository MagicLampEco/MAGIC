// scripts/deploy/11_deploy_gen_beacons.ts — deploy cụm GenBeacons của Gen v2.0: beacon ρ ("RHO"),
// beacon GreenBack ("GBB"), 16 shard GB ("GBS"‖id), sổ két ("VRG"), ref-script `gb_shard`.
//
// Run (từ scripts/, sau khi đã nạp sổ + khoá deploy như các bước khác):
//   GEN_BEACONS_PHASE=beacons  RHO_Q=<ρ Q-format> npx tsx deploy/11_deploy_gen_beacons.ts
//   GEN_BEACONS_PHASE=registry                     npx tsx deploy/11_deploy_gen_beacons.ts
//
// ── Vì sao HAI pha, không một ────────────────────────────────────────────────────
// Chuỗi hash đi một chiều (đầu tệp `GenBeacons/onchain/validators/vault_registry.ak`):
//   seed sổ ⟹ hash sổ ⟹ gb_shard (bake hash sổ) ⟹ két InstantGen/ScheduleGen (bake hash
//   gb_shard) ⟹ đúc sổ với [hash các két].
// Két ScheduleGen còn bake `shard_policy_id` do bước 03 sinh, nên hash két chỉ có SAU bước
// 03/05/07 — mà các bước đó lại cần hash gb_shard của bước này. Một lượt chạy duy nhất
// không đóng được vòng thứ tự đó, nên:
//   · pha `beacons`  — chọn 4 seed, đúc RHO + GBB + 16 GBS, công bố ref `gb_shard`. Hash sổ
//     đã CỐ ĐỊNH (nó chỉ phụ thuộc seed sổ) nhưng sổ CHƯA đúc: seed sổ nằm chờ ở bãi đỗ.
//   · (bước 03 / 05 / 07 dựng két v2.0 trên hash gb_shard vừa ghi)
//   · pha `registry` — tiêu seed sổ, đúc "VRG" với [VAULT_INSTANT_HASH, VAULT_SCHEDULE_HASH].
//
// 🔴 Seed nằm ở BÃI ĐỖ (`refScripts.ts ▸ parkAddressFor`), không nằm ở ví. Validator one-shot
// chỉ đòi `input.output_reference == seed`, không đòi seed nằm ở đâu. Để seed ở ví thì bộ chọn
// UTxO của một bước bất kỳ giữa hai pha có thể tiêu nó làm phí — và sổ không bao giờ đúc được
// nữa, trong khi hash của nó đã nướng vào gb_shard và mọi két: cả cụm chết, không lỗi nào kêu.
//
// `VAULT_REGISTRY_HASH` chỉ vào sổ ở pha `registry` — CỐ Ý. Bộ sinh deployment
// (`gen_vault_tx_api_deployment.ts`) đòi khoá đó, nên nó từ chối phát khối `gen_v2` cho tới
// khi sổ két đã THẬT SỰ đúc. Ghi sớm ở pha 1 thì dịch vụ nhận một địa chỉ sổ rỗng và mọi lượt
// rút shard chết ở phase-2 mà khối cấu hình trông hoàn toàn hợp lệ.
//
// ── Env (ngoài bộ khoá mạng + ví đọc qua config.ts) ─────────────────────────────
//   GEN_BEACONS_PHASE    — `beacons` | `registry`. BẮT BUỘC, không mặc định: chạy nhầm pha 1
//                          lần hai là dựng một cụm MỚI, bỏ mồ côi mọi két đã bake cụm cũ.
//   RHO_Q                — (pha beacons) ρ khởi đầu, Q-format, 0 < RHO_Q ≤ rho_max_q. BẮT BUỘC,
//                          không mặc định: giá trị là quyết định `CC-GEN-RATE-VALUE`
//                          (SPEC v2.0 §13), không phải của tệp này.
//   GEN_BEACONS_REDEPLOY — "1" mới cho pha beacons chạy khi sổ ĐÃ có `GB_SHARD_HASH`.
//   DEPLOY_SEED_REGISTRY · DEPLOY_SEED_GREENBACK · DEPLOY_SEED_GB_SHARD · DEPLOY_SEED_RATE
//                        — (pha beacons) bốn seed CHO TRƯỚC `<tx>#<ix>`, đã đỗ ở bãi đỗ bằng
//                          `deploy/park_seeds.ts`. Đủ cả bốn hoặc không cái nào. Vắng ⟹ tự tạo
//                          seed như cũ. Có ⟹ không tạo seed; seed đã tiêu / không ở bãi đỗ ⟹ ném.
//                          Pha registry: chỉ `DEPLOY_SEED_REGISTRY` có nghĩa, và chỉ để ĐỐI CHIẾU —
//                          phải trùng seed sổ đã ghi ở sổ trạng thái, lệch ⟹ ném.
//   DEPLOY_EXPECT_HASHES — tệp JSON hash kỳ vọng do `clusterHashes.ts --out` ghi. Pha beacons (chỉ
//                          cùng seed cho trước) so bốn hash GenBeacons; pha registry so
//                          vault_registry · vault_instant · vault_schedule. Lệch ⟹ ném TRƯỚC khi đúc.
//                          Có biến DEPLOY_SEED_* nào mà vắng tệp ⟹ ném, trừ DEPLOY_EXPECT_NONE=1.
//   DRY_RUN=1            — chạy trọn luồng trên một Emulator soi gương số dư ví: dựng, ký CỤC
//                          BỘ, đo kích thước, in hash — KHÔNG gửi gì lên mạng, KHÔNG ghi sổ.
//   WRITE_STATE_BOOK     — "1"/"0"; vắng thì quyết theo ví ký (`runResult.ts ▸ decideStateBook`).
//   STATE_BOOK_PATH      — đường TUYỆT ĐỐI tới sổ (tên tệp phải là `state.<NET>.sh`); vắng thì
//                          `scripts/state.<NET>.sh`. Cả phép ĐỌC (cổng `GB_SHARD_HASH`, đầu vào
//                          pha registry) lẫn phép GHI đều theo đường này (`stateBookPath.ts`).
//
// Tham số KHÔNG qua env, và vì sao:
//   · `gb_shard_cap_nanogic` = hằng biên dịch `gb_shard_cap_nanogic` mà HAI két bake
//     (InstantGen + ScheduleGen `constants.ak`; gương TS ở `offchain/src/constants.ts`). Lệch
//     giữa apply-param shard và hằng két là két đòi một trần mà shard không cấp. Tệp này đọc
//     cả hai gương và ném nếu chúng khác nhau.
//   · `rho_max_q` = gương `RHO_MAX_Q`, cùng lý do.
//   · `rate_key` + `greenback_beacon_writer` = khoá payment của ví ký: genesis của cả hai beacon
//     đòi chữ ký của chính khoá đó, nên một khoá khác ví là giao dịch không ký nổi.
//   · GreenBack khởi đầu = 0 (fail-closed): shard chỉ có lượng rút sau lượt ghi beacon đầu tiên
//     có `seq > 0` (`gb_shard.ak` ▸ mint), nên con số genesis không mở gì — 0 là giá trị không
//     cần ai quyết.
//
// Chỉ chạy testnet: `CC-GEN-SURPLUS-SHARD` · `CC-GEN-BEACON-ROTATION` còn TẠM (SPEC v2.0 §13).
//
// Tệp xuất phần lõi (`runBeaconsPhase`, `runRegistryPhase`, đọc/ghi sổ) để
// `scripts/test_deploy_gen_beacons.ts` chạy trọn luồng trên Emulator; `main` chỉ chạy khi tệp
// được gọi trực tiếp, và chỉ `main` mới nạp `config.ts` (nạp nó là đòi khoá mạng + ví).

import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Blockfrost,
  coreToTxOutput,
  Emulator,
  getAddressDetails,
  Lucid,
  scriptFromNative,
  validatorToScriptHash,
  type LucidEvolution,
  type Network,
  type Script,
  type TxBuilder,
  type TxSignBuilder,
  type TxSigned,
  type UTxO,
} from "@lucid-evolution/lucid";
import {
  deriveGenBeaconsScripts,
  initGreenBackBeaconTx,
  initRateBeaconTx,
  loadBlueprint,
  mintGbShardsTx,
  mintVaultRegistryTx,
  vaultRegistryScript,
  type Blueprint,
  type GenBeaconsScripts,
} from "../../GenBeacons/offchain/src/index.js";
import {
  GB_SHARD_CAP_NANOGIC as INSTANT_GB_SHARD_CAP,
  RHO_MAX_Q as INSTANT_RHO_MAX_Q,
} from "../../InstantGen/offchain/src/constants.js";
import {
  GB_SHARD_CAP_NANOGIC as SCHEDULE_GB_SHARD_CAP,
  RHO_MAX_Q as SCHEDULE_RHO_MAX_Q,
} from "../../ScheduleGen/offchain/src/constants.js";
import { GEN_V2_STATE_KEYS, type StateBook } from "../gen_vault_tx_api_deployment.js";
import { vaultHashKey } from "../consumeBook.js";
import {
  assertDistinctPresetSeeds,
  BEACON_SEED_ROLES,
  checkExpectedHashes,
  loadExpectedHashes,
  outRefString,
  parkFor,
  readBeaconPresetSeeds,
  readPresetSeed,
  REGISTRY_SEED_BOOK_KEY,
  requireExpectInPresetMode,
  resolvePresetSeed,
  SEED_ENV,
  SEED_LOVELACE,
  spendsParkedSeed,
  type BeaconPresetSeeds,
  type ExpectedHashes,
  type Park,
} from "../deploySeeds.js";
import { minAdaForRefScriptWithMargin } from "../minAda.js";
import { decideStateBook, parseFlag, parseOutRef, type OutRef } from "../runResult.js";
import { stateBookPath } from "../stateBookPath.js";

// ══════════════════════════════════════════════════════════════════════════════
// Tên khoá sổ
// ══════════════════════════════════════════════════════════════════════════════

/** Tên khoá Gen v2.0 lấy từ CHÍNH bảng của bộ sinh — không gõ lại chuỗi. Đổi tên ở nguồn ⟹
 *  tệp này đổi theo; bỏ một khoá ở nguồn ⟹ `KEY.<tên>` gãy lúc typecheck. */
type GenKey = keyof typeof GEN_V2_STATE_KEYS;
export const KEY = Object.fromEntries(
  Object.keys(GEN_V2_STATE_KEYS).map((k) => [k, k]),
) as { readonly [K in GenKey]: K };

/**
 * Khoá riêng của bước này, KHÔNG phải của bộ sinh: chỉ để pha `registry` nối được với pha
 * `beacons`. Bộ sinh không đọc chúng.
 */
export const PHASE_KEYS = {
  /** `<tx>#<ix>` của seed sổ két, nằm chờ ở bãi đỗ tới pha `registry`. */
  REGISTRY_SEED_UTXO: REGISTRY_SEED_BOOK_KEY,   // tên khai ở `deploySeeds.ts` (bước 03/09 cũng đọc)
  /** Hash sổ mà pha `beacons` đã nướng vào `gb_shard`. Pha `registry` dựng lại sổ từ seed và
   *  phải ra ĐÚNG hash này — lệch nghĩa là blueprint `vault_registry` đã đổi giữa hai pha, và
   *  sổ đúc ra sẽ không phải sổ mà shard tra. */
  REGISTRY_PENDING_HASH: "GEN_BEACONS_REGISTRY_PENDING_HASH",
} as const;

/** Két được ghi vào sổ, theo ĐÚNG thứ tự này. Sổ bất biến sau khi đúc (spend luôn từ chối),
 *  nên thiếu một loại két là loại đó không bao giờ rút shard được — cả hai là BẮT BUỘC. */
export const REGISTRY_VAULT_KINDS = ["instant", "schedule"] as const;
export const REGISTRY_VAULT_KEYS = [vaultHashKey(REGISTRY_VAULT_KINDS[0]), vaultHashKey(REGISTRY_VAULT_KINDS[1])] as const;

// ══════════════════════════════════════════════════════════════════════════════
// Sổ trạng thái — đọc có THỨ TỰ, ghi bằng nối đuôi
// ══════════════════════════════════════════════════════════════════════════════

export interface BookEntry {
  key: string;
  value: string;
  /** Chỉ số dòng (0-based) — pha `registry` dùng thứ tự dòng để biết khoá nào ghi sau khoá nào. */
  line: number;
}

/**
 * Đọc sổ bằng PHÂN TÍCH, không `source` — cùng quy ước với
 * `gen_vault_tx_api_deployment.ts ▸ readStateBook` (dòng `[export ]KHOÁ=giá trị`, bỏ chú thích
 * đuôi khi giá trị không bọc nháy, bỏ nháy bao). Khác ở chỗ GIỮ thứ tự dòng: sổ là tệp nối đuôi,
 * nên dòng sau là giá trị mới hơn, và pha `registry` cần đúng thông tin đó.
 *
 * Tệp chưa tồn tại ⟹ danh sách rỗng (cụm mới); các chỗ gọi tự ném khi thiếu khoá cần.
 */
export function readBookEntries(path: string): BookEntry[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: BookEntry[] = [];
  raw.split("\n").forEach((text, line) => {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(text);
    if (!m) return;
    let v = m[2]!.trim();
    if (!/^["']/.test(v)) v = v.replace(/\s+#.*$/, "");
    v = v.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1").trim();
    if (v !== "") out.push({ key: m[1]!, value: v, line });
  });
  return out;
}

/** Giá trị MỚI NHẤT của mỗi khoá — đúng nghĩa của `source` trên một tệp nối đuôi. */
export function bookToRecord(entries: readonly BookEntry[]): StateBook {
  const book: StateBook = {};
  for (const e of entries) book[e.key] = e.value;
  return book;
}

function lastLine(entries: readonly BookEntry[], key: string): BookEntry | undefined {
  let hit: BookEntry | undefined;
  for (const e of entries) if (e.key === key) hit = e;
  return hit;
}

/**
 * Nối đuôi các dòng `KHOÁ=giá trị` vào sổ, sau một dòng chú thích nêu bước + pha + thời điểm.
 * Kiểm hình dạng TRƯỚC khi ghi byte nào: một giá trị chứa xuống dòng, khoảng trắng hay dấu `#`
 * sẽ đổi nghĩa khi sổ bị `source` — ném, không ghi nửa chừng.
 */
export function appendStateBook(path: string, entries: readonly (readonly [string, string])[], header: string): void {
  for (const [k, v] of entries) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) throw new Error(`Tên khoá sổ không hợp lệ: "${k}".`);
    if (!/^[0-9A-Za-z#_.:-]+$/.test(v) || /#.*#/.test(v)) {
      throw new Error(`Giá trị của ${k} không ghi an toàn vào sổ được: "${v}".`);
    }
  }
  const body = entries.map(([k, v]) => `${k}=${v}\n`).join("");
  appendFileSync(path, `# ${header.replace(/\n/g, " ")}\n${body}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// Hằng biên dịch mà két bake — đọc từ gương, và hai gương phải khớp nhau
// ══════════════════════════════════════════════════════════════════════════════

/** `gb_shard_cap_nanogic` mà cả hai két biên dịch vào. Hai gương lệch ⟹ ném: không có "bản
 *  đúng" nào để chọn khi hai két bake hai trần khác nhau. */
export function compiledGbShardCap(): bigint {
  if (INSTANT_GB_SHARD_CAP !== SCHEDULE_GB_SHARD_CAP) {
    throw new Error(
      `gb_shard_cap_nanogic lệch giữa hai két: InstantGen ${INSTANT_GB_SHARD_CAP} ≠ ScheduleGen ` +
        `${SCHEDULE_GB_SHARD_CAP}. Sửa hằng ở constants.ak + constants.ts của két trước khi deploy.`,
    );
  }
  if (INSTANT_GB_SHARD_CAP <= 0n) throw new Error(`gb_shard_cap_nanogic phải > 0, nhận ${INSTANT_GB_SHARD_CAP}.`);
  return INSTANT_GB_SHARD_CAP;
}

export function compiledRhoMaxQ(): bigint {
  if (INSTANT_RHO_MAX_Q !== SCHEDULE_RHO_MAX_Q) {
    throw new Error(`rho_max_q lệch giữa hai két: InstantGen ${INSTANT_RHO_MAX_Q} ≠ ScheduleGen ${SCHEDULE_RHO_MAX_Q}.`);
  }
  return INSTANT_RHO_MAX_Q;
}

// ══════════════════════════════════════════════════════════════════════════════
// Ví + bãi đỗ
// ══════════════════════════════════════════════════════════════════════════════

/** Lượng lovelace mỗi seed — nguồn ở `deploySeeds.ts` (bãi đỗ seed dùng chung với `park_seeds.ts`). */
export { SEED_LOVELACE };

/** Lùi cận dưới cửa sổ hiệu lực trên chuỗi thật (xem chỗ dùng trong `main`). */
const VALIDITY_BACKOFF_MS = 120_000;

/** Bãi đỗ của ví đang chọn trong `lucid` (`deploySeeds.ts` ▸ `parkFor`). */
async function parkOf(lucid: LucidEvolution, network: Network): Promise<Park> {
  return parkFor(network, await lucid.wallet().address());
}

// ══════════════════════════════════════════════════════════════════════════════
// Dựng · đo · gửi
// ══════════════════════════════════════════════════════════════════════════════

export interface TxReport {
  label: string;
  /** Hash thân tx. Ở DRY_RUN là hash của tx trên Emulator soi gương, không phải trên mạng. */
  hash: string;
  bytes: number;
}

/** Nơi tx ĐÃ KÝ đi: mạng thật (gửi + chờ xác nhận) hoặc Emulator (gửi + sang block). Nhận đúng
 *  bản đã ký-và-đo, không ký lại: tx gửi đi phải là tx vừa được đo kích thước. */
export type Submitter = (signed: TxSigned) => Promise<string>;

export interface Chain {
  lucid: LucidEvolution;
  network: Network;
  submit: Submitter;
  /** Đồng hồ cho cửa sổ hiệu lực theo epoch (Emulator: `emulator.now()`). */
  nowMs: () => number;
  log: (line: string) => void;
}

/** Chain trên mạng THẬT: gửi, chờ xác nhận, rồi chờ ví thấy đầu ra đổi. Dùng chung với
 *  `park_seeds.ts`. */
export function liveChain(real: LucidEvolution, network: Network): Chain {
  return {
    lucid: real,
    network,
    // Lùi `validFrom` một khoảng: cận dưới đặt đúng `Date.now()` thì hay đứng TRƯỚC slot của khối
    // mới nhất (khối ~20 s một lần) và nút từ chối `OutsideValidityIntervalUTxO` — đo 2026-09-30 trên
    // Preprod: `invalidBefore` 135099710 > tip 135099702. Cửa sổ vẫn nằm trong một epoch vì
    // `epochValidityWindow` tính cả hai đầu từ cùng mốc đã lùi.
    nowMs: () => Date.now() - VALIDITY_BACKOFF_MS,
    log: (l) => console.log(l),
    submit: async (signed) => {
      const h = await signed.submit();
      await real.awaitTx(h);
      // `awaitTx` xong chưa có nghĩa bộ chỉ mục đã cập nhật UTxO của ví: đo 2026-09-30 trên
      // Preprod, tx kế tiếp chọn lại đầu ra đổi của tx trước (đã bị tiêu) ⟹ `BadInputsUTxO`.
      // Chờ tới khi ví THẤY đầu ra đổi của chính tx này (mọi tx ở đây trả đổi về ví), tối đa 90 s.
      for (let i = 0; i < 18; i++) {
        if ((await real.wallet().getUtxos()).some((u) => u.txHash === h)) break;
        await new Promise((r) => setTimeout(r, 5_000));
      }
      return h;
    },
  };
}

function maxTxBytes(lucid: LucidEvolution): number {
  const n = lucid.config().protocolParameters?.maxTxSize;
  if (typeof n !== "number" || !(n > 0)) {
    throw new Error("Không đọc được maxTxSize từ tham số giao thức của provider — không đo được trần kích thước tx.");
  }
  return n;
}

function describe(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause;
    return `${e.message}${cause === undefined ? "" : ` | ${typeof cause === "string" ? cause : JSON.stringify(cause)}`}`;
  }
  return typeof e === "string" ? e : JSON.stringify(e);
}

/** complete → ký ví → đo → (vượt trần ⟹ ném, KHÔNG gửi) → gửi. */
export async function completeSignSubmit(chain: Chain, label: string, tx: TxBuilder): Promise<{ report: TxReport; signed: TxSignBuilder }> {
  const built = await tx.completeSafe();
  if (built._tag === "Left") throw new Error(`${label}: dựng tx hỏng — ${describe(built.left)}`);
  const signed = built.right;
  const signedTx = await signed.sign.withWallet().completeSafe();
  if (signedTx._tag === "Left") throw new Error(`${label}: ký hỏng — ${describe(signedTx.left)}`);
  const bytes = signedTx.right.toCBOR().length / 2;
  const limit = maxTxBytes(chain.lucid);
  if (bytes > limit) throw new Error(`${label}: ${bytes} B > trần ${limit} B — không gửi.`);
  const hash = await chain.submit(signedTx.right);
  if (hash !== signed.toHash()) throw new Error(`${label}: hash sau khi gửi ${hash} ≠ hash thân tx ${signed.toHash()}.`);
  chain.log(`   ✔ ${label}: ${hash} · ${bytes} B`);
  return { report: { label, hash, bytes }, signed };
}

/** Các output của một tx đã dựng, kèm chỉ số — đọc từ THÂN tx (chữ ký không đổi thân), nên đúng
 *  cả khi chỉ mục của provider chưa kịp thấy tx. */
export function bodyOutputs(signed: TxSignBuilder): UTxO[] {
  const txHash = signed.toHash();
  const outs = signed.toTransaction().body().outputs();
  const list: UTxO[] = [];
  for (let i = 0; i < outs.len(); i++) {
    const o = coreToTxOutput(outs.get(i));
    list.push({ txHash, outputIndex: i, ...o } as UTxO);
  }
  return list;
}

// ══════════════════════════════════════════════════════════════════════════════
// Pha 1 — beacons
// ══════════════════════════════════════════════════════════════════════════════

export interface BeaconsPhaseInput {
  blueprint: Blueprint;
  msPerEpoch: bigint;
  /** Gốc cửa sổ — apply-param CUỐI của `greenback_beacon` và `rate_param`. */
  windowOriginMs: bigint;
  rhoQ: bigint;
  rhoMaxQ: bigint;
  gbShardCapNanogic: bigint;
  /** Bốn seed CHO TRƯỚC, đã đỗ ở bãi đỗ của ví ký (`deploy/park_seeds.ts`). Vắng ⟹ bước này tự
   *  tạo bốn seed như cũ. Có ⟹ KHÔNG tạo seed, kiểm từng seed còn chưa tiêu và nằm ở bãi đỗ. */
  presetSeeds?: BeaconPresetSeeds;
  /** Hash kỳ vọng (`clusterHashes.ts --out`). Có ⟹ so bốn hash với nó, lệch ⟹ ném TRƯỚC khi đúc.
   *  Chỉ nhận cùng `presetSeeds`: seed tự tạo không thể ra hash tính trước. */
  expectHashes?: ExpectedHashes;
}

export interface BeaconsPhaseResult {
  scripts: GenBeaconsScripts;
  registrySeed: OutRef;
  /** `<tx>#<ix>` của UTxO mang ref-script `gb_shard`. */
  refGbShardUtxo: string;
  txs: TxReport[];
  /** true ⟹ RHO + GBB + 16 GBS nằm chung MỘT tx; false ⟹ tách vì vượt trần hoặc dựng chung hỏng. */
  combinedMint: boolean;
}

/** Bốn script GenBeacons cho bốn seed + khoá ví ký, rồi in (và khi có tệp kỳ vọng thì SO) bốn
 *  hash. Một hàm cho cả pha beacons lẫn lượt DRY_RUN có seed cho trước, để hai đường không lệch
 *  nhau ở cách apply. Hash sổ ở đây là của sổ CHƯA đúc. */
export function beaconScriptsChecked(
  p: BeaconsPhaseInput,
  network: Network,
  walletPkh: string,
  seeds: BeaconPresetSeeds,
  log: (line: string) => void,
): GenBeaconsScripts {
  const scripts = deriveGenBeaconsScripts(p.blueprint, network, {
    msPerEpoch: p.msPerEpoch,
    windowOriginMs: p.windowOriginMs,
    vaultRegistrySeed: seeds.registry,
    greenbackWriter: walletPkh,
    greenbackSeed: seeds.greenback,
    gbShardCapNanogic: p.gbShardCapNanogic,
    gbShardSeed: seeds.gbShard,
    rateKey: walletPkh,
    rhoMaxQ: p.rhoMaxQ,
    rateSeed: seeds.rate,
  });
  checkExpectedHashes(
    "bước 11 pha beacons",
    {
      vault_registry: scripts.vaultRegistry.hash,
      greenback_beacon: scripts.greenback.hash,
      gb_shard: scripts.gbShard.hash,
      rate_param: scripts.rate.hash,
    },
    p.expectHashes,
    log,
  );
  return scripts;
}

/** Kiểm bốn seed cho trước trên chuỗi (còn chưa tiêu, nằm ở bãi đỗ, output trơn), theo thứ tự
 *  sổ · beacon GB · gb_shard · beacon ρ. Hỏng ⟹ ném nêu biến và lý do. */
export async function resolveBeaconPresetSeeds(lucid: LucidEvolution, park: Park, preset: BeaconPresetSeeds): Promise<UTxO[]> {
  const out: UTxO[] = [];
  for (const role of BEACON_SEED_ROLES) {
    out.push((await resolvePresetSeed(lucid, park, role, preset[role], { allowWallet: false })).utxo);
  }
  return out;
}

export async function runBeaconsPhase(chain: Chain, p: BeaconsPhaseInput): Promise<BeaconsPhaseResult> {
  if (!(p.rhoQ > 0n && p.rhoQ <= p.rhoMaxQ)) {
    throw new Error(`RHO_Q phải thoả 0 < RHO_Q ≤ rho_max_q (${p.rhoMaxQ}), nhận ${p.rhoQ}.`);
  }
  if (p.expectHashes && !p.presetSeeds) {
    throw new Error(
      "Pha beacons: có hash kỳ vọng mà không có seed cho trước — seed tự tạo cho hash khác bản tính trước. " +
        "Đặt bốn biến DEPLOY_SEED_{REGISTRY,GREENBACK,GB_SHARD,RATE}, hoặc bỏ DEPLOY_EXPECT_HASHES.",
    );
  }
  const { lucid, network } = chain;
  const park = await parkOf(lucid, network);
  const txs: TxReport[] = [];

  // (1) Bốn seed ở bãi đỗ: sổ · beacon GB · gb_shard · beacon ρ.
  let seeds: UTxO[];
  if (p.presetSeeds) {
    // Seed cho trước: KHÔNG tạo output nào. Mỗi seed phải còn chưa tiêu và nằm ở BÃI ĐỖ (không
    // nhận seed ở ví: seed sổ phải nằm chờ tới pha `registry`, mà ở ví thì bộ chọn UTxO của bước
    // giữa hai pha tiêu mất được). Hỏng ⟹ ném, không lùi về tự tạo.
    seeds = await resolveBeaconPresetSeeds(lucid, park, p.presetSeeds);
    chain.log(`   seed cho trước (bãi đỗ): ${seeds.map((u) => outRefString(u)).join(" · ")}`);
  } else {
    let seedTx = lucid.newTx();
    for (let i = 0; i < 4; i++) seedTx = seedTx.pay.ToAddress(park.parkAddress, { lovelace: SEED_LOVELACE });
    const seeded = await completeSignSubmit(chain, "seed ×4 → bãi đỗ", seedTx);
    txs.push(seeded.report);
    seeds = bodyOutputs(seeded.signed).filter(
      (u) => u.address === park.parkAddress && !u.scriptRef && Object.keys(u.assets).length === 1 && u.assets.lovelace === SEED_LOVELACE,
    );
    if (seeds.length !== 4) {
      throw new Error(`Tx seed phải có đúng 4 output seed ở bãi đỗ, thấy ${seeds.length}.`);
    }
  }
  const [registrySeedUtxo, gbSeedUtxo, shardSeedUtxo, rateSeedUtxo] = seeds as [UTxO, UTxO, UTxO, UTxO];
  const ref = (u: UTxO): OutRef => ({ txHash: u.txHash, outputIndex: u.outputIndex });

  // (2) Apply theo thứ tự: sổ → beacon GB → gb_shard; ρ độc lập (GenBeacons ▸ scripts.ts).
  //     In bốn hash; có tệp kỳ vọng thì so, lệch ⟹ ném ở đây — trước mọi tx đúc.
  const scripts = beaconScriptsChecked(p, network, park.walletPkh, {
    registry: ref(registrySeedUtxo),
    greenback: ref(gbSeedUtxo),
    gbShard: ref(shardSeedUtxo),
    rate: ref(rateSeedUtxo),
  }, chain.log);

  // (3) Đúc RHO + GBB + 16 GBS. Thử MỘT tx trước (một lần phí, một lần chờ); vượt trần hoặc
  //     dựng chung hỏng thì tách ba. Mỗi lượt gọi dựng builder MỚI: TxBuilder của Lucid tích
  //     chương trình vào chính nó, nên tái dùng builder đã compose là gửi chồng lệnh.
  const parts = () => {
    const nowMs = chain.nowMs();
    return [
      { label: "khởi tạo beacon ρ (RHO)", tx: initRateBeaconTx(lucid, { rate: scripts.rate, seedUtxo: rateSeedUtxo, rhoQ: p.rhoQ, nowMs }).tx },
      {
        label: "khởi tạo beacon GreenBack (GBB)",
        tx: initGreenBackBeaconTx(lucid, { greenback: scripts.greenback, seedUtxo: gbSeedUtxo, gbNanogic: 0n, nowMs }).tx,
      },
      { label: "đúc 16 shard GB (GBS‖id)", tx: mintGbShardsTx(lucid, { gbShard: scripts.gbShard, seedUtxo: shardSeedUtxo }).tx },
    ];
  };
  let combinedMint = true;
  try {
    let all = lucid.newTx();
    for (const part of parts()) all = all.compose(part.tx);
    txs.push((await completeSignSubmit(chain, "RHO + GBB + 16 GBS (một tx)", spendsParkedSeed(all, park))).report);
  } catch (e) {
    const msg = describe(e);
    // Chỉ lùi về ba tx khi CHƯA gửi gì. `completeSignSubmit` ném sau `submit` chỉ ở ca hash
    // lệch — ca đó phải nổi lên, không được thử lại.
    if (/hash sau khi gửi/.test(msg)) throw e;
    combinedMint = false;
    chain.log(`   · một tx không được (${msg.slice(0, 200)}) — tách ba tx`);
    for (const part of parts()) {
      txs.push((await completeSignSubmit(chain, part.label, spendsParkedSeed(part.tx, park))).report);
    }
  }

  // (4) Ref-script `gb_shard` — tx riêng: tx đúc đã bê CBOR gb_shard làm minting policy, gộp
  //     thêm bản ref là trả tiền hai lần cho một script (cùng lý do ở bước 09). Cùng bãi đỗ,
  //     cùng hình dạng output với `refScripts.ts ▸ publishRefScript`.
  const refTx = lucid
    .newTx()
    .pay.ToAddressWithData(
      park.parkAddress,
      undefined,
      { lovelace: minAdaForRefScriptWithMargin(scripts.gbShard.script.script) },
      scripts.gbShard.script,
    );
  const published = await completeSignSubmit(chain, "công bố ref-script gb_shard", refTx);
  txs.push(published.report);
  const refOut = bodyOutputs(published.signed).filter(
    (u) => u.address === park.parkAddress && u.scriptRef && validatorToScriptHash(u.scriptRef) === scripts.gbShard.hash,
  );
  if (refOut.length !== 1) throw new Error(`Tx công bố phải có đúng 1 output mang ref gb_shard, thấy ${refOut.length}.`);

  return {
    scripts,
    registrySeed: ref(registrySeedUtxo),
    refGbShardUtxo: `${refOut[0]!.txHash}#${refOut[0]!.outputIndex}`,
    txs,
    combinedMint,
  };
}

/** Dòng sổ của pha 1. KHÔNG có `VAULT_REGISTRY_HASH` — xem đầu tệp. */
export function beaconsBookEntries(r: BeaconsPhaseResult): [string, string][] {
  return [
    [KEY.RATE_PARAM_HASH, r.scripts.rate.hash],
    [KEY.GREENBACK_BEACON_HASH, r.scripts.greenback.hash],
    [KEY.GB_SHARD_HASH, r.scripts.gbShard.hash],
    [KEY.GB_SHARD_CAP_NANOGIC, r.scripts.gbShard.capNanogic.toString()],
    [KEY.REF_GB_SHARD_UTXO, r.refGbShardUtxo],
    [PHASE_KEYS.REGISTRY_SEED_UTXO, `${r.registrySeed.txHash}#${r.registrySeed.outputIndex}`],
    [PHASE_KEYS.REGISTRY_PENDING_HASH, r.scripts.vaultRegistry.hash],
  ];
}

// ══════════════════════════════════════════════════════════════════════════════
// Pha 2 — registry
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Đọc đầu vào pha `registry` từ sổ và kiểm THỨ TỰ: mỗi hash két phải được ghi SAU dòng
 * `GB_SHARD_HASH` mới nhất. Một hash két ghi trước dòng đó không thể đã bake gb_shard hiện tại —
 * đó đúng là ca sổ còn `VAULT_INSTANT_HASH` của đời v1. Đúc sổ với nó là khoá vĩnh viễn một sổ
 * không két thật nào khớp (sổ bất biến).
 *
 * Phép này KHÔNG chứng minh hash két đã bake đúng gb_shard (việc đó cần apply lại két — tham số
 * két thuộc `deployParams.ts`); nó chỉ loại ca két cũ hơn cụm.
 */
export function registryInputsFromBook(entries: readonly BookEntry[]): {
  seed: OutRef;
  pendingHash: string;
  vaultScriptHashes: string[];
} {
  const need = (key: string): BookEntry => {
    const e = lastLine(entries, key);
    if (!e) throw new Error(`Sổ thiếu ${key} — chạy pha \`beacons\` (và bước dựng két) trước.`);
    return e;
  };
  const missing = [PHASE_KEYS.REGISTRY_SEED_UTXO, PHASE_KEYS.REGISTRY_PENDING_HASH, KEY.GB_SHARD_HASH, ...REGISTRY_VAULT_KEYS]
    .filter((k) => !lastLine(entries, k));
  if (missing.length > 0) {
    throw new Error(`Sổ thiếu ${missing.length} khoá cho pha registry: ${missing.join(", ")}.`);
  }
  const gbShard = need(KEY.GB_SHARD_HASH);
  const vaultScriptHashes = REGISTRY_VAULT_KEYS.map((k) => {
    const e = need(k);
    if (e.line < gbShard.line) {
      throw new Error(
        `${k} (dòng ${e.line + 1}) được ghi TRƯỚC ${KEY.GB_SHARD_HASH} (dòng ${gbShard.line + 1}) — két đó không ` +
          `thể đã bake gb_shard ${gbShard.value}. Dựng lại két trên cụm GenBeacons hiện tại rồi chạy lại.`,
      );
    }
    return e.value;
  });
  return {
    seed: parseOutRef(need(PHASE_KEYS.REGISTRY_SEED_UTXO).value, PHASE_KEYS.REGISTRY_SEED_UTXO),
    pendingHash: need(PHASE_KEYS.REGISTRY_PENDING_HASH).value,
    vaultScriptHashes,
  };
}

export interface RegistryPhaseResult {
  registryHash: string;
  registryUtxo: string;
  vaultScriptHashes: string[];
  tx: TxReport;
}

/** So hash sổ két + các hash két SẼ được ghi vào sổ (theo `REGISTRY_VAULT_KINDS`) với tệp kỳ
 *  vọng. Sổ bất biến sau khi đúc, nên đây là lượt so CUỐI trước một thao tác không sửa được:
 *  một hash két lệch bản đã gửi mà vào sổ là két đó không bao giờ rút shard GB được. */
export function registryHashesChecked(
  registryHash: string,
  vaultScriptHashes: readonly string[],
  expected: ExpectedHashes | undefined,
  log: (line: string) => void,
): void {
  if (vaultScriptHashes.length !== REGISTRY_VAULT_KINDS.length) {
    throw new Error(`Sổ két cần đúng ${REGISTRY_VAULT_KINDS.length} hash két (${REGISTRY_VAULT_KINDS.join(", ")}), nhận ${vaultScriptHashes.length}.`);
  }
  const actual: Record<string, string> = { vault_registry: registryHash };
  REGISTRY_VAULT_KINDS.forEach((k, i) => { actual[`vault_${k}`] = vaultScriptHashes[i]!; });
  checkExpectedHashes("bước 11 pha registry", actual, expected, log);
}

export async function runRegistryPhase(
  chain: Chain,
  p: {
    blueprint: Blueprint; seed: OutRef; pendingHash: string; vaultScriptHashes: string[];
    /** Hash kỳ vọng (`clusterHashes.ts --out`). Có ⟹ so vault_registry · vault_instant ·
     *  vault_schedule, lệch ⟹ ném TRƯỚC khi ký/nộp tx đúc sổ. */
    expectHashes?: ExpectedHashes;
  },
): Promise<RegistryPhaseResult> {
  const { lucid, network } = chain;
  const park = await parkOf(lucid, network);
  const registry = vaultRegistryScript(p.blueprint, network, p.seed);
  if (registry.hash !== p.pendingHash) {
    throw new Error(
      `Sổ dựng lại từ seed có hash ${registry.hash}, nhưng gb_shard đã bake ${p.pendingHash} — blueprint ` +
        `vault_registry đã đổi giữa hai pha. Đúc tiếp là đúc một sổ mà shard không tra.`,
    );
  }
  registryHashesChecked(registry.hash, p.vaultScriptHashes, p.expectHashes, chain.log);
  const [seedUtxo] = await lucid.utxosByOutRef([p.seed]);
  if (!seedUtxo) throw new Error(`Seed sổ ${p.seed.txHash}#${p.seed.outputIndex} không còn trên chuỗi — sổ này không đúc được nữa.`);
  if (seedUtxo.address !== park.parkAddress) {
    throw new Error(`Seed sổ nằm ở ${seedUtxo.address}, không phải bãi đỗ của ví ký ${park.parkAddress} — ví này không tiêu được nó.`);
  }
  const { tx } = mintVaultRegistryTx(lucid, { vaultRegistry: registry, seedUtxo, vaultScriptHashes: p.vaultScriptHashes });
  const done = await completeSignSubmit(chain, "đúc sổ két (VRG)", spendsParkedSeed(tx, park));
  const out = bodyOutputs(done.signed).filter((u) => u.address === registry.address && u.assets[registry.nftUnit] === 1n);
  if (out.length !== 1) throw new Error(`Tx đúc sổ phải có đúng 1 output mang ${registry.nftUnit}, thấy ${out.length}.`);
  return {
    registryHash: registry.hash,
    registryUtxo: `${out[0]!.txHash}#${out[0]!.outputIndex}`,
    vaultScriptHashes: p.vaultScriptHashes,
    tx: done.report,
  };
}

export function registryBookEntries(r: RegistryPhaseResult): [string, string][] {
  return [[KEY.VAULT_REGISTRY_HASH, r.registryHash]];
}

// ══════════════════════════════════════════════════════════════════════════════
// main
// ══════════════════════════════════════════════════════════════════════════════

type Phase = "beacons" | "registry";

function parsePhase(raw: string | undefined): Phase {
  if (raw === "beacons" || raw === "registry") return raw;
  throw new Error(`GEN_BEACONS_PHASE phải là "beacons" hoặc "registry", nhận "${raw ?? ""}".`);
}

function parseRhoQ(raw: string | undefined): bigint {
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`RHO_Q bắt buộc ở pha beacons: số nguyên dương Q-format (CC-GEN-RATE-VALUE), nhận "${raw ?? ""}".`);
  }
  return BigInt(raw);
}

async function main(): Promise<void> {
  // Kiểm env TRƯỚC khi nạp config.ts và trước mọi lệnh gọi mạng.
  const phase = parsePhase(process.env.GEN_BEACONS_PHASE);
  const rhoQ = phase === "beacons" ? parseRhoQ(process.env.RHO_Q) : undefined;
  const redeploy = parseFlag(process.env.GEN_BEACONS_REDEPLOY, "GEN_BEACONS_REDEPLOY");
  const dryRun = parseFlag(process.env.DRY_RUN, "DRY_RUN");
  // Seed cho trước + hash kỳ vọng (`deploySeeds.ts`). Pha beacons đúc trên bốn seed; pha registry
  // dựng sổ từ seed đã GHI ở sổ trạng thái, nên ở pha đó `DEPLOY_SEED_REGISTRY` (nếu đặt) chỉ là
  // phép đối chiếu: phải trùng seed trong sổ, lệch ⟹ ném. Tệp kỳ vọng dùng ở CẢ HAI pha — pha
  // registry so vault_registry · vault_instant · vault_schedule trước khi đúc sổ (bất biến).
  // Cùng một bộ env dùng được cho cả chuỗi deploy, không phải gỡ biến giữa hai pha.
  const presetSeeds = phase === "beacons" ? readBeaconPresetSeeds(process.env) : undefined;
  const presetRegistrySeed = phase === "registry" ? readPresetSeed(process.env, "registry") : undefined;
  const expectHashes = loadExpectedHashes(process.env);
  requireExpectInPresetMode(`bước 11 pha ${phase}`, process.env, expectHashes);

  const config = await import("../config.js");
  const { NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, PRIVATE_KEY, PROTOCOL, selectWallet } = config;
  if (NETWORK === "Mainnet") {
    throw new Error("GenBeacons chỉ chạy testnet: CC-GEN-SURPLUS-SHARD và CC-GEN-BEACON-ROTATION còn TẠM (SPEC v2.0 §13).");
  }
  const book = decideStateBook({ dryRun, flag: process.env.WRITE_STATE_BOOK, signsWithPrivateKey: PRIVATE_KEY !== "" });
  // `STATE_BOOK_PATH` (đường tuyệt đối) đổi sổ; vắng thì `scripts/state.<NET>.sh`. Pha này GHI sổ
  // bằng `appendFileSync`, và đường mặc định có thể là symlink tới sổ của cụm đang phục vụ.
  const bookPath = stateBookPath(NETWORK);
  const entries = readBookEntries(bookPath);
  // Seed khác vai phải khác outref; không vai nào ngoài `registry` trỏ vào seed sổ két đã ghi.
  assertDistinctPresetSeeds(process.env, [
    ...entries.filter((e) => e.key === PHASE_KEYS.REGISTRY_SEED_UTXO).map((e) => e.value),
    ...(process.env[PHASE_KEYS.REGISTRY_SEED_UTXO] ? [process.env[PHASE_KEYS.REGISTRY_SEED_UTXO]!] : []),
  ]);

  console.log(`=== Step 11: GenBeacons · pha ${phase}${dryRun ? " · DRY RUN" : ""} ===\n`);
  console.log(`Network: ${NETWORK} · sổ: ${bookPath}`);

  const real = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(real);
  let chain: Chain;
  if (dryRun) {
    // Emulator soi gương: một tài khoản mang ĐÚNG địa chỉ ví và TỔNG lovelace của ví. Token
    // khác bị bỏ (không bước nào ở đây cần). Ký cục bộ bằng chính khoá ví — không gì rời máy.
    const walletAddress = await real.wallet().address();
    const lovelace = (await real.wallet().getUtxos()).reduce((s, u) => s + (u.assets.lovelace ?? 0n), 0n);
    const emulator = new Emulator([{ seedPhrase: "", privateKey: "", address: walletAddress, assets: { lovelace } }]);
    emulator.time = Math.floor(Date.now() / 1000) * 1000;
    const mirror = await Lucid(emulator, "Custom");
    selectWallet(mirror);
    if ((await mirror.wallet().address()) !== walletAddress) {
      throw new Error("Emulator soi gương ra địa chỉ ví khác ví thật — không chạy thử được trên mạng này.");
    }
    chain = {
      lucid: mirror,
      network: NETWORK,
      nowMs: () => emulator.now(),
      log: (l) => console.log(l),
      submit: async (signed) => {
        const h = await signed.submit();
        emulator.awaitBlock(1);
        return h;
      },
    };
    console.log(`DRY RUN: Emulator soi gương ví ${walletAddress} (${lovelace} lovelace). Hash tx in ra là hash trên Emulator.\n`);
  } else {
    chain = liveChain(real, NETWORK);
  }

  const blueprint = loadBlueprint();
  let lines: [string, string][];
  if (phase === "beacons") {
    const prior = lastLine(entries, KEY.GB_SHARD_HASH);
    if (prior && !redeploy) {
      throw new Error(
        `Sổ đã có ${KEY.GB_SHARD_HASH}=${prior.value}. Chạy lại pha beacons là dựng cụm MỚI và bỏ mồ côi mọi ` +
          `két đã bake cụm cũ. Chủ đích đúng thế thì đặt GEN_BEACONS_REDEPLOY=1.`,
      );
    }
    const beaconsInput: BeaconsPhaseInput = {
      blueprint,
      msPerEpoch: PROTOCOL.MS_PER_EPOCH,
      windowOriginMs: PROTOCOL.WINDOW_ORIGIN_MS,
      rhoQ: rhoQ!,
      rhoMaxQ: compiledRhoMaxQ(),
      gbShardCapNanogic: compiledGbShardCap(),
      presetSeeds,
      expectHashes,
    };
    if (dryRun && presetSeeds) {
      // Emulator soi gương chỉ có lovelace của ví, KHÔNG có seed ở bãi đỗ ⟹ không dựng nổi tx đúc
      // trên nó. Lượt chạy thử với seed cho trước vì thế dừng ở phần đo được thật: seed trên mạng
      // thật (chưa tiêu, ở bãi đỗ) + bốn hash so với tệp kỳ vọng. Không gửi gì, không ghi sổ.
      const park = parkFor(NETWORK, await real.wallet().address());
      const seeds = await resolveBeaconPresetSeeds(real, park, presetSeeds);
      console.log(`Seed cho trước (bãi đỗ, chưa tiêu): ${seeds.map((u) => outRefString(u)).join(" · ")}`);
      beaconScriptsChecked(beaconsInput, NETWORK, park.walletPkh, presetSeeds, (l) => console.log(l));
      console.log(`\nDRY RUN + seed cho trước: đã kiểm seed và hash; KHÔNG dựng tx đúc (Emulator không có seed ở bãi đỗ).`);
      return;
    }
    const r = await runBeaconsPhase(chain, beaconsInput);
    console.log(`\nMint ${r.combinedMint ? "gộp MỘT tx" : "tách ba tx"} · ${r.txs.length} tx:`);
    for (const t of r.txs) console.log(`   ${t.label.padEnd(36)} ${t.bytes} B  ${t.hash}`);
    lines = beaconsBookEntries(r);
  } else {
    const input = registryInputsFromBook(entries);
    if (presetRegistrySeed && outRefString(presetRegistrySeed) !== outRefString(input.seed)) {
      throw new Error(
        `${SEED_ENV.registry}=${outRefString(presetRegistrySeed)} nhưng sổ ghi ${PHASE_KEYS.REGISTRY_SEED_UTXO}=` +
          `${outRefString(input.seed)} — hash sổ tính trước là của seed thứ nhất, pha registry đúc trên seed thứ hai.`,
      );
    }
    if (lastLine(entries, KEY.VAULT_REGISTRY_HASH)?.value === input.pendingHash) {
      throw new Error(`Sổ két ${input.pendingHash} đã đúc (sổ có ${KEY.VAULT_REGISTRY_HASH} trùng) — không có gì để làm.`);
    }
    const r = await runRegistryPhase(chain, { blueprint, ...input, expectHashes });
    console.log(`\nSổ két: ${r.registryUtxo} · két: ${r.vaultScriptHashes.join(", ")} · ${r.tx.bytes} B`);
    lines = registryBookEntries(r);
  }

  console.log(`\n📋 Khoá sổ của pha ${phase}:`);
  for (const [k, v] of lines) console.log(`   ${k}=${v}`);
  if (!book.write) {
    console.log(`\nSổ trạng thái: KHÔNG ghi — ${book.reason}`);
    return;
  }
  appendStateBook(bookPath, lines, `11_deploy_gen_beacons · pha ${phase} · ${new Date().toISOString()}`);
  console.log(`\nĐã nối ${lines.length} dòng vào ${bookPath} (${book.reason}).`);
}

const invokedDirectly =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
