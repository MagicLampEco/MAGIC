// VaultTxAPI/src/didOwner.ts — chủ khai bằng DID ⟹ `Script(did_stake)` + nhân chứng, suy từ chuỗi.
//
// App chỉ gửi `owner: {type:"did", did, device_key_hash?}`. Dịch vụ:
//   1. tên NFT anchor = blake2b_256(utf8(did)); unit = anchor_nft_policy ‖ tên;
//   2. đọc UTxO đang giữ unit đó (`chain.utxosByUnit`) — phải ĐÚNG MỘT;
//   3. đọc datum inline của nó như `TAADDatum` (PhoenixKey-Validator ▸ lib/phoenixkey/types.ak,
//      đo @ c9050b9: 18 trường; controller_pkh #2, status #5 với Active = constructor 0,
//      device_pkh #14, aux_device_pkhs #15) — lệch hình dạng ⟹ NÉM, không đệm;
//   4. script = did_stake chưa apply (cấu hình theo mạng) apply `(anchor_nft_policy, tên)`.
// Rồi giao `{ owner: Script(hash), owner_witness }` cho ĐÚNG đường nhân chứng hiện có
// (`owner.ts` ▸ `DidStakeWitnessProvider`) — mọi phép kiểm sau đó (NFT anchor, tài khoản thưởng
// đã đăng ký, required signers) vẫn là MỘT đường mã cho chủ DID lẫn chủ script tường minh.
//
// Lược đồ datum anchor thuộc repo danh tính. Đổi số trường bên đó ⟹ 422 `OWNER_ANCHOR_SCHEMA`
// ở đây (ồn ào), không phải một nhân chứng dựng trên trường đọc nhầm chỗ.

import {
  Constr, Data, applyParamsToScript, credentialToAddress, validatorToScriptHash, type UTxO,
} from "@lucid-evolution/lucid";
import { didAnchorNftName, didStakeScriptForDid } from "@magiclamp/sdk";
import type { Network, OwnerRef } from "@magiclamp/protocol-utils";

import type { ChainReader } from "./chain.js";
import type { DidStakeDeployment } from "./config.js";
import { CodedApiError } from "./errors.js";
import { isDidOwner, type DidOwnerInput, type OwnerInput, type ScriptOwnerWitness } from "./owner.js";

/** Số trường của `TAADDatum` và chỉ số các trường đọc — neo ở khối đầu tệp. */
export const TAAD_DATUM_FIELD_COUNT = 18;
const IDX_CONTROLLER_PKH = 2;
const IDX_STATUS = 5;
const IDX_DEVICE_PKH = 14;
const IDX_AUX_DEVICE_PKHS = 15;
const STATUS_ACTIVE_CONSTRUCTOR = 0;

const HASH28 = /^[0-9a-f]{56}$/;

export interface DidOwnerResolverDeps {
  chain: ChainReader;
  /** `did_stake.anchor_nft_policy` — tham số theo mạng. */
  anchorNftPolicy: string;
  /** `did_stake.unapplied_script` — đã băm lại và so lúc khởi động (`config.ts`). */
  unappliedScript: { cbor: string; hash: string };
}

export interface ResolvedDidOwner {
  ownerRef: OwnerRef;
  witness: ScriptOwnerWitness;
  did: string;
}

export interface DidOwnerResolverPort {
  resolve(input: DidOwnerInput): Promise<ResolvedDidOwner>;
}

export class DidOwnerResolver implements DidOwnerResolverPort {
  constructor(private readonly deps: DidOwnerResolverDeps) {}

  async resolve(input: DidOwnerInput): Promise<ResolvedDidOwner> {
    const name = didAnchorNftName(input.did);
    const unit = this.deps.anchorNftPolicy + name;
    const hits = (await this.deps.chain.utxosByUnit(unit)).filter(u => (u.assets[unit] ?? 0n) > 0n);
    if (hits.length === 0) {
      throw new CodedApiError(422, "OWNER_ANCHOR_NOT_FOUND",
        `Không thấy anchor của DID trên chuỗi (NFT ${name.slice(0, 12)}… dưới anchor_nft_policy của mạng ` +
        `này). DID chưa được tạo trên mạng này, hoặc gõ sai.`,
        { anchor_nft_name: name });
    }
    if (hits.length > 1) {
      throw new CodedApiError(422, "OWNER_ANCHOR_AMBIGUOUS",
        `Có ${hits.length} UTxO cùng giữ NFT anchor ${name.slice(0, 12)}… — anchor phải là one-shot. ` +
        `Không chọn đại một UTxO.`,
        { anchor_nft_name: name, utxo_refs: hits.map(u => `${u.txHash}#${u.outputIndex}`) });
    }
    const anchor = hits[0]!;
    const f = taadFieldsOf(anchor, name);
    let deviceKeyHash = f.devicePkh;
    if (input.deviceKeyHash !== undefined) {
      if (input.deviceKeyHash !== f.devicePkh && !f.auxDevicePkhs.includes(input.deviceKeyHash)) {
        throw new CodedApiError(400, "OWNER_DEVICE_NOT_LISTED",
          `Khoá thiết bị ${input.deviceKeyHash.slice(0, 12)}… không phải device_pkh hay thiết bị phụ ` +
          `nào trong anchor của DID này.`,
          { device_key_hash: input.deviceKeyHash, listed: [f.devicePkh, ...f.auxDevicePkhs] });
      }
      deviceKeyHash = input.deviceKeyHash;
    }
    const script = didStakeScriptForDid({
      unappliedCbor: this.deps.unappliedScript.cbor, anchorNftPolicy: this.deps.anchorNftPolicy, did: input.did,
    });
    return {
      ownerRef: { type: "script", hash: script.hash },
      witness: {
        didStakeScriptCbor: script.cbor,
        anchorRef: { txHash: anchor.txHash, outputIndex: anchor.outputIndex },
        controllerPkh: f.controllerPkh,
        deviceKeyHash,
      },
      did: input.did,
    };
  }
}

/** Yêu cầu sau khi chủ đã được suy: `owner` luôn là credential; `ownerDid` có ⟺ bên gọi khai DID. */
export type WithResolvedOwner<R extends { owner: OwnerInput }> =
  Omit<R, "owner" | "ownerWitness"> & { owner: OwnerRef; ownerWitness?: ScriptOwnerWitness; ownerDid?: string };

/**
 * Chủ `{type:"did"}` ⟹ thay bằng `Script(hash)` + `ownerWitness` suy từ chuỗi; chủ khác ⟹ trả
 * nguyên. Gọi ở ĐẦU mỗi đường dựng, trước khi giữ khoá mềm (`service.ts`, `sponsor.ts`).
 */
export async function resolveOwnerInput<R extends { owner: OwnerInput; ownerWitness?: ScriptOwnerWitness }>(
  req: R, resolver: DidOwnerResolverPort | undefined,
): Promise<WithResolvedOwner<R>> {
  if (!isDidOwner(req.owner)) return req as unknown as WithResolvedOwner<R>;
  if (resolver === undefined) {
    throw new CodedApiError(501, "OWNER_SCRIPT_WITNESS_UNAVAILABLE",
      `Bản triển khai này chưa khai "did_stake.unapplied_script", nên không suy được chủ từ DID. ` +
      `Gửi chủ script tường minh kèm "owner_witness", hoặc hỏi người vận hành.`);
  }
  // Gọi thẳng dịch vụ (không qua bộ đọc thân bài) cũng không được mang hai nguồn cho một chủ.
  if (req.ownerWitness !== undefined) {
    throw new CodedApiError(400, "OWNER_DID_CONFLICT",
      `"owner" kiểu "did" không đi cùng "owner_witness".`, { conflicting_fields: ["owner_witness"] });
  }
  const r = await resolver.resolve(req.owner);
  return { ...req, owner: r.ownerRef, ownerWitness: r.witness, ownerDid: r.did };
}

interface TaadFields {
  controllerPkh: string;
  devicePkh: string;
  auxDevicePkhs: string[];
}

/** Đọc bốn trường cần dùng từ datum inline của anchor, hoặc NÉM 422 có mã. */
export function taadFieldsOf(anchor: UTxO, name: string): TaadFields {
  const ref = `${anchor.txHash}#${anchor.outputIndex}`;
  const schema = (why: string) => new CodedApiError(422, "OWNER_ANCHOR_SCHEMA",
    `Datum của anchor ${ref} không đọc được như TAADDatum ${TAAD_DATUM_FIELD_COUNT} trường: ${why}.`,
    { anchor_ref: ref, anchor_nft_name: name });
  if (typeof anchor.datum !== "string" || anchor.datum === "") throw schema("không có datum inline");
  let d: unknown;
  try {
    d = Data.from(anchor.datum);
  } catch {
    throw schema("CBOR datum hỏng");
  }
  if (!(d instanceof Constr)) throw schema("không phải Constr");
  if (d.fields.length !== TAAD_DATUM_FIELD_COUNT) throw schema(`có ${d.fields.length} trường`);
  const controllerPkh = d.fields[IDX_CONTROLLER_PKH];
  const status = d.fields[IDX_STATUS];
  const devicePkh = d.fields[IDX_DEVICE_PKH];
  const aux = d.fields[IDX_AUX_DEVICE_PKHS];
  if (typeof controllerPkh !== "string" || !HASH28.test(controllerPkh)) throw schema("controller_pkh (#2) không phải 28 byte");
  if (!(status instanceof Constr)) throw schema("status (#5) không phải Constr");
  if (typeof devicePkh !== "string" || !HASH28.test(devicePkh)) throw schema("device_pkh (#14) không phải 28 byte");
  if (!Array.isArray(aux) || !aux.every(x => typeof x === "string" && HASH28.test(x))) {
    throw schema("aux_device_pkhs (#15) không phải danh sách khoá 28 byte");
  }
  if (status.index !== STATUS_ACTIVE_CONSTRUCTOR) {
    throw new CodedApiError(422, "OWNER_ANCHOR_NOT_ACTIVE",
      `Anchor của DID đang không Active (constructor status = ${status.index}) — did_stake sẽ từ chối ` +
      `trên chuỗi. Chờ DID về Active rồi dựng lại.`,
      { anchor_ref: ref, status_constructor: status.index });
  }
  return { controllerPkh, devicePkh, auxDevicePkhs: aux as string[] };
}

// ── địa chỉ ví Phoenix (did_payment) của chủ, suy từ cấu hình + nhân chứng ─────────────────

/** Kết quả suy địa chỉ ví Phoenix: có địa chỉ, hoặc nói rõ THIẾU gì (không đoán). */
export type DidPaymentAddressResult =
  | { address: string; didPaymentHash: string }
  | { missing: string; reason: string };

/**
 * Địa chỉ ví Phoenix của chủ `Script(did_stake)` — nơi nhận thưởng `did_stake` khi giao dịch đi qua
 * ví trả phí (`feePayer.ts` ▸ khối "MỤC RÚT did_stake").
 *
 * Ví Phoenix = địa chỉ BASE (payment = `Script(did_payment đã apply)`, stake = `Script(did_stake đã
 * apply)`), hai script apply CÙNG `(anchor_nft_policy, blake2b_256(utf8(did)))` — PhoenixKey-Core
 * `rust_core/src/phoenix_address.rs` ▸ `derive_phoenix_address` (đổi từ ENTERPRISE sang BASE
 * 2026-10-04). Phần stake ở đây là CHÍNH `owner.hash`, credential mà mục rút đang rút.
 *
 * Nguồn tin được, không có gì từ thân bài:
 *   · `did_payment` chưa apply + `did_stake` chưa apply — cấu hình theo mạng, băm lại lúc khởi động;
 *   · `anchorNftName` — tên NFT anchor trên UTxO anchor mà dịch vụ tự đọc từ chuỗi (`owner.ts`).
 * Ràng buộc nối hai thứ: `did_stake` chưa apply apply `(policy, anchorNftName)` phải băm ra ĐÚNG
 * `owner.hash`. Lệch ⟹ anchor của nhân chứng không phải anchor của chủ này ⟹ không suy (trả `missing`):
 * chuyển thưởng của chủ tới ví Phoenix của MỘT DID KHÁC là đúng loại lỗi chặn này sinh ra để chặn.
 * Chủ `{type:"did"}` luôn thoả ràng buộc đó (`DidOwnerResolver` suy owner theo đúng phép này).
 */
export function didPaymentAddressFor(input: {
  didStake: DidStakeDeployment | undefined;
  anchorNftName: string | undefined;
  ownerHash: string;
  network: Network;
}): DidPaymentAddressResult {
  const d = input.didStake;
  if (d === undefined) return { missing: "deployment.did_stake", reason: "bản deploy không có khối did_stake" };
  if (d.didPaymentUnappliedScript === undefined) {
    return { missing: "deployment.did_stake.did_payment_unapplied_script",
      reason: "bản deploy chưa khai script did_payment chưa apply" };
  }
  if (d.unappliedScript === undefined) {
    return { missing: "deployment.did_stake.unapplied_script",
      reason: "bản deploy chưa khai script did_stake chưa apply — không đối chiếu được anchor với chủ" };
  }
  const name = input.anchorNftName;
  if (name === undefined || !/^[0-9a-f]{64}$/.test(name)) {
    return { missing: "owner_witness.anchor_ref", reason: "UTxO anchor của nhân chứng không mang đúng một NFT anchor" };
  }
  const stakeHash = validatorToScriptHash({
    type: "PlutusV3", script: applyParamsToScript(d.unappliedScript.cbor, [d.anchorNftPolicy, name]),
  });
  if (stakeHash !== input.ownerHash) {
    return { missing: "owner_witness.anchor_ref",
      reason: `anchor ${name.slice(0, 12)}… không phải anchor của chủ script:${input.ownerHash.slice(0, 12)}…` };
  }
  const didPaymentHash = validatorToScriptHash({
    type: "PlutusV3", script: applyParamsToScript(d.didPaymentUnappliedScript.cbor, [d.anchorNftPolicy, name]),
  });
  return {
    address: credentialToAddress(input.network,
      { type: "Script", hash: didPaymentHash }, { type: "Script", hash: input.ownerHash }),
    didPaymentHash,
  };
}
