// Tiến trình con GIẢ: một thư mục `scripts/` dựng tạm, `node_modules/.bin/tsx` là một kịch bản sh
// chạy tệp "ts" như kịch bản sh. Tệp con giả ghi các biến nó NHẬN vào `$FAKE_DUMP`, in
// `$FAKE_OUT`, thoát `$FAKE_EXIT`. Không mạng, không chuỗi: tra UTxO đi qua `lookup` giả.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Constr, Data, generateSeedPhrase, type UTxO } from "@lucid-evolution/lucid";
import { beforeEach, describe, expect, it } from "vitest";

import { chainAccess, scriptEnterpriseAddress } from "../src/chain.ts";
import { buildExecutors, childEnv, type ChainLookup, type ExecutorDeps } from "../src/executors.ts";
import type { ActionKind } from "../src/plan.ts";
import type { ExecContext, Mode } from "../src/runner.ts";
import { walletFromSeedValue } from "../src/wallets.ts";
import { plan } from "./helpers.ts";

const ALL_MARKERS = "# DRY_RUN resultLine VAULT_TX_HASH ENGAGE_OUTREF VerificationKey";
// Thân tệp giả KHÔNG được chứa nguyên văn tên dấu hợp đồng (DRY_RUN, VAULT_TX_HASH, …) — không
// thì mọi tệp giả đều "có dấu" và ca thiếu-dấu xanh vì lý do rỗng. Nên tên biến viết dạng lớp ký tự.
const BODY = [
  `env | grep -E '^(V[A]ULT_TX_HASH|E[N]GAGE_OUTREF|D[R]Y_RUN|LAMP_DEPOSIT|PROFILE|WRITE_STATE_BOOK|VAULT_KIND|TAMPER)=' > "$FAKE_DUMP"`,
  `[ -n "$WALLET_SEED" ] && echo HAS_SEED=yes >> "$FAKE_DUMP"`,
  `printf '%s\\n' "$FAKE_OUT"`,
  `exit "\${FAKE_EXIT:-0}"`,
].join("\n");
const SCRIPTS = [
  "deploy/05_create_instant_vault.ts", "deploy/07_create_schedule_vault.ts", "test/instant_only.ts",
  "test/schedule_commit_only.ts", "test/schedule_fire_only.ts", "test/mint_engage_only.ts", "test/consume_only.ts",
];

function fakeScriptsDir(markers: (script: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), "farmer-fake-scripts-"));
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  mkdirSync(join(dir, "deploy"));
  mkdirSync(join(dir, "test"));
  const tsx = join(dir, "node_modules", ".bin", "tsx");
  writeFileSync(tsx, '#!/bin/sh\nexec /bin/sh "$@"\n');
  chmodSync(tsx, 0o755);
  for (const s of SCRIPTS) writeFileSync(join(dir, s), `${markers(s)}\n${BODY}\n`);
  return dir;
}

const p = plan("spawn-1", 17);
const stepOf = (a: ActionKind) => {
  const s = p.steps.find((x) => x.action === a);
  if (!s) throw new Error(`kế hoạch không có ${a}`);
  return s;
};
const wallets = new Map(p.farmers.map((f) => [f.farmer, walletFromSeedValue(f.farmer, generateSeedPhrase(), "Preprod")] as const));
const pkhOf = (farmer: string) => wallets.get(farmer)!.paymentKeyHash;

const VAULT_NFT = "ef".repeat(28) + "01".repeat(32);
const LIVE_TX = "aa".repeat(32);
const CONSUME = "c0".repeat(28);
const THREAD = CONSUME + "02".repeat(32);

let dump: string;
let calls: { fn: string; args: string[] }[];
let lookupAnswer: { byUnit: UTxO[]; at: UTxO[]; throws?: string };

function deps(scriptsDir: string, env: Record<string, string> = {}): ExecutorDeps {
  const lookup: ChainLookup = {
    utxosAt: async (a) => {
      calls.push({ fn: "utxosAt", args: [a] });
      if (lookupAnswer.throws) throw new Error(lookupAnswer.throws);
      return lookupAnswer.at;
    },
    utxosAtWithUnit: async (a, u) => {
      calls.push({ fn: "utxosAtWithUnit", args: [a, u] });
      if (lookupAnswer.throws) throw new Error(lookupAnswer.throws);
      return lookupAnswer.byUnit;
    },
  };
  return {
    network: "Preprod", access: chainAccess("Preprod", {}), env: { BLOCKFROST_KEY: "fake", FAKE_DUMP: dump, ...env },
    wallets, workDir: "/nonexistent", taad: null, deploySeed: null, scriptsDir, lookup,
  };
}

function ctx(a: ActionKind, mode: Mode, state: Record<string, string> = {}): ExecContext {
  const step = stepOf(a);
  return { mode, plan: p, step, farmer: p.farmers.find((f) => f.farmer === step.farmer) ?? null, mutated: false, state };
}

function dumped(): Record<string, string> {
  return Object.fromEntries(readFileSync(dump, "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

const resultLine = (pkh: string, dry: boolean) =>
  `RESULT ${JSON.stringify({ vault_outref: `${LIVE_TX}#0`, vault_nft: VAULT_NFT, owner: { type: "key", hash: pkh }, dry_run: dry })}`;
const vaultUtxo = (): UTxO => ({ txHash: LIVE_TX, outputIndex: 1, address: "addr_test", assets: { lovelace: 2n, [VAULT_NFT]: 1n } });

beforeEach(() => {
  dump = join(mkdtempSync(join(tmpdir(), "farmer-dump-")), "env.txt");
  calls = [];
  lookupAnswer = { byUnit: [vaultUtxo()], at: [] };
});

describe("vault_open qua deploy/05|07 (tiến trình con giả)", () => {
  const dir = fakeScriptsDir(() => ALL_MARKERS);
  it("dry: env LAMP_DEPOSIT (LAMP nguyên) · PROFILE · WRITE_STATE_BOOK=0 · DRY_RUN=1; RESULT ⟹ built + artifacts; biến rác ở gốc không lọt", async () => {
    const s = stepOf("vault_open_instant");
    const d = deps(dir, { FAKE_OUT: `✔ DRY RUN\n${resultLine(pkhOf(s.farmer), true)}`, VAULT_TX_HASH: "stale", WRITE_STATE_BOOK: "1" });
    const o = await buildExecutors(d).vault_open_instant!(ctx("vault_open_instant", "dry"));
    expect(o).toMatchObject({ kind: "built", artifacts: { vault_nft: VAULT_NFT, vault_outref: `${LIVE_TX}#0` } });
    const e = dumped();
    expect(e.LAMP_DEPOSIT).toBe((BigInt(s.params.lampOildrop!) / 1_000_000n).toString());
    expect(e.PROFILE).toBe(s.params.profile);
    expect(e.WRITE_STATE_BOOK).toBe("0");
    expect(e.DRY_RUN).toBe("1");
    expect(e.VAULT_TX_HASH).toBeUndefined();
    expect(e.HAS_SEED).toBe("yes");
  });
  it("live: owner.hash ≠ pkh nông dân ⟹ error child-owner-mismatch; thiếu RESULT ⟹ child-result-malformed", async () => {
    const d = deps(dir, { FAKE_OUT: resultLine("12".repeat(28), false) });
    expect(await buildExecutors(d).vault_open_schedule!(ctx("vault_open_schedule", "live"))).toMatchObject({ kind: "error", reason: "child-owner-mismatch" });
    const d2 = deps(dir, { FAKE_OUT: "✅ vault created" });
    expect(await buildExecutors(d2).vault_open_schedule!(ctx("vault_open_schedule", "live"))).toMatchObject({ kind: "error", reason: "child-result-malformed" });
  });
  it("tệp con chưa có hợp đồng RESULT ⟹ skip child-contract-missing, KHÔNG chạy", async () => {
    const old = fakeScriptsDir((s) => (s.startsWith("deploy/") ? "# DRY_RUN" : ALL_MARKERS));
    const o = await buildExecutors(deps(old, { FAKE_OUT: "x" })).vault_open_instant!(ctx("vault_open_instant", "dry"));
    expect(o).toMatchObject({ kind: "skip", reason: "child-contract-missing" });
    expect(existsSync(dump)).toBe(false);
  });
});

describe("VAULT_TX_HASH = tx đang giữ NFT vault (tra lúc chạy)", () => {
  const dir = fakeScriptsDir(() => ALL_MARKERS);
  it("instant_gen: tra đúng địa chỉ enterprise của policy NFT, truyền tx SỐNG", async () => {
    const d = deps(dir, { FAKE_OUT: "✔ DRY RUN: tx dựng xong" });
    const o = await buildExecutors(d).instant_gen!(ctx("instant_gen", "dry", { vault_nft: VAULT_NFT, vault_outref: `${"bb".repeat(32)}#0` }));
    expect(o.kind).toBe("built");
    expect(dumped().VAULT_TX_HASH).toBe(LIVE_TX);
    expect(calls).toEqual([{ fn: "utxosAtWithUnit", args: [scriptEnterpriseAddress("Preprod", VAULT_NFT.slice(0, 56)), VAULT_NFT] }]);
  });
  it("schedule_fire dry: DRY_RUN=1 + VAULT_TX_HASH", async () => {
    const d = deps(dir, { FAKE_OUT: "✔ DRY RUN: tx dựng xong" });
    expect((await buildExecutors(d).schedule_fire!(ctx("schedule_fire", "dry", { vault_nft: VAULT_NFT }))).kind).toBe("built");
    expect(dumped()).toMatchObject({ DRY_RUN: "1", VAULT_TX_HASH: LIVE_TX });
  });
  it("vault chưa lên chuỗi ⟹ prereq-missing, không chạy; trạng thái thiếu vault_nft ⟹ farmer-state-missing; tra lỗi ⟹ chain-lookup-failed", async () => {
    lookupAnswer = { byUnit: [], at: [] };
    const t = buildExecutors(deps(dir, { FAKE_OUT: "x" }));
    expect(await t.instant_gen!(ctx("instant_gen", "dry", { vault_nft: VAULT_NFT }))).toMatchObject({ kind: "prereq-missing" });
    expect(existsSync(dump)).toBe(false);
    expect(await t.instant_gen!(ctx("instant_gen", "dry", {}))).toMatchObject({ kind: "error", reason: "farmer-state-missing" });
    lookupAnswer = { byUnit: [], at: [], throws: "Could not fetch UTxOs from Blockfrost. Try again." };
    expect(await t.schedule_commit!(ctx("schedule_commit", "dry", { vault_nft: VAULT_NFT }))).toMatchObject({ kind: "error", reason: "chain-lookup-failed" });
  });
  it("tệp fire không có cổng DRY_RUN ⟹ skip no-dry-path (chỉ ở dry); thiếu VAULT_TX_HASH ⟹ child-contract-missing", async () => {
    const noDry = fakeScriptsDir((s) => (s === "test/schedule_fire_only.ts" ? "# VAULT_TX_HASH" : ALL_MARKERS));
    expect(await buildExecutors(deps(noDry)).schedule_fire!(ctx("schedule_fire", "dry", { vault_nft: VAULT_NFT }))).toMatchObject({ kind: "skip", reason: "no-dry-path" });
    const noPin = fakeScriptsDir((s) => (s === "test/instant_only.ts" ? "# DRY_RUN" : ALL_MARKERS));
    expect(await buildExecutors(deps(noPin)).instant_gen!(ctx("instant_gen", "dry", { vault_nft: VAULT_NFT }))).toMatchObject({ kind: "skip", reason: "child-contract-missing" });
    const noEngage = fakeScriptsDir((s) => (s === "test/consume_only.ts" ? "# DRY_RUN" : ALL_MARKERS));
    expect(await buildExecutors(deps(noEngage)).consume!(ctx("consume", "dry", { engage_nft: THREAD }))).toMatchObject({ kind: "skip", reason: "child-contract-missing" });
    expect(existsSync(dump)).toBe(false);
  });
});

describe("engage_mint → consume: ENGAGE_OUTREF = thread SỐNG của nông dân", () => {
  const dir = fakeScriptsDir(() => ALL_MARKERS);
  const thread = (pkh: string, tx: string): UTxO => ({
    txHash: tx, outputIndex: 3, address: "addr_test", assets: { lovelace: 2_000_000n, [THREAD]: 1n },
    datum: Data.to(new Constr(0, [new Constr(0, [pkh]), 0n, 0n, "", 0n])),
  });
  it("engage_mint dry ⟹ artifacts engage_nft từ dòng 'thread unit:'", async () => {
    const s = stepOf("engage_mint");
    const d = deps(dir, { FAKE_OUT: `owner pkh:     ${pkhOf(s.farmer)}\nthread unit:   ${THREAD}\n✔ DRY RUN: tx dựng xong` });
    expect(await buildExecutors(d).engage_mint!(ctx("engage_mint", "dry"))).toMatchObject({ kind: "built", artifacts: { engage_nft: THREAD } });
    expect(dumped().VAULT_KIND).toBe(s.params.vaultKind);
  });
  it("consume: tra địa chỉ consume suy từ policy thread, truyền ENGAGE_OUTREF của pkh nông dân", async () => {
    const s = stepOf("consume");
    lookupAnswer = { byUnit: [], at: [thread(pkhOf(s.farmer), "dd".repeat(32))] };
    const d = deps(dir, { FAKE_OUT: "✔ DRY RUN: tx dựng xong" });
    expect((await buildExecutors(d).consume!(ctx("consume", "dry", { engage_nft: THREAD }))).kind).toBe("built");
    expect(dumped().ENGAGE_OUTREF).toBe(`${"dd".repeat(32)}#3`);
    expect(calls).toEqual([{ fn: "utxosAt", args: [scriptEnterpriseAddress("Preprod", CONSUME)] }]);
  });
  it("consume: thread thuộc instance consume khác môi trường ⟹ error; thread của người khác ⟹ error owner-mismatch", async () => {
    const s = stepOf("consume");
    const K = s.params.vaultKind!.toUpperCase();
    const d = deps(dir, { [`CONSUME_SCRIPT_HASH_${K}`]: "99".repeat(28) });
    expect(await buildExecutors(d).consume!(ctx("consume", "dry", { engage_nft: THREAD }))).toMatchObject({ kind: "error", reason: "engage-thread-other-instance" });
    lookupAnswer = { byUnit: [], at: [thread("12".repeat(28), "dd".repeat(32))] };
    expect(await buildExecutors(deps(dir)).consume!(ctx("consume", "dry", { engage_nft: THREAD }))).toMatchObject({ kind: "error", reason: "engage-thread-owner-mismatch" });
    expect(existsSync(dump)).toBe(false);
  });
});

describe("môi trường tiến trình con — biến do executor sở hữu", () => {
  it("VAULT_TX_HASH / ENGAGE_OUTREF / WRITE_STATE_BOOK ở gốc KHÔNG lọt; extra thì có", () => {
    const e = childEnv({ VAULT_TX_HASH: "stale", ENGAGE_OUTREF: "stale", WRITE_STATE_BOOK: "1", PATH: "/bin" }, "s", "Preprod", "live", { VAULT_TX_HASH: "fresh" });
    expect(e.VAULT_TX_HASH).toBe("fresh");
    expect(e.ENGAGE_OUTREF).toBeUndefined();
    expect(e.WRITE_STATE_BOOK).toBeUndefined();
    rmSync(dump, { force: true });
  });
});
