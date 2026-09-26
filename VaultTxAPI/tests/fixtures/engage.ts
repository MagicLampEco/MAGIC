// VaultTxAPI/tests/fixtures/engage.ts — thread Engage giả cho phép kiểm (không mạng, không khoá).
//
// Địa chỉ engage ở đây là một script RIÊNG, khác địa chỉ vault: dùng chung địa chỉ thì NFT
// thread và NFT vault đứng chung một policy, và bộ tra vault đọc thread thành vault hỏng.

import { credentialToAddress, type UTxO } from "@lucid-evolution/lucid";
import { encodeEngageDatum } from "@magiclamp/sdk";
import type { OwnerRef } from "@magiclamp/protocol-utils";

export const ENGAGE_SCRIPT_HASH = "e0".repeat(28);
export const ENGAGE_ADDRESS = credentialToAddress("Preview", { type: "Script", hash: ENGAGE_SCRIPT_HASH });

export interface EngageDatumOpts {
  consumedCount?: bigint;
  lastEpoch?: bigint;
  consumedNanogic?: bigint;
  didCommit?: string;
}

export function engageDatumHex(owner: OwnerRef, o: EngageDatumOpts = {}): string {
  return encodeEngageDatum({
    owner: owner.type === "key" ? { VerificationKey: [owner.hash] } : { Script: [owner.hash] },
    consumed_count: o.consumedCount ?? 0n,
    last_epoch: o.lastEpoch ?? 0n,
    did_commit: o.didCommit ?? "",
    consumed_nanogic: o.consumedNanogic ?? 0n,
  } as Parameters<typeof encodeEngageDatum>[0]);
}

/** UTxO thread: 2 ADA + đúng 1 NFT dưới policy consume, datum inline của `owner`. */
export function threadUtxo(owner: OwnerRef, txHash: string, outputIndex = 0, nameHex = "01", datum?: string): UTxO {
  return {
    txHash,
    outputIndex,
    address: ENGAGE_ADDRESS,
    assets: { lovelace: 2_000_000n, [ENGAGE_SCRIPT_HASH + nameHex]: 1n },
    datum: datum ?? engageDatumHex(owner),
  };
}
