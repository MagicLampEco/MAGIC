// scripts/farmers/src/observer.ts — sổ 3: TRẠNG THÁI. Chỉ ĐỌC chuỗi.
//
// Tệp này cố ý KHÔNG import mã dựng tx (did.ts, chain.ts, executors.ts): observer phải đo
// được cả khi runner hỏng, và một observer dùng chung đường mã với runner thì hỏng cùng lúc
// với nó — lúc đó hai sổ "khớp nhau" không chứng minh gì.
//
// Giải mã + cộng dồn đi qua VaultReadAPI ▸ readVaultsFromUtxos (cùng hàm dịch vụ đọc dùng),
// không tự giải datum ở đây. Số tiền là BigInt, ghi ra dạng chuỗi thập phân (nanoMAGIC).

import { readVaultsFromUtxos, type IgnoredUtxo } from "../../../VaultReadAPI/src/vaultView.ts";
import type { ChainUtxo } from "../../../VaultReadAPI/src/chain.ts";
import type { VaultKind } from "../../../VaultReadAPI/src/config.ts";

export interface VaultTarget {
  kind: VaultKind;
  scriptHash: string;
  address: string;
}

export interface Observation {
  schema: "magiclamp:farmer-sim:state:v1";
  at: string;
  atEpoch: string;
  atEpochSource: "caller" | "wall-clock";
  farmer: string;
  vaultKind: VaultKind;
  /** null ⟹ không có vault nào của nông dân này ở địa chỉ đó — vẫn một dòng, không im. */
  utxoRef: string | null;
  vaultIdUnit: string | null;
  availableNanogic: string | null;
  accruedNanogic: string | null;
  expiredNanogic: string | null;
  /** UTxO ở địa chỉ vault mà hàm đọc cố ý bỏ qua cho chủ này — ĐẾM, không chỉ khai. */
  ignoredUtxos: number;
  ignoredByReason: Partial<Record<IgnoredUtxo["reason"], number>>;
  /** Tổng UTxO đọc được ở địa chỉ — để người đọc thấy tập đầy đủ mà phép lọc chạy trên. */
  utxosAtAddress: number;
}

export type ChainSource = { kind: "blockfrost"; key: string; network: string } | { kind: "koios"; network: string };

const KOIOS: Record<string, string> = {
  Preprod: "https://preprod.koios.rest/api/v1",
  Preview: "https://preview.koios.rest/api/v1",
};

async function http(url: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} tại ${new URL(url).pathname}`);
  return res.json();
}

/** Mọi UTxO chưa tiêu tại một địa chỉ, ở hình dạng `ChainUtxo` của VaultReadAPI. */
export async function fetchAddressUtxos(src: ChainSource, address: string): Promise<ChainUtxo[]> {
  if (src.kind === "blockfrost") {
    const base = `https://cardano-${src.network.toLowerCase()}.blockfrost.io/api/v0`;
    const out: ChainUtxo[] = [];
    for (let page = 1; page < 1000; page++) {
      const rows = (await http(`${base}/addresses/${address}/utxos?page=${page}`, { headers: { project_id: src.key } })) as
        | { tx_hash: string; output_index: number; amount: { unit: string; quantity: string }[]; inline_datum: string | null }[]
        | null;
      if (rows === null) return out; // địa chỉ chưa từng có gì
      for (const r of rows) {
        const assets: Record<string, bigint> = {};
        for (const a of r.amount) assets[a.unit] = (assets[a.unit] ?? 0n) + BigInt(a.quantity);
        out.push({ txHash: r.tx_hash, outputIndex: r.output_index, assets, inlineDatumHex: r.inline_datum ?? null });
      }
      if (rows.length < 100) return out;
    }
    throw new Error("fetchAddressUtxos: quá 1000 trang — dừng thay vì trả thiếu");
  }
  const base = KOIOS[src.network];
  if (!base) throw new Error(`Koios không có cho ${src.network}`);
  const rows = (await http(`${base}/address_utxos`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ _addresses: [address], _extended: true }),
  })) as
    | {
        tx_hash: string;
        tx_index: number;
        value: string;
        asset_list: { policy_id: string; asset_name: string | null; quantity: string }[] | null;
        inline_datum: { bytes: string } | null;
      }[]
    | null;
  if (rows === null) return [];
  if (rows.length >= 1000) throw new Error("fetchAddressUtxos: Koios trả trang đầy — cần phân trang, dừng thay vì trả thiếu");
  return rows.map((r) => {
    const assets: Record<string, bigint> = { lovelace: BigInt(r.value) };
    for (const a of r.asset_list ?? []) {
      const unit = a.policy_id + (a.asset_name ?? "");
      assets[unit] = (assets[unit] ?? 0n) + BigInt(a.quantity);
    }
    return { txHash: r.tx_hash, outputIndex: r.tx_index, assets, inlineDatumHex: r.inline_datum?.bytes ?? null };
  });
}

/** Một nông dân × một địa chỉ vault → các dòng trạng thái (ít nhất một dòng). KHÔNG mạng. */
export function observeFarmer(
  utxos: ChainUtxo[],
  target: VaultTarget,
  farmer: string,
  ownerPkh: string,
  atEpoch: bigint,
  atEpochSource: Observation["atEpochSource"],
  at: string = new Date().toISOString(),
): Observation[] {
  const r = readVaultsFromUtxos(utxos, target.scriptHash, target.address, ownerPkh, atEpoch, target.kind);
  const byReason: Observation["ignoredByReason"] = {};
  for (const i of r.ignored) byReason[i.reason] = (byReason[i.reason] ?? 0) + 1;
  const common = {
    schema: "magiclamp:farmer-sim:state:v1" as const,
    at,
    atEpoch: atEpoch.toString(),
    atEpochSource,
    farmer,
    vaultKind: target.kind,
    ignoredUtxos: r.ignored.length,
    ignoredByReason: byReason,
    utxosAtAddress: utxos.length,
  };
  if (r.vaults.length === 0) {
    return [{ ...common, utxoRef: null, vaultIdUnit: null, availableNanogic: null, accruedNanogic: null, expiredNanogic: null }];
  }
  return r.vaults.map((v) => ({
    ...common,
    utxoRef: v.utxoRef,
    vaultIdUnit: v.vaultIdUnit,
    availableNanogic: v.availableNanogic.toString(),
    accruedNanogic: v.accruedNanogic.toString(),
    expiredNanogic: v.expiredNanogic.toString(),
  }));
}
