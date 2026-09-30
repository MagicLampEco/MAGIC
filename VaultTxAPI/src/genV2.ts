// VaultTxAPI/src/genV2.ts — Gen v2.0 ở tầng dịch vụ: cổng cấu hình, đọc beacon/shard từ
// chuỗi, và trần `m` của một lượt InstantGen.
//
// ── VÌ SAO CÁC PHÉP ĐỌC NẰM Ở TẦNG DỊCH VỤ, KHÔNG Ở `SdkTxBuilder` ─────────────────
// Cùng lý do cổng cấu hình `instant` cũ nằm ở `service.ts`: một cổng chỉ sống trong MỘT
// hiện thực của `TxBuilderPort` thì nó gác hiện thực đó, không gác khái niệm. Ở đây còn
// thêm một lý do đo được: trần `m` (`instantGenLimits(..).maxM`) phải được so TRƯỚC khi
// dựng, để `m` vượt trần ra một mã 422 riêng chứ không ra câu từ chối chung của bộ dựng —
// và phép so đó cần đúng các UTxO beacon/shard mà bộ dựng sẽ dùng. Đọc một lần ở đây rồi
// giao UTxO xuống bộ dựng là cách duy nhất để hai bên chắc chắn nhìn CÙNG ảnh chụp chuỗi.
//
// Công thức KHÔNG ở đây: `instantGenLimits` là của `@magiclamp/instantgen-sdk` (gương trùng
// bit với validator). Tệp này chỉ tìm UTxO theo NFT, giải mã datum, và NÉM có mã.

import { Data, type UTxO } from "@lucid-evolution/lucid";
import {
  GREENBACK_NFT_NAME, GbShard, GreenBackBeacon, RATE_NFT_NAME, RateParam, VAULT_REGISTRY_NFT_NAME,
  instantGenLimits, shardNftName, vaultShardId,
  type InstantGenLimits, type InstantVaultParams, type OwnerCredentialData,
  type VaultDatum as InstantVaultDatum, type WakemeRead,
} from "@magiclamp/instantgen-sdk";
import { msPerEpoch, type Network } from "@magiclamp/protocol-utils";
import { decodeVaultDatumOfKind } from "@magiclamp/sdk";
import type { GenBeaconParams } from "@magiclamp/schedulegen-sdk";

import type { ChainReader } from "./chain.js";
import type { Deployment, GenV2Deployment, OutRefConfig } from "./config.js";
import { ChainUnavailableError, CodedApiError, ConfigMissingError, TxBuildRejectedError } from "./errors.js";
import { wakemeScriptHashOrThrow } from "./wakeme.js";

/** Khối `gen_v2` của bản deploy. Vắng ⟹ 501 `CONFIG_MISSING`, nói rõ route nào cần nó. */
export function requireGenV2(d: Deployment, route: string): GenV2Deployment {
  if (d.genV2 === undefined) {
    throw new ConfigMissingError(
      `Đường ${route} cần beacon Gen v2.0 nhưng bản deploy thiếu khối \`gen_v2\` ` +
      `(rate_beacon_address · rate_nft_policy · greenback_beacon_address · ` +
      `greenback_beacon_nft_policy · gb_shard_address · gb_shard_cap_nanogic · ` +
      `vault_registry_address). Validator fail-closed quanh các beacon này — mở đường khi ` +
      `thiếu chúng là dựng tx nào cũng chết trên chuỗi.`,
      { missing: "deployment.gen_v2", route },
    );
  }
  return d.genV2;
}

/** UTxO script tham chiếu tuỳ chọn (`commit`, `gb_shard`). Vắng ⟹ 501 `CONFIG_MISSING`. */
export function requireRefScript(d: Deployment, key: "commit" | "gbShard", route: string): OutRefConfig {
  const ref = d.refScriptUtxos[key];
  if (ref === undefined) {
    const json = key === "gbShard" ? "gb_shard" : key;
    throw new ConfigMissingError(
      `Đường ${route} cần UTxO script tham chiếu \`ref_script_utxos.${json}\` nhưng bản deploy không khai.`,
      { missing: `deployment.ref_script_utxos.${json}`, route },
    );
  }
  return ref;
}

/**
 * Chín apply-param của két InstantGen v2.0, theo đúng tên của gói nền. `wakeme_vault_hash`
 * và `ms_per_epoch` là tham số THEO MẠNG của `@magiclamp/protocol-utils` — cùng nguồn mà bộ
 * dựng genesis dùng; mạng chưa có két Wakeme ⟹ 501 `WAKEME_VAULT_UNAVAILABLE`.
 */
export function instantVaultParamsOf(d: Deployment, g: GenV2Deployment, network: Network): InstantVaultParams {
  return {
    lampPolicyId: d.lampPolicyId,
    lampAssetName: d.lampAssetNameHex,
    gbBeaconNftPolicy: g.gbBeaconNftPolicy,
    gbBeaconScriptHash: g.gbBeaconScriptHash,
    gbShardPolicyId: g.gbShardPolicyId,
    rateNftPolicy: g.rateNftPolicy,
    rateScriptHash: g.rateScriptHash,
    wakemeVaultHash: wakemeScriptHashOrThrow(network),
    msPerEpoch: msPerEpoch(network),
  };
}

/** Phần beacon của `CommitParams.gen` (ScheduleGen). */
export function scheduleGenBeaconParamsOf(g: GenV2Deployment): GenBeaconParams {
  return {
    gbBeaconNftPolicy: g.gbBeaconNftPolicy,
    gbBeaconScriptHash: g.gbBeaconScriptHash,
    gbShardPolicyId: g.gbShardPolicyId,
    rateNftPolicy: g.rateNftPolicy,
    rateScriptHash: g.rateScriptHash,
    gbShardCapNanogic: g.gbShardCapNanogic,
  };
}

/** Đúng MỘT UTxO mang NFT `nftUnit` (số lượng 1). 0 hoặc >1 ⟹ 502 `CHAIN_UNAVAILABLE`. */
export function pickByNft(utxos: UTxO[], nftUnit: string, what: string): UTxO {
  const hits = utxos.filter(u => (u.assets[nftUnit] ?? 0n) === 1n);
  if (hits.length === 0) {
    throw new ChainUnavailableError(
      `Không tìm thấy UTxO nào mang NFT của ${what} (${nftUnit.slice(0, 20)}…).`,
      { what, nft_unit: nftUnit },
    );
  }
  if (hits.length > 1) {
    throw new ChainUnavailableError(
      `Có ${hits.length} UTxO cùng mang NFT của ${what} — bất khả trên sổ cái đã lắng. ` +
      `Từ chối chọn đại một cái.`,
      { what, nft_unit: nftUnit, utxo_refs: hits.map(u => `${u.txHash}#${u.outputIndex}`) },
    );
  }
  return hits[0]!;
}

export async function readRateBeaconUtxo(chain: ChainReader, g: GenV2Deployment): Promise<UTxO> {
  return pickByNft(await chain.utxosAt(g.rateBeaconAddress), g.rateNftPolicy + RATE_NFT_NAME, "beacon ρ (RHO)");
}

export async function readGbBeaconUtxo(chain: ChainReader, g: GenV2Deployment): Promise<UTxO> {
  return pickByNft(await chain.utxosAt(g.gbBeaconAddress), g.gbBeaconNftPolicy + GREENBACK_NFT_NAME, "beacon GreenBack (GBB)");
}

export async function readVaultRegistryUtxo(chain: ChainReader, g: GenV2Deployment): Promise<UTxO> {
  return pickByNft(
    await chain.utxosAt(g.vaultRegistryAddress), g.vaultRegistryPolicy + VAULT_REGISTRY_NFT_NAME, "sổ két (VRG)",
  );
}

/** Mọi UTxO ở địa chỉ shard GB. Rỗng ⟹ 502 — nhánh sinh tiêu đúng một shard, không có thì không dựng được. */
export async function readGbShardUtxos(chain: ChainReader, g: GenV2Deployment): Promise<UTxO[]> {
  const all = await chain.utxosAt(g.gbShardAddress);
  if (all.length === 0) {
    throw new ChainUnavailableError(
      `Địa chỉ shard GreenBack ${g.gbShardAddress.slice(0, 20)}… không có UTxO nào.`,
      { gb_shard_address: g.gbShardAddress },
    );
  }
  return all;
}

/** Shard GB của ĐÚNG két này: NFT `"GBS" ‖ vault_shard_id(owner)` (gói nền, gương `greenback.ak`). */
export function gbShardUtxoOf(shards: UTxO[], g: GenV2Deployment, owner: OwnerCredentialData): UTxO {
  const id = vaultShardId(owner);
  return pickByNft(shards, g.gbShardPolicyId + shardNftName(id), `shard GreenBack ${id}`);
}

/** Datum inline của một UTxO beacon/shard, giải bằng lược đồ gói nền. Sai ⟹ 502: dữ kiện chuỗi hỏng. */
export function decodeInline<T>(u: UTxO, schema: T, what: string): T {
  if (typeof u.datum !== "string" || u.datum === "") {
    throw new ChainUnavailableError(`${what} ${u.txHash}#${u.outputIndex} không mang datum inline.`,
      { what, utxo_ref: `${u.txHash}#${u.outputIndex}` });
  }
  try {
    return Data.from(u.datum, schema as never) as T;
  } catch (e) {
    throw new ChainUnavailableError(
      `datum ${what} ${u.txHash}#${u.outputIndex} sai hình dạng: ${(e as Error).message}`,
      { what, utxo_ref: `${u.txHash}#${u.outputIndex}` },
    );
  }
}

/** Datum két Instant v2.0 (20 trường) của UTxO két. v1 / hình dạng khác ⟹ NÉM (gói nền). */
export function instantVaultDatumOf(vaultUtxo: UTxO): InstantVaultDatum {
  if (typeof vaultUtxo.datum !== "string" || vaultUtxo.datum === "") {
    throw new ChainUnavailableError("UTxO két không mang datum inline.",
      { utxo_ref: `${vaultUtxo.txHash}#${vaultUtxo.outputIndex}` });
  }
  return decodeVaultDatumOfKind("Instant", vaultUtxo.datum) as unknown as InstantVaultDatum;
}

/**
 * Lượt tiêu này có làm mới checkpoint không — gương `checkpoint.ak ▸ expected_checkpoint`:
 * `cap_epoch < e` ⟹ làm mới (đòi beacon ρ; `wakeme_link != ""` ⟹ đòi két Wakeme đang ghim).
 */
export function instantCheckpointNeed(d: InstantVaultDatum, epoch: bigint): { refresh: boolean; wakemeLink: string } {
  return { refresh: d.cap_epoch < epoch, wakemeLink: d.wakeme_link };
}

/** Các UTxO mà một lượt InstantGen đọc/tiêu — đọc MỘT lần ở tầng dịch vụ, giao nguyên xuống bộ dựng. */
export interface InstantGenRefs {
  /** Beacon ρ — luôn đọc (bộ dựng chỉ đưa vào tx khi lượt này làm mới checkpoint). */
  rateBeaconUtxo: UTxO;
  greenbackBeaconUtxo: UTxO;
  vaultRegistryUtxo: UTxO;
  /** Shard GB của két (bị TIÊU). */
  gbShardUtxo: UTxO;
}

export async function readInstantGenRefs(
  chain: ChainReader, g: GenV2Deployment, owner: OwnerCredentialData,
): Promise<InstantGenRefs> {
  const [rateBeaconUtxo, greenbackBeaconUtxo, vaultRegistryUtxo, shards] = await Promise.all([
    readRateBeaconUtxo(chain, g), readGbBeaconUtxo(chain, g), readVaultRegistryUtxo(chain, g), readGbShardUtxos(chain, g),
  ]);
  return { rateBeaconUtxo, greenbackBeaconUtxo, vaultRegistryUtxo, gbShardUtxo: gbShardUtxoOf(shards, g, owner) };
}

/**
 * Trần của lượt sinh ở ảnh chụp chuỗi đã đọc — `instantGenLimits` của gói nền. Vế validator
 * `fail` bất kể `m` (beacon depeg/cũ, LAMP dưới mức giữ tối thiểu…) ⟹ 422 `TX_BUILD_REJECTED`
 * với NGUYÊN VĂN câu của gói nền, như mọi lời từ chối giao thức khác của dịch vụ này.
 */
export function instantLimitsOf(args: {
  vaultUtxo: UTxO;
  vaultDatum: InstantVaultDatum;
  epoch: bigint;
  refs: InstantGenRefs;
  wakeme: WakemeRead | null;
  g: GenV2Deployment;
}): InstantGenLimits {
  const rate = decodeInline(args.refs.rateBeaconUtxo, RateParam, "beacon ρ");
  const greenback = decodeInline(args.refs.greenbackBeaconUtxo, GreenBackBeacon, "beacon GreenBack");
  const shardIn = decodeInline(args.refs.gbShardUtxo, GbShard, "shard GreenBack");
  try {
    return instantGenLimits({
      vaultDatum: args.vaultDatum,
      vaultOutRef: { txHash: args.vaultUtxo.txHash, outputIndex: args.vaultUtxo.outputIndex },
      currentEpoch: args.epoch,
      rate,
      wakeme: args.wakeme,
      greenback,
      shardIn,
      gbShardCapNanogic: args.g.gbShardCapNanogic,
    });
  } catch (e) {
    if (e instanceof Error) throw new TxBuildRejectedError(e.message, { thrown_by: "instantGenLimits" });
    throw e;
  }
}

/**
 * `m` phải nằm trong `(0, maxM]`. Vượt ⟹ 422 `INSTANT_GEN_M_ABOVE_MAX`, kèm `max_m` để app
 * hiện được con số đúng thay vì một câu từ chối chung. `maxM = 0` ⟹ epoch này không sinh
 * thêm được gì — cùng mã, `max_m: "0"`.
 */
export function assertMWithinMax(m: bigint, limits: InstantGenLimits): void {
  if (m > limits.maxM) {
    throw new CodedApiError(422, "INSTANT_GEN_M_ABOVE_MAX",
      `"m" = ${m} nanogic vượt lượng còn sinh được trong epoch này (${limits.maxM} nanogic).`,
      {
        m: m.toString(), max_m: limits.maxM.toString(),
        gen_so_far: limits.genSoFar.toString(), cap_nanogic: limits.capNanogic.toString(),
        cap_lamp: limits.capLamp.toString(), gb_available: limits.gbAvailable.toString(),
      });
  }
}
