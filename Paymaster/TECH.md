# Paymaster — TECH (datum/redeemer + validator)

## GenMAGIC v3.3 · Module Paymaster · v1.0

Nguồn: `Paymaster/onchain/validators/paymaster.ak`; `lib/magiclamp/paymaster/{types,util,math}.ak`;
`offchain/src/{types,math,paymaster}.ts`.

---

## 1. Aiken types + Plutus Data encoding

Constructor index = THỨ TỰ KHAI BÁO field → Plutus Data. Mirror BYTE-PERFECT offchain
(`offchain/src/types.ts`). Field MỚI ở CUỐI (append-only).

### 1.1 SponsorPolicy (beacon datum, reference input) — `types.ak:23-32`

| idx | field | type | offchain schema |
|---|---|---|---|
| 0 | `app_id` | ByteArray | `Data.Bytes()` |
| 1 | `app_authority` | ByteArray (vkh) | `Data.Bytes()` |
| 2 | `max_per_did_per_epoch` | Int (oildrop) | `Data.Integer()` |
| 3 | `max_global_per_epoch` | Int (oildrop) | `Data.Integer()` |
| 4 | `lamp_per_magic_q` | Int (Q) | `Data.Integer()` |
| 5 | `ada_per_magic_q` | Int (Q) | `Data.Integer()` |
| 6 | `oracle_nft_policy` | Option\<ByteArray\> | `Data.Nullable(Data.Bytes())` |
| 7 | `epoch` | Int | `Data.Integer()` |

`Option` encode: `Some(x)=Constr(0,[Bytes])`, `None=Constr(1,[])` ↔ `Data.Nullable`.

### 1.2 SponsorMeter (thread UTxO datum) — `types.ak:39-44`

| idx | field | type | offchain schema |
|---|---|---|---|
| 0 | `app_id` | ByteArray | `Data.Bytes()` |
| 1 | `epoch` | Int | `Data.Integer()` |
| 2 | `did_lamp_map` | List\<(ByteArray,Int)\> | `Data.Array(Data.Tuple([Bytes,Integer]))` |
| 3 | `global_lamp_epoch` | Int (oildrop) | `Data.Integer()` |

Tuple `(ByteArray,Int)` = `Constr(0,[Bytes,Int])` ↔ `Data.Tuple`.

### 1.3 ProtocolFeeParams (beacon DAO sàn) — `types.ak:51-55`

| idx | field | type | offchain schema |
|---|---|---|---|
| 0 | `min_lamp_per_magic_q` | Int (Q) | `Data.Integer()` |
| 1 | `protocol_fee_active` | Bool | `Data.Boolean()` |
| 2 | `epoch` | Int | `Data.Integer()` |

`Bool`: `False=Constr(0,[])`, `True=Constr(1,[])` ↔ `Data.Boolean`. Test xác nhận tag ở `paymaster.test.ts`.

### 1.4 PaymasterRedeemer = Sponsor (spend Meter) — `types.ak:65-74`

| idx | field | type | offchain |
|---|---|---|---|
| 0 | `vault_refs` | List\<OutputReference\> | `Data.Array(OutputReferenceSchema)` |
| 1 | `policy_ref` | OutputReference | `OutputReferenceSchema` |
| 2 | `protocol_ref` | OutputReference | `OutputReferenceSchema` |
| 3 | `did_key` | ByteArray | `Data.Bytes()` |
| 4 | `lamp_this` | Int (oildrop) | `Data.Integer()` |
| 5 | `ada_this` | Int (lovelace) | `Data.Integer()` |

Enum 1-constr → `Constr(0,[...6...])`. Offchain dùng `Data.Object` (KHÔNG `Data.Enum` 1-phần-tử —
Lucid 0.4.x cast lỗi khi variant >1 field; cùng lý do `consume.ts`). `offchain/src/types.ts:73-81`.

### 1.5 NftRedeemer = MintGenesis — `types.ak:77-79`

One-shot minting policy cho **policy NFT + meter NFT** (KHÔNG mint MAGIC). `Data.Enum([Literal("MintGenesis")])`.

---

## 2. Validator logic — paymaster(9 param)

Param (`paymaster.ak:46-56`): `vault_script_hash`, `burn_batch_constr` (Instant=2/Snapshot=1/Vacuum=4/
Schedule=2), `lamp_policy_id`, `policy_nft_policy`, `meter_nft_policy`, `protocol_nft_policy`,
`max_policy_stale`, `max_did_entries`, `ms_per_epoch`.

Handler `spend` (Sponsor): xem FEAT §3.1 cho 17 bước PM-1..PM-12. Điểm an toàn cốt lõi:

- **Đếm theo PAYMENT script hash** (chống double-satisfaction qua stake credential — `util.ak:1-3,45-58`).
- **magic_consumed đọc redeemer thật**, KHÔNG tin redeemer Sponsor (`util.ak:75-90`).
- **PM-1.5 đọc `personal_delegate` field-agnostic** qua `un_constr_data` field index 15 (KHÔNG import
  VaultDatum → tránh coupling cross-module) (`paymaster.ak:225-240`).
- **PM-12 quét MỌI input** `find_spend_redeemer` (`paymaster.ak:246-287`) → magic_total độc lập với
  `vault_refs` khai.
- **Beacon NFT auth**: policy/protocol đọc qua `quantity_of(.., nft_policy, nft_name) == 1` (`paymaster.ak:181-205`).

`else(_) { fail }` (`paymaster.ak:168-170`) — chỉ Spend hợp lệ.

---

## 3. eUTXO flow

```
INPUTS:
  Meter UTxO @paymaster   (Sponsor redeemer)         → cập did_lamp_map + global
  Vault UTxO(s) @vault    (BurnBatch redeemer)        → giảm current_amount (tiêu MAGIC)
REFERENCE INPUTS:
  SponsorPolicy beacon    (policy NFT)                → tỷ giá + cap
  ProtocolFeeParams beacon(protocol NFT)              → sàn + cờ phí
OUTPUTS:
  Meter UTxO @paymaster   (datum mới, value bảo toàn) → 1 Meter NFT giữ nguyên
  (+ phần App settlement ADA/LAMP do App tự dựng)
SIGNERS: app_authority (= delegate)
VALIDITY: cửa sổ ≤ 1 epoch, epoch ref = upper bound
```

---

## 4. Offchain SDK (TypeScript)

| File | Vai trò |
|---|---|
| `offchain/src/types.ts` | Codec datum/redeemer (P8 mirror types.ak) + encode/decode helpers. |
| `offchain/src/math.ts` | `lampCap`/`adaCap` (mirror math.ak) + `sumBurns`/`lookupDid`/`addDid` (mirror util.ak). |
| `offchain/src/paymaster.ts` | `buildSponsorTx` — co-spend Meter+Vault, đọc beacon, tính cap+state, dựng tx. `signAndSubmit`. |
| `offchain/src/index.ts` | Re-export. |

`buildSponsorTx` (`paymaster.ts`) bám validator: tính `magic_consumed` (dedup), `lamp_this`/`ada_this`
(mặc định = cap, override được), áp epoch reset, dựng `meter_out` KHỚP `paymaster.ak:142-144`, ép value
Meter bảo toàn (copy `meterUtxo.assets`), `addSignerKey(app_authority)`, validity cửa sổ ≤ 1 epoch.
Redeemer BurnBatch của vault do **caller truyền CBOR** (constr index khác per vault — tránh coupling).

---

## 5. Aiken test coverage (paymaster.ak)

28 tests pass (`aiken check`, exit 0). Gồm: 4 happy (lamp/ada/epoch-reset/2-vault), 15+ negative
(PM-1 no-cosign, PM-1.5 not-delegate/delegate-none, PM-3 over-cap, PM-3.5 below-floor/sponsor-zero,
PM-5/6 did/global cap, PM-10 stale/fake-NFT, PM-2 fake-magic, PM-7 double-meter/nft-drain, PM-11
drain-ada, PM-8 future-epoch, bad-state, PM-16 unbounded-validity, PM-17 did-overflow), + 6 math
vectors (`math.ak:27-54`). `paymaster.ak:290-901`.
