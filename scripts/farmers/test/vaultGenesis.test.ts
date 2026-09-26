import { describe, expect, it } from "vitest";

import { checkVaultOpen, interpretVaultOpen, lampDepositOf, parseVaultOpenResult, pickVaultUtxo } from "../src/vaultGenesis.ts";

const PKH = "ab".repeat(28);
const TX = "cd".repeat(32);
const NFT = "ef".repeat(28) + "01".repeat(32);
const result = (over: Record<string, unknown> = {}) =>
  `RESULT ${JSON.stringify({ vault_outref: `${TX}#0`, vault_nft: NFT, owner: { type: "key", hash: PKH }, dry_run: true, ...over })}`;
const run = (stdout: string, status: number | null = 0) => ({ status, stdout, stderr: "", timedOut: false });

describe("dòng RESULT của deploy/05|07", () => {
  it("đúng hình dạng ⟹ đọc được; phải là dòng CUỐI (dòng trống sau nó được bỏ qua)", () => {
    const p = parseVaultOpenResult(`log\n✔ DRY RUN: ...\n${result()}\n\n`);
    expect(p).toMatchObject({ ok: true, value: { vault_outref: `${TX}#0`, vault_nft: NFT, dry_run: true } });
  });
  it("thiếu RESULT · RESULT không ở cuối · JSON hỏng · khoá lạ · thiếu khoá · hình dạng sai ⟹ không đọc", () => {
    expect(parseVaultOpenResult("log\nxong\n").ok).toBe(false);
    expect(parseVaultOpenResult(`${result()}\ndòng khác\n`).ok).toBe(false);
    // Dòng cuối không mang tiền tố RESULT nhưng phần sau 7 ký tự đầu là JSON hợp lệ: chỉ cổng tiền tố bắt được.
    expect(parseVaultOpenResult(`log\nXXXXXXX${result().slice("RESULT ".length)}\n`).ok).toBe(false);
    expect(parseVaultOpenResult('RESULT {"vault_outref":').ok).toBe(false);
    expect(parseVaultOpenResult(result({ extra: 1 })).ok).toBe(false);
    expect(parseVaultOpenResult(`RESULT ${JSON.stringify({ vault_outref: `${TX}#0`, vault_nft: NFT, owner: { type: "key", hash: PKH } })}`).ok).toBe(false);
    expect(parseVaultOpenResult(result({ vault_outref: `${TX.toUpperCase()}#0` })).ok).toBe(false);
    expect(parseVaultOpenResult(result({ vault_nft: "ef".repeat(28) })).ok).toBe(false);
    expect(parseVaultOpenResult(result({ owner: { type: "key", hash: PKH, x: 1 } })).ok).toBe(false);
    expect(parseVaultOpenResult(result({ dry_run: "true" })).ok).toBe(false);
  });
  it("owner ≠ pkh nông dân ⟹ lệch; owner script ⟹ lệch; dry_run lệch chế độ ⟹ lệch", () => {
    const v = (over: Record<string, unknown>) => {
      const p = parseVaultOpenResult(result(over));
      if (!p.ok) throw new Error(p.reason);
      return p.value;
    };
    expect(checkVaultOpen(v({}), { pkh: PKH, mode: "dry" })).toBeNull();
    expect(checkVaultOpen(v({ owner: { type: "key", hash: "12".repeat(28) } }), { pkh: PKH, mode: "dry" })?.reason).toBe("child-owner-mismatch");
    expect(checkVaultOpen(v({ owner: { type: "script", hash: PKH } }), { pkh: PKH, mode: "dry" })?.reason).toBe("child-owner-mismatch");
    expect(checkVaultOpen(v({}), { pkh: PKH, mode: "live" })?.reason).toBe("child-result-malformed");
  });
  it("interpretVaultOpen: dry ⟹ built + artifacts; live ⟹ confirmed tx của outref; thoát 1 mà có RESULT ⟹ error", () => {
    expect(interpretVaultOpen(run(result()), "dry", PKH)).toMatchObject({ kind: "built", artifacts: { vault_outref: `${TX}#0`, vault_nft: NFT } });
    expect(interpretVaultOpen(run(`   TX hash:   ${TX}\n${result({ dry_run: false })}`), "live", PKH)).toMatchObject({ kind: "confirmed", txHash: TX });
    expect(interpretVaultOpen(run(`   TX hash:   ${"99".repeat(32)}\n${result({ dry_run: false })}`), "live", PKH)).toMatchObject({ kind: "error", reason: "child-result-malformed" });
    expect(interpretVaultOpen(run(result(), 1), "dry", PKH)).toMatchObject({ kind: "error", reason: "child-result-malformed" });
    expect(interpretVaultOpen(run("Error: boom", 1), "dry", PKH).kind).toBe("error");
    expect(interpretVaultOpen(run("không có RESULT"), "dry", PKH)).toMatchObject({ kind: "error", reason: "child-result-malformed" });
    expect(interpretVaultOpen(run(result({ owner: { type: "key", hash: "12".repeat(28) } })), "dry", PKH)).toMatchObject({ kind: "error", reason: "child-owner-mismatch" });
  });
  it("LAMP_DEPOSIT: oildrop chia hết 10^6 ⟹ LAMP nguyên; lẻ / 0 / vắng ⟹ từ chối", () => {
    expect(lampDepositOf("25000000000")).toEqual({ ok: true, value: "25000" });
    expect(lampDepositOf("25000000001").ok).toBe(false);
    expect(lampDepositOf("0").ok).toBe(false);
    expect(lampDepositOf(undefined).ok).toBe(false);
  });
  it("pickVaultUtxo: 0 ⟹ prereq-missing; 1 ⟹ tx; 2 hoặc lượng ≠ 1 ⟹ error", () => {
    const u = (tx: string, q = 1n) => ({ txHash: tx, outputIndex: 0, address: "addr", assets: { lovelace: 2n, [NFT]: q } });
    expect(pickVaultUtxo([], NFT)).toMatchObject({ ok: false, outcome: { kind: "prereq-missing" } });
    expect(pickVaultUtxo([u(TX)], NFT)).toMatchObject({ ok: true, txHash: TX });
    expect(pickVaultUtxo([u(TX), u("11".repeat(32))], NFT)).toMatchObject({ ok: false, outcome: { kind: "error", reason: "vault-nft-not-unique" } });
    expect(pickVaultUtxo([u(TX, 2n)], NFT)).toMatchObject({ ok: false, outcome: { kind: "error" } });
  });
});
