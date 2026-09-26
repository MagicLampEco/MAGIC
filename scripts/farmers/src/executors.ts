// scripts/farmers/src/executors.ts — bảng executor cho runner: mỗi hành động của kế hoạch →
// một hàm trả `Outcome`. Chỗ nào CHƯA dựng được thì trả `skip` kèm mã lý do + con trỏ, không
// bao giờ bỏ im lặng (runner.ts ▸ statusOf dịch `skip` thành dòng `skip` trong sổ).
//
// Ba đường thực thi:
//   1. trong tiến trình — `did_mint` (did.ts ▸ buildDidMintTx, đánh giá bằng aiken) và `fund`;
//   2. tiến trình con — `engage_mint`, `instant_gen`, `schedule_commit`, `consume`, `tamper`,
//      `schedule_fire` (live): chạy `scripts/test/<x>_only.ts` với ví của CHÍNH nông dân;
//   3. `skip` có lý do — mọi thứ còn lại.
//
// Hạt giống: chỉ đi vào (a) `selectWallet.fromSeed` trong tiến trình này, (b) biến
// `WALLET_SEED` của đúng MỘT tiến trình con. Không in, không ghi vào sổ.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Lucid, type LucidEvolution, type Network } from "@lucid-evolution/lucid";

import { lampAssetName } from "../../../ProtocolUtils/src/index.ts";
import { classifyBuildError, refScriptUtxo, withAikenEvaluator, type ChainAccess } from "./chain.ts";
import { DID_SIM_LABEL, SHARD_PREFIX_HEX, buildDidMintTx, utf8Hex } from "./did.ts";
import type { ActionKind, FarmerProfile } from "./plan.ts";
import type { ExecContext, ExecutorTable, Outcome } from "./runner.ts";
import type { FarmerWallet } from "./wallets.ts";
import { VAULT_GENESIS_STATUS } from "./vaultGenesis.ts";

/** Thư mục `scripts/` của kho — nơi tiến trình con chạy. */
export const SCRIPTS_DIR = fileURLToPath(new URL("../../", import.meta.url));

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
}

const skip = (reason: string, detail: string): Outcome => ({ kind: "skip", reason, detail });

/** Nút phá chung của các tệp con có nó: bỏ chữ ký chủ vault ⟹ validator phải từ chối. */
const mutationEnv = (mutated: boolean): Record<string, string> => (mutated ? { SKIP_OWNER_SIG: "1" } : {});

function errText(e: unknown): string {
  return String((e as Error)?.message ?? e);
}

/** Lỗi dựng/gửi → kết cục. `funds` = ví chưa đủ tiền ⟹ điều kiện tiên quyết chưa có. */
function outcomeOfError(msg: string): Outcome {
  const cls = classifyBuildError(msg);
  if (cls === "script") return { kind: "rejected", byScript: true, detail: msg.slice(0, 400) };
  if (cls === "funds") return { kind: "prereq-missing", detail: `ví chưa đủ tiền: ${msg.slice(0, 300)}` };
  return { kind: "error", detail: msg.slice(0, 400) };
}

// ── tiến trình con ────────────────────────────────────────────────────────────

interface ChildSpec {
  script: string; // tên tệp trong scripts/test/
  env: Record<string, string>;
  negative: boolean; // lượt phá (TAMPER hoặc SKIP_OWNER_SIG) — tệp con tự in "REJECTED (as expected…"
}

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
    if (k === "DRY_RUN" || k === "TAMPER" || k === "SKIP_OWNER_SIG") continue;
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

const TX_HASH_RE = /(?:TX hash:|Đã gửi:)\s*([0-9a-f]{64})/;

/** Đọc kết cục của một tiến trình con theo quy ước chung của `scripts/test/*_only.ts`. */
export function interpretChild(status: number | null, text: string, mode: ExecContext["mode"], timedOut: boolean): Outcome {
  const tail = text.replace(/\s+/g, " ").trim().slice(-400);
  if (timedOut) return { kind: "error", detail: `tiến trình con quá hạn: ${tail}` };
  const hash = TX_HASH_RE.exec(text)?.[1] ?? null;
  const rej = /REJECTED \(as expected[^\n]*\n[\s\S]*?Reason:\s*([^\n]*)/.exec(text);
  if (rej) return { kind: "rejected", byScript: classifyBuildError(rej[1] ?? "") === "script", detail: (rej[1] ?? "").slice(0, 400) };
  // Thoát 3 = lượt phá LỌT (dry: qua validator; live: đã gửi).
  if (status === 3) {
    if (mode === "dry") return { kind: "built", fee: null, detail: `tamper qua validator: ${tail}` };
    return hash ? { kind: "confirmed", txHash: hash, fee: null, detail: tail } : { kind: "submitted-unconfirmed", txHash: null, fee: null, detail: tail };
  }
  if (status === 0) {
    if (/DRY RUN: tx dựng xong/.test(text)) return { kind: "built", fee: null, detail: tail };
    if (mode === "live" && hash) return { kind: "confirmed", txHash: hash, fee: null, detail: tail };
    return { kind: "error", detail: `thoát 0 mà không có dấu hiệu kết cục nào: ${tail}` };
  }
  if (/not found|không thấy|không tìm thấy/i.test(text) && /vault|utxo|engage|thread|schedule/i.test(text)) {
    return { kind: "prereq-missing", detail: tail };
  }
  return outcomeOfError(tail);
}

function runChild(deps: ExecutorDeps, ctx: ExecContext, spec: ChildSpec): Outcome {
  const dir = deps.scriptsDir ?? SCRIPTS_DIR;
  const file = join(dir, "test", spec.script);
  if (!existsSync(file)) return skip("no-child-script", `không có tệp scripts/test/${spec.script}`);
  if (ctx.mode === "dry" && !readFileSync(file, "utf8").includes("DRY_RUN")) {
    return skip("no-dry-path", `scripts/test/${spec.script} không có cổng DRY_RUN`);
  }
  const tsx = join(dir, "node_modules", ".bin", "tsx");
  if (!existsSync(tsx)) return skip("no-child-toolchain", "thiếu scripts/node_modules/.bin/tsx (chạy npm install trong scripts/)");
  if (!deps.env.BLOCKFROST_KEY) return skip("child-needs-blockfrost-key", "scripts/config.ts đòi BLOCKFROST_KEY; lượt này không có");
  const w = deps.wallets.get(ctx.step.farmer);
  if (!w) return skip("no-seed-in-env", `không có hạt giống cho ${ctx.step.farmer} trong môi trường`);
  const env = childEnv(deps.env, w.seedForSigning(), deps.network, ctx.mode, spec.env);
  const r = spawnSync(tsx, [join("test", spec.script)], {
    cwd: dir,
    env,
    encoding: "utf8",
    timeout: deps.childTimeoutMs ?? 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return interpretChild(r.status, `${r.stdout ?? ""}\n${r.stderr ?? ""}`, ctx.mode, timedOut);
}

function farmerOrThrow(ctx: ExecContext): FarmerProfile {
  if (!ctx.farmer) throw new Error(`bước ${ctx.step.stepId}: không có hồ sơ nông dân ${ctx.step.farmer}`);
  return ctx.farmer;
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
function tamperSpec(ctx: ExecContext): ChildSpec {
  const f = farmerOrThrow(ctx);
  const mode = ctx.step.params.mode;
  if (!mode) throw new Error(`bước ${ctx.step.stepId}: tamper thiếu params.mode`);
  if (ctx.step.params.via === "instant_gen") return { script: "instant_only.ts", env: { TAMPER: mode }, negative: true };
  if (ctx.step.params.via === "schedule_commit") {
    return {
      script: "schedule_commit_only.ts",
      env: { TAMPER: mode, SCHEDULE_LENGTH: String(f.scheduleLength), LAMP_PER_EPOCH: f.lampPerEpochLamp },
      negative: true,
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
      skip("no-tcarp-funding-builder", "chưa có bộ dựng cấp tCARP trong bộ chạy (định danh tCARP: PrepaidGen/offchain/src/constants.ts ▸ carpAssetClass)"),
    did_mint: (ctx) => didMint(deps, ctx),
    vault_open_instant: async () => skip("no-vault-genesis-builder", VAULT_GENESIS_STATUS),
    vault_open_schedule: async () => skip("no-vault-genesis-builder", VAULT_GENESIS_STATUS),
    engage_mint: child((ctx) =>
      ctx.mutated
        ? { kind: "error", detail: "mint_engage_only.ts không có nút phá — lượt đột biến ghi hỏng có chủ ý" }
        : { script: "mint_engage_only.ts", env: { VAULT_KIND: farmerOrThrow(ctx).generatorKind }, negative: false },
    ),
    schedule_commit: child((ctx) => {
      const f = farmerOrThrow(ctx);
      return {
        script: "schedule_commit_only.ts",
        env: {
          SCHEDULE_LENGTH: ctx.step.params.scheduleLength ?? String(f.scheduleLength),
          LAMP_PER_EPOCH: ctx.step.params.lampPerEpochLamp ?? f.lampPerEpochLamp,
          ...mutationEnv(ctx.mutated),
        },
        negative: ctx.mutated,
      };
    }),
    tamper: child(tamperSpec),
    instant_gen: child((ctx) => ({ script: "instant_only.ts", env: mutationEnv(ctx.mutated), negative: ctx.mutated })),
    schedule_fire: child((ctx) =>
      ctx.mode === "dry"
        ? skip("no-dry-path", "không có đường dry (scripts/test/schedule_fire_only.ts không có cổng DRY_RUN)")
        : { script: "schedule_fire_only.ts", env: mutationEnv(ctx.mutated), negative: ctx.mutated },
    ),
    consume: child((ctx) =>
      ctx.mutated
        ? { kind: "error", detail: "consume_only.ts không có nút phá — lượt đột biến ghi hỏng có chủ ý" }
        : {
            script: "consume_only.ts",
            env: {
              VAULT_KIND: ctx.step.params.vaultKind ?? farmerOrThrow(ctx).generatorKind,
              op_type: ctx.step.params.opType ?? "",
              op_count: ctx.step.params.opCount ?? "",
            },
            negative: false,
          },
    ),
    prepaid_lock: async () => skip("no-tx-builder", "không có bộ dựng tx (PrepaidGen/offchain/src/prepaid.ts chỉ có hàm luật, không dựng tx)"),
    rest: undefined, // runner.ts tự ghi `scripted-rest`
    beacon_inversion: async () => skip("keeper-responsibility", "việc của keeper (beacon backing), không phải của nông dân"),
  };
  return table;
}
