// scripts/farmers/src/did.ts — dựng tx đúc PersonDID MÔ PHỎNG (`GenesisPerson { rand_256 }`).
//
// Hợp đồng nhị phân đọc từ PhoenixKey-Validator (CHỈ ĐỌC, trích theo TÊN):
//   validators/taad.ak ▸ `mint` — redeemer `StateNftRedeemer` KHÔNG bọc: GenesisPerson = Constr 0 [rand_256]
//   lib/phoenixkey/state_nft_logic.ak ▸ nhánh `GenesisPerson`, `is_fresh`, `person_genesis_guardians_ok`
//   lib/phoenixkey/pop_bind.ak ▸ `inner_hash`, `canonical_did`, `base32_genesis_ms`, `hex_lower`
//   lib/phoenixkey/types.ak ▸ `TAADDatum` (17 trường), `EntityType` (Person = 0), `TAADStatus` (Active = 0),
//                               `TAADRedeemer` (`ThreadUpdate` = Constr 10)
//   lib/phoenixkey/pa2_uniqueness_logic.ak ▸ `ShardDatum`, `ThreadRedeemer` (RegisterName = 0), `shard_of`,
//                               `shard_name` = "pk-uniq" ‖ byte(i), `genesis_uniqueness_ok`
//   lib/phoenixkey/pa2_smt.ak ▸ `register_transition_ok` (xem smt.ts)
//
// Dấu DID mô phỏng: CIP-20 metadata 674, nhãn `magiclamp:did-sim:v1`; sổ DID mô phỏng là một
// mục trong `scripts/DEPLOYED.md`. Lá chắn mainnet thật KHÔNG phải nhãn này mà là policy id
// (seed apply-param của `taad`): DID mô phỏng không bao giờ mang policy của mainnet.

import { createECDH, createHash } from "node:crypto";

import {
  Constr,
  Data,
  credentialToAddress,
  slotToUnixTime,
  unixTimeToSlot,
  type LucidEvolution,
  type Network,
  type UTxO,
} from "@lucid-evolution/lucid";

import { blake2b256, bytesToHex, hexToBytes, registerProof, type RegisterProof } from "./smt.ts";

export const SHARD_COUNT = 256; // pa2_uniqueness_logic ▸ shard_count
export const SHARD_PREFIX_HEX = "706b2d756e6971"; // "pk-uniq"
export const DID_SIM_LABEL = "magiclamp:did-sim:v1";
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

const NONE = () => new Constr(1, []);
const UNIT0 = () => new Constr(0, []);

/** pop_bind ▸ base32_genesis_ms: base32 chữ thường, không đệm, của 8 byte BE — luôn 13 ký tự. */
export function base32GenesisMs(ms: bigint): string {
  if (ms < 0n || ms >= 1n << 64n) throw new Error("genesis_ms ngoài miền u64");
  const v = ms << 1n; // 65 bit — đệm một bit 0 cho đủ bội của 5
  let s = "";
  for (let j = 12; j >= 0; j--) s += B32[Number((v >> BigInt(5 * j)) & 31n)];
  return s;
}

function u64be(ms: bigint): Uint8Array {
  const b = new Uint8Array(8);
  let x = ms;
  for (let i = 7; i >= 0; i--) {
    b[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return b;
}

/** pop_bind ▸ inner_hash cho Person gốc (parent_did = None ⟹ enc_creator = 0x00). */
export function innerHashPerson(genesisMs: bigint, rand256Hex: string, controllerPkh: string): string {
  const rand = hexToBytes(rand256Hex);
  const pkh = hexToBytes(controllerPkh);
  if (rand.length !== 32) throw new Error("rand_256 phải dài 32 byte");
  if (pkh.length !== 28) throw new Error("controller_pkh phải dài 28 byte");
  const pre = new Uint8Array(1 + 1 + 8 + 32 + 28);
  pre[0] = 0; // enc_type(Person)
  pre[1] = 0; // enc_creator(None)
  pre.set(u64be(genesisMs), 2);
  pre.set(rand, 10);
  pre.set(pkh, 42);
  return bytesToHex(blake2b256(pre));
}

export function canonicalDid(genesisMs: bigint, innerHex: string): string {
  return `did:phoenix:${base32GenesisMs(genesisMs)}:${innerHex}`;
}

export function utf8Hex(s: string): string {
  return Buffer.from(s, "utf8").toString("hex");
}

/** asset name của anchor = blake2b_256(did-string UTF-8). */
export function anchorName(did: string): string {
  return bytesToHex(blake2b256(new TextEncoder().encode(did)));
}

export function shardOf(nameHex: string): number {
  return Number.parseInt(nameHex.slice(0, 2), 16) % SHARD_COUNT;
}

export function shardAssetName(i: number): string {
  return SHARD_PREFIX_HEX + i.toString(16).padStart(2, "0");
}

/** Khoá phần cứng mô phỏng: pubkey P-256 nén, suy tất định từ rand_256 (không ai giữ khoá bí mật này). */
export function simulatedHwPubkey(rand256Hex: string): string {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(createHash("sha256").update(`did-sim-hw:${rand256Hex}`).digest());
  return ecdh.getPublicKey("hex", "compressed");
}

export interface TaadDatumInput {
  didHex: string;
  controllerPkh: string;
  hwPubkeyHex: string;
  guardians: string[];
  devicePkh: string;
}

/** types ▸ TAADDatum, 17 trường đúng thứ tự, giá trị genesis theo `is_fresh`. */
export function taadGenesisDatum(d: TaadDatumInput): string {
  return Data.to(
    new Constr(0, [
      d.didHex, // did
      UNIT0(), // entity_type = Person
      d.controllerPkh, // controller_pkh
      d.hwPubkeyHex, // hw_key_pubkey
      0n, // sequence
      UNIT0(), // status = Active
      d.guardians, // guardians
      NONE(), // parent_did
      NONE(), // revoked_ms
      NONE(), // recovery_anchor
      NONE(), // limit_meter_policy
      NONE(), // pending_meter_policy
      NONE(), // pending_meter_ms
      0n, // depth
      d.devicePkh, // device_pkh
      [], // aux_device_pkhs
      NONE(), // wakeme_vault_policy
    ]),
  );
}

export function decodeShardDatum(u: UTxO): { shard: number; root: string } {
  if (!u.datum) throw new Error(`shard ${u.txHash}#${u.outputIndex} không có datum inline`);
  const c = Data.from(u.datum) as Constr<unknown>;
  if (!(c instanceof Constr) || c.index !== 0 || c.fields.length !== 2) throw new Error("ShardDatum sai hình dạng");
  const [shard, root] = c.fields as [bigint, string];
  return { shard: Number(shard), root };
}

export interface DidMintParams {
  lucid: LucidEvolution; // ví đã chọn = ví nông dân (controller)
  network: Network;
  taadPolicyId: string;
  taadRefUtxo: UTxO;
  controllerPkh: string;
  devicePkh: string;
  guardians: string[];
  rand256: string;
  /** Mọi tên anchor Live hiện có dưới policy (đã loại tên `pk-uniq*`). */
  existingAnchorNames: string[];
  validToMs: number;
  metadataMsg: string[];
  /** Tập dượt đột biến: redeemer mang rand_256 lệch một bit ⟹ pop_bind phải từ chối. */
  mutateRand?: boolean;
  /** true (mặc định): validator chạy cục bộ bằng UPLC. false: nhờ provider đánh giá (Ogmios). */
  localEval?: boolean;
}

export interface DidMintBuilt {
  did: string;
  anchorName: string;
  shard: number;
  genesisMs: bigint;
  proof: RegisterProof;
  txCbor: string;
  fee: bigint;
  sizeBytes: number;
}

export async function buildDidMintTx(p: DidMintParams): Promise<DidMintBuilt> {
  if (p.taadRefUtxo.scriptRef == null) throw new Error("UTxO ref-script taad không mang script");
  const guardians = [...new Set(p.guardians)];
  if (guardians.length !== p.guardians.length) throw new Error("người bảo hộ trùng nhau");
  if (guardians.length < 2 || guardians.length > 5) throw new Error(`cần 2..5 người bảo hộ (có ${guardians.length})`);
  if (p.devicePkh === p.controllerPkh) throw new Error("device_pkh phải khác controller_pkh");

  // genesis_ms == upper_bound của tx. Lucid đổi mốc ms → slot khi dựng, nên lấy đúng giá
  // trị slot đổi ngược ra, không lấy mốc đầu vào (lệch phần dưới giây là chết pop_bind).
  const slot = unixTimeToSlot(p.network, p.validToMs);
  const genesisMs = BigInt(slotToUnixTime(p.network, slot));
  const inner = innerHashPerson(genesisMs, p.rand256, p.controllerPkh);
  const did = canonicalDid(genesisMs, inner);
  const name = anchorName(did);
  const shard = shardOf(name);

  const taadAddr = credentialToAddress(p.network, { type: "Script", hash: p.taadPolicyId });
  const shardUnit = p.taadPolicyId + shardAssetName(shard);
  const shardUtxo = await p.lucid.utxoByUnit(shardUnit);
  if (shardUtxo.address !== taadAddr) throw new Error(`shard ${shard} không nằm ở địa chỉ taad`);
  const sd = decodeShardDatum(shardUtxo);
  if (sd.shard !== shard) throw new Error(`ShardDatum.shard = ${sd.shard}, kỳ vọng ${shard}`);

  const keysInShard = p.existingAnchorNames.filter((n) => shardOf(n) === shard);
  const proof = registerProof(keysInShard, name);
  if (proof.oldRoot !== sd.root) {
    throw new Error(
      `root shard ${shard} trên chuỗi (${sd.root.slice(0, 16)}…) ≠ root tính từ ${keysInShard.length} tên đang Live ` +
        `(${proof.oldRoot.slice(0, 16)}…) — danh sách anchor đọc được không khớp cây`,
    );
  }

  const unit = p.taadPolicyId + name;
  const lastByte = Number.parseInt(p.rand256.slice(62), 16);
  const mintRand = p.mutateRand ? p.rand256.slice(0, 62) + (lastByte ^ 1).toString(16).padStart(2, "0") : p.rand256;
  const mintRedeemer = Data.to(new Constr(0, [mintRand]));
  const spendRedeemer = Data.to(
    new Constr(10, [new Constr(0, [name, new Constr(0, []), proof.bitmap, proof.siblings, proof.newRoot])]),
  );
  const anchorDatum = taadGenesisDatum({
    didHex: utf8Hex(did),
    controllerPkh: p.controllerPkh,
    hwPubkeyHex: simulatedHwPubkey(p.rand256),
    guardians,
    devicePkh: p.devicePkh,
  });
  const shardDatum = Data.to(new Constr(0, [BigInt(shard), proof.newRoot]));

  const tx = await p.lucid
    .newTx()
    .readFrom([p.taadRefUtxo])
    .collectFrom([shardUtxo], spendRedeemer)
    .mintAssets({ [unit]: 1n }, mintRedeemer)
    .pay.ToContract(taadAddr, { kind: "inline", value: anchorDatum }, { [unit]: 1n })
    .pay.ToContract(taadAddr, { kind: "inline", value: shardDatum }, { lovelace: shardUtxo.assets.lovelace ?? 0n, [shardUnit]: 1n })
    .addSignerKey(p.controllerPkh)
    .validTo(p.validToMs)
    .attachMetadata(674, { msg: p.metadataMsg })
    .complete({ localUPLCEval: p.localEval ?? true });

  const cbor = tx.toCBOR();
  return {
    did,
    anchorName: name,
    shard,
    genesisMs,
    proof,
    txCbor: cbor,
    fee: BigInt(tx.toTransaction().body().fee()),
    sizeBytes: cbor.length / 2,
  };
}
