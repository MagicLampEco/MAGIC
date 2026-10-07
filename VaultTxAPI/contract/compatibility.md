# VaultTxAPI module contract: compatibility rules

Who this is for: a developer who writes a backend module that calls VaultTxAPI to consume MAGIC, and the
developer who changes VaultTxAPI.

The contract is `openapi.json` in this directory. Its version is `info.version`. The error table is
`error-codes.json`; the example answers and refused answers are in `vectors/`. The test
`tests/moduleContract.test.ts` runs all three against the real router, so they cannot drift from the code
without a red test.

## 1. Responses are OPEN

A response may gain keys at any level (top level, inside `fee_payer`, inside a step, inside `error.details`)
without a major version bump. A reader of responses MUST:

- ignore keys it does not know;
- not fail the parse on them, and not answer its own caller with an error because of them;
- treat an error `code` it does not know by the HTTP status class (4xx: the request or the state is at fault,
  do not retry blindly; 409: rebuild; 5xx: try later), not as a parse failure.

What a response never loses or changes without a major bump: a key listed in the schema's `required`, the
type or format of a listed key, and the meaning of an error code.

The case that made this rule: `fee_payer.reservation_id` was added to the `/fee/utxo` answer without a major
bump. A reader that rejected keys it did not know answered its own users with 502 on every call after the
release.

## 2. Requests are CLOSED where the service echoes a shape back

Two request objects refuse unknown keys:

| Object | Refusal |
|---|---|
| `fee_payer` (in `POST /tx/consume` and `POST /tx/sponsor/first-consume`) | `400 FEE_PAYER_SHAPE`, `details.extra_fields` lists the keys |
| each element of `pairs` | `400 CONSUME_PAIRS_SHAPE` |

Why they are closed: a key the service silently ignores is a key the caller believes is in force. A request
that says `fee_payer: { ..., "reserve_for": "x" }` would be built and priced as if the key were absent. Failing
closed tells the caller the service does not know that key, before money is involved.

The rest of the request bodies follow `openapi.json`; its schema is the statement of what is accepted.

## 3. The fee_payer echo rule

A module MUST send the `fee_payer` object of `/fee/utxo` to the build routes AS RETURNED, as one block. It
must not pick keys one by one ("utxo, address and reservation_id are all I need"): the day the service adds a
key to that object, a re-picked copy loses the key, and the reservation it carries no longer applies.

The service, for its part: when it adds a key to the `fee_payer` object of the `/fee/utxo` response, the SAME
release must make the build routes accept that key (section 2 would otherwise refuse the module's own echo).
That pair of changes is one change, in one pull request, with the contract and tests of section 5.

## 4. What changes the major version

Increase the major number of `info.version` when a change can break a module that follows sections 1 to 3:

- removing a key from a response, renaming it, or changing its type or format;
- changing the meaning of an error code, or the HTTP status a code is answered with, so that a reader
  branching on it would act wrongly;
- adding a REQUIRED key to a request, or making a request key stricter (a narrower pattern or enum);
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
   `sponsorEmulator.test.ts` that check the two routes needing heavier setup against the same schemas).

A pull request that changes the routes without these is incomplete: the contract is the thing a module
developer reads, and a stale contract is worse than none.

## 6. Where the version lives

`info.version` in `openapi.json` is the only number. The error table and each vector file repeat it as
`contract_version`, and a test fails when the three differ. Do not add a second version string elsewhere.
