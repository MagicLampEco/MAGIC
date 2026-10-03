// MagicSDK/tests/didStakeForDid.test.ts — suy tên NFT anchor và script `did_stake` từ chuỗi DID.
//
// Vector blake2b_256 tính độc lập bằng Python `hashlib.blake2b(s.encode(), digest_size=32)`
// (2026-10-03), không bằng chính thư viện mà mã dùng.

import { applyParamsToScript, validatorToScriptHash } from "@lucid-evolution/lucid";
import { describe, expect, it } from "vitest";

import { didAnchorNftName, didStakeScriptForDid } from "../src/index.js";

// Script giả CHƯA apply. `4746010000222220` làm `applyParamsToScript` hỏng; mẫu dưới thì không.
const FAKE_UNAPPLIED = "49480100002221200101";
const POLICY = "ab".repeat(28);
const DID = "did:phoenix:preprod:abc123";

describe("didAnchorNftName", () => {
  it("khớp vector blake2b_256(utf8(did)) tính bằng Python", () => {
    expect(didAnchorNftName(DID)).toBe("9000b767ee33c6ddf6b5fd558fff37c5fa082d3a584ae4f39d581234df24d94a");
  });
  it("chuỗi rỗng bị từ chối, không trả hash của chuỗi rỗng", () => {
    expect(() => didAnchorNftName("")).toThrow(/khác rỗng/);
  });
});

describe("didStakeScriptForDid", () => {
  it("hash = apply (policy, tên anchor) độc lập rồi băm", () => {
    const got = didStakeScriptForDid({ unappliedCbor: FAKE_UNAPPLIED, anchorNftPolicy: POLICY, did: DID });
    const cbor = applyParamsToScript(FAKE_UNAPPLIED, [POLICY, "9000b767ee33c6ddf6b5fd558fff37c5fa082d3a584ae4f39d581234df24d94a"]);
    expect(got.cbor).toBe(cbor);
    expect(got.hash).toBe(validatorToScriptHash({ type: "PlutusV3", script: cbor }));
    expect(got.hash).toMatch(/^[0-9a-f]{56}$/);
  });
  it("DID khác ⟹ hash khác; policy khác ⟹ hash khác; thứ tự tham số có nghĩa", () => {
    const a = didStakeScriptForDid({ unappliedCbor: FAKE_UNAPPLIED, anchorNftPolicy: POLICY, did: DID }).hash;
    const b = didStakeScriptForDid({ unappliedCbor: FAKE_UNAPPLIED, anchorNftPolicy: POLICY, did: `${DID}x` }).hash;
    const c = didStakeScriptForDid({ unappliedCbor: FAKE_UNAPPLIED, anchorNftPolicy: "cd".repeat(28), did: DID }).hash;
    const swapped = validatorToScriptHash({ type: "PlutusV3",
      script: applyParamsToScript(FAKE_UNAPPLIED, [didAnchorNftName(DID), POLICY]) });
    expect(new Set([a, b, c, swapped]).size).toBe(4);
  });
  it("đầu vào sai hình dạng ⟹ ném", () => {
    expect(() => didStakeScriptForDid({ unappliedCbor: "abc", anchorNftPolicy: POLICY, did: DID })).toThrow(/unappliedCbor/);
    expect(() => didStakeScriptForDid({ unappliedCbor: FAKE_UNAPPLIED, anchorNftPolicy: "ab", did: DID })).toThrow(/anchorNftPolicy/);
  });
});
