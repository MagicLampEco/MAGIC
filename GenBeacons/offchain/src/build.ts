// GenBeacons/offchain/src/build.ts — hàm thuần khớp validator + bộ dựng giao dịch.
//
// Mỗi hàm thuần dưới đây là bản TS của đúng một vế validator, neo theo TÊN HÀM:
//   rhoAt              ↔ lib/genbeacons/rate.ak       ▸ `rho_at`
//   shardResetAmount   ↔ lib/genbeacons/shard.ak      ▸ `lazy_reset` (vế `min(⌊GB/16⌋, cap)`)
//   lazyReset          ↔ lib/genbeacons/shard.ak      ▸ `lazy_reset`
//   assertVaultList    ↔ lib/genbeacons/registry.ak   ▸ `vault_list_ok`
//   txEpoch            ↔ lib/genbeacons/util.ak       ▸ `get_epoch`
// Hàm thuần NÉM khi đầu vào là trạng thái validator sẽ từ chối — để lỗi lộ ra lúc dựng,
// không lộ ra thành một lần đánh giá script thất bại khó đọc.
//
// Bộ dựng trả `TxBuilder` CHƯA complete: người gọi tự `complete()` / ký / nộp. Rút shard
// (`addShardDraw`) chỉ GẮN phần shard vào một giao dịch két — shard đòi đúng MỘT két đi kèm
// (gb_shard.ak ▸ `exactly_one_vault`), còn nhánh két thuộc gói InstantGen/ScheduleGen.
//
// Hàm `*Raw` là đường THÔ: dựng đúng hình dạng giao dịch với datum/người ký do người gọi
// đưa, KHÔNG kiểm ngữ nghĩa. Có để bài kiểm dựng được giao dịch sai có chủ ý (ca âm) và đo
// rằng VALIDATOR — không phải bộ dựng — là thứ từ chối.

import {
  getAddressDetails,
  toUnit,
  type LucidEvolution,
  type TxBuilder,
  type UTxO,
} from "@lucid-evolution/lucid";
import {
  encodeGbShard,
  encodeGbShardRedeemer,
  encodeGreenBackBeacon,
  encodeRateParam,
  encodeVaultRegistry,
  decodeGbShard,
  decodeGreenBackBeacon,
  decodeRateParam,
  decodeVaultRegistry,
  IGNORED_REDEEMER,
  SCRIPT_HASH_BYTES,
  type GbShard,
  type GreenBackBeacon,
  type RateParam,
} from "./types.js";
import {
  GREENBACK_NFT_NAME,
  SHARD_COUNT,
  type GbShardScript,
  type GreenBackBeaconScript,
  type OutRef,
  type RateParamScript,
  type VaultRegistryScript,
} from "./scripts.js";

// ══════════════════════════════════════════════════════════════════════════════
// Thời gian
// ══════════════════════════════════════════════════════════════════════════════

/** Epoch của một mốc POSIX ms — phép chia sàn trần `ms / ms_per_epoch`, KHÔNG có gốc theo
 *  mạng (khác `ProtocolUtils.posixMsToEpoch`): đúng phép mà validator dùng. */
export function epochOf(ms: bigint, msPerEpoch: bigint): bigint {
  if (msPerEpoch <= 0n) throw new Error(`ms_per_epoch phải > 0, nhận ${msPerEpoch}.`);
  if (ms < 0n) throw new Error(`mốc thời gian âm: ${ms}.`);
  return ms / msPerEpoch;
}

/** `get_epoch`: hai biên hữu hạn, `hi ≥ lo`, cùng epoch ⟹ epoch đó; khác ⟹ ném. */
export function txEpoch(loMs: bigint, hiMs: bigint, msPerEpoch: bigint): bigint {
  if (hiMs < loMs) throw new Error(`khoảng hiệu lực ngược: ${loMs} > ${hiMs}.`);
  const lo = epochOf(loMs, msPerEpoch);
  const hi = epochOf(hiMs, msPerEpoch);
  if (lo !== hi) throw new Error(`khoảng hiệu lực vắt qua hai epoch (${lo} → ${hi}).`);
  return hi;
}

export interface EpochWindow {
  fromMs: number;
  toMs: number;
  epoch: bigint;
}

/** Độ rộng tối thiểu của khoảng hiệu lực — hai slot (slot 1 s) để `ttl` > `validity_start`. */
const MIN_WINDOW_MS = 2_000;

/**
 * Khoảng hiệu lực `[now, min(now + maxWidth, cuối epoch − 1 s)]` nằm gọn trong epoch của
 * `now` — đúng điều `get_epoch` đòi. Giả định: ranh giới epoch trùng ranh giới slot (đúng
 * khi `ms_per_epoch` là bội của 1000 và gốc slot của mạng tròn giây), nên việc Lucid làm
 * tròn xuống về đầu slot không kéo biên dưới sang epoch trước.
 * Còn dưới `MIN_WINDOW_MS` trước ranh giới ⟹ ném: đợi sang epoch sau rồi dựng lại.
 */
export function epochValidityWindow(nowMs: number, msPerEpoch: bigint, maxWidthMs = 600_000): EpochWindow {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error(`nowMs không hợp lệ: ${nowMs}.`);
  const now = BigInt(nowMs);
  const epoch = epochOf(now, msPerEpoch);
  const lastSafe = (epoch + 1n) * msPerEpoch - 1_000n;
  const to = now + BigInt(maxWidthMs) < lastSafe ? now + BigInt(maxWidthMs) : lastSafe;
  if (to - now < BigInt(MIN_WINDOW_MS)) {
    throw new Error(
      `còn ${lastSafe + 1_000n - now} ms tới ranh giới epoch ${epoch + 1n} — quá sát để đặt khoảng ` +
        `hiệu lực trong một epoch; đợi sang epoch sau.`,
    );
  }
  return { fromMs: nowMs, toMs: Number(to), epoch };
}

// ══════════════════════════════════════════════════════════════════════════════
// Hàm thuần — khớp validator
// ══════════════════════════════════════════════════════════════════════════════

/** `rate.rho_at`: ρ hiệu lực ở epoch `e`. */
export function rhoAt(d: RateParam, e: bigint): bigint {
  return e >= d.effective_epoch ? d.rho_q : d.prev_rho_q;
}

function assertRhoInRange(rho: bigint, rhoMaxQ: bigint): void {
  if (rho < 0n || rho > rhoMaxQ) {
    throw new Error(`ρ = ${rho} ngoài [0, rho_max_q = ${rhoMaxQ}] (rate.rho_in_range).`);
  }
}

/** Datum genesis beacon ρ: `prev_rho_q = 0`, hiệu lực từ epoch SAU (rate_param.ak ▸ mint). */
export function genesisRateParam(rhoQ: bigint, nowEpoch: bigint, rhoMaxQ: bigint): RateParam {
  assertRhoInRange(rhoQ, rhoMaxQ);
  return { rho_q: rhoQ, prev_rho_q: 0n, effective_epoch: nowEpoch + 1n };
}

/** Datum đăng ρ mới (rate_param.ak ▸ spend): `prev_rho_q` = ρ đang hiệu lực NGAY LÚC đăng. */
export function nextRateParam(
  current: RateParam,
  newRhoQ: bigint,
  nowEpoch: bigint,
  rhoMaxQ: bigint,
): RateParam {
  assertRhoInRange(newRhoQ, rhoMaxQ);
  return { rho_q: newRhoQ, prev_rho_q: rhoAt(current, nowEpoch), effective_epoch: nowEpoch + 1n };
}

function assertGbNonNegative(gb: bigint): void {
  if (gb < 0n) throw new Error(`gb_nanogic phải ≥ 0 (bên ghi đăng max(0, thặng dư)), nhận ${gb}.`);
}

/** Datum genesis beacon GreenBack: `seq = 0`, `epoch` = epoch giao dịch. */
export function genesisGreenBackBeacon(gbNanogic: bigint, nowEpoch: bigint, depeg = false): GreenBackBeacon {
  assertGbNonNegative(gbNanogic);
  return { gb_nanogic: gbNanogic, seq: 0n, epoch: nowEpoch, depeg };
}

/** Datum ghi GreenBack mới: `seq` +1, `epoch` = epoch giao dịch (greenback_beacon.ak ▸ spend). */
export function nextGreenBackBeacon(
  current: GreenBackBeacon,
  gbNanogic: bigint,
  nowEpoch: bigint,
  depeg: boolean,
): GreenBackBeacon {
  assertGbNonNegative(gbNanogic);
  return { gb_nanogic: gbNanogic, seq: current.seq + 1n, epoch: nowEpoch, depeg };
}

/** `reset_amount = min(⌊GB / 16⌋, gb_shard_cap_nanogic)` — vế đặt lại của `shard.lazy_reset`. */
export function shardResetAmount(gbNanogic: bigint, capNanogic: bigint): bigint {
  assertGbNonNegative(gbNanogic);
  if (capNanogic < 0n) throw new Error(`gb_shard_cap_nanogic phải ≥ 0, nhận ${capNanogic}.`);
  const perShard = gbNanogic / SHARD_COUNT;
  return perShard < capNanogic ? perShard : capNanogic;
}

/**
 * `shard.lazy_reset`: beacon mới hơn ⟹ đặt lại (KHÔNG cộng dồn) về `shardResetAmount`;
 * cùng seq ⟹ giữ nguyên; beacon CŨ hơn shard ⟹ trạng thái không tới được, validator
 * từ chối ⟹ ném.
 */
export function lazyReset(shard: GbShard, beacon: GreenBackBeacon, capNanogic: bigint): GbShard {
  if (beacon.seq > shard.seq) {
    const amount = shardResetAmount(beacon.gb_nanogic, capNanogic);
    return { shard_id: shard.shard_id, seq: beacon.seq, reset_amount: amount, remaining: amount };
  }
  if (beacon.seq !== shard.seq) {
    throw new Error(`beacon.seq ${beacon.seq} < shard.seq ${shard.seq} — trạng thái không tới được.`);
  }
  return shard;
}

/** Datum shard sau lượt rút `amount` (gb_shard.ak ▸ spend). */
export function shardAfterDraw(
  shard: GbShard,
  beacon: GreenBackBeacon,
  capNanogic: bigint,
  amount: bigint,
): GbShard {
  if (amount < 0n) throw new Error(`amount phải ≥ 0, nhận ${amount}.`);
  if (beacon.depeg) throw new Error(`beacon GreenBack đang depeg — shard từ chối mọi lượt rút.`);
  const eff = lazyReset(shard, beacon, capNanogic);
  if (amount > eff.remaining) {
    throw new Error(`rút ${amount} > còn lại ${eff.remaining} ở shard ${shard.shard_id} (sau đặt lại lười).`);
  }
  return { ...eff, remaining: eff.remaining - amount };
}

/** Datum genesis shard `id`: `{ id, 0, 0, 0 }` (gb_shard.ak ▸ `genesis_shard_ok`). */
export function genesisShard(id: bigint): GbShard {
  if (id < 0n || id >= SHARD_COUNT) throw new Error(`shard_id ${id} ngoài [0, ${SHARD_COUNT}).`);
  return { shard_id: id, seq: 0n, reset_amount: 0n, remaining: 0n };
}

/** `registry.vault_list_ok`: không rỗng, mỗi phần tử đúng 28 byte, không trùng. */
export function assertVaultList(hashes: readonly string[]): void {
  if (hashes.length === 0) throw new Error(`sổ két rỗng — không shard nào rút được, và sổ không sửa được.`);
  const seen = new Set<string>();
  for (const h of hashes) {
    if (!new RegExp(`^[0-9a-f]{${SCRIPT_HASH_BYTES * 2}}$`).test(h)) {
      throw new Error(`hash két "${h}" không phải ${SCRIPT_HASH_BYTES} byte hex (chữ thường).`);
    }
    if (seen.has(h)) throw new Error(`hash két "${h}" trùng trong sổ.`);
    seen.add(h);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Kiểm UTxO đầu vào
// ══════════════════════════════════════════════════════════════════════════════

function assertIsSeed(utxo: UTxO, seed: OutRef, label: string): void {
  if (utxo.txHash !== seed.txHash || utxo.outputIndex !== seed.outputIndex) {
    throw new Error(
      `${label}: UTxO ${utxo.txHash}#${utxo.outputIndex} không phải seed đã apply ` +
        `${seed.txHash}#${seed.outputIndex} — đúc sẽ bị từ chối.`,
    );
  }
}

function assertCarries(utxo: UTxO, unit: string, label: string): void {
  const q = utxo.assets[unit];
  if (q !== 1n) {
    throw new Error(`${label}: UTxO ${utxo.txHash}#${utxo.outputIndex} mang ${String(q ?? 0n)} đơn vị ${unit}, cần đúng 1.`);
  }
}

function assertAt(utxo: UTxO, address: string, label: string): void {
  if (utxo.address !== address) {
    throw new Error(`${label}: UTxO ${utxo.txHash}#${utxo.outputIndex} ở ${utxo.address}, không phải ${address}.`);
  }
}

/** Payment credential của UTxO là `Script(hash)` — so theo credential, không theo chuỗi địa chỉ
 *  (beacon có thể mang stake credential khác mà validator shard vẫn nhận). */
function assertAtScript(utxo: UTxO, scriptHash: string, label: string): void {
  const cred = getAddressDetails(utxo.address).paymentCredential;
  if (cred?.type !== "Script" || cred.hash !== scriptHash) {
    throw new Error(`${label}: UTxO ${utxo.txHash}#${utxo.outputIndex} không nằm tại Script(${scriptHash}).`);
  }
}

function inline(value: string) {
  return { kind: "inline" as const, value };
}

function withWindow(tx: TxBuilder, w: EpochWindow): TxBuilder {
  return tx.validFrom(w.fromMs).validTo(w.toMs);
}

export interface Built<T> {
  tx: TxBuilder;
  datum: T;
}

// ══════════════════════════════════════════════════════════════════════════════
// (a) Sổ két — vault_registry
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Đúc sổ két (bước 5 thứ tự deploy): tiêu `seedUtxo`, đúc 1 NFT "VRG", khoá tại chính script
 * với datum `VaultRegistry { vaultScriptHashes }`. Sổ BẤT BIẾN sau giao dịch này (spend luôn
 * từ chối) — danh sách phải là hash két ĐÃ APPLY `gb_shard_policy_id` = `gbShard.hash`.
 */
export function mintVaultRegistryTx(
  lucid: LucidEvolution,
  p: { vaultRegistry: VaultRegistryScript; seedUtxo: UTxO; vaultScriptHashes: readonly string[] },
): Built<{ vault_script_hashes: string[] }> {
  assertIsSeed(p.seedUtxo, p.vaultRegistry.seed, "vault_registry");
  assertVaultList(p.vaultScriptHashes);
  const datum = { vault_script_hashes: [...p.vaultScriptHashes] };
  const tx = lucid
    .newTx()
    .collectFrom([p.seedUtxo])
    .mintAssets({ [p.vaultRegistry.nftUnit]: 1n }, IGNORED_REDEEMER)
    .attach.MintingPolicy(p.vaultRegistry.script)
    .pay.ToContract(p.vaultRegistry.address, inline(encodeVaultRegistry(datum)), {
      [p.vaultRegistry.nftUnit]: 1n,
    });
  return { tx, datum };
}

// ══════════════════════════════════════════════════════════════════════════════
// (b) Beacon ρ — rate_param
// ══════════════════════════════════════════════════════════════════════════════

/** Khởi tạo beacon ρ: tiêu seed, đúc "RHO", datum `{ rhoQ, 0, epoch+1 }`, khoá đăng ký. */
export function initRateBeaconTx(
  lucid: LucidEvolution,
  p: { rate: RateParamScript; seedUtxo: UTxO; rhoQ: bigint; nowMs: number },
): Built<RateParam> {
  assertIsSeed(p.seedUtxo, p.rate.seed, "rate_param");
  const w = epochValidityWindow(p.nowMs, p.rate.msPerEpoch);
  const datum = genesisRateParam(p.rhoQ, w.epoch, p.rate.rhoMaxQ);
  const tx = withWindow(
    lucid
      .newTx()
      .collectFrom([p.seedUtxo])
      .mintAssets({ [p.rate.nftUnit]: 1n }, IGNORED_REDEEMER)
      .attach.MintingPolicy(p.rate.script)
      .pay.ToContract(p.rate.address, inline(encodeRateParam(datum)), { [p.rate.nftUnit]: 1n })
      .addSignerKey(p.rate.rateKey),
    w,
  );
  return { tx, datum };
}

/** Đăng ρ mới: hiệu lực từ epoch SAU, `prev_rho_q` = ρ hiệu lực lúc đăng, `≤ rho_max_q`. */
export function postRateTx(
  lucid: LucidEvolution,
  p: { rate: RateParamScript; beaconUtxo: UTxO; newRhoQ: bigint; nowMs: number },
): Built<RateParam> {
  const current = decodeRateParam(p.beaconUtxo.datum);
  const w = epochValidityWindow(p.nowMs, p.rate.msPerEpoch);
  const datum = nextRateParam(current, p.newRhoQ, w.epoch, p.rate.rhoMaxQ);
  return { tx: spendRateBeaconRaw(lucid, { ...p, next: datum, signer: p.rate.rateKey, window: w }), datum };
}

/** Đường THÔ tiêu beacon ρ — không kiểm ngữ nghĩa `next`/`signer`. */
export function spendRateBeaconRaw(
  lucid: LucidEvolution,
  p: { rate: RateParamScript; beaconUtxo: UTxO; next: RateParam; signer: string; window: EpochWindow },
): TxBuilder {
  assertAt(p.beaconUtxo, p.rate.address, "beacon ρ");
  assertCarries(p.beaconUtxo, p.rate.nftUnit, "beacon ρ");
  return withWindow(
    lucid
      .newTx()
      .collectFrom([p.beaconUtxo], IGNORED_REDEEMER)
      .attach.SpendingValidator(p.rate.script)
      .pay.ToContract(p.beaconUtxo.address, inline(encodeRateParam(p.next)), p.beaconUtxo.assets)
      .addSignerKey(p.signer),
    p.window,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// (c) Beacon GreenBack — greenback_beacon
// ══════════════════════════════════════════════════════════════════════════════

/** Khởi tạo beacon GB: tiêu seed, đúc "GBB", datum `{ gb, 0, epoch, depeg }`, khoá ghi ký. */
export function initGreenBackBeaconTx(
  lucid: LucidEvolution,
  p: { greenback: GreenBackBeaconScript; seedUtxo: UTxO; gbNanogic: bigint; depeg?: boolean; nowMs: number },
): Built<GreenBackBeacon> {
  assertIsSeed(p.seedUtxo, p.greenback.seed, "greenback_beacon");
  const w = epochValidityWindow(p.nowMs, p.greenback.msPerEpoch);
  const datum = genesisGreenBackBeacon(p.gbNanogic, w.epoch, p.depeg ?? false);
  const tx = withWindow(
    lucid
      .newTx()
      .collectFrom([p.seedUtxo])
      .mintAssets({ [p.greenback.nftUnit]: 1n }, IGNORED_REDEEMER)
      .attach.MintingPolicy(p.greenback.script)
      .pay.ToContract(p.greenback.address, inline(encodeGreenBackBeacon(datum)), {
        [p.greenback.nftUnit]: 1n,
      })
      .addSignerKey(p.greenback.writer),
    w,
  );
  return { tx, datum };
}

/** Ghi GreenBack mới: `seq` +1, `epoch` = epoch giao dịch, `gb ≥ 0`. */
export function postGreenBackTx(
  lucid: LucidEvolution,
  p: { greenback: GreenBackBeaconScript; beaconUtxo: UTxO; gbNanogic: bigint; depeg: boolean; nowMs: number },
): Built<GreenBackBeacon> {
  const current = decodeGreenBackBeacon(p.beaconUtxo.datum);
  const w = epochValidityWindow(p.nowMs, p.greenback.msPerEpoch);
  const datum = nextGreenBackBeacon(current, p.gbNanogic, w.epoch, p.depeg);
  return {
    tx: spendGreenBackBeaconRaw(lucid, { ...p, next: datum, signer: p.greenback.writer, window: w }),
    datum,
  };
}

/** Đường THÔ tiêu beacon GreenBack — không kiểm ngữ nghĩa `next`/`signer`. */
export function spendGreenBackBeaconRaw(
  lucid: LucidEvolution,
  p: { greenback: GreenBackBeaconScript; beaconUtxo: UTxO; next: GreenBackBeacon; signer: string; window: EpochWindow },
): TxBuilder {
  assertAt(p.beaconUtxo, p.greenback.address, "beacon GreenBack");
  assertCarries(p.beaconUtxo, p.greenback.nftUnit, "beacon GreenBack");
  return withWindow(
    lucid
      .newTx()
      .collectFrom([p.beaconUtxo], IGNORED_REDEEMER)
      .attach.SpendingValidator(p.greenback.script)
      .pay.ToContract(p.beaconUtxo.address, inline(encodeGreenBackBeacon(p.next)), p.beaconUtxo.assets)
      .addSignerKey(p.signer),
    p.window,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// (d) 16 shard GB — gb_shard
// ══════════════════════════════════════════════════════════════════════════════

/** Đúc 16 shard "GBS"‖0..15, mỗi cái một output tại chính script, datum `{ id, 0, 0, 0 }`. */
export function mintGbShardsTx(
  lucid: LucidEvolution,
  p: { gbShard: GbShardScript; seedUtxo: UTxO },
): Built<GbShard[]> {
  assertIsSeed(p.seedUtxo, p.gbShard.seed, "gb_shard");
  const ids = Array.from({ length: Number(SHARD_COUNT) }, (_, i) => BigInt(i));
  const mint: Record<string, bigint> = {};
  for (const id of ids) mint[p.gbShard.nftUnit(id)] = 1n;
  let tx = lucid
    .newTx()
    .collectFrom([p.seedUtxo])
    .mintAssets(mint, IGNORED_REDEEMER)
    .attach.MintingPolicy(p.gbShard.script);
  const datums = ids.map(genesisShard);
  for (const d of datums) {
    tx = tx.pay.ToContract(p.gbShard.address, inline(encodeGbShard(d)), { [p.gbShard.nftUnit(d.shard_id)]: 1n });
  }
  return { tx, datum: datums };
}

/**
 * Gắn lượt rút `amount` từ shard vào `tx` (một giao dịch két — người gọi tự thêm nhánh két).
 * Đọc beacon GreenBack + sổ két làm reference input, tiêu shard với `Draw { amount }`, trả
 * shard với datum `shardAfterDraw`. Nếu đưa `vaultScriptHash` thì kiểm trước nó có trong sổ.
 */
export function addShardDraw(
  tx: TxBuilder,
  p: {
    gbShard: GbShardScript;
    shardUtxo: UTxO;
    beaconUtxo: UTxO;
    registryUtxo: UTxO;
    registry: Pick<VaultRegistryScript, "nftUnit" | "address">;
    amount: bigint;
    vaultScriptHash?: string;
  },
): Built<GbShard> {
  assertAtScript(p.beaconUtxo, p.gbShard.gbBeaconScriptHash, "beacon GreenBack");
  assertCarries(p.beaconUtxo, toUnit(p.gbShard.gbBeaconNftPolicy, GREENBACK_NFT_NAME), "beacon GreenBack");
  assertCarries(p.registryUtxo, p.registry.nftUnit, "sổ két");
  assertAt(p.registryUtxo, p.registry.address, "sổ két");
  if (p.vaultScriptHash !== undefined) {
    const reg = decodeVaultRegistry(p.registryUtxo.datum);
    if (!reg.vault_script_hashes.includes(p.vaultScriptHash)) {
      throw new Error(`két ${p.vaultScriptHash} không có trong sổ — shard sẽ từ chối.`);
    }
  }
  const shard = decodeGbShard(p.shardUtxo.datum);
  const beacon = decodeGreenBackBeacon(p.beaconUtxo.datum);
  const next = shardAfterDraw(shard, beacon, p.gbShard.capNanogic, p.amount);
  return {
    tx: addShardSpendRaw(tx, {
      gbShard: p.gbShard,
      shardUtxo: p.shardUtxo,
      refs: [p.beaconUtxo, p.registryUtxo],
      amount: p.amount,
      next,
    }),
    datum: next,
  };
}

/** Đường THÔ tiêu shard — không kiểm `next`/`amount`/reference input. */
export function addShardSpendRaw(
  tx: TxBuilder,
  p: { gbShard: GbShardScript; shardUtxo: UTxO; refs: UTxO[]; amount: bigint; next: GbShard },
): TxBuilder {
  assertAt(p.shardUtxo, p.gbShard.address, "shard GB");
  const id = decodeGbShard(p.shardUtxo.datum).shard_id;
  assertCarries(p.shardUtxo, p.gbShard.nftUnit(id), "shard GB");
  return tx
    .readFrom(p.refs)
    .collectFrom([p.shardUtxo], encodeGbShardRedeemer({ amount: p.amount }))
    .attach.SpendingValidator(p.gbShard.script)
    .pay.ToContract(p.shardUtxo.address, inline(encodeGbShard(p.next)), p.shardUtxo.assets);
}

/** Đọc datum `GbShard` của một UTxO shard (tiện cho người gọi). */
export function readShard(utxo: UTxO): GbShard {
  return decodeGbShard(utxo.datum);
}
