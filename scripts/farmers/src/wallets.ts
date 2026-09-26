// scripts/farmers/src/wallets.ts — suy ví nông dân từ hạt giống trong môi trường.
//
// Hạt giống chỉ sống trong trường riêng `#seed` của đối tượng. `toJSON` và `inspect` không
// mang nó, nên một lệnh `console.log(wallet)` hay `JSON.stringify` vô ý không in ra được.

import { getAddressDetails, walletFromSeed, type Network } from "@lucid-evolution/lucid";

import type { FarmerRef } from "./farmers.ts";

export class FarmerWallet {
  readonly #seed: string;

  constructor(
    readonly farmer: string,
    seed: string,
    readonly address: string,
    readonly paymentKeyHash: string,
    /** Khoá THIẾT BỊ của DID (TAADDatum.device_pkh) — account 1 cùng hạt giống, khác controller. */
    readonly devicePkh: string,
  ) {
    this.#seed = seed;
  }

  /** Chỉ executor dựng tx được gọi hàm này, để chọn ví ký. */
  seedForSigning(): string {
    return this.#seed;
  }

  toJSON(): Record<string, string> {
    return { farmer: this.farmer, address: this.address, paymentKeyHash: this.paymentKeyHash, devicePkh: this.devicePkh };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): Record<string, string> {
    return this.toJSON();
  }
}

function pkhOf(address: string): string {
  const c = getAddressDetails(address).paymentCredential;
  if (!c || c.type !== "Key") throw new Error("địa chỉ ví không có payment key credential");
  return c.hash;
}

export function walletFromSeedValue(farmer: string, seed: string, network: Network): FarmerWallet {
  const s = seed.trim().replace(/\s+/g, " ");
  const main = walletFromSeed(s, { network, addressType: "Base", accountIndex: 0 });
  const device = walletFromSeed(s, { network, addressType: "Base", accountIndex: 1 });
  const pkh = pkhOf(main.address);
  const devicePkh = pkhOf(device.address);
  if (pkh === devicePkh) throw new Error(`${farmer}: khoá thiết bị trùng khoá controller`);
  return new FarmerWallet(farmer, s, main.address, pkh, devicePkh);
}

export function deriveFarmerWallets(refs: FarmerRef[], env: Record<string, string | undefined>, network: Network): Map<string, FarmerWallet> {
  const out = new Map<string, FarmerWallet>();
  const seenPkh = new Map<string, string>();
  for (const r of refs) {
    const seed = env[r.seedVar];
    if (!seed) throw new Error(`thiếu giá trị cho ${r.seedVar}`);
    const w = walletFromSeedValue(r.id, seed, network);
    const prior = seenPkh.get(w.paymentKeyHash);
    if (prior) throw new Error(`${r.id} và ${prior} dẫn ra CÙNG một ví — hai biến mang cùng hạt giống`);
    seenPkh.set(w.paymentKeyHash, r.id);
    out.set(r.id, w);
  }
  return out;
}
