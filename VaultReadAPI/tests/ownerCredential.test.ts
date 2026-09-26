// VaultReadAPI/tests/ownerCredential.test.ts — lọc theo chủ `{ type, hash }`.
//
// Hai két ở CÙNG địa chỉ, CÙNG 28 byte chủ, khác tag. Mỗi truy vấn phải trả đúng MỘT két:
// một bộ lọc chỉ so hash sẽ trả cả hai ở mọi truy vấn, một bộ lọc cứng nhánh khoá sẽ trả 0
// cho truy vấn script. Cặp ca này phân biệt được cả hai đột biến.
import { describe, expect, it } from "vitest";

import { RecordedChainReader } from "../src/chain.js";
import { handle } from "../src/http.js";
import { VaultReadService, resolveReadOwner } from "../src/service.js";
import type { VaultScope } from "../src/config.js";
import {
  SYNTH_ADDRESS, SYNTH_OWNER, SYNTH_SCRIPT_HASH, PIN_EPOCH, synthDatumHex, synthUtxo,
} from "./fixtures/synthetic.js";

const SCOPES: VaultScope[] = [{
  vaultType: "Schedule", address: SYNTH_ADDRESS, scriptHash: SYNTH_SCRIPT_HASH, source: "tổng hợp",
}];
const TIP = { blockHeight: 1, blockHash: "00".repeat(32), blockTimePosixMs: 0n };

const keyVault = synthUtxo({ txHash: "a1".repeat(32), datumHex: synthDatumHex(SYNTH_OWNER, []), vaultIdAssetNameSeed: "c1" });
const scriptVault = synthUtxo({
  txHash: "a2".repeat(32),
  datumHex: synthDatumHex({ type: "script", hash: SYNTH_OWNER }, []),
  vaultIdAssetNameSeed: "c2",
});

function deps() {
  const reader = new RecordedChainReader({ [SYNTH_ADDRESS]: [keyVault, scriptVault] }, TIP);
  const service = new VaultReadService("Preview", SCOPES, reader);
  return { service, scopes: SCOPES, network: "Preview", chainLabel: reader.label, token: "" };
}
const get = (seg: string) => handle({ method: "GET", url: `/vault/by-owner/${seg}?at_epoch=${PIN_EPOCH}`, headers: {} }, deps());

describe("GET /vault/by-owner — chủ Credential", () => {
  it("script:<h> ⟹ đúng két chủ script; owner_pkh = null", async () => {
    const res = await get(`script:${SYNTH_OWNER}`);
    expect(res.status).toBe(200);
    const b = res.body as { owner: unknown; owner_pkh: unknown; vaults: Array<{ utxo_ref: string; owner: unknown; owner_pkh: unknown }> };
    expect(b.owner).toEqual({ type: "script", hash: SYNTH_OWNER });
    expect(b.owner_pkh).toBeNull();
    expect(b.vaults.map(v => v.utxo_ref)).toEqual([`${"a2".repeat(32)}#0`]);
    expect(b.vaults[0]!.owner).toEqual({ type: "script", hash: SYNTH_OWNER });
    expect(b.vaults[0]!.owner_pkh).toBeNull();
  });

  it("CẶP: <h> trần (bí danh) và key:<h> ⟹ đúng két chủ khoá, owner_pkh = h", async () => {
    for (const seg of [SYNTH_OWNER, `key:${SYNTH_OWNER}`]) {
      const res = await get(seg);
      const b = res.body as { owner_pkh: unknown; vaults: Array<{ utxo_ref: string }> };
      expect(b.vaults.map(v => v.utxo_ref)).toEqual([`${"a1".repeat(32)}#0`]);
      expect(b.owner_pkh).toBe(SYNTH_OWNER);
    }
  });

  it("CỰC ĐỐI: tag lạ / hash sai hình dạng / chữ hoa ⟹ 400", async () => {
    for (const seg of [`pool:${SYNTH_OWNER}`, "script:zz", `script:${SYNTH_OWNER.toUpperCase().replace(/1/g, "A")}`]) {
      const res = await get(seg);
      expect(res.status, seg).toBe(400);
    }
  });
});

describe("resolveReadOwner — hai trường cùng có", () => {
  it("cùng chủ ⟹ nhận; KHÁC tag cùng hash ⟹ 400 OWNER_ALIAS_MISMATCH", () => {
    expect(resolveReadOwner({ owner: { type: "key", hash: SYNTH_OWNER }, ownerPkh: SYNTH_OWNER }))
      .toEqual({ type: "key", hash: SYNTH_OWNER });
    try {
      resolveReadOwner({ owner: { type: "script", hash: SYNTH_OWNER }, ownerPkh: SYNTH_OWNER });
      expect.unreachable();
    } catch (e) {
      expect((e as { httpStatus: number; code: string }).httpStatus).toBe(400);
      expect((e as { code: string }).code).toBe("OWNER_ALIAS_MISMATCH");
    }
  });
});
