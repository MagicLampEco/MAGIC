// scripts/farmers/src/chain.ts — nhà cung cấp chuỗi cho RUNNER (không dùng cho observer).
//
// Có khoá Blockfrost trong môi trường ⟹ Blockfrost. Không có ⟹ Koios công khai (Preprod),
// đủ để dựng khô một tx mà không cần khoá nào. Mã ở đây chỉ nhận GIÁ TRỊ khoá qua biến
// `BLOCKFROST_KEY`; nó không biết giá trị đó đến từ đâu.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  Blockfrost,
  CML,
  Koios,
  Lucid,
  SLOT_CONFIG_NETWORK,
  applyDoubleCborEncoding,
  credentialToAddress,
  scriptHashToCredential,
  utxoToTransactionInput,
  utxoToTransactionOutput,
  validatorToScriptHash,
  type EvalRedeemer,
  type LucidEvolution,
  type Network,
  type Provider,
  type Script,
  type UTxO,
} from "@lucid-evolution/lucid";

/** Địa chỉ ENTERPRISE của một script — dạng mà `deploy/05|07` (vault) và `mint_engage_only.ts`
 *  (thread consume) dùng: `credentialToAddress(NETWORK, scriptHashToCredential(hash))`. */
export function scriptEnterpriseAddress(network: Network, scriptHash: string): string {
  if (!/^[0-9a-f]{56}$/.test(scriptHash)) throw new Error(`script hash phải 56 hex, nhận "${scriptHash}"`);
  return credentialToAddress(network, scriptHashToCredential(scriptHash));
}

export interface ChainAccess {
  label: "blockfrost" | "koios";
  provider: Provider;
  network: Network;
  /** Tên tài sản (hex) dưới một policy, kèm số lượng đang lưu hành. */
  policyAssetNames(policy: string): Promise<string[]>;
  /** Phí (lovelace) của một tx đã vào khối. */
  feeOf(txHash: string): Promise<bigint>;
  lucid(): Promise<LucidEvolution>;
}

const KOIOS: Partial<Record<Network, string>> = {
  Preprod: "https://preprod.koios.rest/api/v1",
  Preview: "https://preview.koios.rest/api/v1",
};

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} tại ${new URL(url).pathname}`);
  return res.json();
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} tại ${new URL(url).pathname}`);
  return res.json();
}

export function chainAccess(network: Network, env: Record<string, string | undefined>): ChainAccess {
  const key = env.BLOCKFROST_KEY?.trim();
  if (key) {
    const base = `https://cardano-${network.toLowerCase()}.blockfrost.io/api/v0`;
    const provider = new Blockfrost(base, key);
    const h = { project_id: key };
    return {
      label: "blockfrost",
      provider,
      network,
      async policyAssetNames(policy) {
        const out: string[] = [];
        for (let page = 1; page < 100; page++) {
          let rows: { asset: string; quantity: string }[];
          try {
            rows = (await getJson(`${base}/assets/policy/${policy}?page=${page}`, h)) as { asset: string; quantity: string }[];
          } catch (e) {
            // Blockfrost trả 404 khi policy chưa từng đúc gì — đó là "rỗng", không phải lỗi.
            if (page === 1 && String((e as Error).message).includes("HTTP 404")) return [];
            throw e;
          }
          for (const r of rows) if (BigInt(r.quantity) > 0n) out.push(r.asset.slice(56));
          if (rows.length < 100) return out;
        }
        throw new Error("policyAssetNames: quá 100 trang — dừng thay vì trả thiếu");
      },
      async feeOf(txHash) {
        const tx = (await getJson(`${base}/txs/${txHash}`, h)) as { fees: string };
        return BigInt(tx.fees);
      },
      lucid: () => Lucid(provider, network),
    };
  }
  const base = KOIOS[network];
  if (!base) throw new Error(`Koios không có cho ${network} — cần BLOCKFROST_KEY`);
  const provider = new Koios(base);
  return {
    label: "koios",
    provider,
    network,
    async policyAssetNames(policy) {
      const rows = (await getJson(`${base}/policy_asset_list?_asset_policy=${policy}&select=asset_name,total_supply`, { accept: "application/json" })) as {
        asset_name: string;
        total_supply: string;
      }[];
      if (rows.length >= 1000) throw new Error("policyAssetNames: Koios trả trang đầy — cần phân trang, dừng thay vì trả thiếu");
      return rows.filter((r) => BigInt(r.total_supply) > 0n).map((r) => r.asset_name);
    },
    async feeOf(txHash) {
      const rows = (await postJson(`${base}/tx_info`, { _tx_hashes: [txHash] })) as { fee: string }[];
      if (!rows[0]) throw new Error(`tx ${txHash.slice(0, 12)}… chưa thấy trên Koios`);
      return BigInt(rows[0].fee);
    },
    lucid: () => Lucid(provider, network),
  };
}

/**
 * Đọc một UTxO ref-script và NÉM nếu hash script nó mang khác `expectHash`.
 * Provider Koios của lucid không trả `scriptRef` qua `utxosByOutRef`, nên với Koios ta đọc
 * `utxo_info` (_extended) rồi tự gắn script vào. Phép so hash là thứ bắt mọi lệch mã hoá.
 */
export async function refScriptUtxo(access: ChainAccess, lucid: LucidEvolution, outRef: string, expectHash: string): Promise<UTxO> {
  const [txHash, ix] = outRef.split("#");
  if (!txHash || ix === undefined) throw new Error(`outRef không hợp lệ: ${outRef}`);
  const [u] = await lucid.utxosByOutRef([{ txHash, outputIndex: Number(ix) }]);
  if (!u) throw new Error(`không thấy UTxO ${outRef} (đã bị tiêu, hoặc chưa tồn tại trên ${access.network})`);
  let script: Script | null = u.scriptRef ?? null;
  if (!script && access.label === "koios") {
    const rows = (await postJson(`${KOIOS[access.network]}/utxo_info`, { _utxo_refs: [outRef], _extended: true })) as {
      reference_script: { type: string; bytes: string } | null;
    }[];
    const rs = rows[0]?.reference_script;
    if (rs) {
      const type = rs.type === "plutusV3" ? "PlutusV3" : rs.type === "plutusV2" ? "PlutusV2" : rs.type === "plutusV1" ? "PlutusV1" : null;
      if (!type) throw new Error(`ref-script loại lạ: ${rs.type}`);
      script = { type, script: applyDoubleCborEncoding(rs.bytes) };
    }
  }
  if (!script) throw new Error(`UTxO ${outRef} không mang ref-script`);
  const h = validatorToScriptHash(script);
  if (h !== expectHash) throw new Error(`ref-script tại ${outRef} có hash ${h}, KHÁC hash khai báo ${expectHash}`);
  return { ...u, scriptRef: script };
}

/**
 * Provider bọc: `evaluateTx` chạy `aiken tx simulate` thay vì bộ UPLC gói trong lucid.
 *
 * Vì sao cần (đo 2026-09-26 trên Preprod, taad `8e5dba9d…`): bộ đánh giá cục bộ của
 * lucid-evolution 0.4.30 báo "execution went over budget Mem −2·10¹⁰" cho nhánh `RegisterName`
 * ngay cả khi trần được nâng lên 10¹³ — trong khi `aiken tx simulate` (aiken 1.1.21) chạy
 * CÙNG tx đó ra mem 2.971.956 / cpu 836.285.027 và qua. Nhánh đó là nơi duy nhất dùng
 * builtin `read_bit` (pa2_smt ▸ `climb_compact`); một lượt chi shard KHÔNG gọi `read_bit`
 * (AdvanceBootstrap) thì bộ của lucid chết nhanh, bình thường. Kết luận làm việc: bộ của lucid
 * định giá sai builtin mới — không dùng nó cho tx nào chạm `read_bit`.
 *
 * Giới hạn phải khai: aiken đánh giá bằng mô hình chi phí MẶC ĐỊNH của nó, không phải bảng
 * chi phí đang có hiệu lực trên chuỗi. Nên ExUnit ghi vào tx được cộng biên `marginPct`, và
 * "qua aiken" là bằng chứng về LOGIC validator, không phải bằng chứng tx lọt trần mạng.
 */
export function withAikenEvaluator(
  base: Provider,
  network: Network,
  opts: {
    workDir: string;
    marginPct?: number;
    aikenBin?: string;
    /** UTxO chỉ có trong bộ nhớ (ví giả của lượt dựng khô) — không tra được trên chuỗi. */
    knownUtxos?: () => UTxO[];
  },
): Provider {
  const margin = BigInt(100 + (opts.marginPct ?? 10));
  const slot = SLOT_CONFIG_NETWORK[network];
  const wrapped: Provider = Object.create(base);
  wrapped.evaluateTx = async (txCbor: string, additionalUTxOs?: UTxO[]): Promise<EvalRedeemer[]> => {
    // Lucid chỉ chuyển cho provider các input đã `collectFrom` + `readFrom`; input ví (phí,
    // collateral) thì không. aiken đòi giải ĐỦ mọi input, nên ở đây tự tra phần còn thiếu.
    const body = CML.Transaction.from_cbor_hex(txCbor).body();
    const refs: { txHash: string; outputIndex: number }[] = [];
    for (const list of [body.inputs(), body.collateral_inputs(), body.reference_inputs()]) {
      if (!list) continue;
      for (let i = 0; i < list.len(); i++) {
        const x = list.get(i);
        refs.push({ txHash: x.transaction_id().to_hex(), outputIndex: Number(x.index()) });
      }
    }
    const key = (u: { txHash: string; outputIndex: number }) => `${u.txHash}#${u.outputIndex}`;
    const pool = new Map<string, UTxO>();
    for (const u of [...(opts.knownUtxos?.() ?? []), ...(additionalUTxOs ?? [])]) pool.set(key(u), u);
    const missing = refs.filter((r) => !pool.has(key(r)));
    if (missing.length > 0) for (const u of await base.getUtxosByOutRef(missing)) pool.set(key(u), u);
    const utxos: UTxO[] = [];
    const seen = new Set<string>();
    for (const r of refs) {
      const k = key(r);
      if (seen.has(k)) continue;
      seen.add(k);
      const u = pool.get(k);
      if (!u) throw new Error(`aiken evaluator: không giải được input ${k}`);
      utxos.push(u);
    }
    const dir = mkdtempSync(join(opts.workDir, "eval-"));
    const arr = (items: string[]) => cborArrayHeader(items.length) + items.join("");
    writeFileSync(join(dir, "tx.hex"), txCbor);
    writeFileSync(join(dir, "inputs.hex"), arr(utxos.map((u) => utxoToTransactionInput(u).to_cbor_hex())));
    writeFileSync(join(dir, "outputs.hex"), arr(utxos.map((u) => utxoToTransactionOutput(u).to_cbor_hex())));
    const r = spawnSync(
      opts.aikenBin ?? "aiken",
      ["tx", "simulate", "--zero-time", String(slot.zeroTime), "--zero-slot", String(slot.zeroSlot), "--slot-length", String(slot.slotLength),
        join(dir, "tx.hex"), join(dir, "inputs.hex"), join(dir, "outputs.hex")],
      { encoding: "utf8", timeout: 120_000 },
    );
    const stderr = `${r.stderr ?? ""}`;
    const labels = [...stderr.matchAll(/Evaluating (Spend|Mint|Withdraw|Publish|Vote|Propose)\[(\d+)\]/g)].map((m) => ({
      tag: m[1]!.toLowerCase() as EvalRedeemer["redeemer_tag"],
      index: Number(m[2]),
    }));
    let costs: { mem: number; cpu: number }[] | null = null;
    if (r.status === 0) {
      try {
        costs = JSON.parse(r.stdout.slice(r.stdout.indexOf("["))) as { mem: number; cpu: number }[];
      } catch {
        costs = null;
      }
    }
    if (!costs || costs.length !== labels.length || costs.length === 0) {
      throw new Error(
        `script evaluation failed (aiken tx simulate, exit ${r.status}): ` +
          `${(stderr + r.stdout).replace(/\s+/g, " ").slice(-600)}`,
      );
    }
    return costs.map((c, i) => ({
      redeemer_tag: labels[i]!.tag,
      redeemer_index: labels[i]!.index,
      ex_units: { mem: Number((BigInt(c.mem) * margin) / 100n), steps: Number((BigInt(c.cpu) * margin) / 100n) },
    }));
  };
  return wrapped;
}

function cborArrayHeader(n: number): string {
  if (n < 24) return (0x80 + n).toString(16);
  if (n < 256) return "98" + n.toString(16).padStart(2, "0");
  throw new Error("quá nhiều UTxO cho một lượt đánh giá");
}

/** Lỗi của lucid/validator → phân loại thô. */
export function classifyBuildError(msg: string): "script" | "funds" | "other" {
  if (/insufficient|not enough|InputsExhausted|UTxO Balance|no utxos|ValueNotConserved|collateral/i.test(msg)) return "funds";
  if (/evaluat|uplc|machine terminated|script.*fail|failed.*script|validator|phase.?2|redeemer|ExBudget|trace/i.test(msg)) return "script";
  return "other";
}
