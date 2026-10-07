// VaultTxAPI/src/platformSigner.ts — the ONLY module of this package that holds key material.
//
// ── WHAT THIS MODULE IS ALLOWED TO DO ─────────────────────────────────────────────────────────────
// The service holds exactly ONE key: the `platform` role of the per-DID sponsor fund genesis
// (`PrepaidGen/onchain/validators/prepaid.ak` ▸ `validate_mint_fund_nft` requires
// `list.has(tx.extra_signatories, fd.platform)`). The project owner decided on 2026-10-07 that the
// service co-signs that role inside the open-vault transaction itself (one step fewer for the newcomer,
// and the fee payer no longer has to hold the platform key).
//
// The key never leaves the closure built by `createPlatformSigner`, and the closure signs ONLY a
// transaction object that the service has just built in the same request (a `CML.Transaction`, never
// CBOR taken from a request body). Before signing it checks, on the transaction itself:
//   (1) the mint field carries exactly one asset under the `paid_fund` policy, with quantity +1;
//   (2) `required_signers` contains the platform key hash.
// Anything else ⟹ it throws and signs nothing.
//
// The service still holds NO key that moves funds, and it never signs for the fee payer, the vault owner
// or the sponsor. If this key leaks, an attacker can mint funds whose `platform` is the real platform
// key; the service pins `beneficiary` (`sponsorFund.ts` ▸ `foreign_beneficiary`), so a fund with any
// other destination is rejected, and `FundClaim` only pays to the pinned destination.
//
// Runtime exports: exactly `createPlatformSigner` (pinned by `tests/noSigningMaterial.test.ts`).

import { CML } from "@lucid-evolution/lucid";

/** Signs the platform role of a sponsor fund genesis that the service has just built. */
export type PlatformSign = (tx: CML.Transaction) => CML.Vkeywitness;

export interface PlatformSignerOptions {
  /** Bech32 `ed25519_sk…` value handed over by `config.ts` (the value, never a path). */
  keyBech32: string;
  /** `paid_fund.sponsor.platform_pkhs[0]` — the derived key hash must equal it. */
  expectedPkh: string | undefined;
  /** Script hash of `paid_fund` (= policy of the fund NFT). */
  paidFundPolicy: string;
  /** Bearer token values of this service; the key must not equal any of them. */
  tokenValues: string[];
}

const HEX28 = /^[0-9a-f]{56}$/;

/**
 * Startup: derive the key hash and refuse to start on any mismatch. Returns the only signing function.
 * Error messages never echo the key value.
 */
export function createPlatformSigner(o: PlatformSignerOptions): PlatformSign {
  const raw = o.keyBech32.trim();
  if (o.tokenValues.some(t => t !== "" && t === raw)) {
    throw new Error("[platform] VAULT_TX_API_PLATFORM_KEY equals a bearer token value of this service — refusing to start.");
  }
  if (!raw.startsWith("ed25519_sk1")) {
    throw new Error("[platform] VAULT_TX_API_PLATFORM_KEY must be a bech32 ed25519_sk… value — refusing to start.");
  }
  let sk: CML.PrivateKey;
  try {
    sk = CML.PrivateKey.from_bech32(raw);
  } catch {
    throw new Error("[platform] VAULT_TX_API_PLATFORM_KEY is not a valid bech32 ed25519_sk… value — refusing to start.");
  }
  const pkh = sk.to_public().hash().to_hex();
  const expected = o.expectedPkh?.toLowerCase();
  if (expected === undefined) {
    throw new Error(
      "[platform] VAULT_TX_API_PLATFORM_KEY is set but paid_fund.sponsor.platform_pkhs is empty — the key hash " +
      "cannot be checked; refusing to start.");
  }
  if (pkh !== expected) {
    throw new Error(
      `[platform] key hash of VAULT_TX_API_PLATFORM_KEY (${pkh}) != paid_fund.sponsor.platform_pkhs[0] (${expected}) ` +
      `— refusing to start.`);
  }
  const policy = o.paidFundPolicy.toLowerCase();
  if (!HEX28.test(policy)) throw new Error(`[platform] paid_fund policy "${o.paidFundPolicy}" is not 28 bytes hex.`);

  return (tx: CML.Transaction): CML.Vkeywitness => {
    const body = tx.body();
    // (1) exactly one +1 asset under the paid_fund policy.
    const mint = body.mint();
    const assets = mint?.get_assets(CML.ScriptHash.from_hex(policy));
    const names = assets?.keys();
    if (assets === undefined || names === undefined || names.len() !== 1 || assets.get(names.get(0)) !== 1n) {
      throw new Error("[platform] refusing to sign: the transaction does not mint exactly one fund NFT (+1) under paid_fund.");
    }
    // (2) the platform key hash is a required signer.
    const rs = body.required_signers();
    let listed = false;
    for (let i = 0; rs !== undefined && i < rs.len(); i++) if (rs.get(i).to_hex() === pkh) listed = true;
    if (!listed) {
      throw new Error("[platform] refusing to sign: required_signers does not contain the platform key hash.");
    }
    return CML.make_vkey_witness(CML.hash_transaction(body), sk);
  };
}
