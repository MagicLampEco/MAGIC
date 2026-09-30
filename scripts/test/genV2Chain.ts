// scripts/test/genV2Chain.ts — phần DÙNG CHUNG của các kịch bản e2e chạy tay dưới Gen v2.0:
// đọc khoá GenBeacons / ref-script từ sổ trạng thái (đã nạp vào `process.env` bởi runner),
// rồi tìm các UTxO beacon / shard GB / sổ két / két Wakeme trên chuỗi theo NFT.
//
// Không có công thức nào ở đây. Tên khoá và NGHĨA của khoá lấy từ nguồn duy nhất
// `gen_vault_tx_api_deployment.ts` ▸ `GEN_V2_STATE_KEYS` / `SCHEDULE_ONLY_STATE_KEYS`;
// năm hash apply-param lấy qua `deployParams.ts` ▸ `genV2BeaconRefsFromBook`. Thiếu khoá ⟹
// NÉM và kể ĐỦ mọi khoá thiếu trong một lượt, không đệm: một hash đệm vẫn apply ra một két
// "hợp lệ" — chỉ là két đó tra một beacon không tồn tại, vĩnh viễn.
//
// Hàm đọc sổ là hàm THUẦN (nhận `book`, không đọc env, không đụng mạng) để
// `test/test_gen_v2_chain.ts` kiểm được offline. Hàm đọc chuỗi nhận `lucid` từ nơi gọi.

import {
  scriptHashToCredential, validatorToScriptHash,
  type LucidEvolution, type UTxO, type Validator,
} from "@lucid-evolution/lucid";
import { GEN_V2_STATE_KEYS, SCHEDULE_ONLY_STATE_KEYS } from "../gen_vault_tx_api_deployment.js";
import { genV2BeaconRefsFromBook, type GenV2BeaconRefs } from "../deployParams.js";
import { parseOutRef, type OutRef } from "../runResult.js";
import {
  GREENBACK_NFT_NAME, RATE_NFT_NAME, VAULT_REGISTRY_NFT_NAME,
} from "../../InstantGen/offchain/src/constants.js";

export type Book = Readonly<Record<string, string | undefined>>;

type GenKey = keyof typeof GEN_V2_STATE_KEYS;
type ScheduleOnlyKey = keyof typeof SCHEDULE_ONLY_STATE_KEYS;

/** Khoá sổ mà kịch bản e2e cần NGOÀI năm hash apply-param. */
const E2E_GEN_KEYS = [
  "GB_SHARD_CAP_NANOGIC", "VAULT_REGISTRY_HASH", "REF_GB_SHARD_UTXO",
] as const satisfies readonly GenKey[];

export interface GenV2E2eBook {
  beacons:            GenV2BeaconRefs;
  gbShardCapNanogic:  bigint;
  vaultRegistryHash:  string;
  refGbShardOutRef:   OutRef;
  /** Chỉ có khi gọi với `withScheduleCommit: true`. */
  refCommitOutRef?:   OutRef;
}

/**
 * Đọc mọi khoá Gen v2.0 mà một kịch bản e2e cần. Thiếu ⟹ NÉM kể tên + nghĩa từng khoá thiếu
 * (nghĩa chép từ bảng nguồn, không viết lại). Sai dạng ⟹ NÉM nêu khoá.
 */
export function readGenV2E2eBook(book: Book, opts: { withScheduleCommit: boolean }): GenV2E2eBook {
  const wanted: [string, string][] = [
    ...E2E_GEN_KEYS.map((k): [string, string] => [k, GEN_V2_STATE_KEYS[k]]),
    ...(opts.withScheduleCommit
      ? (["REF_COMMIT_SCHEDULE_UTXO"] as const satisfies readonly ScheduleOnlyKey[])
          .map((k): [string, string] => [k, SCHEDULE_ONLY_STATE_KEYS[k]])
      : []),
  ];
  const missing = wanted.filter(([k]) => !book[k]);
  if (missing.length > 0) {
    throw new Error(
      `Sổ trạng thái thiếu ${missing.length} khoá Gen v2.0 mà kịch bản này cần:\n` +
      missing.map(([k, nghia]) => `    · ${k} — ${nghia}\n`).join("") +
      `  Nạp sổ \`state.<NETWORK>.sh\` sau bước 11 (GenBeacons) + 06 (ref-script) rồi chạy lại.`,
    );
  }
  // Năm hash apply-param: hàm nguồn tự kiểm thiếu + dạng.
  const beacons = genV2BeaconRefsFromBook(book);

  const capRaw = book.GB_SHARD_CAP_NANOGIC!;
  if (!/^[1-9][0-9]*$/.test(capRaw)) {
    throw new Error(`GB_SHARD_CAP_NANOGIC="${capRaw}" không phải chuỗi chữ số nanogic > 0.`);
  }
  const vaultRegistryHash = book.VAULT_REGISTRY_HASH!;
  if (!/^[0-9a-f]{56}$/.test(vaultRegistryHash)) {
    throw new Error(`VAULT_REGISTRY_HASH="${vaultRegistryHash}" không phải 28 byte hex thường.`);
  }
  return {
    beacons,
    gbShardCapNanogic: BigInt(capRaw),
    vaultRegistryHash,
    refGbShardOutRef: parseOutRef(book.REF_GB_SHARD_UTXO!, "REF_GB_SHARD_UTXO"),
    ...(opts.withScheduleCommit
      ? { refCommitOutRef: parseOutRef(book.REF_COMMIT_SCHEDULE_UTXO!, "REF_COMMIT_SCHEDULE_UTXO") }
      : {}),
  };
}

/** Đọc một khoá outref bắt buộc (vd `REF_VAULT_SCHEDULE_UTXO`). Thiếu/sai dạng ⟹ NÉM nêu khoá. */
export function requireOutRefKey(book: Book, key: string, hint: string): OutRef {
  const v = book[key];
  if (!v) throw new Error(`Sổ/env thiếu ${key} — ${hint}.`);
  return parseOutRef(v, key);
}

/**
 * Lượng sinh `m` (nanogic) của một lượt InstantGen — BẮT BUỘC người chạy chọn, không mặc định.
 * Hai dạng: chuỗi chữ số > 0 (nanogic), hoặc đúng chữ `max` (lấy `maxM` của `instantGenLimits`
 * ở ảnh chụp chuỗi vừa đọc — vẫn là lựa chọn TƯỜNG MINH của người chạy, không phải đệm).
 */
export type InstantMChoice = { kind: "exact"; m: bigint } | { kind: "max" };

export function parseInstantM(raw: string | undefined, key: string): InstantMChoice {
  if (raw === undefined || raw === "") {
    throw new Error(
      `${key} bắt buộc: lượng MAGIC sinh ở lượt này, đơn vị nanogic (chuỗi chữ số > 0), ` +
      `hoặc đúng chữ "max" để lấy trần còn sinh được trong epoch. Không có mặc định.`,
    );
  }
  if (raw === "max") return { kind: "max" };
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${key}="${raw}" không hợp lệ — cần chuỗi chữ số nanogic > 0 hoặc "max".`);
  }
  return { kind: "exact", m: BigInt(raw) };
}

/** `m` cuối cùng so với trần `maxM` đã tính. Vượt ⟹ NÉM kèm trần (validator sẽ bác IG-8..12). */
export function resolveInstantM(choice: InstantMChoice, maxM: bigint, key: string): bigint {
  if (maxM <= 0n) {
    throw new Error(`Két không còn sinh được gì trong epoch này (maxM = ${maxM}) — ${key} vô nghĩa.`);
  }
  if (choice.kind === "max") return maxM;
  if (choice.m > maxM) {
    throw new Error(`${key} = ${choice.m} nanogic vượt trần còn sinh được trong epoch này (${maxM} nanogic).`);
  }
  return choice.m;
}

/** Đúng MỘT UTxO mang đúng 1 đơn vị `unit`. 0 hoặc >1 ⟹ NÉM, không chọn đại. */
export function pickByNft(utxos: UTxO[], unit: string, what: string): UTxO {
  const hits = utxos.filter((u) => u.assets[unit] === 1n);
  if (hits.length !== 1) {
    throw new Error(
      `${what}: cần đúng 1 UTxO mang NFT ${unit}, thấy ${hits.length}` +
      (hits.length > 1 ? ` (${hits.map((u) => `${u.txHash}#${u.outputIndex}`).join(", ")}).` : "."),
    );
  }
  return hits[0]!;
}

/** Một outref trên chuỗi, mang ĐÚNG script có hash `wantHash` (CIP-33). Sai ⟹ NÉM. */
export async function fetchRefScript(
  lucid: LucidEvolution, ref: OutRef, key: string, wantHash: string,
): Promise<UTxO> {
  const found = await lucid.utxosByOutRef([ref]);
  if (found.length !== 1) {
    throw new Error(`${key}=${ref.txHash}#${ref.outputIndex} không có trên chuỗi (đã tiêu hoặc chỉ mục chưa thấy).`);
  }
  const u = found[0]!;
  if (!u.scriptRef) throw new Error(`${key}=${ref.txHash}#${ref.outputIndex} không mang script tham chiếu nào.`);
  const got = validatorToScriptHash(u.scriptRef as Validator);
  if (got !== wantHash) {
    throw new Error(`${key}=${ref.txHash}#${ref.outputIndex} mang script ${got}, cần ${wantHash}.`);
  }
  return u;
}

async function utxosAtScript(lucid: LucidEvolution, hash: string): Promise<UTxO[]> {
  return lucid.utxosAt(scriptHashToCredential(hash));
}

/** Chỉ beacon ρ — cho các nhánh làm mới checkpoint (BurnBatch / UpdateProfile) không cần
 *  beacon GB hay shard GB. Nhận đúng năm hash apply-param, không đòi các khoá sổ khác. */
export async function readRateBeaconUtxo(lucid: LucidEvolution, beacons: GenV2BeaconRefs): Promise<UTxO> {
  return pickByNft(
    await utxosAtScript(lucid, beacons.rateScriptHash), beacons.rateNftPolicy + RATE_NFT_NAME, "beacon ρ (RHO)",
  );
}

export interface GenV2ChainRefs {
  rateBeaconUtxo:    UTxO;
  gbBeaconUtxo:      UTxO;
  vaultRegistryUtxo: UTxO;
  /** Mọi UTxO ở Script(gb_shard) — bộ dựng tự chọn đúng shard của két. */
  gbShardUtxos:      UTxO[];
  /** UTxO ref-script của `gb_shard`; `scriptRef` của nó là script shard GB. */
  gbShardRefUtxo:    UTxO;
}

/** Đọc beacon ρ, beacon GreenBack, sổ két, 16 shard GB và ref-script `gb_shard` theo sổ. */
export async function readGenV2ChainRefs(lucid: LucidEvolution, b: GenV2E2eBook): Promise<GenV2ChainRefs> {
  const { beacons } = b;
  const [rateAt, gbbAt, vrgAt, gbShardUtxos, gbShardRefUtxo] = await Promise.all([
    utxosAtScript(lucid, beacons.rateScriptHash),
    utxosAtScript(lucid, beacons.gbBeaconScriptHash),
    utxosAtScript(lucid, b.vaultRegistryHash),
    utxosAtScript(lucid, beacons.gbShardPolicyId),
    fetchRefScript(lucid, b.refGbShardOutRef, "REF_GB_SHARD_UTXO", beacons.gbShardPolicyId),
  ]);
  if (gbShardUtxos.length === 0) {
    throw new Error(`Script(gb_shard ${beacons.gbShardPolicyId}) không có UTxO nào — chưa chạy bước 11 pha shard?`);
  }
  return {
    rateBeaconUtxo:    pickByNft(rateAt, beacons.rateNftPolicy + RATE_NFT_NAME, "beacon ρ (RHO)"),
    gbBeaconUtxo:      pickByNft(gbbAt, beacons.gbBeaconNftPolicy + GREENBACK_NFT_NAME, "beacon GreenBack (GBB)"),
    vaultRegistryUtxo: pickByNft(vrgAt, b.vaultRegistryHash + VAULT_REGISTRY_NFT_NAME, "sổ két (VRG)"),
    gbShardUtxos,
    gbShardRefUtxo,
  };
}

/**
 * Két Wakeme ghim két InstantGen (chỉ ĐỌC, reference input — G1b).
 *   · `overrideRaw` (env `WAKEME_VAULT_UTXO`) có ⟹ dùng đúng outref đó (bộ dựng tự soát luật đọc).
 *   · không có, `wakemeLink != ""` ⟹ tìm két mang NFT `wakemeVaultHash ‖ wakemeLink` (tên NFT két
 *     Wakeme = owner_commit, `instant.ts ▸ readWakemeVault` vế b). Không thấy đúng 1 ⟹ NÉM.
 *   · không có, link rỗng ⟹ `undefined` (lượt này không nối két; L_lent = 0).
 * Nơi gọi quyết có cần hay không: nhánh sinh đọc L_lent cả khi không làm mới
 * (`expectedCheckpointForGen`); nhánh BurnBatch / UpdateProfile chỉ đọc khi làm mới
 * (`cap_epoch < e`) — đưa vào lúc không làm mới là thừa, bộ dựng không dùng.
 */
export async function resolveWakemeVaultUtxo(
  lucid: LucidEvolution, wakemeVaultHash: string, wakemeLink: string, overrideRaw: string | undefined,
): Promise<UTxO | undefined> {
  if (overrideRaw !== undefined && overrideRaw !== "") {
    const ref = parseOutRef(overrideRaw, "WAKEME_VAULT_UTXO");
    const found = await lucid.utxosByOutRef([ref]);
    if (found.length !== 1) throw new Error(`WAKEME_VAULT_UTXO=${overrideRaw} không có trên chuỗi.`);
    return found[0]!;
  }
  if (wakemeLink === "") return undefined;
  return pickByNft(
    await utxosAtScript(lucid, wakemeVaultHash), wakemeVaultHash + wakemeLink,
    `két Wakeme đang ghim (wakeme_link ${wakemeLink.slice(0, 16)}…)`,
  );
}
