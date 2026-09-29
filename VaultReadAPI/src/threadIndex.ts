// VaultReadAPI/src/threadIndex.ts — chỉ mục DID ⟹ thread Engage, giữ trong bộ nhớ.
//
// ── THREAD LÀ GÌ ────────────────────────────────────────────────────────────────
// Một UTxO tại địa chỉ script `consume` (ConsumeMAGIC) mang ĐÚNG MỘT NFT: policy = script hash
// `consume`, tên = `blake2b_256(cbor(seed))` (`ConsumeMAGIC/onchain/validators/consume.ak` ▸
// `validate_mint_engage_id`; bản TS: `ConsumeMAGIC/offchain/src/engageId.ts` ▸ `engageNftUnit`).
// Datum là `EngageDatum` 5 trường; `did_commit` rỗng tới khi `BindDID`, sau đó 32 byte và bất
// biến. Mỗi lần consume thread bị tiêu và tạo lại ⟹ UTxO đổi, NFT giữ nguyên.
//
// ── HAI THỨ TỆP NÀY CỐ Ý KHÔNG TỰ LÀM ───────────────────────────────────────────
// 1. Giải mã datum: `decodeEngageDatum` của MagicSDK (lược đồ gốc ở
//    `ConsumeMAGIC/offchain/src/types.ts` ▸ `EngageDatumSchema`). Không khai lược đồ thứ hai.
// 2. Gọi nhà cung cấp dữ liệu: chỉ qua `ChainHistoryReader` (`chain.ts`).
//
// ── LÚC TRA KHÔNG GỌI CHUỖI ─────────────────────────────────────────────────────
// `byDid` / `byAsset` / `status` chỉ đọc Map trong bộ nhớ. Mọi lời gọi chuỗi nằm trong
// `syncOnce`, chạy nền. Cái giá của lựa chọn này là dữ liệu có thể CŨ — nên mọi câu trả lời
// đi qua `assertFresh` trước, và cũ quá ngưỡng thì trả 503 thay vì trả danh sách.
//
// ── ĐỘ TRỄ ĐO THẾ NÀO ───────────────────────────────────────────────────────────
// lag_blocks = (chiều cao đỉnh QUAN SÁT lần cuối − chiều cao đã đồng bộ)
//            + ⌊(bây giờ − lúc quan sát đỉnh đó) / thời gian khối⌋
// Vế thứ hai là thứ bắt ca "vòng đồng bộ đã CHẾT": không có nó, một chỉ mục ngừng đồng bộ
// từ hôm qua vẫn tự khai lag = 0, vì đỉnh nó biết cũng dừng ở hôm qua.

import { decodeEngageDatum } from "@magiclamp/sdk";
import { ownerRefOf } from "@magiclamp/protocol-utils";

import type { ChainHistoryReader, ChainPoint, ChainTxEffect, ChainUtxo, AddressTx } from "./chain.js";
import type { ConsumeScope, ThreadIndexConfig } from "./config.js";
import {
  BadRequestError,
  IndexStaleError,
  ThreadDatumUndecodableError,
  ThreadIdentityDuplicateError,
  ThreadNotFoundError,
  UnknownConsumeScopeError,
  VaultReadError,
} from "./errors.js";

const POLICY_HEX_LEN = 56;
/** Tên NFT thread = blake2b_256 ⟹ đúng 32 byte. */
const NAME_HEX_LEN = 64;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX56 = /^[0-9a-f]{56}$/;
/** Độ dài một slot (ms). Gương của `SLOT_LENGTH_MS` ở `ProtocolUtils/src/index.ts`; chỉ dùng để
 *  ngoại suy `tip_slot` khi đồng hồ tường đã trôi quá lần quan sát đỉnh cuối. */
const SLOT_MS = 1_000;
/** Cửa sổ khối cần phát lại lớn hơn số giao dịch này ⟹ dựng lại từ ảnh chụp, rẻ hơn. */
const MAX_REPLAY_TXS = 2_000;

export interface ThreadOwner {
  type: "key" | "script";
  hash: string;
}

export interface ThreadEntry {
  consumeHash: string;
  /** = consumeHash (policy của NFT thread). Giữ riêng vì hợp đồng in cả hai. */
  policy: string;
  name: string;
  /** `<txhash>#<idx>`. */
  utxo: string;
  owner: ThreadOwner;
  consumedCount: bigint;
  lastEpoch: bigint;
  /** Hex thường; rỗng khi thread chưa `BindDID`. */
  didCommit: string;
  consumedNanogic: bigint;
}

export type SkipReason = "NO_INLINE_DATUM" | "DATUM_UNDECODABLE" | "OWNER_SHAPE" | "DID_COMMIT_LENGTH";

/** UTxO mang ĐÚNG NFT thread mà datum không đọc được — đếm và lộ ra, không nuốt. */
export interface SkippedThread {
  utxo: string;
  consumeHash: string;
  name: string;
  reason: SkipReason;
  detail: string;
}

export type ThreadClass =
  | { kind: "no_nft" }
  | { kind: "skipped"; skipped: SkippedThread }
  | { kind: "thread"; entry: ThreadEntry };

/** Điểm đồng bộ + độ trễ của MỘT câu trả lời — in ở đầu mọi thân bài. */
export interface FreshnessView {
  syncedSlot: number;
  tipSlot: number;
  lagBlocks: number;
}

// ── Chủ thread ──────────────────────────────────────────────────────────────────

// ── Phân loại một UTxO ──────────────────────────────────────────────────────────

/** Đúng một tài sản dưới `policy`, số lượng 1, tên 32 byte ⟹ tên (hex). Ngược lại null. */
function threadNftName(assets: Record<string, bigint>, policy: string): string | null {
  let found: string | null = null;
  for (const [unit, qty] of Object.entries(assets)) {
    if (unit.length <= POLICY_HEX_LEN) continue;               // "lovelace", policy trơ
    if (unit.slice(0, POLICY_HEX_LEN) !== policy) continue;
    const name = unit.slice(POLICY_HEX_LEN);
    if (qty !== 1n || name.length !== NAME_HEX_LEN) return null;
    if (found !== null) return null;                            // hai token cùng policy
    found = name;
  }
  return found;
}

/**
 * Hàm THUẦN: một UTxO ở địa chỉ `consume` là thread, là thread đọc hỏng, hay là rác.
 *
 * Không mang NFT đúng policy ⟹ `no_nft`, KHÔNG vào chỉ mục: địa chỉ script là công cộng, ai
 * cũng đỗ được ở đó một UTxO với datum tự soạn khai `did_commit` của người khác.
 */
export function classifyThreadUtxo(u: ChainUtxo, consumeHash: string): ThreadClass {
  const utxo = `${u.txHash}#${u.outputIndex}`;
  const name = threadNftName(u.assets, consumeHash);
  if (name === null) return { kind: "no_nft" };

  const skip = (reason: SkipReason, detail: string): ThreadClass =>
    ({ kind: "skipped", skipped: { utxo, consumeHash, name, reason, detail: detail.slice(0, 200) } });

  if (u.inlineDatumHex === null) return skip("NO_INLINE_DATUM", "không có datum inline");

  let d: ReturnType<typeof decodeEngageDatum>;
  try {
    d = decodeEngageDatum(u.inlineDatumHex);
  } catch (e) {
    return skip("DATUM_UNDECODABLE", (e as Error).message);
  }

  let owner: ThreadOwner;
  try {
    owner = ownerRefOf(d.owner);
  } catch (e) {
    return skip("OWNER_SHAPE", (e as Error).message);
  }

  const didCommit = String(d.did_commit).toLowerCase();
  if (didCommit.length !== 0 && didCommit.length !== 64) {
    // On-chain ép rỗng hoặc đúng 32 byte; thứ khác là datum ta không hiểu.
    return skip("DID_COMMIT_LENGTH", `did_commit dài ${didCommit.length / 2} byte`);
  }

  return {
    kind: "thread",
    entry: {
      consumeHash,
      policy: consumeHash,
      name,
      utxo,
      owner,
      consumedCount: d.consumed_count,
      lastEpoch: d.last_epoch,
      didCommit,
      consumedNanogic: d.consumed_nanogic,
    },
  };
}

// ── Chỉ mục ─────────────────────────────────────────────────────────────────────

export interface ThreadIndexOptions {
  /** Đồng hồ tường (ms). Tiêm được để bài kiểm dựng ca "vòng đồng bộ đã chết". */
  now?: () => number;
  /** Nơi ghi một dòng khi vòng đồng bộ hỏng. Mặc định `console.error`. */
  log?: (msg: string) => void;
}

export class ThreadIndex {
  private readonly entries = new Map<string, ThreadEntry>();      // utxo → thread
  private readonly skipped = new Map<string, SkippedThread>();    // utxo → thread đọc hỏng
  private readonly noNft = new Map<string, string>();             // utxo → consumeHash (rác)
  private readonly byUnit = new Map<string, Set<string>>();       // policy+name → utxo
  private readonly byDidMap = new Map<string, Set<string>>();     // did → utxo
  private readonly scopeByAddress: Map<string, ConsumeScope>;
  private readonly scopeByHash: Map<string, ConsumeScope>;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  private synced: ChainPoint | null = null;
  private tip: ChainPoint | null = null;
  private tipObservedAtMs: number | null = null;
  private lastSyncOkAtMs: number | null = null;
  private lastSyncError: string | null = null;
  private rounds = 0;
  private rebuilds = 0;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly chain: ChainHistoryReader,
    private readonly scopes: ConsumeScope[],
    private readonly cfg: ThreadIndexConfig,
    opts: ThreadIndexOptions = {},
  ) {
    this.scopeByAddress = new Map(scopes.map(s => [s.address, s]));
    this.scopeByHash = new Map(scopes.map(s => [s.scriptHash, s]));
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (m => console.error(m));
  }

  // ── Đồng bộ (nền) ─────────────────────────────────────────────────────────────

  /** Một vòng đồng bộ. Gọi chồng khi vòng trước chưa xong ⟹ chờ chung vòng đó. */
  syncOnce(): Promise<void> {
    if (this.inFlight === null) {
      this.inFlight = this.runRound().finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  /** Chạy vòng đồng bộ theo nhịp `syncIntervalMs`. Vòng kế tiếp chỉ hẹn SAU khi vòng này xong. */
  start(): void {
    if (this.timer !== null) return;
    const tick = (): void => {
      void this.syncOnce().finally(() => {
        if (this.timer !== null) this.timer = setTimeout(tick, this.cfg.syncIntervalMs);
      });
    };
    this.timer = setTimeout(tick, 0);
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private async runRound(): Promise<void> {
    this.rounds++;
    try {
      const tip = await this.chain.tipPoint();
      this.tip = tip;
      this.tipObservedAtMs = this.now();

      if (this.synced === null || tip.height < this.synced.height) {
        // Chưa có gì, hoặc đỉnh LÙI dưới điểm đã đồng bộ (cuộn lại / nhà cung cấp lệch):
        // mọi giao dịch đã áp sau điểm đó có thể không còn — dựng lại từ ảnh chụp.
        await this.rebuild(tip);
      } else if (tip.height > this.synced.height) {
        await this.replay(this.synced.height + 1, tip);
      }
      this.lastSyncOkAtMs = this.now();
      this.lastSyncError = null;
    } catch (e) {
      // Không ném ra ngoài vòng nền; nhưng cũng không im: ghi lại để `/threads/status` và
      // chi tiết 503 in được, và độ trễ tự tăng theo đồng hồ tường.
      const code = e instanceof VaultReadError ? e.code : "INTERNAL";
      this.lastSyncError = `${code}: ${(e as Error).message}`.slice(0, 300);
      this.log(`[thread-index] vòng đồng bộ hỏng — ${this.lastSyncError}`);
    }
  }

  /** Ảnh chụp trọn các địa chỉ consume. Thay trạng thái CHỈ khi mọi địa chỉ đều đọc được. */
  private async rebuild(tip: ChainPoint): Promise<void> {
    const snaps: [ConsumeScope, ChainUtxo[]][] = [];
    for (const s of this.scopes) snaps.push([s, await this.chain.utxosAt(s.address)]);
    this.clear();
    for (const [s, utxos] of snaps) for (const u of utxos) this.add(s, u);
    // Ảnh chụp đọc SAU khi quan sát đỉnh, nên nó ít nhất mới bằng `tip`. Vòng sau phát lại từ
    // `tip + 1`; áp lại một giao dịch đã có trong ảnh chụp là vô hại vì phát lại theo đúng
    // thứ tự chuỗi (đầu ra bị tiêu sau đó sẽ bị gỡ lại bởi chính giao dịch tiêu nó).
    this.synced = tip;
    this.rebuilds++;
  }

  /** Phát lại giao dịch ở các khối `from..tip.height`. Đọc HẾT trước, áp sau ⟹ vòng nguyên tử. */
  private async replay(fromHeight: number, tip: ChainPoint): Promise<void> {
    const seen = new Map<string, AddressTx>();
    for (const s of this.scopes) {
      for (const t of await this.chain.txsAt(s.address, fromHeight, tip.height)) seen.set(t.txHash, t);
    }
    if (seen.size > MAX_REPLAY_TXS) {
      await this.rebuild(tip);
      return;
    }
    const ordered = [...seen.values()].sort(
      (a, b) => a.blockHeight - b.blockHeight || a.txIndex - b.txIndex,
    );
    const effects: ChainTxEffect[] = [];
    for (const t of ordered) effects.push(await this.chain.txEffect(t.txHash));

    for (const eff of effects) {
      for (const r of eff.spent) this.remove(`${r.txHash}#${r.outputIndex}`);
      for (const o of eff.created) {
        const scope = this.scopeByAddress.get(o.address);
        if (scope !== undefined) this.add(scope, o);
      }
    }
    this.synced = tip;
  }

  private clear(): void {
    this.entries.clear();
    this.skipped.clear();
    this.noNft.clear();
    this.byUnit.clear();
    this.byDidMap.clear();
  }

  private add(scope: ConsumeScope, u: ChainUtxo): void {
    const ref = `${u.txHash}#${u.outputIndex}`;
    this.remove(ref);   // áp lại cùng một đầu ra ⟹ thay, không nhân đôi
    const c = classifyThreadUtxo(u, scope.scriptHash);
    if (c.kind === "no_nft") {
      this.noNft.set(ref, scope.scriptHash);
      return;
    }
    const unit = c.kind === "thread" ? c.entry.policy + c.entry.name : c.skipped.consumeHash + c.skipped.name;
    setAdd(this.byUnit, unit, ref);
    if (c.kind === "skipped") {
      this.skipped.set(ref, c.skipped);
      return;
    }
    this.entries.set(ref, c.entry);
    if (c.entry.didCommit !== "") setAdd(this.byDidMap, c.entry.didCommit, ref);
  }

  private remove(ref: string): void {
    this.noNft.delete(ref);
    const e = this.entries.get(ref);
    if (e !== undefined) {
      this.entries.delete(ref);
      setDel(this.byUnit, e.policy + e.name, ref);
      if (e.didCommit !== "") setDel(this.byDidMap, e.didCommit, ref);
    }
    const s = this.skipped.get(ref);
    if (s !== undefined) {
      this.skipped.delete(ref);
      setDel(this.byUnit, s.consumeHash + s.name, ref);
    }
  }

  // ── Tra (không gọi chuỗi) ─────────────────────────────────────────────────────

  /** Độ trễ hiện tại, hoặc null khi chưa đồng bộ lần nào. */
  private measure(): (FreshnessView & { fresh: boolean }) | null {
    if (this.synced === null || this.tip === null || this.tipObservedAtMs === null) return null;
    const elapsed = Math.max(0, this.now() - this.tipObservedAtMs);
    const lagBlocks = Math.max(0, this.tip.height - this.synced.height) + Math.floor(elapsed / this.cfg.blockTimeMs);
    return {
      syncedSlot: this.synced.slot,
      tipSlot: this.tip.slot + Math.floor(elapsed / SLOT_MS),
      lagBlocks,
      fresh: lagBlocks <= this.cfg.staleBlocks,
    };
  }

  private assertFresh(): FreshnessView {
    const m = this.measure();
    if (m === null) {
      throw new IndexStaleError({
        synced_slot: null, tip_slot: this.tip?.slot ?? null, lag_blocks: null,
        stale_threshold_blocks: this.cfg.staleBlocks, reason: "NEVER_SYNCED",
        last_sync_error: this.lastSyncError,
      });
    }
    if (!m.fresh) {
      throw new IndexStaleError({
        synced_slot: m.syncedSlot, tip_slot: m.tipSlot, lag_blocks: m.lagBlocks,
        stale_threshold_blocks: this.cfg.staleBlocks, reason: "LAG_EXCEEDED",
        last_sync_error: this.lastSyncError,
      });
    }
    return { syncedSlot: m.syncedSlot, tipSlot: m.tipSlot, lagBlocks: m.lagBlocks };
  }

  private assertUnique(unit: string): void {
    const refs = this.byUnit.get(unit);
    if (refs !== undefined && refs.size > 1) {
      throw new ThreadIdentityDuplicateError(unit, [...refs].sort());
    }
  }

  byDid(did: string): { freshness: FreshnessView; threads: ThreadEntry[]; skippedCount: number } {
    if (!HEX64.test(did)) {
      throw new BadRequestError("did_commit phải là đúng 64 ký tự hex THƯỜNG (32 byte).", { did_length: did.length });
    }
    const freshness = this.assertFresh();
    const threads = [...(this.byDidMap.get(did) ?? [])].map(r => this.entries.get(r)!);
    for (const t of threads) this.assertUnique(t.policy + t.name);
    threads.sort((a, b) => cmp(a.consumeHash, b.consumeHash) || cmp(a.utxo, b.utxo));
    return { freshness, threads, skippedCount: this.skipped.size };
  }

  byAsset(policy: string, name: string): { freshness: FreshnessView; thread: ThreadEntry } {
    if (!HEX56.test(policy) || !HEX64.test(name)) {
      throw new BadRequestError(
        "Tài sản phải có dạng <policy 56 hex thường>.<tên 64 hex thường>.",
        { policy_length: policy.length, name_length: name.length },
      );
    }
    if (!this.scopeByHash.has(policy)) {
      // Không theo dõi policy này ⟹ KHÔNG biết, khác "biết là không có".
      throw new UnknownConsumeScopeError(policy, [...this.scopeByHash.keys()]);
    }
    const freshness = this.assertFresh();
    const unit = policy + name;
    this.assertUnique(unit);
    const ref = [...(this.byUnit.get(unit) ?? [])][0];
    if (ref === undefined) throw new ThreadNotFoundError(`${policy}.${name}`);
    const s = this.skipped.get(ref);
    if (s !== undefined) throw new ThreadDatumUndecodableError(ref, `${policy}.${name}`, `${s.reason}: ${s.detail}`);
    return { freshness, thread: this.entries.get(ref)! };
  }

  /** Chẩn đoán cho người vận hành. Không gọi chuỗi, không ném khi cũ. */
  status(): Record<string, unknown> {
    const m = this.measure();
    const perScope = this.scopes.map(s => ({
      consume_hash: s.scriptHash,
      address: s.address,
      source: s.source,
      threads: countWhere(this.entries.values(), e => e.consumeHash === s.scriptHash),
      skipped: countWhere(this.skipped.values(), x => x.consumeHash === s.scriptHash),
      ignored_no_nft: countWhere(this.noNft.values(), h => h === s.scriptHash),
    }));
    return {
      synced: this.synced === null ? null : { height: this.synced.height, slot: this.synced.slot, hash: this.synced.hash },
      synced_slot: m?.syncedSlot ?? null,
      tip_slot: m?.tipSlot ?? this.tip?.slot ?? null,
      lag_blocks: m?.lagBlocks ?? null,
      fresh: m?.fresh ?? false,
      stale_threshold_blocks: this.cfg.staleBlocks,
      block_time_ms: this.cfg.blockTimeMs,
      rounds: this.rounds,
      rebuilds: this.rebuilds,
      last_sync_ok_at_ms: this.lastSyncOkAtMs,
      last_sync_error: this.lastSyncError,
      thread_count: this.entries.size,
      did_count: this.byDidMap.size,
      skipped_count: this.skipped.size,
      ignored_no_nft_count: this.noNft.size,
      scopes: perScope,
      // Liệt kê từng cái: một datum lạ ở địa chỉ consume là thứ người vận hành phải nhìn
      // tận mặt, không phải chỉ một con số.
      skipped: [...this.skipped.values()]
        .sort((a, b) => cmp(a.utxo, b.utxo))
        .map(x => ({ utxo: x.utxo, consume_hash: x.consumeHash, name: x.name, reason: x.reason, detail: x.detail })),
    };
  }
}

// ── Thân bài JSON ───────────────────────────────────────────────────────────────

/** Mọi số nguyên của datum đi ra dạng CHUỖI thập phân — cùng lý do ở đầu `service.ts`. */
export function threadToJson(t: ThreadEntry): Record<string, unknown> {
  return {
    consume_hash: t.consumeHash,
    policy: t.policy,
    name: t.name,
    utxo: t.utxo,
    datum: {
      owner: { type: t.owner.type, hash: t.owner.hash },
      consumed_count: t.consumedCount.toString(10),
      last_epoch: t.lastEpoch.toString(10),
      did_commit: t.didCommit,
      consumed_nanogic: t.consumedNanogic.toString(10),
    },
  };
}

export function freshnessToJson(f: FreshnessView): Record<string, unknown> {
  return { synced_slot: f.syncedSlot, tip_slot: f.tipSlot, lag_blocks: f.lagBlocks };
}

// ── tiện ích ────────────────────────────────────────────────────────────────────

function setAdd(m: Map<string, Set<string>>, k: string, v: string): void {
  let s = m.get(k);
  if (s === undefined) { s = new Set(); m.set(k, s); }
  s.add(v);
}

function setDel(m: Map<string, Set<string>>, k: string, v: string): void {
  const s = m.get(k);
  if (s === undefined) return;
  s.delete(v);
  if (s.size === 0) m.delete(k);
}

function countWhere<T>(it: Iterable<T>, p: (x: T) => boolean): number {
  let n = 0;
  for (const x of it) if (p(x)) n++;
  return n;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
