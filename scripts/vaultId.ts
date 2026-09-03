// scripts/vaultId.ts — tên asset của NFT danh-tính vault (state-thread NFT)
//
// ⚠  BẢN SAO CÓ NHÃN. NGUỒN GỐC: MagicSDK/src/vaultId.ts (đã chạy xanh, có test
//    MagicSDK/tests/vaultId.test.ts + neo Aiken InstantGen/onchain/lib/magiclamp/
//    protocol/vault_id.ak). Chép nguyên văn phần phép băm sang đây vì scripts/ là
//    một npm package độc lập, KHÔNG khai @magiclamp/sdk làm dependency.
//    SỬA MỘT BÊN LÀ PHẢI SỬA BÊN KIA — lệch một byte thì mint hỏng ở
//    `quantity_of(tx.mint, policy_id, nft_name) == 1`.
//
// BỐI CẢNH (INV-VAULT-IDENTITY)
// Cardano chỉ chạy validator khi UTxO bị TIÊU, không bao giờ khi UTxO được TẠO.
// Địa chỉ script vault là công khai ⇒ kẻ tấn công có thể đặt một UTxO với datum
// BỊA vào chính địa chỉ đó. Vá: mỗi vault mang một NFT "state-thread" chỉ ra đời
// được qua handler `mint` của chính validator vault (handler đó ép datum khởi
// sinh SẠCH), và MỌI nhánh `spend` đều đòi NFT đó còn nguyên trên output nối tiếp.
//
//   policy id   = chính script hash của vault ĐÃ apply params (multi-purpose
//                 validator: `mint` và `spend` cùng một script)
//   asset name  = blake2b_256( cbor.serialise(seed) )   với seed : OutputReference
//
// DẠNG CBOR ĐÚNG của OutputReference (PlutusV3 / Conway, aiken stdlib v3.1.0):
//   OutputReference { transaction_id: ByteArray, output_index: Int }
//     → Constr 0 [ bytes(32), int ]
//   PlutusV1/V2 bọc transaction_id trong một Constr 0 (TxId) nữa; V3 thì KHÔNG.
//   Bọc thêm một lớp ⇒ hash khác ⇒ mint hỏng.

import { Data, Constr } from "@lucid-evolution/lucid";
import { blake2b } from "@noble/hashes/blake2b";

/** Seed UTxO một-lần (one-shot) sinh ra danh tính của vault. */
export interface VaultIdSeed {
  /** Tx hash của UTxO seed — 32 byte hex (64 ký tự). */
  txHash: string;
  /** Chỉ số output trong tx đó. */
  outputIndex: number | bigint;
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

function normalizeSeed(seed: VaultIdSeed): { txHash: string; index: bigint } {
  if (!seed || typeof seed.txHash !== "string" || !HEX64.test(seed.txHash)) {
    throw new Error(
      `vaultIdAssetName: txHash phải là hex 32 byte (64 ký tự), nhận "${seed?.txHash}"`,
    );
  }
  const index = BigInt(seed.outputIndex);
  if (index < 0n) {
    throw new Error(`vaultIdAssetName: outputIndex không được âm (nhận ${index})`);
  }
  return { txHash: seed.txHash.toLowerCase(), index };
}

/** CBOR của `seed` đúng như Aiken `cbor.serialise(seed : OutputReference)`. */
export function vaultIdSeedCbor(seed: VaultIdSeed): string {
  const { txHash, index } = normalizeSeed(seed);
  return Data.to(new Constr(0, [txHash, index]));
}

/** Tên asset (hex 64 ký tự) của NFT danh-tính vault sinh từ `seed`. */
export function vaultIdAssetName(seed: VaultIdSeed): string {
  const cborHex = vaultIdSeedCbor(seed);
  const digest = blake2b(Buffer.from(cborHex, "hex"), { dkLen: 32 });
  return Buffer.from(digest).toString("hex");
}

/**
 * Redeemer `MintVaultId { seed }` — biến thể 0 của VaultIdRedeemer.
 * Neo: MagicSDK/src/schemas.ts VaultIdRedeemerSchema
 *   Data.Enum([ Data.Object({ MintVaultId: Data.Object({ seed: OutputReference }) }),
 *               Data.Literal("BurnVaultId") ])
 * ⇒ Constr 0 [ Constr 0 [ txHash, index ] ].
 */
export function mintVaultIdRedeemer(seed: VaultIdSeed): string {
  const { txHash, index } = normalizeSeed(seed);
  return Data.to(new Constr(0, [new Constr(0, [txHash, index])]));
}

/**
 * Chọn seed UTxO TẤT ĐỊNH (cùng ví + cùng tập UTxO ⇒ cùng seed ⇒ cùng tên NFT),
 * ưu tiên UTxO chỉ có ADA và nhiều ADA nhất.
 * Nguồn: MagicSDK/src/createVault.ts `pickSeedUtxo` — giữ đồng bộ.
 */
export function pickSeedUtxo<T extends {
  txHash: string; outputIndex: number; assets: Record<string, bigint>;
}>(utxos: T[]): T {
  if (utxos.length === 0) {
    throw new Error(
      "Ví không có UTxO nào để làm seed cho NFT danh-tính vault. Nạp ADA vào ví trước.",
    );
  }
  const rank = (u: T) => (Object.keys(u.assets).length === 1 ? 0 : 1);
  return [...utxos].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const la = a.assets["lovelace"] ?? 0n;
    const lb = b.assets["lovelace"] ?? 0n;
    if (la !== lb) return lb > la ? 1 : -1;
    if (a.txHash !== b.txHash) return a.txHash < b.txHash ? -1 : 1;
    return a.outputIndex - b.outputIndex;
  })[0]!;
}
