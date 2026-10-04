// scripts/deploy/10_deploy_prepaid.ts — PrepaidGen: quỹ Paid + vault trả trước.
// Run: npx tsx deploy/10_deploy_prepaid.ts
//
// ⛔ BƯỚC NÀY CHẠY ĐƯỢC TRÊN PREPROD, VÀ ĐÓNG TRÊN MAINNET/PREVIEW.
//    `config.ts` ▸ `requireCarpIdentity` lấy cặp định danh CARP từ
//    `PrepaidGen/offchain/src/constants.ts` ▸ `carpAssetClass(network)` — cửa DUY
//    NHẤT của cặp đó, fail-closed sẵn. Preprod có cặp (đo 2026-09-11, nguồn nhà
//    CarpetMint); Mainnet và Preview là `null` ⟹ hàm NÉM ở dòng đầu của `main`.
//
//    Bản trước của khối này viết "CỐ TÌNH KHÔNG CHẠY ĐƯỢC KHI CHƯA CÓ CẶP ĐỊNH
//    DANH CARP ĐÃ CHỐT". Cặp ĐÃ chốt từ 2026-09-11 và nằm trong chính kho này —
//    câu đó khai một bước chạy được là đang bị nhà khác chặn, tức đúng lớp hại mà
//    `POLICY_IDS.backing` vừa phải gỡ: một việc nằm im vì một lý do đã hết hiệu lực,
//    và không có gì kêu lên.
//
//    `carp_policy_id`/`carp_asset_name` vẫn là apply-param lúc BIÊN DỊCH: một giá
//    trị giữ chỗ vẫn ra script hash hợp lệ và vẫn deploy êm — cái ra đời là một quỹ
//    không bao giờ nhìn thấy CARP của chính nó, và ba nhánh tiêu của nó (`FundLock`
//    · `FundSettle` · `FundClaim`) đều chết. Đó là lý do cổng đối chiếu CANONICAL
//    chứ không chỉ đo hình dạng.
//
// HAI GIAO DỊCH, KHÔNG PHẢI MỘT — và thứ tự không đảo được:
//
//   (A) đúc NFT quỹ  → `paid_fund` genesis, datum ghim `vault_hash`
//   (B) đúc NFT vault → `prepaid_vault` genesis, datum sạch
//
//   Tách làm hai vì (B) tiêu UTxO thối của (A): không chờ xác nhận thì node vẫn
//   thấy UTxO cũ ⟹ BadInputsUTxO. Cùng bẫy mà `07_create_schedule_vault.ts` đã
//   trả giá một lần.
//
// CHUỖI APPLY MỘT CHIỀU (không khép vòng — xem `deployParams.ts`):
//   paid_fund(carp…) → paid_fund_hash → prepaid_vault(carp…, paid_fund_hash, …)
// Chiều ngược đi qua DỮ LIỆU chứ không qua tham số biên dịch:
//   PaidFundDatum.vault_hash ghim tại genesis bởi handler `mint` của paid_fund.
//
// 🔴 HAI PHÉP BĂM TÊN TÀI SẢN, KHÁC NHAU, DÙNG TRONG CÙNG MỘT ĐỢT:
//   NFT quỹ  → `fundId.ts`  ▸ fundIdAssetName    (tx_hash ‖ be8(index), KHÔNG CBOR)
//   NFT vault→ `vaultId.ts` ▸ vaultIdAssetName   (cbor.serialise(OutputReference))
//   Gọi nhầm hàm không đỏ ở TypeScript. Xem khối đầu `scripts/fundId.ts`.
//
// Env vars:
//   CARP_POLICY_ID    — BẮT BUỘC, 56 hex. Không có ⟹ bước này đóng.
//   CARP_ASSET_NAME   — BẮT BUỘC, hex chẵn, không rỗng.
//   PLATFORM_PKH      — pkh provider giữ quỹ (mặc định: pkh của ví đang chạy).
//                       On-chain ĐÒI chữ ký này ở genesis (từ 2026-09-26).
//   BUFFER_BPS        — đệm buffer-Paid, mặc định 1500 (= min_buffer_bps)
//   BENEFICIARY_ADDRESS — BẮT BUỘC, KHÔNG mặc định. Địa chỉ bech32 ENTERPRISE (không
//                       stake) nhận CARP mỗi lượt `FundClaim`, ghim trọn đời quỹ.
//   BENEFICIARY_DATUM — BẮT BUỘC, KHÔNG mặc định: `none` (output không datum) hoặc
//                       CBOR hex của Plutus Data (output mang inline datum đó).
//                       Beneficiary là script ⟹ phải là CBOR, không được `none`.
//   (Hai biến BENEFICIARY_* chỉ bắt buộc khi chạy genesis — xem hai cờ dưới.)
//   PREPAID_REFS_ONLY=1 — chỉ công bố hai ref-script (bước R), KHÔNG genesis. Dùng khi chạy
//                       lại sau khi genesis đã xong mà ref-script chưa đỗ: genesis KHÔNG
//                       idempotent (mỗi lượt đúc một quỹ + một két mới), ref-script thì có.
//   DRY_RUN=1         — tính hash, đọc bãi đỗ, DỰNG tx công bố cho cái còn thiếu để đo
//                       kích thước; KHÔNG ký, KHÔNG gửi, KHÔNG genesis, KHÔNG in dòng cho sổ.
//
// BA PHA theo thứ tự: (R) ref-script → (A) quỹ → (B) két. (R) đứng đầu vì nó idempotent
// và không phụ thuộc genesis; hỏng ở (R) thì chưa đúc gì, chạy lại an toàn.
//
// (R) — HAI ref-script CIP-33, MỖI CÁI MỘT TX (`refScripts.ts ▸ publishRefScript`), khoá sổ
// `REF_VAULT_PREPAID_UTXO` + `REF_PAID_FUND_UTXO`. Bước này công bố vì bước này tính ra hash
// (cùng luật với 05/06/09/11). Hai hash phụ thuộc ĐỜI CARP, không phụ thuộc LAMP.
//
// Vì sao TÁCH dù gộp VỪA trần — chép có nhãn, đo 2026-10-02 bằng `scripts/test_deploy_prepaid.ts`
// (C) trên blueprint PrepaidGen sau vá `validate_draw` (prepaid_vault chưa apply 693e56fa…), đo
// lại bằng chính lệnh đó: script đã apply 8.069 B + 4.958 B; tx riêng 8.235 B / 5.124 B; GỘP một
// tx 13.240 B, còn 3.144 B tới trần 16.384. Kích thước không buộc phải tách. Tách vì: (a) bãi đỗ
// idempotent THEO TỪNG SCRIPT (`publishRefScript`), nên lượt chạy lại sau khi đỗ được một cái chỉ
// công bố cái còn thiếu — một tx gộp phải tự dựng lại phép lọc đó; (b) biên 3.144 B là biên của
// MỘT đời validator, và `prepaid_vault` đổi bytes theo mỗi bản vá; (c) chi phí gộp tiết kiệm được
// chỉ là một lần phí tx mỗi đời CARP, còn min-ADA (khoản lớn) như nhau ở cả hai cách.

import {
  Lucid, Blockfrost, Data, Constr, toUnit,
  credentialToAddress, scriptHashToCredential,
  getAddressDetails, validatorToScriptHash,
} from "@lucid-evolution/lucid";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet,
  PROTOCOL, requireCarpIdentity,
} from "../config.js";
import { loadBlueprint } from "../applyParams.js";
import { prepaidScriptPair, prepaidRefScriptPlan, type PaidFundParamInputs } from "../deployParams.js";
import { parkAddressFor, publishRefScript } from "../refScripts.js";
import { minAdaForRefScriptWithMargin } from "../minAda.js";
import { parseFlag } from "../runResult.js";
import { vaultIdAssetName, mintVaultIdRedeemer, pickSeedUtxo } from "../vaultId.js";
import { fundIdAssetName } from "../fundId.js";
import {
  OwnerCredentialSchema,
  PaidFundDatumSchema,
  type PaidFundDatum as PaidFundDatumT,
  type PlutusAddress,
} from "../../PrepaidGen/offchain/src/types.js";
import { assertCarpMatchesInstance, fetchCarpInstance } from "../../PrepaidGen/offchain/src/carpInstance.js";
import type { CarpNetwork } from "../../PrepaidGen/offchain/src/constants.js";
import { wakemeVaultHash } from "@magiclamp/protocol-utils";

// ── Lược đồ datum ────────────────────────────────────────────────
// Neo: PrepaidGen/onchain/lib/magiclamp/protocol/types.ak ▸ PaidFundDatum,
// PrepaidVaultDatum. Thứ tự trường là HỢP ĐỒNG NHỊ PHÂN — xê dịch một trường là
// đổi cách giải mã mọi UTxO đã tạo (BOUNDARIES.md §2).
//
// `PaidFundDatum` (13 trường từ 2026-10-04) + `Address` NẠP từ `PrepaidGen/offchain`
// — MỘT nguồn lược đồ. Bản chép riêng ở đây (11 trường) đã trôi khỏi validator đúng một
// lần và bị gỡ. Lược đồ Lucid là dữ liệu thuần (TypeBox), nên dùng chéo hai bản lucid
// của hai gói được — cùng cách `OwnerCredentialSchema` đã được nạp từ trước.
type PaidFundDatum = PaidFundDatumT;
const PaidFundDatum = PaidFundDatumSchema as unknown as PaidFundDatum;

const PrepaidVaultDatumSchema = Data.Object({
  owner:            OwnerCredentialSchema,   // Credential — nguồn: PrepaidGen/offchain/src/types.ts
  did_commit:       Data.Bytes(),
  prepaid_credits:  Data.Array(Data.Object({
    fund_id:         Data.Bytes(),
    remaining:       Data.Integer(),
    issued_epoch:    Data.Integer(),
    last_draw_epoch: Data.Integer(),
    // Thêm Ở CUỐI 2026-09-28: nợ quyết toán (nanogic đã đốt, quỹ chưa ghi nhận).
    // Vault 4-trường-mỗi-dòng đời trước KHÔNG đọc được bằng lược đồ này, và
    // ngược lại — Aiken nghiêm về số trường cả hai chiều.
    consumed_unsettled: Data.Integer(),
  })),
  // 🔴 `MagicBatch` CỦA PREPAIDGEN KHÔNG CÙNG HÌNH DẠNG với ScheduleGen/InstantGen.
  // Đừng chép lược đồ từ `07_create_schedule_vault.ts` sang — đo 2026-09-19 trên
  // `PrepaidGen/onchain/lib/magiclamp/protocol/types.ak` ▸ `MagicBatch`:
  //
  //   ở đây (7 trường)          | ScheduleGen/InstantGen (9 trường)
  //   source: Int  1|2|3        | source: enum Snapshot|Instant|Vacuum|Schedule
  //   (không có initial_amount) | initial_amount: Int
  //   profile_at_creation: Int  | profile_at_creation: Option<ActivityProfile>
  //   contract_id: ByteArray    | contract_id: Option<ByteArray>
  //   (không có halved)         | halved: Bool
  //
  // `source` để Int là CHỦ Ý (chú thích ở types.ak): "số 3" của spec và chỉ số
  // constructor là hai thang khác nhau, và một enum ở đây sẽ trộn chúng.
  //
  // Genesis ép `magic_batches == []` nên mảng rỗng mã hoá y nhau ở mọi lược đồ —
  // tức lược đồ SAI ở đây sẽ đi qua bước deploy này mà không có gì đỏ, rồi hỏng ở
  // người viết bước tiếp theo. Đó là lý do nó được viết đúng ngay bây giờ.
  magic_batches:    Data.Array(Data.Object({
    batch_id:            Data.Bytes(),
    source:              Data.Integer(),   // 1=Instant 2=Schedule 3=Prepaid
    created_epoch:       Data.Integer(),
    current_amount:      Data.Integer(),   // nanogic
    decay_window:        Data.Integer(),   // luôn = 1 (§4.2)
    profile_at_creation: Data.Integer(),   // luôn = 0 (PrepaidGen không dùng tư-cách)
    contract_id:         Data.Bytes(),     // = fund_id
  })),
  next_batch_index:   Data.Integer(),
  // 🪦 BIA MỘ — quyền chết 2026-09-16 (Nợ #14), trường ở lại đúng chỗ: gỡ nó đẩy
  // mọi trường sau lên một chỉ số, và có bên đọc theo VỊ TRÍ.
  personal_delegate:  Data.Nullable(Data.Bytes()),
  last_updated_epoch: Data.Integer(),
  attribution:        Data.Object({
    attribution_root: Data.Bytes(),
    last_event_epoch: Data.Integer(),
    total_events:     Data.Integer(),
  }),
});
type PrepaidVaultDatum = Data.Static<typeof PrepaidVaultDatumSchema>;
const PrepaidVaultDatum = PrepaidVaultDatumSchema as unknown as PrepaidVaultDatum;

/**
 * Đọc đích nhận CARP từ env, fail-closed: thiếu một trong hai biến ⟹ NÉM, không
 * đệm giá trị nào (đích đệm = một quỹ trả doanh thu về chỗ không ai định chọn,
 * và `beneficiary` bất biến trọn đời quỹ).
 *
 * Gương các cổng `validate_mint_fund_nft` nằm ĐƯỢC ở đây (không stake, datum bắt
 * buộc khi là script). Hai cổng so với hash quỹ/vault chạy sau khi apply param.
 */
function readBeneficiary(): {
  address: PlutusAddress;
  datum: Data | null;
  kind: "Key" | "Script";
  hash: string;
} {
  const bech = process.env.BENEFICIARY_ADDRESS;
  if (!bech) {
    throw new Error(
      "BENEFICIARY_ADDRESS chưa đặt. Đích nhận CARP của FundClaim ghim TRỌN ĐỜI quỹ " +
      "(`PaidFundDatum.beneficiary`), nên bước này không chọn hộ.",
    );
  }
  const rawDatum = process.env.BENEFICIARY_DATUM;
  if (rawDatum === undefined || rawDatum === "") {
    throw new Error(
      "BENEFICIARY_DATUM chưa đặt. Ghi `none` (output không datum) hoặc CBOR hex của " +
      "Plutus Data — không có giá trị mặc định.",
    );
  }
  const details = getAddressDetails(bech);
  const wantNetworkId = NETWORK === "Mainnet" ? 1 : 0;
  if (details.networkId !== wantNetworkId) {
    throw new Error(
      `BENEFICIARY_ADDRESS thuộc networkId ${details.networkId}, mạng đang chạy là ${NETWORK}.`,
    );
  }
  const pc = details.paymentCredential;
  if (!pc) throw new Error("BENEFICIARY_ADDRESS không có payment credential.");
  if (details.stakeCredential) {
    throw new Error(
      "BENEFICIARY_ADDRESS phải là địa chỉ ENTERPRISE (không stake). " +
      "`validate_mint_fund_nft` ép `beneficiary.stake_credential == None`, và " +
      "`validate_fund_claim` so địa chỉ đầy đủ.",
    );
  }
  let datum: Data | null;
  if (rawDatum === "none") {
    datum = null;
  } else {
    if (!/^([0-9a-f]{2})+$/.test(rawDatum)) {
      throw new Error("BENEFICIARY_DATUM phải là `none` hoặc CBOR hex chẵn, chữ thường.");
    }
    datum = Data.from(rawDatum);   // ném nếu không phải Plutus Data hợp lệ
  }
  if (pc.type === "Script" && datum === null) {
    throw new Error(
      "Beneficiary là SCRIPT mà BENEFICIARY_DATUM = none. On-chain từ chối " +
      "(`Script(_) ⟹ beneficiary_datum != None`): CARP tới script không datum là " +
      "CARP không nhánh nào của kho đích tiêu lại được.",
    );
  }
  const cred = pc.type === "Key"
    ? { VerificationKey: [pc.hash] as [string] }
    : { Script: [pc.hash] as [string] };
  return {
    address: { payment_credential: cred, stake_credential: null },
    datum,
    kind: pc.type,
    hash: pc.hash,
  };
}

/** `min_buffer_bps` — neo: PrepaidGen/onchain/lib/magiclamp/protocol/constants.ak */
const MIN_BUFFER_BPS = 1_500n;
const MAX_BUFFER_BPS = 10_000n;

async function main() {
  console.log("=== Step 10: PrepaidGen — quỹ Paid + vault trả trước ===\n");

  // Cổng fail-closed. Ném TRƯỚC khi chạm ví hay mạng: một bước deploy dừng lại vì
  // thiếu dữ kiện thì phải dừng ở chỗ RẺ NHẤT, không phải sau khi đã đốt phí.
  const carp = requireCarpIdentity();
  // SOFT-PIN: cặp CARP (mặc định hoặc đè bằng biến môi trường) phải trùng instance
  // công khai của nhà CarpetMint ngay lúc chạy. Lệch ⟹ NÉM trước khi biên dịch
  // apply-param — đời CARP đổi mà bản chép trong kho chưa theo là ca đã xảy ra.
  const carpInstance = await fetchCarpInstance(NETWORK as CarpNetwork);
  assertCarpMatchesInstance(carp, carpInstance);
  console.log(`CARP khớp instance ${carpInstance.network} (deployedAt ${carpInstance.deployedAt ?? "?"})`);
  const dryRun = parseFlag(process.env.DRY_RUN, "DRY_RUN");
  const refsOnly = dryRun || parseFlag(process.env.PREPAID_REFS_ONLY, "PREPAID_REFS_ONLY");
  // `null` ⟺ chỉ chạy pha (R): đích nhận CARP không dùng tới, nên không đòi hai biến của nó.
  const beneficiary = refsOnly ? null : readBeneficiary();

  const bufferBps = BigInt(process.env.BUFFER_BPS ?? MIN_BUFFER_BPS.toString());
  if (bufferBps < MIN_BUFFER_BPS) {
    throw new Error(
      `BUFFER_BPS=${bufferBps} dưới sàn hiến định ${MIN_BUFFER_BPS} (15%).\n` +
      `  · validate_mint_fund_nft ép \`fd.buffer_bps >= min_buffer_bps\`, nên giao ` +
      `dịch sẽ chết trên chuỗi — cổng này chỉ để nó chết trước khi mất phí.`,
    );
  }
  // TRẦN, không chỉ SÀN. On-chain CHỈ có sàn (`prepaid.ak` ▸ `validate_mint_fund_nft`),
  // và `buffer_bps` BẤT BIẾN trọn đời quỹ (`fund_common_checks` ▸ `buffer_bps` vào ==
  // ra). Nên một số 0 gõ thừa không đỏ ở đâu cả: `BUFFER_BPS=150000` cho
  // `buffer_floor = 16 × outstanding`, mà `validate_fund_claim` ép
  // `carp_locked >= buffer_floor` ⟹ MỌI lượt rút một phần bị chặn vĩnh viễn, và
  // không nhánh nào sửa được `buffer_bps`. Lối thoát duy nhất là bỏ quỹ và dựng quỹ
  // mới — trong khi CARP người dùng đã khoá vào thì nằm lại tới khi quyết toán hết.
  if (bufferBps > MAX_BUFFER_BPS) {
    throw new Error(
      `BUFFER_BPS=${bufferBps} vượt trần ${MAX_BUFFER_BPS} (100%).\n` +
      `  · Đây là cổng OFF-CHAIN thuần: validator chỉ ép SÀN, nên giá trị này deploy ` +
      `êm và khoá cứng đường rút của provider vĩnh viễn.\n` +
      `  · \`buffer_bps\` bất biến trọn đời quỹ — sai ở đây không sửa được bằng một ` +
      `giao dịch về sau, chỉ sửa được bằng cách bỏ quỹ.`,
    );
  }

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error("Không lấy được payment credential của ví");
  const ownerPkh = paymentCredential.hash;

  const platformPkh = process.env.PLATFORM_PKH ?? ownerPkh;
  if (!/^[0-9a-f]{56}$/.test(platformPkh)) {
    throw new Error(
      `PLATFORM_PKH phải là 28 byte hex (56 ký tự), nhận "${platformPkh}". ` +
      `\`validate_mint_fund_nft\` ép \`bytearray.length(fd.platform) == 28\`.`,
    );
  }
  // HÌNH DẠNG KHÔNG PHẢI QUYỀN ĐIỀU KHIỂN. `fd.platform` bất biến trọn đời quỹ và là
  // khoá DUY NHẤT ký được `FundClaim` (`validate_fund_claim` ▸ `list.has(tx.extra_signatories,
  // fund_in.platform)`). Từ 2026-09-26 cổng genesis on-chain ĐÒI chữ ký đó (trước
  // đây chỉ ép độ dài 28 byte, nên một pkh gõ nhầm cho ra quỹ hợp lệ mà không ai
  // rút được) — dòng `addSignerKey(platformPkh)` bên dưới là để giao dịch đáp ứng
  // cổng ấy, không còn là cổng off-chain thuần.
  const platformIsOwner = platformPkh === ownerPkh;

  // ── Apply params THEO TÊN — thứ tự do blueprint quyết định ───────────────
  const bp = await loadBlueprint("PrepaidGen");

  // Cặp `paid_fund` → `prepaid_vault` qua MỘT hàm dùng chung với bước 09 và bộ ca
  // (`deployParams.ts` ▸ `prepaidScriptPair`): `paid_fund_hash` của két là hash bản ĐÃ apply.
  const carpParams: PaidFundParamInputs = {
    carpPolicyId:   carp.policyId,
    carpAssetName:  carp.assetName,
    msPerEpoch:     PROTOCOL.MS_PER_EPOCH,
    windowOriginMs: PROTOCOL.WINDOW_ORIGIN_MS,
    // Két Wakeme của mạng — nguồn duy nhất ProtocolUtils; mạng chưa có két ⟹ NÉM.
    wakemeVaultHash: wakemeVaultHash(NETWORK),
  };
  const { fundScript, fundHash, vaultScript, vaultHash } = prepaidScriptPair(bp, carpParams);
  const fundAddress = credentialToAddress(NETWORK, scriptHashToCredential(fundHash));
  const vaultAddress = credentialToAddress(NETWORK, scriptHashToCredential(vaultHash));

  // ── (R) Ref-script CIP-33 ────────────────────────────────────────────────
  const plan = prepaidRefScriptPlan(bp, carpParams);
  if (plan[0]?.hash !== vaultHash || plan[1]?.hash !== fundHash) {
    throw new Error("prepaidRefScriptPlan lệch prepaidScriptPair — hai hàm phải dựng cùng một cặp.");
  }
  const parkAddr = parkAddressFor(NETWORK, address);
  console.log(`Bãi đỗ ref-script:  ${parkAddr}`);
  // Lấy MỘT lần rồi truyền vào từng lượt (cùng lý do với bước 06).
  const parked = await lucid.utxosAt(parkAddr);
  const refOut: [string, string][] = [];
  for (const p of plan) {
    // min-ADA TÍNH từ chính script đã apply-param, không gõ cứng (`scripts/minAda.ts`).
    const lovelace = minAdaForRefScriptWithMargin(p.script.script);
    console.log(`${p.label.padEnd(18)}  ${p.hash} (script ${p.script.script.length / 2} byte, min-ADA ${lovelace / 1_000_000n} ADA)`);
    if (dryRun) {
      const have = parked.find((u) => u.scriptRef && validatorToScriptHash(u.scriptRef) === p.hash);
      if (have) { console.log(`  ✓ đã đỗ: ${have.txHash}#${have.outputIndex}`); continue; }
      const tx = await lucid.newTx().pay.ToAddressWithData(parkAddr, undefined, { lovelace }, p.script).complete();
      console.log(`  (dry run) tx công bố dựng được: ${tx.toCBOR().length / 2} byte chưa ký — không gửi`);
      continue;
    }
    refOut.push([p.bookKey, await publishRefScript({
      lucid, parkAddr, label: p.label, script: p.script, hash: p.hash, lovelace, parked,
    })]);
  }
  if (dryRun) {
    console.log(`\n✔ DRY RUN: không ký, không gửi, không genesis, không in dòng cho sổ.`);
    return;
  }
  if (beneficiary === null) {
    console.log(`\n📋 Ghi vào state.${NETWORK}.sh (PREPAID_REFS_ONLY — không genesis):`);
    for (const [k, v] of refOut) console.log(`   ${k}=${v}`);
    return;
  }

  // Hai cổng genesis còn lại chỉ đo được sau khi biết hash đã apply.
  if (beneficiary.kind === "Script" && beneficiary.hash === fundHash) {
    throw new Error("BENEFICIARY_ADDRESS là chính script quỹ — mọi FundClaim sẽ chết.");
  }
  if (beneficiary.kind === "Script" && beneficiary.hash === vaultHash) {
    throw new Error(
      "BENEFICIARY_ADDRESS là script vault — output không mang NFT vault, CARP chết.",
    );
  }

  console.log(`Network:            ${NETWORK}`);
  console.log(`CARP policy:        ${carp.policyId}`);
  console.log(`CARP asset name:    ${carp.assetName}`);
  console.log(`ms_per_epoch:       ${PROTOCOL.MS_PER_EPOCH}`);
  console.log(`paid_fund hash:     ${fundHash}`);
  console.log(`paid_fund address:  ${fundAddress}`);
  console.log(`prepaid_vault hash: ${vaultHash}`);
  console.log(`vault address:      ${vaultAddress}`);
  console.log(`platform pkh:       ${platformPkh}`);
  console.log(`buffer_bps:         ${bufferBps}`);
  console.log(`beneficiary:        ${process.env.BENEFICIARY_ADDRESS} (${beneficiary.kind})`);
  console.log(`beneficiary datum:  ${beneficiary.datum === null ? "none" : process.env.BENEFICIARY_DATUM}\n`);
  if (beneficiary.kind === "Script") {
    console.log(
      "⚠  Beneficiary là SCRIPT: on-chain chỉ ép HÌNH DẠNG (địa chỉ + datum), không ép " +
      "khả năng tiêu lại.\n   Trước khi lập quỹ này, chi thử một UTxO ở đúng cặp " +
      "(BENEFICIARY_ADDRESS, BENEFICIARY_DATUM) trên testnet — DevStatus.md ▸ Nợ #85.\n",
    );
  }

  // ── (A) Genesis quỹ ──────────────────────────────────────────────────────
  // `validate_mint_fund_nft` ép: đúng một tên dưới policy, qty 1, tên suy từ một
  // input BỊ TIÊU, đúng một carrier ở `Script(policy_id)`, không stake, không
  // ref-script, và sổ genesis sạch.
  const utxosA   = await lucid.wallet().getUtxos();
  const fundSeed = pickSeedUtxo(utxosA);
  const fundId   = fundIdAssetName({
    txHash: fundSeed.txHash, outputIndex: fundSeed.outputIndex,
  });
  const fundUnit = toUnit(fundHash, fundId);

  console.log(`Seed quỹ:           ${fundSeed.txHash}#${fundSeed.outputIndex}`);
  console.log(`NFT quỹ:            ${fundHash}.${fundId}`);

  const fundDatum: PaidFundDatum = {
    fund_id:            fundId,
    platform:           platformPkh,
    vault_hash:         vaultHash,     // PIN: phá vòng tham chiếu qua DỮ LIỆU
    carp_locked:        0n,            // PIN: `expect fd.carp_locked == 0`
    credit_issued:      0n,            // PIN
    magic_settled:      0n,            // PIN
    provider_claimed:   0n,            // PIN
    buffer_bps:         bufferBps,     // PIN: `>= min_buffer_bps`
    last_updated_epoch: 0n,            // PIN
    beneficiary:        beneficiary.address, // PIN trọn đời: không stake, ≠ quỹ/vault
    beneficiary_datum:  beneficiary.datum,   // PIN: Script ⟹ bắt buộc có
    // Quỹ thường của provider (DESIGN-reclaim §10.3). Quỹ tài trợ cho một DID mở ở
    // luồng T2 theo DID, không ở bước deploy này.
    sponsorship:        null,                // PIN: None ⟹ không bao giờ vào FundReclaim
    sponsor_reclaimed:  0n,                  // PIN: `expect fd.sponsor_reclaimed == 0`
  };

  // Handler `mint` của paid_fund bỏ qua redeemer (`_redeemer: Data`); gửi một
  // constructor rỗng thay vì `undefined` để CBOR luôn hợp lệ.
  const fundMintRedeemer = Data.to(new Constr(0, []));

  let txABuilder = lucid
    .newTx()
    .collectFrom([fundSeed])
    .mintAssets({ [fundUnit]: 1n }, fundMintRedeemer)
    .attach.MintingPolicy(fundScript)
    .pay.ToAddressWithData(
      fundAddress,
      { kind: "inline", value: Data.to(fundDatum, PaidFundDatum) },
      { lovelace: 2_000_000n, [fundUnit]: 1n },
    );

  // Chữ ký platform nay là cổng ON-CHAIN (`validate_mint_fund_nft` ▸
  // `list.has(tx.extra_signatories, fd.platform)`, 2026-09-26): không có nó thì ai
  // cũng lập được quỹ mạo danh platform thật với đích là ví mình. Luôn khai signer —
  // kể cả khi platform trùng ví đang chạy — để `extra_signatories` mang đúng pkh
  // đó; ví chỉ ký witness thôi thì KHÔNG đưa pkh vào `extra_signatories`.
  // `sign.withWallet()` chỉ ký bằng ví đang chạy: `PLATFORM_PKH` khác ví thì tx dựng
  // được mà không submit được — đó là cố ý, fail-closed.
  txABuilder = txABuilder.addSignerKey(platformPkh);
  if (!platformIsOwner) {
    console.log(
      `⚠  PLATFORM_PKH ≠ ví đang chạy: giao dịch (A) cần thêm chữ ký của ${platformPkh}.`,
    );
  }

  const txA = await txABuilder.complete();

  const signedA = await txA.sign.withWallet().complete();
  const txHashA = await signedA.submit();
  await lucid.awaitTx(txHashA);
  console.log(`\n✅ (A) Quỹ Paid genesis: ${txHashA}`);

  // ── (B) Genesis vault ────────────────────────────────────────────────────
  // `validate_mint_vault_id` ép thêm: owner phải KÝ giao dịch này, và
  // `did_commit` RỖNG (đặt sau, một lần, qua nhánh `SetDidCommit` constr 5).
  const utxosB    = await lucid.wallet().getUtxos();
  const vaultSeed = pickSeedUtxo(utxosB);
  const vaultIdName = vaultIdAssetName({
    txHash: vaultSeed.txHash, outputIndex: vaultSeed.outputIndex,
  });
  const vaultIdUnit  = toUnit(vaultHash, vaultIdName);
  const mintRedeemer = mintVaultIdRedeemer({
    txHash: vaultSeed.txHash, outputIndex: vaultSeed.outputIndex,
  });

  console.log(`\nSeed vault:         ${vaultSeed.txHash}#${vaultSeed.outputIndex}`);
  console.log(`NFT vault:          ${vaultHash}.${vaultIdName}`);

  const vaultDatum: PrepaidVaultDatum = {
    owner:              { VerificationKey: [ownerPkh] },   // PIN: `owner_authorized(tx, vd.owner)` — nhánh khoá ⟹ ví ký
    did_commit:         "",            // PIN: `expect vd.did_commit == #""`
    prepaid_credits:    [],            // PIN
    magic_batches:      [],            // PIN
    next_batch_index:   0n,            // PIN
    personal_delegate:  null,          // PIN: `expect vd.personal_delegate == None`
    last_updated_epoch: 0n,            // PIN
    // PIN: `attribution_root: #""` — chuỗi byte RỖNG, KHÔNG phải 32 byte 0.
    attribution:        { attribution_root: "", last_event_epoch: 0n, total_events: 0n },
  };

  const txB = await lucid
    .newTx()
    .collectFrom([vaultSeed])
    .mintAssets({ [vaultIdUnit]: 1n }, mintRedeemer)
    .attach.MintingPolicy(vaultScript)
    .pay.ToAddressWithData(
      vaultAddress,
      { kind: "inline", value: Data.to(vaultDatum, PrepaidVaultDatum) },
      // Nhiều nhất {ADA, NFT} — `expect list.length(assets.policies(...)) <= 2`.
      // KHÔNG gửi kèm CARP ở đây: CARP vào quỹ qua `PrepaidLock`, không qua genesis.
      { lovelace: 2_000_000n, [vaultIdUnit]: 1n },
    )
    .addSignerKey(ownerPkh)
    .complete();

  const signedB = await txB.sign.withWallet().complete();
  const txHashB = await signedB.submit();
  await lucid.awaitTx(txHashB);
  console.log(`✅ (B) Vault trả trước genesis: ${txHashB}`);

  console.log(`\n📋 Ghi vào state.${NETWORK}.sh:`);
  for (const [k, v] of refOut) console.log(`   ${k}=${v}`);
  console.log(`   PAID_FUND_HASH=${fundHash}`);
  console.log(`   PAID_FUND_ADDR=${fundAddress}`);
  console.log(`   PAID_FUND_NFT_UNIT=${fundUnit}`);
  console.log(`   VAULT_PREPAID_HASH=${vaultHash}`);
  console.log(`   VAULT_PREPAID_ADDR=${vaultAddress}`);
  console.log(`   VAULT_PREPAID_ID_UNIT=${vaultIdUnit}`);
  console.log(
    `\n⚠  Hai dòng hash trên GHIM một đời CARP: policy ${carp.policyId.slice(0, 12)}…, ` +
    `name ${carp.assetName}.\n` +
    `   Đời CARP đổi ⟹ apply-param đổi ⟹ hash đổi ⟹ địa chỉ đổi. Ghi cặp định danh ` +
    `NGAY CẠNH hai hash này trong sổ deploy, đừng để người tra phải đoán.`,
  );
  console.log(
    `\n⚠  CÒN THIẾU để PrepaidGen tiêu được MAGIC: một bản \`consume\` apply-param bằng ` +
    `\`vault_script_hash=${vaultHash}\`.\n` +
    `   \`consume\` ghim vault theo LOẠI (BOUNDARIES.md §2), nên mỗi cửa gen cần một bản ` +
    `riêng. Chạy \`VAULT_KIND=prepaid npx tsx deploy/09_deploy_consume.ts\` với VAULT_PREPAID_HASH ` +
    `trên — bước 09 dựng lại hash từ đời CARP và NÉM nếu sổ lệch.`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
