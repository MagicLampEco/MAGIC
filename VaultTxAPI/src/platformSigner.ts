// VaultTxAPI/src/platformSigner.ts — the ONLY module of this package that holds key material.
//
// ── WHAT THIS MODULE IS ALLOWED TO DO ─────────────────────────────────────────────────────────────
// The service holds exactly ONE key: the `platform` key of the per-DID sponsor funds
// (`PaidFundDatum.platform`, = `paid_fund.sponsor.platform_pkhs[0]`). The project owner decided on
// 2026-10-07 that the service co-signs that role itself. The validator asks for this signature in three
// places the service signs (`PrepaidGen/onchain/validators/prepaid.ak`):
//   · `validate_mint_fund_nft`   — fund genesis (open-vault carrying the fund, open-fund);
//   · `validate_fund_claim`      — FundClaim, CARP out to the fund's pinned beneficiary;
//   · `validate_fund_claim_close`— the last FundClaim of a reclaimed fund (burns the fund NFT).
// This module signs the first (`kind: "fund-genesis"`) and the other two (`kind: "fund-claim"`), nothing else.
//
// The key never leaves the closure built by `createPlatformSigner`, and the closure signs ONLY a
// transaction object that the service has just built in the same request (a `CML.Transaction`, never
// CBOR taken from a request body), together with the resolved UTxO of EVERY spent and collateral input.
//
// Checks common to both kinds (a witness of this key authorises EVERYTHING in the body that this key
// controls, not only the role the validator asks for):
//   (a) every input and collateral input is resolved, and none sits at an address whose payment
//       credential is the platform key — otherwise the witness would also spend that UTxO (review #162-1:
//       a caller who sets `change_address` / `fee_payer` to the platform address gets the fee wallet
//       paid by the platform key);
//   (b) no withdrawal from a reward account whose credential is the platform key; no certificate, no
//       vote, no proposal at all (neither shape needs one);
//   (c) `required_signers` contains the platform key hash.
// Kind-specific:
//   fund-genesis: the mint field carries exactly one asset under the `paid_fund` policy, quantity +1.
//   fund-claim:   exactly one spent input sits at the `paid_fund` script, its spend redeemer is
//                 `FundClaim { amount > 0 }`, its datum names THIS platform and the beneficiary pinned in
//                 configuration; every output that carries CARP goes to that beneficiary (exactly one
//                 output, with the pinned datum) or back to the fund script together with the fund NFT;
//                 the mint field is empty, or burns exactly that fund NFT (−1) and nothing else.
// Anything else ⟹ it throws and signs nothing.
//
// ── IF THIS KEY LEAKS ─────────────────────────────────────────────────────────────────────────────
// Whoever holds it can, without the service:
//   1. trigger `FundClaim` / the closing claim on EVERY fund whose `platform` is this key. The validator
//      still sends the CARP only to the beneficiary pinned in that fund's datum (immutable from genesis),
//      so the holder moves CARP earlier than planned but cannot redirect it;
//   2. mint funds ahead of time for other DIDs (genesis needs only this signature). The service rejects
//      such funds when they differ from configuration — `classifySponsorFunds` marks `foreign_beneficiary`,
//      `buffer_mismatch`, `reclaim_too_far` — and they show up in `GET /sponsor/funds`. A fund minted with
//      exactly the configured values for a DID that has none yet is indistinguishable from a genuine one;
//      it holds 0 CARP until the sponsor signs a fund-vault;
//   3. NOT spend the money of any wallet: the key is no payment key of a fee wallet, sponsor, owner or
//      beneficiary, and (a) above keeps the service from ever turning it into one. If someone sends funds
//      to an address of this key, the holder can spend those — the service warns at startup when the
//      enterprise address of the key holds UTxOs (`sponsor.ts` ▸ `platformAddressFundedWarning`).
// A fourth place accepts this signature but the service never signs it: topping up an EXISTING credit line
// of a Prepaid vault (`validate_lock`: platform OR owner; opening a new line needs the owner). The holder can
// spend the vault UTxO to add CARP of their own to the line of a fund with this platform — value goes INTO
// the vault, not out; the harm is contention on the vault UTxO while they keep topping up.
// Rotation: README "Xoay khoá platform".
//
// Runtime exports: exactly `createPlatformSigner` (pinned by `tests/noSigningMaterial.test.ts`).

import { CML } from "@lucid-evolution/lucid";
import { decodeFundDatum, fundClaimRedeemer, plutusAddressToBech32 } from "@magiclamp/prepaidgen-sdk";

import { fundBeneficiaryIs } from "./sponsorFund.js";

export type PlatformSignKind = "fund-genesis" | "fund-claim";

/** A resolved input of the transaction: `ref` = `<tx hash>#<index>`. */
export interface PlatformSignInput {
  ref: string;
  address: string;
  /** Inline datum CBOR — needed for the fund input of a claim. */
  datumCbor?: string;
  /** Assets of the UTxO — needed for the fund input of a claim (the fund NFT). */
  assets?: Readonly<Record<string, bigint>>;
}

export interface PlatformSignRequest {
  kind: PlatformSignKind;
  tx: CML.Transaction;
  /** Every spent input AND every collateral input of `tx`, resolved. Missing one ⟹ the signer throws. */
  inputs: readonly PlatformSignInput[];
}

/** Signs the platform role of a transaction that the service has just built. */
export type PlatformSign = (r: PlatformSignRequest) => CML.Vkeywitness;

type AddressNetwork = Parameters<typeof plutusAddressToBech32>[0];

export interface PlatformSignerOptions {
  /** Bech32 `ed25519_sk…` value handed over by `config.ts` (the value, never a path). */
  keyBech32: string;
  /** `paid_fund.sponsor.platform_pkhs[0]` — the derived key hash must equal it. */
  expectedPkh: string | undefined;
  /** Script hash of `paid_fund` (= policy of the fund NFT = payment credential of the fund address). */
  paidFundPolicy: string;
  /** Bearer token values of this service; the key must not equal any of them. */
  tokenValues: string[];
  /** Address network of the service (fund datum addresses are rendered to bech32 on it). */
  network: AddressNetwork;
  /** `paid_fund.carp_unit`. Absent ⟹ `fund-claim` is refused. */
  carpUnit?: string;
  /** `paid_fund.sponsor.beneficiary` (+ datum). Absent ⟹ `fund-claim` is refused. */
  beneficiary?: { address: string; datumCbor?: string };
}

const HEX28 = /^[0-9a-f]{56}$/;

function refuse(why: string): never {
  throw new Error(`[platform] refusing to sign: ${why}`);
}

function refOf(i: CML.TransactionInput): string {
  return `${i.transaction_id().to_hex()}#${i.index()}`;
}

function paymentKeyOf(address: string): string | undefined {
  let a: CML.Address;
  try {
    a = CML.Address.from_bech32(address);
  } catch {
    refuse(`input address ${address} is not a bech32 Shelley address`);
  }
  return a.payment_cred()?.as_pub_key()?.to_hex();
}

function paymentScriptOf(address: string): string | undefined {
  try {
    return CML.Address.from_bech32(address).payment_cred()?.as_script()?.to_hex();
  } catch {
    return undefined;
  }
}

/** Spend redeemers by input index (sorted-input position), whatever the witness-set encoding. */
function spendRedeemers(tx: CML.Transaction): Map<bigint, CML.PlutusData> {
  const out = new Map<bigint, CML.PlutusData>();
  const rs = tx.witness_set().redeemers();
  if (rs === undefined) return out;
  const flat = rs.to_flat_format();
  for (let i = 0; i < flat.len(); i++) {
    const r = flat.get(i);
    if (r.tag() === CML.RedeemerTag.Spend) out.set(r.index(), r.data());
  }
  return out;
}

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
  // Constructor index of `FundClaim` as the SDK encodes it (one source for the redeemer shape).
  const claimAlt = CML.PlutusData.from_cbor_hex(fundClaimRedeemer(1n)).as_constr_plutus_data()!.alternative();

  /** (a) + (b): nothing in the body may draw on the platform key except the role the validator asks for. */
  const checkCommon = (body: CML.TransactionBody, resolved: Map<string, PlatformSignInput>): void => {
    const ins = body.inputs();
    const col = body.collateral_inputs();
    const all: CML.TransactionInput[] = [];
    for (let i = 0; i < ins.len(); i++) all.push(ins.get(i));
    for (let i = 0; col !== undefined && i < col.len(); i++) all.push(col.get(i));
    for (const i of all) {
      const u = resolved.get(refOf(i));
      if (u === undefined) refuse(`input ${refOf(i)} is not resolved — every input and collateral must be known.`);
      if (paymentKeyOf(u.address) === pkh) {
        refuse(`input ${refOf(i)} sits at an address of the platform key (${u.address}) — the witness would spend it.`);
      }
    }
    const w = body.withdrawals();
    const ws = w?.keys();
    for (let i = 0; ws !== undefined && i < ws.len(); i++) {
      if (ws.get(i).payment().as_pub_key()?.to_hex() === pkh) {
        refuse("a withdrawal draws on a reward account of the platform key.");
      }
    }
    const certs = body.certs();
    if (certs !== undefined && certs.len() > 0) refuse("the transaction carries certificates.");
    if (body.voting_procedures() !== undefined || body.proposal_procedures() !== undefined) {
      refuse("the transaction carries governance votes or proposals.");
    }
  };

  /** (c) */
  const checkRequiredSigner = (body: CML.TransactionBody): void => {
    const rs = body.required_signers();
    let listed = false;
    for (let i = 0; rs !== undefined && i < rs.len(); i++) if (rs.get(i).to_hex() === pkh) listed = true;
    if (!listed) refuse("required_signers does not contain the platform key hash.");
  };

  const checkGenesis = (body: CML.TransactionBody): void => {
    const mint = body.mint();
    const assets = mint?.get_assets(CML.ScriptHash.from_hex(policy));
    const names = assets?.keys();
    if (assets === undefined || names === undefined || names.len() !== 1 || assets.get(names.get(0)) !== 1n) {
      refuse("the transaction does not mint exactly one fund NFT (+1) under paid_fund.");
    }
  };

  const checkClaim = (tx: CML.Transaction, resolved: Map<string, PlatformSignInput>): void => {
    const body = tx.body();
    if (o.carpUnit === undefined || o.beneficiary === undefined) {
      refuse("fund-claim needs paid_fund.carp_unit and paid_fund.sponsor.beneficiary in configuration.");
    }
    const carpUnit = o.carpUnit;
    const ben = o.beneficiary;
    // Exactly one spent input at the paid_fund script; sorted position = spend redeemer index.
    const ins = body.inputs();
    const sorted: CML.TransactionInput[] = [];
    for (let i = 0; i < ins.len(); i++) sorted.push(ins.get(i));
    sorted.sort((a, b) => {
      const ha = a.transaction_id().to_hex();
      const hb = b.transaction_id().to_hex();
      return ha === hb ? Number(a.index() - b.index()) : ha < hb ? -1 : 1;
    });
    const fundIdx = sorted.flatMap((i, k) => paymentScriptOf(resolved.get(refOf(i))!.address) === policy ? [k] : []);
    if (fundIdx.length !== 1) refuse(`the transaction spends ${fundIdx.length} paid_fund UTxOs, a claim spends exactly one.`);
    const fund = resolved.get(refOf(sorted[fundIdx[0]!]!))!;
    // Redeemer: FundClaim { amount > 0 } (the closing claim uses the same redeemer).
    const rd = spendRedeemers(tx).get(BigInt(fundIdx[0]!))?.as_constr_plutus_data();
    const amount = rd?.fields().len() === 1 ? rd.fields().get(0).as_integer()?.to_str() : undefined;
    if (rd === undefined || rd.alternative() !== claimAlt || amount === undefined || !(BigInt(amount) > 0n)) {
      refuse("the paid_fund input is not spent with FundClaim { amount > 0 }.");
    }
    // Fund datum: this platform, the pinned beneficiary.
    if (fund.datumCbor === undefined || fund.assets === undefined) refuse("the fund input is resolved without datum or assets.");
    let datum: ReturnType<typeof decodeFundDatum>;
    try {
      datum = decodeFundDatum(fund.datumCbor);
    } catch {
      refuse("the fund input datum does not decode as PaidFundDatum.");
    }
    if (datum.platform !== pkh) refuse("the fund names another platform key.");
    if (!fundBeneficiaryIs(o.network, datum, ben)) refuse("the fund beneficiary differs from paid_fund.sponsor.beneficiary.");
    const nfts = Object.entries(fund.assets).filter(([k, q]) => k.startsWith(policy) && q === 1n).map(([k]) => k);
    if (nfts.length !== 1) refuse("the fund input does not carry exactly one fund NFT.");
    const nftUnit = nfts[0]!;
    // Outputs: CARP only to the pinned beneficiary (exactly one output, pinned datum) or back to the fund.
    const benDatum = ben.datumCbor === undefined ? null : CML.PlutusData.from_cbor_hex(ben.datumCbor).to_cbor_hex();
    const outs = body.outputs();
    let benHits = 0;
    let continued = false;
    for (let i = 0; i < outs.len(); i++) {
      const out = outs.get(i);
      const addr = out.address().to_bech32(undefined);
      const ma = out.amount().multi_asset();
      const carp = ma.get(CML.ScriptHash.from_hex(carpUnit.slice(0, 56)), CML.AssetName.from_hex(carpUnit.slice(56))) ?? 0n;
      const nft = ma.get(CML.ScriptHash.from_hex(policy), CML.AssetName.from_hex(nftUnit.slice(56))) ?? 0n;
      if (paymentScriptOf(addr) === policy && nft === 1n) { continued = true; continue; }
      if (addr === ben.address) {
        const d = out.datum()?.as_datum();
        const got = d === undefined ? null : CML.PlutusData.from_cbor_hex(d.to_cbor_hex()).to_cbor_hex();
        if (got !== benDatum) refuse(`output #${i} to the beneficiary carries a datum other than the pinned one.`);
        if (carp > 0n) benHits += 1;
        continue;
      }
      if (carp > 0n) refuse(`output #${i} carries CARP to ${addr}, not to the pinned beneficiary.`);
    }
    if (benHits !== 1) refuse(`the claim pays CARP to the beneficiary in ${benHits} outputs, exactly one is required.`);
    // Mint: none (continuing claim), or burn exactly the fund NFT (closing claim, no continuation output).
    const mint = body.mint();
    const pols = mint?.keys();
    if (pols !== undefined && pols.len() > 0) {
      const burn = mint!.get_assets(CML.ScriptHash.from_hex(policy));
      const names = burn?.keys();
      if (pols.len() !== 1 || burn === undefined || names === undefined || names.len() !== 1
        || names.get(0).to_hex() !== nftUnit.slice(56) || burn.get(names.get(0)) !== -1n || continued) {
        refuse("the claim mints something other than burning its own fund NFT (closing claim).");
      }
    } else if (!continued) {
      refuse("the claim neither continues the fund nor burns its NFT.");
    }
  };

  return (r: PlatformSignRequest): CML.Vkeywitness => {
    const body = r.tx.body();
    const resolved = new Map(r.inputs.map(i => [i.ref, i] as const));
    checkCommon(body, resolved);
    if (r.kind === "fund-genesis") checkGenesis(body);
    else if (r.kind === "fund-claim") checkClaim(r.tx, resolved);
    else refuse(`unknown kind ${String(r.kind)}.`);
    checkRequiredSigner(body);
    return CML.make_vkey_witness(CML.hash_transaction(body), sk);
  };
}
