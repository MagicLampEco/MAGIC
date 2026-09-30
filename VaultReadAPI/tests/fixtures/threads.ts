// VaultReadAPI/tests/fixtures/threads.ts — chuỗi GIẢ có lịch sử, và thread dựng bằng CHÍNH lược đồ thật.
//
// Không gõ tay CBOR: datum đi qua `encodeEngageDatum`, tên NFT đi qua `engageNftUnit` của
// MagicSDK. Lược đồ đổi thì mẫu đổi theo và bài kiểm nói ra.
//
// `FakeHistoryChain` là một sổ cái thu nhỏ: giữ tập UTxO chưa tiêu + danh sách giao dịch theo
// khối. Mỗi lời gọi ra ngoài đều ĐẾM vào `calls` — đó là thước đo của tiêu chí "tra không gọi
// chuỗi". `failing = true` ⟹ mọi lời gọi ném `ChainUnavailableError`.

import { encodeEngageDatum, engageNftUnit, type EngageDatumT } from "@magiclamp/sdk";

import type {
  AddressTx, AddressedUtxo, ChainHistoryReader, ChainPoint, ChainTip, ChainTxEffect, ChainUtxo, OutRef,
} from "../../src/chain.js";
import { ChainUnavailableError } from "../../src/errors.js";
import type { ConsumeScope, ThreadIndexConfig } from "../../src/config.js";

export const CONSUME_A = "c1".repeat(28);
export const CONSUME_B = "c2".repeat(28);
export const ADDR_A = "addr_test1_consume_a";
export const ADDR_B = "addr_test1_consume_b";
export const OWNER_PKH = "11".repeat(28);

export const SCOPE_A: ConsumeScope = { address: ADDR_A, scriptHash: CONSUME_A, source: "giả — bài kiểm" };
export const SCOPE_B: ConsumeScope = { address: ADDR_B, scriptHash: CONSUME_B, source: "giả — bài kiểm" };

export const CFG: ThreadIndexConfig = { staleBlocks: 3, syncIntervalMs: 20_000, blockTimeMs: 20_000 };

/** DID thứ `i` — 32 byte hex, đôi một khác nhau. */
export const didOf = (i: number): string => i.toString(16).padStart(64, "0");

/** Tx hash tổng hợp 32 byte từ một số đếm. */
export const txHashOf = (tag: string, i: number): string =>
  (tag + i.toString(16)).padStart(64, "0").slice(-64);

export interface ThreadSpec {
  consumeHash?: string;
  /** Hạt giống sinh tên NFT (giả lập UTxO seed lúc mint). */
  seedIndex: number;
  did?: string;
  consumedCount?: bigint;
  consumedNanogic?: bigint;
  lastEpoch?: bigint;
}

export function threadDatumHex(spec: { did?: string; consumedCount?: bigint; consumedNanogic?: bigint; lastEpoch?: bigint }): string {
  const d: EngageDatumT = {
    owner: { VerificationKey: [OWNER_PKH] },
    consumed_count: spec.consumedCount ?? 0n,
    last_epoch: spec.lastEpoch ?? 20_700n,
    did_commit: spec.did ?? "",
    consumed_nanogic: spec.consumedNanogic ?? 0n,
  } as EngageDatumT;
  return encodeEngageDatum(d);
}

/** Unit (policy + tên) của NFT thread sinh từ hạt giống `seedIndex`. */
export function threadUnit(consumeHash: string, seedIndex: number): string {
  return engageNftUnit(consumeHash, { txHash: txHashOf("5eed", seedIndex), outputIndex: 0 });
}

/** Tài sản + datum của một thread (chưa có txHash/outputIndex). */
export function threadOutput(spec: ThreadSpec, datumHex?: string): Omit<AddressedUtxo, "txHash" | "outputIndex"> {
  const ch = spec.consumeHash ?? CONSUME_A;
  return {
    address: ch === CONSUME_A ? ADDR_A : ADDR_B,
    assets: { lovelace: 2_000_000n, [threadUnit(ch, spec.seedIndex)]: 1n },
    inlineDatumHex: datumHex ?? threadDatumHex(spec),
  };
}

export class FakeHistoryChain implements ChainHistoryReader {
  readonly label = "fake-history";
  calls = 0;
  failing = false;
  height = 1_000;
  private txCounter = 0;
  private readonly utxos = new Map<string, AddressedUtxo>();
  private readonly txs: { tx: AddressTx; addrs: Set<string>; effect: ChainTxEffect }[] = [];

  slotOf(h: number): number { return h * 20; }

  private hit(): void {
    this.calls++;
    if (this.failing) throw new ChainUnavailableError("chuỗi giả đang hỏng", { transport: "fake" });
  }

  /** Đặt UTxO có sẵn từ trước điểm theo dõi (không để lại giao dịch trong lịch sử). */
  seed(u: Omit<AddressedUtxo, "txHash" | "outputIndex">, ref?: OutRef): OutRef {
    const r = ref ?? { txHash: txHashOf("00", this.txCounter++), outputIndex: 0 };
    this.utxos.set(`${r.txHash}#${r.outputIndex}`, { ...u, ...r });
    return r;
  }

  /** Một giao dịch trong một khối MỚI: tiêu `spent`, tạo `created` (theo thứ tự chỉ số đầu ra). */
  submit(spent: OutRef[], created: Omit<AddressedUtxo, "txHash" | "outputIndex">[]): { txHash: string; outs: OutRef[] } {
    this.height++;
    const txHash = txHashOf("7a", this.txCounter++);
    const addrs = new Set<string>();
    for (const r of spent) {
      const k = `${r.txHash}#${r.outputIndex}`;
      const u = this.utxos.get(k);
      if (u === undefined) throw new Error(`fake: tiêu UTxO không tồn tại ${k}`);
      addrs.add(u.address);
      this.utxos.delete(k);
    }
    const outs: OutRef[] = [];
    const createdFull: AddressedUtxo[] = created.map((c, i) => {
      const full = { ...c, txHash, outputIndex: i };
      this.utxos.set(`${txHash}#${i}`, full);
      addrs.add(c.address);
      outs.push({ txHash, outputIndex: i });
      return full;
    });
    this.txs.push({
      tx: { txHash, blockHeight: this.height, txIndex: 0 },
      addrs,
      effect: { txHash, spent, created: createdFull },
    });
    return { txHash, outs };
  }

  /** Khối rỗng. */
  advance(n: number): void { this.height += n; }

  async utxosAt(address: string): Promise<ChainUtxo[]> {
    this.hit();
    const out: ChainUtxo[] = [];
    for (const u of this.utxos.values()) {
      if (u.address === address) {
        out.push({ txHash: u.txHash, outputIndex: u.outputIndex, assets: u.assets, inlineDatumHex: u.inlineDatumHex });
      }
    }
    return out;
  }

  async tip(): Promise<ChainTip> {
    this.hit();
    return { blockHeight: this.height, blockHash: `h${this.height}`, blockTimePosixMs: 0n };
  }

  async tipPoint(): Promise<ChainPoint> {
    this.hit();
    return { height: this.height, hash: `h${this.height}`, slot: this.slotOf(this.height) };
  }

  async txsAt(address: string, fromHeight: number, toHeight: number): Promise<AddressTx[]> {
    this.hit();
    return this.txs
      .filter(t => t.tx.blockHeight >= fromHeight && t.tx.blockHeight <= toHeight && t.addrs.has(address))
      .map(t => t.tx);
  }

  async txEffect(txHash: string): Promise<ChainTxEffect> {
    this.hit();
    const t = this.txs.find(x => x.tx.txHash === txHash);
    if (t === undefined) throw new Error(`fake: không có giao dịch ${txHash}`);
    return t.effect;
  }
}
