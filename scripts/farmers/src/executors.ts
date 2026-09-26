// scripts/farmers/src/executors.ts — bảng executor cho runner: mỗi hành động của kế hoạch →
// một hàm trả `Outcome`. Chỗ nào CHƯA dựng được thì trả `skip` kèm mã lý do + con trỏ, không
// bao giờ bỏ im lặng (runner.ts ▸ statusOf dịch `skip` thành dòng `skip` trong sổ).
//
// Ba đường thực thi:
//   1. trong tiến trình — `did_mint` (did.ts ▸ buildDidMintTx, đánh giá bằng aiken) và `fund`;
//   2. tiến trình con — `vault_open_*` (`scripts/deploy/05|07`, đọc RESULT — vaultGenesis.ts),
//      `engage_mint`, `instant_gen`, `schedule_commit`, `schedule_fire`, `consume`, `tamper`
//      (`scripts/test/<x>_only.ts`) với ví của CHÍNH nông dân;
//   3. `skip` có lý do — mọi thứ còn lại.
//
// Trạng thái nông dân (runner.ts ▸ ExecContext.state) mang `vault_nft` (từ bước mở vault) và
// `engage_nft` (từ bước đúc thread). Trước mỗi tiến trình con cần vault/thread, executor TRA
// CHUỖI lấy UTxO SỐNG theo NFT rồi truyền `VAULT_TX_HASH` / `ENGAGE_OUTREF` — outref lưu từ
// lượt trước là UTxO đã chết sau lượt tiêu đầu tiên.
//
// Hạt giống: chỉ đi vào (a) `selectWallet.fromSeed` trong tiến trình này, (b) biến
// `WALLET_SEED` của đúng MỘT tiến trình con. Không in, không ghi vào sổ, không vào artifacts.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Lucid, type LucidEvolution, type Network, type UTxO } from "@lucid-evolution/lucid";

import { lampAssetName } from "../../../ProtocolUtils/src/index.ts";
import { refScriptUtxo, withAikenEvaluator, type ChainAccess } from "./chain.ts";
import { interpretChild, outcomeOfError, type ChildRun } from "./childResult.ts";
import { DID_SIM_LABEL, SHARD_PREFIX_HEX, buildDidMintTx, utf8Hex } from "./did.ts";
import {
  CONSUME_ENGAGE_MARKER,
  ENGAGE_MINT_CONTRACT_MARKER,
  ENGAGE_MINT_SCRIPT,
  consumeAddressOf,
  interpretEngageMint,
  pickEngageThread,
} from "./engage.ts";
import type { ActionKind, FarmerProfile, GeneratorKind } from "./plan.ts";
import type { ExecContext, ExecutorTable, Outcome } from "./runner.ts";
import {
  VAULT_OPEN_CONTRACT_MARKER,
  VAULT_OPEN_SCRIPT,
  interpretVaultOpen,
  lampDepositOf,
  pickVaultUtxo,
  vaultAddressOf,
} from "./vaultGenesis.ts";
import type { FarmerWallet } from "./wallets.ts";

export { interpretChild } from "./childResult.ts";

/** Thư mục `scripts/` của kho — nơi tiến trình con chạy. */
export const SCRIPTS_DIR = fileURLToPath(new URL("../../", import.meta.url));

/** Tra UTxO SỐNG. Tách thành giao diện để bộ kiểm cắm bản giả, không chạm mạng. */
export interface ChainLookup {
  utxosAt(address: string): Promise<UTxO[]>;
  utxosAtWithUnit(address: string, unit: string): Promise<UTxO[]>;
}

/** Bản thật: provider của runner. Blockfrost trả `[]` cho 404, ném cho lỗi khác — lỗi khác đi
 *  thành `fail chain-lookup-failed`, không bị đọc thành "chưa lên chuỗi". (KHÔNG dùng
 *  `getUtxoByUnit`: bản Blockfrost của nó dịch MỌI lỗi, kể cả 403/429, thành "Unit not found.") */
export function providerLookup(access: ChainAccess): ChainLookup {
  return {
    utxosAt: (a) => access.provider.getUtxos(a),
    utxosAtWithUnit: (a, u) => access.provider.getUtxosWithUnit(a, u),
  };
}

export interface ExecutorDeps {
  network: Network;
  access: ChainAccess;
  /** Môi trường gốc của runner — nguồn cho env tiến trình con (đã lọc khoá). */
  env: Record<string, string | undefined>;
  wallets: Map<string, FarmerWallet>;
  /** Thư mục làm việc cho bộ đánh giá aiken. */
  workDir: string;
  taad: { policy: string; ref: string } | null;
  /** Hạt giống ví cấp vốn — chỉ cần cho bước `fund`. */
  deploySeed: string | null;
  scriptsDir?: string;
  childTimeoutMs?: number;
  /** Mặc định `providerLookup(access)`. */
  lookup?: ChainLookup;
}

const skip = (reason: string, detail: string): Outcome => ({ kind: "skip", reason, detail });

/** Nút phá chung của các tệp con có nó: bỏ chữ ký chủ vault ⟹ validator phải từ chối. */
const mutationEnv = (mutated: boolean): Record<string, string> => (mutated ? { SKIP_OWNER_SIG: "1" } : {});

function errText(e: unknown): string {
  return String((e as Error)?.message ?? e);
}

// ── tiến trình con ────────────────────────────────────────────────────────────

type Prepared = { env: Record<string, string> } | { stop: Outcome };

interface ChildSpec {
  /** Đường tương đối gốc `scripts/`, vd `test/instant_only.ts`, `deploy/05_create_instant_vault.ts`. */
  script: string;
  env: Record<string, string>;
  negative: boolean; // lượt phá (TAMPER hoặc SKIP_OWNER_SIG) — tệp con tự in "REJECTED (as expected…"
  /** Dấu hợp đồng phải có trong tệp con; vắng ⟹ `skip child-contract-missing` + câu nói thiếu gì. */
  requires?: { marker: string; what: string }[];
  /** Tra chuỗi ngay trước khi chạy (vault/thread SỐNG) ⟹ env thêm, hoặc một kết cục dừng. */
  prepare?: (w: FarmerWallet) => Promise<Prepared>;
  /** Bộ đọc theo hợp đồng riêng; vắng ⟹ `interpretChild`. */
  interpret?: (run: ChildRun, w: FarmerWallet) => Outcome;
}

/** Biến mà executor tự đặt cho từng tiến trình con — bản ở môi trường gốc KHÔNG được lọt vào:
 *  một `VAULT_TX_HASH` sót lại trong shell sẽ ghim nhầm vault của nông dân khác. */
const CHILD_OWNED_VARS = new Set(["DRY_RUN", "TAMPER", "SKIP_OWNER_SIG", "VAULT_TX_HASH", "ENGAGE_OUTREF", "WRITE_STATE_BOOK", "LAMP_DEPOSIT", "PROFILE"]);

/** Môi trường cho tiến trình con: bỏ MỌI khoá khác, chỉ để lại hạt giống của đúng một nông dân. */
export function childEnv(
  base: Record<string, string | undefined>,
  seed: string,
  network: Network,
  mode: ExecContext["mode"],
  extra: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (k === "PRIVATE_KEY" || k === "DEPLOY_WALLET_SEED" || k === "WALLET_SEED" || /^FARMER_SEED_/.test(k)) continue;
    if (CHILD_OWNED_VARS.has(k)) continue;
    out[k] = v;
  }
  out.WALLET_SEED = seed;
  out.NETWORK = network;
  // scripts/config.ts nạp `dotenv/config`; trỏ nó vào tệp rỗng để không tệp nào trên đĩa
  // chen khoá vào tiến trình con (dotenv không đè biến đã có, nhưng biến ĐÃ XOÁ thì nó nạp lại).
  out.DOTENV_CONFIG_PATH = "/dev/null";
  if (mode === "dry") out.DRY_RUN = "1";
  return { ...out, ...extra };
}

async function runChild(deps: ExecutorDeps, ctx: ExecContext, spec: ChildSpec): Promise<Outcome> {
  const dir = deps.scriptsDir ?? SCRIPTS_DIR;
  const file = join(dir, spec.script);
  if (!existsSync(file)) return skip("no-child-script", `không có tệp scripts/${spec.script}`);
  const src = readFileSync(file, "utf8");
  const lacking = (spec.requires ?? []).filter((r) => !src.includes(r.marker));
  if (lacking.length > 0) return skip("child-contract-missing", `scripts/${spec.script}: ${lacking.map((r) => r.what).join("; ")}`);
  if (ctx.mode === "dry" && !src.includes("DRY_RUN")) return skip("no-dry-path", `scripts/${spec.script} không có cổng DRY_RUN`);
  const tsx = join(dir, "node_modules", ".bin", "tsx");
  if (!existsSync(tsx)) return skip("no-child-toolchain", "thiếu scripts/node_modules/.bin/tsx (chạy npm install trong scripts/)");
  if (!deps.env.BLOCKFROST_KEY) return skip("child-needs-blockfrost-key", "scripts/config.ts đòi BLOCKFROST_KEY; lượt này không có");
  const w = deps.wallets.get(ctx.step.farmer);
  if (!w) return skip("no-seed-in-env", `không có hạt giống cho ${ctx.step.farmer} trong môi trường`);
  let extra: Record<string, string> = {};
  if (spec.prepare) {
    let p: Prepared;
    try {
      p = await spec.prepare(w);
    } catch (e) {
      return { kind: "error", reason: "chain-lookup-failed", detail: errText(e).slice(0, 400) };
    }
    if ("stop" in p) return p.stop;
    extra = p.env;
  }
  const env = childEnv(deps.env, w.seedForSigning(), deps.network, ctx.mode, { ...spec.env, ...extra });
  const r = spawnSync(tsx, [spec.script], {
    cwd: dir,
    env,
    encoding: "utf8",
    timeout: deps.childTimeoutMs ?? 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const run: ChildRun = {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    timedOut: (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
  };
  return spec.interpret ? spec.interpret(run, w) : interpretChild(run.status, `${run.stdout}\n${run.stderr}`, ctx.mode, run.timedOut);
}

function farmerOrThrow(ctx: ExecContext): FarmerProfile {
  if (!ctx.farmer) throw new Error(`bước ${ctx.step.stepId}: không có hồ sơ nông dân ${ctx.step.farmer}`);
  return ctx.farmer;
}

function lookupOf(deps: ExecutorDeps): ChainLookup {
  return deps.lookup ?? providerLookup(deps.access);
}

const VAULT_TX_REQ = { marker: "VAULT_TX_HASH", what: "không nhận VAULT_TX_HASH để chọn vault" };

/** `VAULT_TX_HASH` = tx đang giữ UTxO SỐNG mang NFT vault của nông dân (tra lúc chạy). */
function vaultTxPrepare(deps: ExecutorDeps, ctx: ExecContext): ChildSpec["prepare"] {
  return async () => {
    const unit = ctx.state.vault_nft;
    if (!unit) {
      return { stop: { kind: "error", reason: "farmer-state-missing", detail: `${ctx.step.farmer}: bước mở vault đã qua nhưng sổ không có artifact vault_nft` } };
    }
    const p = pickVaultUtxo(await lookupOf(deps).utxosAtWithUnit(vaultAddressOf(deps.network, unit), unit), unit);
    return p.ok ? { env: { VAULT_TX_HASH: p.txHash } } : { stop: p.outcome };
  };
}

/** `ENGAGE_OUTREF` = UTxO SỐNG của thread nông dân tại địa chỉ `consume` (tra lúc chạy). */
function engagePrepare(deps: ExecutorDeps, ctx: ExecContext, kind: GeneratorKind): ChildSpec["prepare"] {
  return async (w) => {
    const unit = ctx.state.engage_nft ?? null;
    const envHash = deps.env[`CONSUME_SCRIPT_HASH_${kind.toUpperCase()}`]?.trim() || null;
    if (unit !== null && envHash !== null && unit.slice(0, 56) !== envHash) {
      return { stop: { kind: "error", reason: "engage-thread-other-instance", detail: `thread ${unit} thuộc consume ${unit.slice(0, 56)}, môi trường trỏ consume ${envHash}` } };
    }
    const consumeHash = unit?.slice(0, 56) ?? envHash;
    if (consumeHash === null) {
      return { stop: { kind: "error", reason: "farmer-state-missing", detail: `${ctx.step.farmer}: không có engage_nft trong sổ và không có CONSUME_SCRIPT_HASH_${kind.toUpperCase()}` } };
    }
    const utxos = await lookupOf(deps).utxosAt(consumeAddressOf(deps.network, consumeHash));
    const p = pickEngageThread(utxos, w.paymentKeyHash, consumeHash, unit);
    return p.ok ? { env: { ENGAGE_OUTREF: p.outRef } } : { stop: p.outcome };
  };
}

function kindOf(raw: string | undefined, ctx: ExecContext): GeneratorKind {
  const k = raw ?? farmerOrThrow(ctx).generatorKind;
  if (k !== "instant" && k !== "schedule") throw new Error(`bước ${ctx.step.stepId}: loại vault lạ ${String(k)}`);
  return k;
}

function vaultOpenSpec(ctx: ExecContext, kind: GeneratorKind): ChildSpec | Outcome {
  const script = VAULT_OPEN_SCRIPT[kind];
  if (ctx.mutated) return { kind: "error", detail: `${script} không có nút phá — lượt đột biến ghi hỏng có chủ ý` };
  const dep = lampDepositOf(ctx.step.params.lampOildrop);
  if (!dep.ok) return { kind: "error", reason: "plan-param-invalid", detail: dep.reason };
  const profile = ctx.step.params.profile;
  if (profile !== "Ember" && profile !== "Flame" && profile !== "Lantern") {
    return { kind: "error", reason: "plan-param-invalid", detail: `params.profile lạ: ${String(profile)}` };
  }
  return {
    script,
    env: { LAMP_DEPOSIT: dep.value, PROFILE: profile, WRITE_STATE_BOOK: "0" },
    negative: false,
    requires: [{ marker: VAULT_OPEN_CONTRACT_MARKER, what: "chưa in dòng RESULT (hợp đồng scripts/runResult.ts ▸ resultLine, nhánh owner-cred)" }],
    interpret: (run, w) => interpretVaultOpen(run, ctx.mode, w.paymentKeyHash),
  };
}

// ── trong tiến trình ──────────────────────────────────────────────────────────

async function farmerLucid(deps: ExecutorDeps, w: FarmerWallet): Promise<LucidEvolution> {
  const provider = withAikenEvaluator(deps.access.provider, deps.network, { workDir: deps.workDir });
  const lucid = await Lucid(provider, deps.network);
  lucid.selectWallet.fromSeed(w.seedForSigning());
  return lucid;
}

async function didMint(deps: ExecutorDeps, ctx: ExecContext): Promise<Outcome> {
  if (!deps.taad) return skip("no-taad-config", "thiếu --taad-policy/--taad-ref");
  const w = deps.wallets.get(ctx.step.farmer);
  if (!w) return skip("no-seed-in-env", `không có hạt giống cho ${ctx.step.farmer} trong môi trường`);
  const lucid = await farmerLucid(deps, w);
  if ((await lucid.wallet().getUtxos()).length === 0) return { kind: "prereq-missing", detail: "ví nông dân chưa có UTxO nào (chưa được cấp vốn)" };
  const guardians = (ctx.step.params.guardians ?? "").split(",").filter((g) => g.length > 0);
  const rand256 = ctx.step.params.rand256;
  if (!rand256 || !/^[0-9a-f]{64}$/.test(rand256)) return { kind: "error", detail: "params.rand256 thiếu hoặc sai dạng" };
  let built;
  try {
    const taadRef = await refScriptUtxo(deps.access, lucid, deps.taad.ref, deps.taad.policy);
    const anchors = (await deps.access.policyAssetNames(deps.taad.policy)).filter((n) => !n.startsWith(SHARD_PREFIX_HEX));
    built = await buildDidMintTx({
      lucid,
      network: deps.network,
      taadPolicyId: deps.taad.policy,
      taadRefUtxo: taadRef,
      controllerPkh: w.paymentKeyHash,
      devicePkh: w.devicePkh,
      guardians,
      rand256,
      existingAnchorNames: anchors,
      validToMs: Math.floor((Date.now() + 20 * 60_000) / 1000) * 1000,
      metadataMsg: [DID_SIM_LABEL, `farmer:${ctx.step.farmer}`, `step:${ctx.step.stepId}`],
      mutateRand: ctx.mutated,
      localEval: false,
    });
  } catch (e) {
    return outcomeOfError(errText(e));
  }
  if (ctx.mode === "dry") return { kind: "built", fee: built.fee, detail: `did ${built.did} · shard ${built.shard}` };
  try {
    const signed = await lucid.fromTx(built.txCbor).sign.withWallet().complete();
    const txHash = await signed.submit();
    const ok = await lucid.awaitTx(txHash);
    return ok
      ? { kind: "confirmed", txHash, fee: built.fee, detail: `did ${built.did}` }
      : { kind: "submitted-unconfirmed", txHash, fee: built.fee, detail: `did ${built.did}` };
  } catch (e) {
    return outcomeOfError(errText(e));
  }
}

async function fund(deps: ExecutorDeps, ctx: ExecContext): Promise<Outcome> {
  if (!deps.deploySeed) return skip("no-deploy-seed", "bước cấp vốn cần DEPLOY_WALLET_SEED; lượt này không có");
  const w = deps.wallets.get(ctx.step.farmer);
  if (!w) return skip("no-seed-in-env", `không có hạt giống cho ${ctx.step.farmer} trong môi trường`);
  const lovelace = BigInt(ctx.step.params.lovelace ?? "0");
  const oil = BigInt(ctx.step.params.lampOildrop ?? "0");
  const assets: Record<string, bigint> = { lovelace };
  if (oil > 0n) {
    const policy = deps.env.LAMP_POLICY_ID;
    if (!policy || !/^[0-9a-f]{56}$/.test(policy)) return skip("no-lamp-policy", "cấp LAMP cần LAMP_POLICY_ID (sổ triển khai theo mạng)");
    if (deps.network === "Custom") return skip("no-lamp-asset-name", "mạng Custom không có tên tài sản LAMP theo mạng");
    assets[policy + utf8Hex(lampAssetName(deps.network))] = oil;
  }
  try {
    const lucid = await Lucid(deps.access.provider, deps.network);
    lucid.selectWallet.fromSeed(deps.deploySeed);
    const tx = await lucid.newTx().pay.ToAddress(w.address, assets).complete();
    const fee = BigInt(tx.toTransaction().body().fee());
    if (ctx.mode === "dry") return { kind: "built", fee, detail: `cấp ${lovelace} lovelace · ${oil} oildrop` };
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    const ok = await lucid.awaitTx(txHash);
    return ok ? { kind: "confirmed", txHash, fee } : { kind: "submitted-unconfirmed", txHash, fee };
  } catch (e) {
    return outcomeOfError(errText(e));
  }
}

// ── bảng ─────────────────────────────────────────────────────────────────────

/** Tamper: tệp con + biến phá, theo `params.via` / `params.mode` của kế hoạch (plan.ts ▸ TAMPER_MODES). */
function tamperSpec(deps: ExecutorDeps, ctx: ExecContext): ChildSpec {
  const f = farmerOrThrow(ctx);
  const mode = ctx.step.params.mode;
  if (!mode) throw new Error(`bước ${ctx.step.stepId}: tamper thiếu params.mode`);
  const common = { negative: true, requires: [VAULT_TX_REQ], prepare: vaultTxPrepare(deps, ctx) };
  if (ctx.step.params.via === "instant_gen") return { script: "test/instant_only.ts", env: { TAMPER: mode }, ...common };
  if (ctx.step.params.via === "schedule_commit") {
    return {
      script: "test/schedule_commit_only.ts",
      env: { TAMPER: mode, SCHEDULE_LENGTH: String(f.scheduleLength), LAMP_PER_EPOCH: f.lampPerEpochLamp },
      ...common,
    };
  }
  throw new Error(`bước ${ctx.step.stepId}: params.via lạ ${String(ctx.step.params.via)}`);
}

export function buildExecutors(deps: ExecutorDeps): ExecutorTable {
  const child = (make: (ctx: ExecContext) => ChildSpec | Outcome) => async (ctx: ExecContext): Promise<Outcome> => {
    const s = make(ctx);
    return "kind" in s ? s : runChild(deps, ctx, s);
  };
  const table: Record<ActionKind, ((ctx: ExecContext) => Promise<Outcome>) | undefined> = {
    fund: (ctx) => fund(deps, ctx),
    fund_tcarp: async () =>
      skip(
        "fund-lacks-tcarp-leg",
        "bước fund chỉ trả lovelace + LAMP; chưa có chân trả tCARP từ ví deploy (định danh Preprod: PrepaidGen/offchain/src/constants.ts ▸ carpAssetClass)",
      ),
    did_mint: (ctx) => didMint(deps, ctx),
    vault_open_instant: child((ctx) => vaultOpenSpec(ctx, "instant")),
    vault_open_schedule: child((ctx) => vaultOpenSpec(ctx, "schedule")),
    engage_mint: child((ctx) => {
      if (ctx.mutated) return { kind: "error", detail: "mint_engage_only.ts không có nút phá — lượt đột biến ghi hỏng có chủ ý" };
      const kind = kindOf(ctx.step.params.vaultKind, ctx);
      return {
        script: ENGAGE_MINT_SCRIPT,
        env: { VAULT_KIND: kind },
        negative: false,
        requires: [{ marker: ENGAGE_MINT_CONTRACT_MARKER, what: "thread còn ghi owner ByteArray; engage.ts chỉ nhận owner VerificationKey(pkh)" }],
        interpret: (run, w) => interpretEngageMint(run, ctx.mode, w.paymentKeyHash, kind),
      };
    }),
    schedule_commit: child((ctx) => {
      const f = farmerOrThrow(ctx);
      return {
        script: "test/schedule_commit_only.ts",
        env: {
          SCHEDULE_LENGTH: ctx.step.params.scheduleLength ?? String(f.scheduleLength),
          LAMP_PER_EPOCH: ctx.step.params.lampPerEpochLamp ?? f.lampPerEpochLamp,
          ...mutationEnv(ctx.mutated),
        },
        negative: ctx.mutated,
        requires: [VAULT_TX_REQ],
        prepare: vaultTxPrepare(deps, ctx),
      };
    }),
    tamper: child((ctx) => tamperSpec(deps, ctx)),
    instant_gen: child((ctx) => ({
      script: "test/instant_only.ts",
      env: mutationEnv(ctx.mutated),
      negative: ctx.mutated,
      requires: [VAULT_TX_REQ],
      prepare: vaultTxPrepare(deps, ctx),
    })),
    // Dry: childEnv đặt DRY_RUN=1; tệp con thiếu cổng DRY_RUN thì runChild trả `skip no-dry-path`.
    schedule_fire: child((ctx) => ({
      script: "test/schedule_fire_only.ts",
      env: mutationEnv(ctx.mutated),
      negative: ctx.mutated,
      requires: [VAULT_TX_REQ],
      prepare: vaultTxPrepare(deps, ctx),
    })),
    consume: child((ctx) => {
      if (ctx.mutated) return { kind: "error", detail: "consume_only.ts không có nút phá — lượt đột biến ghi hỏng có chủ ý" };
      const kind = kindOf(ctx.step.params.vaultKind, ctx);
      return {
        script: "test/consume_only.ts",
        env: { VAULT_KIND: kind, op_type: ctx.step.params.opType ?? "", op_count: ctx.step.params.opCount ?? "" },
        negative: false,
        requires: [{ marker: CONSUME_ENGAGE_MARKER, what: "không nhận ENGAGE_OUTREF (thread của chính ví ký) — sẽ đọc thread của ví deploy trong sổ" }],
        prepare: engagePrepare(deps, ctx, kind),
      };
    }),
    prepaid_lock: async () =>
      skip(
        "no-prepaid-lock-builder",
        "chưa có tệp con dựng tx khoá tCARP vào PrepaidGen (scripts/test/ không có; PrepaidGen/offchain/src/prepaid.ts chỉ có hàm luật)",
      ),
    rest: undefined, // runner.ts tự ghi `scripted-rest`
    beacon_inversion: async () => skip("keeper-responsibility", "việc của keeper (beacon backing), không phải của nông dân"),
  };
  return table;
}
