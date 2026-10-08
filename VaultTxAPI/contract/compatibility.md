# VaultTxAPI module contract: compatibility rules

Who this is for: a developer who writes a backend module that calls VaultTxAPI to consume MAGIC, and the
developer who changes VaultTxAPI.

The contract is `openapi.json` in this directory. Its version is `info.version`. The error table is
`error-codes.json`; the example answers and refused answers are in `vectors/`. The test
`tests/moduleContract.test.ts` runs all three against the real router, and checks the error table in both
directions: every code in the table is still raised in `src/`, and every code `src/` raises is in the table with
the same HTTP status, or on a short list of codes, each with its reason, that only routes outside this contract
raise or that a guard on a contract route makes unreachable. They cannot drift
from the code without a red test.

## 1. Responses are OPEN

A response may gain keys at any level (top level, inside `fee_payer`, inside a step, inside `error.details`)
without a major version bump. A reader of responses MUST:

- ignore keys it does not know;
- not fail the parse on them, and not answer its own caller with an error because of them;
- treat an error `code` it does not know by its HTTP status class, not as a parse failure, and NEVER as a reason
  to build a new transaction:
  - 4xx (409 and 410 included): the request or the state is at fault. Do not send the same request again on
    its own; surface the error, or fix the request.
  - 5xx: the same request may be sent again, with backoff.

What a response never loses or changes without a major bump: a key listed in the schema's `required`, the
type or format of a listed key, and the meaning of an error code. `error.details` follows the same rule: a code
may gain a key in `details` (minor), and a key it already has keeps its type and its meaning (changing either
is major).

### Before rebuilding after a failed submit or sign

A transaction the module already signed may have reached the chain even when the answer was an error: the node
took it and the answer was lost, the service restarted, another replica answered, or the node said "input
already spent" because this very transaction spent it. Building a new transaction for the same operation then
spends MAGIC twice.

So after ANY failure of `POST /tx/submit` or `POST /fee/sign` (any status, any code, or no answer at all), and
before building again, call `GET /tx/status/{tx_hash}` with the hash of the transaction already signed:

| `state` | Meaning | What to do |
|---|---|---|
| `in_chain` | It landed. | The operation is done. Do not build. |
| `in_mempool` | It is on its way. | Poll `/tx/status` again. Do not build. |
| `not_found` | Not seen. | Rebuild ONLY once it can no longer land: `server_time` is later than `expires_at`. When the answer has no `expires_at` (the service no longer remembers the transaction), use the upper bound of the validity interval decoded from the transaction's own CBOR, compared with the `server_time` of a recent answer of this service. Until then, poll. |

A `/tx/status` that fails itself (`502 TX_STATUS_PROVIDER_UNAVAILABLE`) is not `not_found`: wait and ask again.

The case that made this rule: `fee_payer.reservation_id` was added to the `/fee/utxo` answer without a major
bump. A reader that rejected keys it did not know answered its own users with 502 on every call after the
release.

## 2. Requests are CLOSED where the service echoes a shape back

These request objects refuse unknown keys:

| Object | Refusal |
|---|---|
| `fee_payer` (in `POST /tx/consume` and every `POST /tx/sponsor/*` route that reads it) | `400 FEE_PAYER_SHAPE`, `details.extra_fields` lists the keys |
| each element of `pairs` | `400 CONSUME_PAIRS_SHAPE` |
| `owner`: `{type: key or script, hash}`, or `{type: did, did, device_key_hash?}` | `400 OWNER_CREDENTIAL_SHAPE`, `details.extra_fields` lists the keys |
| the `POST /tx/quote` body (`route`, `params`, `owner_fee_addresses`) | `400 FEE_QUOTE_SHAPE`, `details.extra_fields` lists the keys |

Why they are closed: a key the service silently ignores is a key the caller believes is in force. A request
that says `fee_payer: { ..., "reserve_for": "x" }` would be built and priced as if the key were absent. Failing
closed tells the caller the service does not know that key, before money is involved.

The rest of the request bodies follow `openapi.json`; its schema is the statement of what is accepted.

## 3. The fee_payer echo rule

A module MUST send the `fee_payer` object of `/fee/utxo` to the build routes AS RETURNED, as one block. It
must not pick keys one by one ("utxo, address and reservation_id are all I need"): the day the service adds a
key to that object, a re-picked copy loses the key, and the reservation it carries no longer applies.

The service, for its part, adds a key to the `fee_payer` object of the `/fee/utxo` response in TWO releases.
Section 2 refuses a key the build routes do not know, and during a rollout a module can get its `fee_payer` from
an instance of the new release and send it to a build route of the old one:

1. release N: every route that reads `fee_payer` (`/tx/consume`, `/tx/sponsor/first-consume`, and the others)
   accepts the new key. `/fee/utxo` does not send it yet.
2. release N+1, once every instance runs N: `/fee/utxo` starts sending the key.

Each release carries the contract and tests of section 5 for its half.

## 4. What changes the major version

Increase the major number of `info.version` when a change can break a module that follows sections 1 to 3:

- removing a key from a response, renaming it, or changing its type or format;
- changing the meaning of an error code, or the HTTP status a code is answered with, so that a reader
  branching on it would act wrongly;
- adding a REQUIRED key to a request, or making a request key stricter (a narrower pattern or enum);
- adding a value to an enum of a RESPONSE (`state`, `redeemer`, `feecover`, `actor`, `source`,
  `details.submission`, and any other enum a response carries). A reader branches on those values and treats a
  value it does not know as a breach of the contract;
- removing a route or a method.

Additive changes (a new response key, a new error code, a new optional request key, a new route) increase the
minor number. Wording, examples and test changes only increase the patch number.

## 5. One change, one pull request

A change to behaviour a module sees updates, in the SAME pull request:

1. `openapi.json` (and `info.version` per section 4);
2. `error-codes.json`, when a code is added or changes;
3. `vectors/`: the valid sample that shows the new behaviour and, when something is now refused, the refused
   sample with its reason (`contract_version` in every vector file equals `info.version`);
4. the tests in `tests/moduleContract.test.ts` (and the hooks in `feeQuote.test.ts` and
   `sponsorEmulator.test.ts` that check the routes needing heavier setup (`/tx/quote` and the seven `/tx/sponsor/*` routes) against the same schemas and the same error table).

A pull request that changes the routes without these is incomplete: the contract is the thing a module
developer reads, and a stale contract is worse than none.

## 6. Where the version lives

`info.version` in `openapi.json` is the only number. The error table and each vector file repeat it as
`contract_version`, and a test fails when the three differ. Do not add a second version string elsewhere.
