// VaultTxAPI/tests/minAdaFloor.test.ts — min-ADA của output KÉT Instant và THREAD Engage, đo bằng
// đúng phép tính của sổ cái (CML, cùng `calculateMinLovelace` của lucid) trên datum mã hoá bằng
// lược đồ SẢN XUẤT.
//
// Bài này là chỗ đo cho hai quyết định của `feePayer.ts` (khối "KHOẢN ỨNG MIN-ADA"):
//   · két Instant lớn dần theo số lô ⟹ ví trả phí được ứng phần nâng, có trần — KHÔNG đặt sàn
//     "đủ cho datum trần" lúc tạo: két Instant không có nhánh đóng (mọi nhánh spend ghim NFT danh
//     tính ở output, `validate_vault_value`), nên lovelace của két khoá VĨNH VIỄN; sàn trần = khoá
//     thêm ~13 ADA mỗi két mà phần lớn két không bao giờ dùng tới;
//   · thread Engage KHÔNG nâng được (nhánh Consume ép `out.value == inp.output.value`) ⟹ sàn
//     `ENGAGE_MIN_LOVELACE` phải ≥ min-ADA datum thread ở cỡ trần. Ca cuối tệp GHIM quan hệ đó.
//
// "Cỡ trần": mọi số nguyên 2^64 − 1 (dạng CBOR dài nhất trước bignum), bytes ở độ dài lớn nhất
// validator cho ghi (`batch_id`/`wakeme_link`/`did_commit` 32 byte, chủ Script 28 byte), các ô
// validator ghim sau genesis giữ giá trị ghim.

import { CML, Data, assetsToValue, credentialToAddress, type Assets } from "@lucid-evolution/lucid";
import { InstantVaultDatumSchema, buildInitialVaultDatum, type InstantVaultDatum } from "@magiclamp/sdk";
import { ENGAGE_MIN_LOVELACE, EngageDatumSchema, type EngageDatumT } from "@magiclamp/consumemagic";
import { describe, expect, it } from "vitest";

const CPUB = 4310n;
const MAX = 2n ** 64n - 1n;
const MAX_BATCHES = 32; // `InstantGen/onchain/lib/magiclamp/protocol/constants.ak` ▸ `max_batches_per_vault`
const B32 = "ff".repeat(32);
const VAULT_HASH = "a1".repeat(28);
const ENGAGE_HASH = "c3".repeat(28);
const LAMP_UNIT = "4c".repeat(28) + "744c414d50";
const STAKE = { type: "Key" as const, hash: "5e".repeat(28) };
const VAULT_ADDRS = {
  enterprise: credentialToAddress("Preprod", { type: "Script", hash: VAULT_HASH }),
  base: credentialToAddress("Preprod", { type: "Script", hash: VAULT_HASH }, STAKE),
};
const ENGAGE_ADDRS = {
  enterprise: credentialToAddress("Preprod", { type: "Script", hash: ENGAGE_HASH }),
  base: credentialToAddress("Preprod", { type: "Script", hash: ENGAGE_HASH }, STAKE),
};
const NFT = VAULT_HASH + "ab".repeat(32);

/** min-ADA sổ cái của một output (phần lovelace của `assets` bị bỏ qua). */
function minAdaOf(address: string, assets: Assets, datumHex: string): bigint {
  const tokens: Assets = {};
  for (const [u, q] of Object.entries(assets)) if (u !== "lovelace") tokens[u] = q;
  return CML.TransactionOutputBuilder.new()
    .with_address(CML.Address.from_bech32(address))
    .with_data(CML.DatumOption.new_datum(CML.PlutusData.from_cbor_hex(datumHex)))
    .next()
    .with_asset_and_min_required_coin(assetsToValue(tokens).multi_asset(), CPUB)
    .build().output().amount().coin();
}

const enc = (d: InstantVaultDatum) => Data.to(d as never, InstantVaultDatumSchema as never);
const encE = (d: EngageDatumT) => Data.to(d, EngageDatumSchema as unknown as EngageDatumT);

/** Datum genesis THẬT (hàm sản xuất) cộng `n` lô Instant ở cỡ thực tế. */
function genesisPlus(n: number): InstantVaultDatum {
  const g = buildInitialVaultDatum({
    ownerPkh: "5b".repeat(28), lampBalanceOildrop: 1_000_000_000n, profile: "Flame",
    currentEpoch: 280n, vaultType: "Instant", wakemeLink: "dd".repeat(32),
  });
  return {
    ...g,
    magic_batches: Array.from({ length: n }, (_, i) => ({
      batch_id: (i + 1).toString(16).padStart(64, "0"), source: "Instant", created_epoch: 280n,
      initial_amount: 3_900_000_000n, current_amount: 3_900_000_000n, decay_window: 1n,
      profile_at_creation: null, contract_id: null, halved: false,
    })) as InstantVaultDatum["magic_batches"],
    next_batch_index: BigInt(n),
    ...(n === 0 ? {} : { last_updated_epoch: 280n, cap_epoch: 280n, cap_nanogic: 390_000_000_000n, instant_unlock_ms: 1_791_000_000_000n }),
  };
}

/** Datum két Instant ở cỡ trần. */
function instantMax(): InstantVaultDatum {
  return {
    owner: { Script: ["ff".repeat(28)] } as InstantVaultDatum["owner"],
    lamp_balance: MAX, lamp_locked: MAX,
    loyalty_holdings: [{ amount: MAX, acquired_epoch: MAX, is_locked: false }],
    magic_batches: Array.from({ length: MAX_BATCHES }, () => ({
      batch_id: B32, source: "Instant", created_epoch: MAX, initial_amount: MAX, current_amount: MAX,
      decay_window: MAX, profile_at_creation: null, contract_id: null, halved: false,
    })) as InstantVaultDatum["magic_batches"],
    next_batch_index: MAX, wakeme_link: B32, gen_schedules: [], profile: "Lantern",
    profile_changed_epoch: MAX, pending_profile: { new_profile: "Lantern", effective_epoch: MAX },
    last_updated_epoch: MAX, cap_epoch: MAX,
    activity_state: { recent_burn_epochs: [], consumed_credit: MAX },
    cap_nanogic: MAX, personal_delegate: null,
    attribution: { attribution_root: B32, last_event_epoch: MAX, total_events: MAX },
    instant_unlock_ms: MAX,
    usage_window: Array.from({ length: 7 }, () => ({ generated: MAX, consumed: MAX })),
    usage_window_epoch: MAX,
  } as InstantVaultDatum;
}

const threadGenesis = (): EngageDatumT => ({
  owner: { VerificationKey: ["5b".repeat(28)] }, consumed_count: 0n, last_epoch: 0n, did_commit: "", consumed_nanogic: 0n,
} as unknown as EngageDatumT);
const threadMax = (): EngageDatumT => ({
  owner: { Script: ["ff".repeat(28)] }, consumed_count: MAX, last_epoch: MAX, did_commit: B32, consumed_nanogic: MAX,
} as unknown as EngageDatumT);

describe("min-ADA két Instant — số đo", () => {
  it("đơn điệu theo số lô, ở cả hai hình dạng địa chỉ; datum trần đòi nhiều nhất", () => {
    const rows: string[] = [];
    for (const [shape, addr] of Object.entries(VAULT_ADDRS)) {
      let prev = 0n;
      for (const n of [0, 1, 8, 16, MAX_BATCHES]) {
        const hex = enc(genesisPlus(n));
        const m = minAdaOf(addr, { [LAMP_UNIT]: 1_000_000_000n, [NFT]: 1n }, hex);
        rows.push(`két ${shape} · ${n} lô · datum ${hex.length / 2} B → ${m}`);
        // Cực đối của "một hằng": hàm trả hằng đứng yên và trượt ca này.
        expect(m).toBeGreaterThan(prev);
        prev = m;
      }
      const maxHex = enc(instantMax());
      const t = minAdaOf(addr, { [LAMP_UNIT]: MAX, [NFT]: 1n }, maxHex);
      rows.push(`két ${shape} · TRẦN · datum ${maxHex.length / 2} B → ${t}`);
      expect(t).toBeGreaterThan(prev);
    }
    console.log("\n" + rows.join("\n"));
  });

  it("lượt Sinh đầu (0 → 1 lô) đòi nâng min-ADA — đúng hiện tượng đo trên Preprod 2026-10-04", () => {
    const g = minAdaOf(VAULT_ADDRS.base, { [LAMP_UNIT]: 1_000_000_000n, [NFT]: 1n }, enc(genesisPlus(0)));
    const one = minAdaOf(VAULT_ADDRS.base, { [LAMP_UNIT]: 1_000_000_000n, [NFT]: 1n }, enc(genesisPlus(1)));
    expect(one - g).toBeGreaterThan(0n);
    // Một két mở 2 ADA không đủ cho datum 1 lô.
    expect(one).toBeGreaterThan(2_000_000n);
  });

  it("datum trần mã hoá được bằng lược đồ sản xuất (lược đồ trôi thì ca này đỏ)", () => {
    expect(() => Data.from(enc(instantMax()), InstantVaultDatumSchema as never)).not.toThrow();
  });
});

describe("thread Engage — sàn ENGAGE_MIN_LOVELACE", () => {
  it("sàn ≥ min-ADA datum thread ở cỡ trần, cả hai hình dạng địa chỉ (thread không nâng được sau khi mở)", () => {
    const rows: string[] = [];
    for (const [shape, addr] of Object.entries(ENGAGE_ADDRS)) {
      const assets = { [ENGAGE_HASH + "ab".repeat(32)]: 1n };
      const g = minAdaOf(addr, assets, encE(threadGenesis()));
      const t = minAdaOf(addr, assets, encE(threadMax()));
      rows.push(`thread ${shape} · genesis ${g} · trần ${t} · sàn ${ENGAGE_MIN_LOVELACE}`);
      // Cực đối: datum trần đòi nhiều hơn genesis — một phép đo bỏ qua datum sẽ trượt ca này.
      expect(t).toBeGreaterThan(g);
      expect(ENGAGE_MIN_LOVELACE).toBeGreaterThanOrEqual(t);
    }
    console.log("\n" + rows.join("\n"));
  });
});
