// src/keeper.ts — UM Keeper: update UM datum mỗi epoch
// §14.1 Compute & Smoothing, §14.3 Permissionless update
// Keeper có incentive update vì users nhận better Instant rate khi UM fresh (C-UM-6).

import {
  Lucid, Blockfrost, Data,
  validatorToScriptHash, credentialToAddress, scriptHashToCredential,
  slotToUnixTime,
  type LucidEvolution, type UTxO, type TxSignBuilder, type Validator,
} from "@lucid-evolution/lucid";
import { posixMsToEpoch, msPerEpoch, epochValidityWindow, type Network } from "@magiclamp/protocol-utils";
import {
  computeUMRaw, clampUM, clampStep, appendHistory, computeSMA, computeNewUM,
  type UMDatum,
} from "./math.js";

export {
  computeUMRaw, clampUM, clampStep, appendHistory, computeSMA, computeNewUM,
  type UMDatum,
};

// ── Local constants used for tx serialization only ────────────
const Q = 1_000_000_000n;

// ══════════════════════════════════════════════════════════════
// Dấu nhật ký — HỢP ĐỒNG với bên vận hành, không phải chuỗi trang trí
// ══════════════════════════════════════════════════════════════
//
// Bên vận hành canh sức khoẻ keeper bằng NỘI DUNG nhật ký, KHÔNG bằng mã thoát.
// Lý do đo được: vòng lặp dưới bắt mọi lỗi vào `catch` rồi đi tiếp, nên tiến trình
// thoát 0 kể cả ở lượt không làm gì cả — và nó đã làm đúng thế suốt thời gian
// `buildUMUpdateTx` ném ở mọi lần gọi (Nợ #80). Mã thoát ở đây là một phép đo đang
// nói "tôi không biết" bằng giọng của "ổn".
//
// Ba dấu dưới đây vì thế là BỀ MẶT CÔNG KHAI: đổi chuỗi là phá phép canh của bên
// vận hành, và phá im lặng — cảnh báo của họ đơn giản không bao giờ bắn nữa. Đổi
// thì phải báo cho bên đang canh TRƯỚC, đúng như đổi một trường API.
// Bài ghim: `UMKeeper/tests/umTxWindow.test.ts` ▸ "D".
//
// Điều kiện SỐNG mà bên vận hành canh là sự CÓ MẶT của `LOG_MARKER_UPDATED` trong
// một cửa sổ thời gian — không phải sự VẮNG MẶT của `LOG_MARKER_ERROR`. Hai thứ đó
// khác nhau ở đúng ca tệ nhất: một lượt thoát sớm, im lặng, không in dấu nào.

/** In khi một lượt cập nhật UM đã lên chuỗi. Dấu SỐNG — canh sự có mặt của nó. */
export const LOG_MARKER_UPDATED    = "[UM Keeper] UPDATED";
/** In khi thấy epoch mới, TRƯỚC khi dựng giao dịch. Một mình nó KHÔNG phải thành công. */
export const LOG_MARKER_EPOCH_SEEN = "[UM Keeper] NEW-EPOCH";
/** In khi một lượt hỏng. Tiến trình vẫn thoát 0 — đó là lý do phải canh theo nhật ký. */
export const LOG_MARKER_ERROR      = "[UM Keeper] ERROR";

export interface EpochStats {
  epoch      : bigint;
  totalBurns : bigint;   // nanogic burned this epoch
  totalMints : bigint;   // nanogic minted this epoch
}

export interface UMUpdateResult {
  tx           : TxSignBuilder;
  oldSmoothed  : bigint;
  newSmoothed  : bigint;
  newRaw       : bigint;   // tỉ lệ ĐO ĐƯỢC của epoch (chưa kẹp bước)
  submittedRaw : bigint;   // con số THẬT đi vào redeemer, sau khi kẹp bước
  epoch        : bigint;
  summary      : string;
}

// ══════════════════════════════════════════════════════════════
// Epoch stats — query from Blockfrost or on-chain indexer
// ══════════════════════════════════════════════════════════════

/**
 * Get total burns and mints for the previous epoch.
 * In production: query from a MagicSupplyShard UTxO or Blockfrost tx history.
 * For testnet: simplified stub that keeper replaces with real data.
 */
export async function getEpochStats(
  lucid   : LucidEvolution,
  epoch   : bigint,
  shardAddresses: string[],
): Promise<EpochStats> {
  // In production, read from MagicSupplyShardDatums which track per-epoch stats.
  // For testnet v1: keeper provides these values from off-chain indexer.
  // Stub returns neutral (1:1 ratio → raw=Q=1.0)
  console.log(`⚠  getEpochStats stub for epoch ${epoch}. Replace with real indexer query.`);
  return {
    epoch,
    totalBurns: 1_000_000_000_000n,   // 1000 MAGIC burned
    totalMints: 1_000_000_000_000n,   // 1000 MAGIC minted → ratio = 1.0 → raw = Q
  };
}

// ══════════════════════════════════════════════════════════════
// Transaction builder
// ══════════════════════════════════════════════════════════════

// Lược đồ Plutus Data. Thứ tự trường LÀ hợp đồng nhị phân — đổi chỗ là vỡ decode
// mọi UM UTxO đã tạo. Neo: UMKeeper/onchain/validators/um_datum.ak.
//
// Cặp `type X = Data.Static<...>` + `const X = schema as unknown as X` là khuôn bắt
// buộc của lucid-evolution: `Data.to`/`Data.from` nhận KIỂU TĨNH ở tham số thứ hai,
// không nhận chính đối tượng lược đồ. Thiếu cặp này thì tệp không biên dịch được —
// và trước đây không ai biết, vì gói này chưa từng có `tsconfig.json` để chạy
// `tsc --noEmit`, còn vitest thì chỉ chạm `math.ts`.
const UMDatumSchema = Data.Object({
  smoothed_q:          Data.Integer(),
  last_updated_epoch:  Data.Integer(),
  history:             Data.Array(Data.Integer()),
});
type UMDatumPlutus = Data.Static<typeof UMDatumSchema>;
const UMDatumPlutus = UMDatumSchema as unknown as UMDatumPlutus;

// 🔴 KHÔNG viết lược đồ này bằng `Data.Enum` có ĐÚNG MỘT biến thể.
//
// Trên `@lucid-evolution/lucid` 0.4.30, `Data.Enum` một-biến-thể KHÔNG mã hoá được.
// Đo bằng cả ba hình dạng, cả ba đều ném:
//     Data.Enum([Data.Literal("X")])                    → "Could not type cast to void"
//     Data.Enum([Data.Object({X: Data.Object({})})])     → "Could not type cast to void"
//     Data.Enum([Data.Object({X: Data.Object({i: …})})]) → "Could not type cast to integer"
// Hai biến thể trở lên thì chạy bình thường. Lucid quy trường hợp một-biến-thể về
// một đường khác và đường đó vỡ.
//
// Hệ quả trước bản vá: `buildUMUpdateTx` NÉM ở mọi lần gọi ⟹ keeper không bao giờ
// cập nhật được UM. Không bài kiểm nào bắt được vì không bài kiểm nào nhập tệp này
// (Nợ #79) — vòng lặp keeper lại nuốt lỗi vào `catch` rồi ghi nhật ký, nên trên máy
// thật nó trông như "chưa tới epoch mới" chứ không như một thứ hỏng.
//
// `UMRedeemer` phía Aiken có đúng MỘT constructor (`um_datum.ak` ▸ `UMRedeemer`),
// nên `Constr(0, [new_raw])` là hình dạng đúng — và `Data.Object` cho ra chính nó:
// `Data.to({new_raw: 1n}, …)` = `d8799f01ff`. Bài ghim byte: `tests/umTxWindow.test.ts`.
//
// Cùng bẫy đã được ghi ở `ConsumeMAGIC/offchain/src/types.ts` (vá bằng `Data.void()`)
// từ trước mà không được quét sang các module anh em. Bốn chỗ một-biến-thể còn lại
// trong kho đều là bia mộ hoặc đường chưa mã hoá lần nào — xem Nợ #80.
const UMRedeemerSchema = Data.Object({ new_raw: Data.Integer() });
type UMRedeemerPlutus = Data.Static<typeof UMRedeemerSchema>;
const UMRedeemerPlutus = UMRedeemerSchema as unknown as UMRedeemerPlutus;

export async function buildUMUpdateTx(
  lucid          : LucidEvolution,
  umUtxo         : UTxO,
  epochStats     : EpochStats,
  umScript       : Validator,         // applied script (ms_per_epoch baked in)
  network        : Network = "Preview",
  tipPosixMs?    : bigint,
): Promise<UMUpdateResult> {
  const datum    = Data.from(umUtxo.datum!, UMDatumPlutus);
  const currentEpoch = epochStats.epoch;

  // C-UM-4: Must be a new epoch
  if (currentEpoch <= datum.last_updated_epoch) {
    throw new Error(`C-UM-4: current_epoch ${currentEpoch} ≤ last_updated ${datum.last_updated_epoch}`);
  }

  // Compute new UM
  const { newSmoothed, newHistory, newRaw, submittedRaw } = computeNewUM(
    datum, epochStats.totalBurns, epochStats.totalMints,
  );

  const newDatum: UMDatum = {
    smoothed_q:         newSmoothed,
    last_updated_epoch: currentEpoch,
    history:            newHistory,
  };

  // UM address derived from applied script (hash differs per-network).
  const umAddr   = credentialToAddress(
    network,
    scriptHashToCredential(validatorToScriptHash(umScript)),
  );
  // `new_raw` gửi lên là con số ĐÃ KẸP BƯỚC, không phải tỉ lệ đo được: validator
  // từ chối (không kẹp hộ) mọi bước vượt `um_max_step_q`.
  const redeemer = Data.to({ new_raw: submittedRaw }, UMRedeemerPlutus);
  // POSIX-ms validity range. Validator computes epoch = posix_ms / ms_per_epoch.
  const tipMs    = tipPosixMs ?? BigInt(Date.now());
  const { lowerMs: lowerTime, upperMs: upperTime } =
    epochValidityWindow(tipMs, network);

  const tx = await lucid
    .newTx()
    .collectFrom([umUtxo], redeemer)
    .attach.SpendingValidator(umScript)
    .pay.ToAddressWithData(
      umAddr,
      { kind: "inline", value: Data.to(newDatum, UMDatumPlutus) },
      umUtxo.assets,
    )
    // Permissionless — no .addSignerKey()
    .validFrom(lowerTime)
    .validTo(upperTime)
    .complete();

  const arrow = newSmoothed > datum.smoothed_q ? "▲" : newSmoothed < datum.smoothed_q ? "▼" : "─";
  // Hàng rào có cắt bớt bước không — phải HIỆN RA, không nuốt im. Keeper đọc
  // dòng này là biết UM đang đi sau thị trường bao nhiêu và vì lý do gì.
  const stepNote = submittedRaw === clampUM(newRaw)
    ? `(trong trần bước 0,10)`
    : `(ĐÃ KẸP về trần bước 0,10 — thị trường đòi ${(Number(clampUM(newRaw)) / 1e9).toFixed(4)}×)`;
  const summary = [
    `═══ UM Update ═══`,
    `Epoch:         ${currentEpoch}`,
    `Burns / Mints: ${epochStats.totalBurns} / ${epochStats.totalMints} nanogic`,
    `Raw đo được:   ${newRaw} (${(Number(newRaw) / 1e9).toFixed(4)}×)`,
    `Raw đã gửi:    ${submittedRaw} (${(Number(submittedRaw) / 1e9).toFixed(4)}×) ${stepNote}`,
    `Old smoothed:  ${datum.smoothed_q} (${(Number(datum.smoothed_q) / 1e9).toFixed(4)}×)`,
    `New smoothed:  ${newSmoothed} (${(Number(newSmoothed) / 1e9).toFixed(4)}×) ${arrow}`,
    `History:       [${newHistory.map(x => (Number(x)/1e9).toFixed(2)).join(", ")}]`,
    ``,
    `Effect on Instant rate at UM=${(Number(newSmoothed)/1e9).toFixed(2)}×:`,
    `  Flame 1000 LAMP → ${(Number(newSmoothed) * 3 * 1.05 / 1e9).toFixed(4)} MAGIC`,
    ``,
    `Note: Permissionless tx — no owner signature required (§14.3).`,
  ].join("\n");

  return {
    tx, oldSmoothed: datum.smoothed_q, newSmoothed, newRaw, submittedRaw,
    epoch: currentEpoch, summary,
  };
}

// ══════════════════════════════════════════════════════════════
// Keeper monitoring loop
// ══════════════════════════════════════════════════════════════

export interface KeeperConfig {
  lucid          : LucidEvolution;
  umUtxoUnit     : string;     // NFT unit to identify UM UTxO
  umScript       : Validator;  // applied script (ms_per_epoch baked in)
  shardAddresses : string[];   // for epoch stats query
  intervalMs     : number;     // polling interval (e.g. 60_000 = 1 min)
  network?       : Network;    // for POSIX-based epoch math
  onUpdate?      : (result: UMUpdateResult) => void;
  onError?       : (err: Error) => void;
}

/**
 * Start the UM keeper loop.
 * Checks every `intervalMs` ms if a new epoch has started.
 * If yes: queries stats, builds and submits UM update tx.
 * Returns a stop function.
 */
export function startUMKeeper(config: KeeperConfig): () => void {
  const { lucid, umUtxoUnit, umScript, shardAddresses, intervalMs } = config;
  let running = true;

  async function tick() {
    if (!running) return;
    try {
      const umUtxo = await lucid.utxoByUnit(umUtxoUnit);
      if (!umUtxo.datum) return;

      const datum       = Data.from(umUtxo.datum, UMDatumPlutus);
      const tip         = await (lucid.config().provider as any).getBlock("latest");
      const network     = config.network ?? "Preview";
      const tipPosixMs  = BigInt(slotToUnixTime(network, tip.slot ?? 0));
      const currentEpoch = posixMsToEpoch(tipPosixMs, network);

      // Check if update needed
      if (currentEpoch <= datum.last_updated_epoch) return;

      console.log(`${LOG_MARKER_EPOCH_SEEN} ${currentEpoch}`);

      const stats  = await getEpochStats(lucid, currentEpoch, shardAddresses);
      const result = await buildUMUpdateTx(lucid, umUtxo, stats, umScript, network);
      const signed = await result.tx.sign.withWallet().complete();
      const txHash = await signed.submit();

      console.log(`${LOG_MARKER_UPDATED} epoch=${currentEpoch} tx=${txHash}`);
      console.log(result.summary);
      config.onUpdate?.(result);

    } catch (err) {
      console.error(`${LOG_MARKER_ERROR}`, err);
      config.onError?.(err as Error);
    }
  }

  const interval = setInterval(tick, intervalMs);
  tick();  // run immediately

  return () => { running = false; clearInterval(interval); };
}

export async function createLucid(apiKey: string, network = "Preview"): Promise<LucidEvolution> {
  return Lucid(
    new Blockfrost(`https://cardano-${network.toLowerCase()}.blockfrost.io/api/v0`, apiKey),
    network as any,
  );
}
