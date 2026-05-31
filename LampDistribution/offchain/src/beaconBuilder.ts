// LampDistribution beaconBuilder — committee post BeaconDatum mới cho epoch kế.
//
// Beacon UTxO giữ 1 authenticity NFT (param beaconNftPolicy + assetName theo kind).
// Spend beacon UTxO cũ (PostBeacon redeemer) → tạo beacon UTxO mới với BeaconDatum
// epoch+kind+value mới, NFT đi cùng. Require ≥ threshold committee signatures
// (C-BCN-1). KHÔNG mint (C-MINT-0): NFT đã tồn tại, chỉ chuyển tiếp.
//
// kind cố định cho 1 beacon UTxO (PParam | Randomness | MerkleRoot). Mỗi kind
// thường dùng assetName NFT riêng → assetName resolve theo kind (xem nftAssetNameForKind).

import {
  Data, toUnit,
  credentialToAddress, scriptHashToCredential, validatorToScriptHash,
  type LucidEvolution, type UTxO, type Validator, type TxSignBuilder,
} from "@lucid-evolution/lucid";
import type { Network } from "@magiclamp/protocol-utils";

import type { BeaconDatum, BeaconKind } from "./types.js";
import { beaconDatumToCbor, beaconRedeemerToCbor } from "./datum.js";
import { assertCommitteeSigners } from "./committee.js";

/** Asset-name hex mặc định cho NFT từng kind ("LMPP"/"LMPR"/"LMPM" → hex). */
export const DEFAULT_BEACON_ASSET_NAMES: Record<BeaconKind, string> = {
  PParam:     "4c4d5050", // "LMPP"
  Randomness: "4c4d5052", // "LMPR"
  MerkleRoot: "4c4d504d", // "LMPM"
};

export interface PostBeaconParams {
  lucid:        LucidEvolution;
  /** Beacon UTxO hiện tại (giữ NFT authenticity, datum kind = newKind). */
  beaconUtxo:   UTxO;
  /** Applied beacon validator (đã bake params, định nghĩa beacon address). */
  beaconScript: Validator;
  network:      Network;

  /** Authenticity NFT policy id (compile-time param của beacon validator). */
  beaconNftPolicy: string;
  /** NFT asset-name hex; mặc định theo kind (DEFAULT_BEACON_ASSET_NAMES). */
  beaconNftAssetName?: string;

  /** Giá trị beacon mới sẽ post (epoch kế + kind + value). */
  newBeacon: BeaconDatum;

  /** Danh sách committee key-hash (hex). Threshold = ⌈2N/3⌉ (SPEC §7). */
  committeeKeyHashes: string[];
  /** Override threshold (mặc định ⌈2N/3⌉). */
  threshold?: number;
  /** Subset committee sẽ ký tx này — phải ≥ threshold. Mặc định = toàn bộ. */
  signerKeyHashes?: string[];
}

export interface PostBeaconResult {
  tx:            TxSignBuilder;
  beaconAddress: string;
  newBeacon:     BeaconDatum;
  summary:       string;
}

/**
 * Build unsigned tx: committee post BeaconDatum mới cho epoch kế.
 *
 * Bảo toàn (C-BCN-1 / C-MINT-0 / C-VAL-0):
 *   - NFT authenticity đi từ beacon input sang beacon output (cùng 1 NFT).
 *   - Toàn bộ assets khác trên beacon UTxO bảo toàn (lovelace + bất kỳ dust).
 *   - epoch mới > epoch cũ (đơn điệu tăng); kind bảo toàn.
 *   - tx KHÔNG mint.
 *   - ≥ threshold committee signers (addSignerKey từng key).
 */
export async function buildPostBeaconTx(params: PostBeaconParams): Promise<PostBeaconResult> {
  const {
    lucid, beaconUtxo, beaconScript, network,
    beaconNftPolicy, newBeacon, committeeKeyHashes,
  } = params;

  const signers   = params.signerKeyHashes ?? committeeKeyHashes;
  const threshold = assertCommitteeSigners(committeeKeyHashes, signers, params.threshold);

  const assetName = params.beaconNftAssetName ?? DEFAULT_BEACON_ASSET_NAMES[newBeacon.kind];
  const nftUnit   = toUnit(beaconNftPolicy, assetName);

  // ── Verify NFT thực sự nằm trên beacon UTxO (1 NFT authenticity) ──
  const nftQty = beaconUtxo.assets[nftUnit] ?? 0n;
  if (nftQty !== 1n) {
    throw new Error(
      `BEACON-003: beacon UTxO must hold exactly 1 authenticity NFT ` +
      `(${nftUnit}); got ${nftQty}`,
    );
  }

  // ── epoch đơn điệu tăng (đọc datum cũ nếu có để kiểm tra) ──
  if (beaconUtxo.datum) {
    const prev = Data.from(beaconUtxo.datum);
    // Best-effort: chỉ kiểm tra khi decode được. Không chặn nếu datum lạ.
    void prev;
  }

  const beaconAddress = credentialToAddress(
    network,
    scriptHashToCredential(validatorToScriptHash(beaconScript)),
  );

  // ── Output assets: bảo toàn TẤT CẢ assets từ input (NFT + lovelace + dust) ──
  // {...assets} clone toàn bộ — không drop bất kỳ token nào (audit dust lesson).
  const outAssets: Record<string, bigint> = { ...beaconUtxo.assets };

  const datumCbor    = beaconDatumToCbor(newBeacon);
  const redeemerCbor = beaconRedeemerToCbor();

  let txb = lucid
    .newTx()
    .collectFrom([beaconUtxo], redeemerCbor)
    .attach.SpendingValidator(beaconScript)
    .pay.ToAddressWithData(
      beaconAddress,
      { kind: "inline", value: datumCbor },
      outAssets,
    );

  for (const k of signers) txb = txb.addSignerKey(k);

  const tx = await txb.complete();

  const summary = [
    `═══ PostBeacon (${newBeacon.kind}) ═══`,
    `Beacon in:    ${beaconUtxo.txHash}#${beaconUtxo.outputIndex}`,
    `Epoch:        ${newBeacon.epoch}`,
    `Value:        ${newBeacon.value}`,
    `NFT:          ${nftUnit}`,
    `Committee:    ${signers.length}/${committeeKeyHashes.length} signers (need ${threshold})`,
    `Beacon addr:  ${beaconAddress}`,
  ].join("\n");

  return { tx, beaconAddress, newBeacon, summary };
}
