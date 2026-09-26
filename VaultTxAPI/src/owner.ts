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
}

export interface OwnerWitnessProvider {
  resolve(owner: OwnerRef, w: ScriptOwnerWitness): Promise<ResolvedOwnerWitness>;
}

// ── đọc thân bài ─────────────────────────────────────────────────────────────

/** `owner` + bí danh `owner_pkh` → một `OwnerRef`, hoặc ném 400 có mã. */
export function parseOwnerFields(body: Record<string, unknown>): OwnerRef {
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
        `"owner.type" phải là "key" hoặc "script", và "owner" chỉ có hai trường type/hash.`,
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

// ── hiện thực: did_stake ───────────────────────────────────────────────────────

export interface DidStakeProviderDeps {
  network: Network;
  chain: ChainReader;
  /** `did_stake.anchor_nft_policy` của cấu hình triển khai — tham số theo mạng. */
  anchorNftPolicy: string;
}

/**
 * Nhân chứng `did_stake`: đọc UTxO anchor, kiểm nó mang tài sản dưới `anchor_nft_policy`,
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
    const underPolicy = Object.entries(anchorUtxo.assets)
      .filter(([unit, q]) => unit.startsWith(this.deps.anchorNftPolicy) && q > 0n);
    if (underPolicy.length === 0) {
      throw new CodedApiError(400, "OWNER_ANCHOR_INVALID",
        `UTxO anchor ${w.anchorRef.txHash.slice(0, 12)}…#${w.anchorRef.outputIndex} không mang ` +
        `tài sản nào dưới anchor_nft_policy của mạng này — không phải anchor DID.`,
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
    return {
      auth,
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
