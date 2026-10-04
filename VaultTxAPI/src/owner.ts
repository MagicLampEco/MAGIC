// VaultTxAPI/src/owner.ts — chủ vault là `Credential`: đọc từ thân bài, và nhân chứng cho
// chủ script.
//
// ── HAI TRƯỜNG, MỘT CHỦ ────────────────────────────────────────────────────────
// Thân bài mang `owner: { type: "key" | "script", hash }`. `owner_pkh` giữ làm bí danh
// (= `{ type: "key", hash: owner_pkh }`) cho app đời cũ. Cả hai cùng có mà chỉ hai chủ khác
// nhau ⟹ 400 `OWNER_ALIAS_MISMATCH`: chọn một bên là đoán ý người gọi, và đoán sai là dựng
// giao dịch cho một chủ khác.
//
// ── CHỦ SCRIPT ─────────────────────────────────────────────────────────────────
// Chủ `Script(h)` chứng minh quyền bằng một mục rút `Script(h)` (xem `owner_auth.ak`).
// Dịch vụ KHÔNG ký gì và KHÔNG giữ khoá nào, nên nó chỉ dựng được mục rút đó khi:
//   (1) cấu hình triển khai có mục `did_stake` (tham số theo mạng `anchor_nft_policy`), và
//   (2) yêu cầu mang `owner_witness` — dữ kiện của RIÊNG DID đó, chỉ ví Phoenix biết.
// Thiếu (1) ⟹ 501 `OWNER_SCRIPT_WITNESS_UNAVAILABLE` (hỏi người vận hành).
// Thiếu (2) ⟹ 400 `OWNER_SCRIPT_WITNESS_UNAVAILABLE` (bên gọi thiếu trường).
// Không có đường thứ ba: dịch vụ không bịa redeemer hay chứng từ cho một script nó không biết.
//
// Script do app gửi KHÔNG được tin: dịch vụ băm lại và so với `owner.hash`
// (`@magiclamp/protocol-utils` ▸ `didStakeOwnerAuth`). Gửi script khác ⟹ 400
// `OWNER_AUTH_MISMATCH`.

import type { TxBuilder, UTxO } from "@lucid-evolution/lucid";
import { didStakeOwnerAuthLucid } from "@magiclamp/sdk";
import type { Network, OwnerAuth, OwnerRef, RewardAccountState } from "@magiclamp/protocol-utils";
import type { ChainReader } from "./chain.js";
import { CodedApiError } from "./errors.js";

const HASH28 = /^[0-9a-f]{56}$/;
const CBOR_HEX = /^(?:[0-9a-f]{2})+$/;
const OUTREF = /^([0-9a-f]{64})#(0|[1-9][0-9]{0,4})$/;

/** Dữ kiện riêng của DID, app gửi kèm khi chủ là script. */
export interface ScriptOwnerWitness {
  /** CBOR `did_stake` ĐÃ apply `(anchor_nft_policy, blake2b_256(utf8(did)))`. */
  didStakeScriptCbor: string;
  /** UTxO anchor DID, dạng `<tx_hash>#<index>`. */
  anchorRef: { txHash: string; outputIndex: number };
  controllerPkh: string;
  deviceKeyHash: string;
}

/** Kết quả nhân chứng: thứ gắn vào tx + thứ báo lại cho app. */
export interface ResolvedOwnerWitness {
  auth: OwnerAuth<TxBuilder>;
  requiredSigners: string[];
  notes: string[];
  /** Tên (64 hex) của ĐÚNG MỘT NFT anchor dưới `anchor_nft_policy` trên UTxO anchor của nhân chứng =
   *  `blake2b_256(utf8(did))`. Vắng khi UTxO đó mang nhiều hơn một tên — nơi so (`sponsor.ts` ▸
   *  `assertOwnerDid`) coi vắng là lệch. */
  anchorNftName?: string;
  /** Chủ `Script(did_stake)`: mục rút mà nhân chứng gắn — TRỌN số dư thưởng lúc dựng. Đường ví trả
   *  phí đọc nó để dừng trước khi thưởng của chủ thối sang ví trả phí (`feePayer.ts` ▸
   *  `assertNoOwnerRewardToFeePayer`). */
  ownerReward?: { rewardAddress: string; withdrawLovelace: bigint };
}

export interface OwnerWitnessProvider {
  resolve(owner: OwnerRef, w: ScriptOwnerWitness): Promise<ResolvedOwnerWitness>;
}

// ── đọc thân bài ─────────────────────────────────────────────────────────────

/**
 * Chủ khai bằng DID: `owner: { "type": "did", "did": "did:…", "device_key_hash"?: <56 hex> }`.
 * Dịch vụ tự suy `Script(did_stake)` + nhân chứng từ anchor trên chuỗi (`didOwner.ts`), nên app
 * chỉ gửi DID — và tuỳ chọn khoá thiết bị sẽ ký (vắng ⟹ `device_pkh` chính của anchor).
 */
export interface DidOwnerInput {
  type: "did";
  did: string;
  deviceKeyHash?: string;
}

/** Chủ như bên gọi khai: credential tường minh, hoặc DID chờ suy. */
export type OwnerInput = OwnerRef | DidOwnerInput;

export function isDidOwner(o: OwnerInput): o is DidOwnerInput {
  return o.type === "did";
}

// `did:` + ký tự ASCII in được không khoảng trắng (0x21..0x7e), tổng 5..256 byte. Không đoán
// phương thức DID: luật hình dạng chỉ để chặn rác trước khi băm, tính đúng do anchor trên chuỗi
// quyết (DID không có anchor ⟹ 422 `OWNER_ANCHOR_NOT_FOUND`).
const DID_SHAPE = /^did:[\x21-\x7e]{1,252}$/;

function parseDidOwner(o: Record<string, unknown>, body: Record<string, unknown>): DidOwnerInput {
  const extra = Object.keys(o).filter(k => k !== "type" && k !== "did" && k !== "device_key_hash");
  if (extra.length > 0) {
    throw new CodedApiError(400, "OWNER_CREDENTIAL_SHAPE",
      `"owner" kiểu "did" chỉ có các trường type/did/device_key_hash.`, { extra_fields: extra });
  }
  const did = o.did;
  if (typeof did !== "string" || !DID_SHAPE.test(did)) {
    throw new CodedApiError(400, "OWNER_DID_SHAPE",
      `"owner.did" phải là chuỗi bắt đầu bằng "did:", chỉ gồm ký tự ASCII in được không khoảng trắng, ` +
      `dài 5..256 byte.`,
      { did_length: typeof did === "string" ? did.length : typeof did });
  }
  const dk = o.device_key_hash;
  if (dk !== undefined && (typeof dk !== "string" || !HASH28.test(dk))) {
    throw new CodedApiError(400, "OWNER_HASH_INVALID",
      `"owner.device_key_hash" phải là 56 ký tự hex thường (28 byte).`);
  }
  // Chủ DID mà kèm nhân chứng / bí danh: hai nguồn cho cùng một dữ kiện, chọn một bên là đoán.
  const conflicting = ["owner_witness", "owner_pkh"].filter(k => body[k] !== undefined);
  if (conflicting.length > 0) {
    throw new CodedApiError(400, "OWNER_DID_CONFLICT",
      `"owner" kiểu "did" không đi cùng ${conflicting.map(k => `"${k}"`).join(" / ")}: dịch vụ tự suy ` +
      `script và nhân chứng từ anchor của DID. Bỏ các trường đó, hoặc gửi chủ script tường minh.`,
      { conflicting_fields: conflicting });
  }
  return { type: "did", did, ...(dk === undefined ? {} : { deviceKeyHash: dk as string }) };
}

/** `owner` + bí danh `owner_pkh` → một `OwnerInput`, hoặc ném 400 có mã. */
export function parseOwnerFields(body: Record<string, unknown>): OwnerInput {
  const raw = body.owner;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw) && (raw as Record<string, unknown>).type === "did") {
    return parseDidOwner(raw as Record<string, unknown>, body);
  }
  let alias: OwnerRef | undefined;
  if (body.owner_pkh !== undefined) {
    const v = body.owner_pkh;
    if (typeof v !== "string" || !HASH28.test(v)) {
      throw new CodedApiError(400, "OWNER_HASH_INVALID",
        "owner_pkh phải là 56 ký tự hex thường (khoá băm thanh toán 28 byte).",
        { owner_pkh_length: typeof v === "string" ? v.length : typeof v });
    }
    alias = { type: "key", hash: v };
  }
  let owner: OwnerRef | undefined;
  if (body.owner !== undefined) {
    const o = body.owner;
    if (o === null || typeof o !== "object" || Array.isArray(o)) {
      throw new CodedApiError(400, "OWNER_CREDENTIAL_SHAPE",
        `"owner" phải là đối tượng { "type": "key" | "script", "hash": <56 hex thường> }.`);
    }
    const { type, hash } = o as Record<string, unknown>;
    const extra = Object.keys(o).filter(k => k !== "type" && k !== "hash");
    if ((type !== "key" && type !== "script") || extra.length > 0) {
      throw new CodedApiError(400, "OWNER_CREDENTIAL_SHAPE",
        `"owner.type" phải là "key", "script" hoặc "did"; chủ key/script chỉ có hai trường type/hash.`,
        { owner_type: typeof type === "string" ? type : typeof type, extra_fields: extra });
    }
    if (typeof hash !== "string" || !HASH28.test(hash)) {
      throw new CodedApiError(400, "OWNER_HASH_INVALID",
        `"owner.hash" phải là 56 ký tự hex thường (28 byte).`);
    }
    owner = { type, hash };
  }
  if (owner && alias && !(owner.type === alias.type && owner.hash === alias.hash)) {
    throw new CodedApiError(400, "OWNER_ALIAS_MISMATCH",
      `"owner" = ${owner.type}:${owner.hash.slice(0, 12)}… nhưng "owner_pkh" = ${alias.hash.slice(0, 12)}…. ` +
      `Hai trường cùng có thì phải chỉ cùng một chủ.`,
      { owner, owner_pkh: alias.hash });
  }
  const r = owner ?? alias;
  if (r === undefined) {
    throw new CodedApiError(400, "OWNER_CREDENTIAL_SHAPE", `Thiếu "owner" (hoặc bí danh "owner_pkh").`);
  }
  return r;
}

/** `owner_witness` tuỳ chọn. Có mặt thì mọi trường BẮT BUỘC và đúng hình dạng. */
export function parseOwnerWitness(body: Record<string, unknown>): ScriptOwnerWitness | undefined {
  const w = body.owner_witness;
  if (w === undefined) return undefined;
  if (w === null || typeof w !== "object" || Array.isArray(w)) {
    throw new CodedApiError(400, "OWNER_WITNESS_SHAPE", `"owner_witness" phải là một đối tượng JSON.`);
  }
  const o = w as Record<string, unknown>;
  const bad = (field: string, want: string) =>
    new CodedApiError(400, "OWNER_WITNESS_SHAPE", `"owner_witness.${field}" phải là ${want}.`, { field });
  if (typeof o.did_stake_script_cbor !== "string" || !CBOR_HEX.test(o.did_stake_script_cbor)) {
    throw bad("did_stake_script_cbor", "hex thường, số ký tự chẵn, khác rỗng");
  }
  const ref = typeof o.anchor_ref === "string" ? OUTREF.exec(o.anchor_ref) : null;
  if (ref === null) throw bad("anchor_ref", `chuỗi "<tx_hash 64 hex>#<index>"`);
  if (typeof o.controller_pkh !== "string" || !HASH28.test(o.controller_pkh)) throw bad("controller_pkh", "56 hex thường");
  if (typeof o.device_key_hash !== "string" || !HASH28.test(o.device_key_hash)) throw bad("device_key_hash", "56 hex thường");
  return {
    didStakeScriptCbor: o.did_stake_script_cbor,
    anchorRef: { txHash: ref[1]!, outputIndex: Number(ref[2]!) },
    controllerPkh: o.controller_pkh,
    deviceKeyHash: o.device_key_hash,
  };
}

/**
 * Khoá mềm theo chủ. Chủ khoá giữ NGUYÊN chuỗi pkh như trước (để `lock_released_for` của
 * app đời cũ không đổi nghĩa); chủ script mang tiền tố, vì một script hash trùng 28 byte với
 * một pkh là chủ KHÁC và không được tranh chung một khoá.
 */
export function ownerLockKey(owner: OwnerRef): string {
  return owner.type === "key" ? owner.hash : `script:${owner.hash}`;
}

// ── nhận diện NFT anchor ───────────────────────────────────────────────────────

/**
 * UTxO có mang một NFT anchor DID dưới `policy` không: tên 32 byte
 * (`blake2b_256(utf8(did))`) và số lượng ĐÚNG 1.
 *
 * "Có tài sản bất kỳ dưới policy" là chưa đủ: `taad` còn đúc token shard (`pk-uniq\x00`…,
 * 8 byte) và cursor dưới CÙNG policy, và chúng nằm trên UTxO ở địa chỉ `taad`. Một
 * `anchor_ref` trỏ vào shard lọt qua phép cũ rồi chết ở bước sau với mã sai loại
 * (`OWNER_STAKE_NOT_REGISTERED` thay vì `OWNER_ANCHOR_INVALID`) — đo trên Preprod
 * 2026-09-27. Trên chuỗi vẫn an toàn vì `did_stake` ép đúng tên; đây là cổng để người
 * dùng đọc được đúng lỗi, không phải cổng an ninh.
 */
export function carriesAnchorNft(assets: Record<string, bigint>, policy: string): boolean {
  return anchorNftNamesOf(assets, policy).length > 0;
}

/** Tên (64 hex) của mọi NFT anchor dưới `policy` trên một UTxO — cùng luật với `carriesAnchorNft`. */
export function anchorNftNamesOf(assets: Record<string, bigint>, policy: string): string[] {
  return Object.entries(assets)
    .filter(([unit, q]) => unit.length === 56 + 64 && unit.startsWith(policy) && q === 1n)
    .map(([unit]) => unit.slice(56));
}

// ── hiện thực: did_stake ───────────────────────────────────────────────────────

export interface DidStakeProviderDeps {
  network: Network;
  chain: ChainReader;
  /** `did_stake.anchor_nft_policy` của cấu hình triển khai — tham số theo mạng. */
  anchorNftPolicy: string;
}

/**
 * Nhân chứng `did_stake`: đọc UTxO anchor, kiểm nó mang NFT anchor dưới `anchor_nft_policy`,
 * tra tài khoản thưởng, rồi giao cho `didStakeOwnerAuthLucid` (so hash + dựng mục rút).
 *
 * Trạng thái Active của anchor KHÔNG kiểm ở đây — lược đồ datum anchor thuộc repo danh tính.
 * Anchor không Active ⟹ `did_stake` từ chối trên chuỗi; ghi chú trả về nói rõ điều đó.
 */
export class DidStakeWitnessProvider implements OwnerWitnessProvider {
  constructor(private readonly deps: DidStakeProviderDeps) {}

  async resolve(owner: OwnerRef, w: ScriptOwnerWitness): Promise<ResolvedOwnerWitness> {
    const [anchor] = await this.deps.chain.utxosByOutRef([w.anchorRef]);
    const anchorUtxo = anchor as UTxO;
    if (!carriesAnchorNft(anchorUtxo.assets, this.deps.anchorNftPolicy)) {
      throw new CodedApiError(400, "OWNER_ANCHOR_INVALID",
        `UTxO anchor ${w.anchorRef.txHash.slice(0, 12)}…#${w.anchorRef.outputIndex} không mang ` +
        `NFT anchor nào (tên 32 byte, số lượng 1) dưới anchor_nft_policy của mạng này — ` +
        `không phải anchor DID.`,
        { anchor_ref: `${w.anchorRef.txHash}#${w.anchorRef.outputIndex}` });
    }
    const chain = this.deps.chain;
    const auth = await didStakeOwnerAuthLucid({
      owner,
      didStakeScriptCbor: w.didStakeScriptCbor,
      anchorRefUtxo: anchorUtxo,
      controllerPkh: w.controllerPkh,
      deviceKeyHash: w.deviceKeyHash,
      network: this.deps.network,
    }, (addr: string): Promise<RewardAccountState> => chain.rewardAccount(addr));
    const names = anchorNftNamesOf(anchorUtxo.assets, this.deps.anchorNftPolicy);
    return {
      ...(names.length === 1 ? { anchorNftName: names[0]! } : {}),
      auth,
      ownerReward: { rewardAddress: auth.details.rewardAddress, withdrawLovelace: auth.details.withdrawLovelace },
      requiredSigners: [...auth.details.requiredSigners],
      notes: [
        `Chủ script ${owner.hash}: giao dịch rút ${auth.details.withdrawLovelace} lovelace từ ` +
          `${auth.details.rewardAddress} (đúng số dư thưởng lúc dựng) với redeemer Authorize, ` +
          `script did_stake đính inline.`,
        `Cần chữ ký của controller ${w.controllerPkh} VÀ khoá thiết bị ${w.deviceKeyHash}.`,
        `Anchor DID phải đang Active; nộp sau một ranh giới epoch có cộng thưởng thì dựng lại.`,
      ],
    };
  }
}
