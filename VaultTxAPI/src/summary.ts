// VaultTxAPI/src/summary.ts — bản tóm tắt SUY TỪ CBOR, không phải tiếng vọng của yêu cầu.
//
// ══ VÌ SAO TỆP NÀY TỒN TẠI ════════════════════════════════════════════════════
// App hiện `summary` cho người dùng đọc TRƯỚC khi họ ký. Nếu `summary` được dựng từ
// tham số của chính yêu cầu — `schedule_length`, `lamp_per_epoch`, `op_count` — thì nó
// KHÔNG CHỨNG MINH GÌ về thứ sắp được ký: một máy chủ bị chiếm dựng một giao dịch khác
// hẳn rồi kèm một `summary` đẹp đẽ chép lại đúng thứ người dùng vừa nhập, và màn hình
// xác nhận trông y hệt lúc bình thường.
//
// Nên mọi con số trong `summary` ở đây đi qua ĐÚNG MỘT đường: giải mã lại `tx_cbor` vừa
// dựng. Hàm này KHÔNG nhận tham số yêu cầu — chữ ký của nó là chỗ ràng buộc đó được
// cưỡng chế, chứ không phải một lời hứa trong chú thích.
//
// Thứ DUY NHẤT đi vào ngoài CBOR là `inputVaultDatumHex`: datum của UTxO vault đang bị
// tiêu. Đó là một DỮ KIỆN CỦA CHUỖI đọc trước lúc dựng, không phải thứ người gọi khai.
// Không có nó thì không nói được "khoá THÊM bao nhiêu" — chỉ nói được số tuyệt đối sau
// giao dịch. `tests/summary.test.ts` ghim cả hai vế.
// ══════════════════════════════════════════════════════════════════════════════

import { CML, valueToAssets } from "@lucid-evolution/lucid";

import { TxSummaryUndecodableError } from "./errors.js";
import { decodeVaultDatumOrThrow, type DecodedVaultDatum } from "./vaultDatumShape.js";
import { ownerRefFromPlutusData, type OwnerRef } from "@magiclamp/protocol-utils";
import { lovelaceToAda, nanogicToMagic, oildropToLamp, raw } from "./units.js";

/** Nhãn của đường HTTP đã gọi. Đây là thứ DUY NHẤT trong `summary` không suy từ CBOR,
 *  nên nó mang tên nói rõ điều đó. Mọi con số đều suy từ CBOR. */
export type RequestedIntent = "instant_gen" | "schedule_commit" | "schedule_fire" | "consume";

export interface SummaryContext {
  /** Địa chỉ vault — dùng để nhận ra output tiếp-nối trong danh sách output. */
  vaultAddress: string;
  /** Datum của UTxO vault ĐANG BỊ TIÊU, đọc từ chuỗi trước lúc dựng. */
  inputVaultDatumHex: string;
  /** `policyId + assetNameHex` của LAMP theo mạng (tLAMP testnet / LAMP mainnet). */
  lampUnit: string;
  network: string;
  requestedIntent: RequestedIntent;
}

export interface OutputView {
  index: number;
  address: string;
  lovelace: string;
  ada: string;
  /** Mọi tài sản khác lovelace, `unit` → số lượng dạng chuỗi. */
  assets: { unit: string; quantity: string }[];
  has_inline_datum: boolean;
}

export interface TxSummary {
  requested_intent: RequestedIntent;
  network: string;
  fee_lovelace: string;
  fee_ada: string;
  lamp: {
    locked_delta_oildrop: string;
    locked_delta_lamp: string;
    balance_delta_oildrop: string;
    balance_delta_lamp: string;
    in_vault_output_oildrop: string;
    in_vault_output_lamp: string;
  };
  magic: {
    minted_nanogic: string;
    minted_magic: string;
    burned_nanogic: string;
    burned_magic: string;
    expired_dropped_nanogic: string;
    expired_dropped_magic: string;
    total_after_nanogic: string;
    total_after_magic: string;
  };
  vault: {
    address: string;
    output_index: number;
    /** Chủ trong datum output — `Credential` dạng JSON. */
    owner: OwnerRef;
    /** Bí danh cũ: `owner.hash` khi chủ là khoá; `null` khi chủ là script. */
    owner_pkh: string | null;
    last_updated_epoch: string;
    batch_count_before: number;
    batch_count_after: number;
    gen_schedule_count_before: number;
    gen_schedule_count_after: number;
    /**
     * Mốc LAMP RỜI KÉT được, POSIX **mili-giây**, dạng chuỗi chữ số.
     * `null` ở két Schedule — nơi trường KHÔNG TỒN TẠI, không phải nơi nó bằng 0.
     *
     * Đây là **mốc tuyệt đối, không phải một số đếm epoch.** Nói rõ vì câu hỏi tới
     * từ bên tích hợp là *"đếm epoch loại nào — giao thức hay Cardano?"*, và câu trả
     * lời đúng là **không loại nào**: `INV-INSTANT-LOCK` không đếm epoch. Validator
     * ghi `max(mốc cũ, cận-trên-validity + ms_per_epoch)` rồi cổng ở
     * `validate_withdraw_lamp` so `get_validity_lower_ms(tx) >= instant_unlock_ms`.
     * Người hiển thị **không cần biết `ms_per_epoch`, không cần đổi đơn vị, không
     * cần đọc đỉnh chuỗi**. Nhưng *"in thẳng ra giờ địa phương"* chỉ đúng cho nhánh
     * thứ ba trong BA nhánh dưới đây — bản trước của dòng này nói hai, và nhánh bị
     * bỏ là nhánh in ra năm 1970:
     *
     *   `null`  két Schedule, trường KHÔNG TỒN TẠI  →  đừng nhắc gì tới khoá
     *   `"0"`   két Instant CHƯA TỪNG sinh          →  "chưa có khoá nào"
     *   `>0`    đang khoá                            →  in mốc, giờ địa phương
     *
     * Cặp ca kiểm ở `tests/summary.test.ts` phân biệt đủ ba nhánh; câu dặn ở đây
     * từng xoá mất sự phân biệt đó ở đúng bước người dùng nhìn thấy.
     *
     * ⚠ Trường này là **TIỆN ÍCH**, không phải bằng chứng. Nó suy từ CBOR thật, chứ
     * bản thân JSON thì vẫn là lời khai của bên phát — bên duyệt TRƯỚC KHI KÝ phải
     * tự đọc mốc từ `tx_cbor`, đừng tin trường này thay cho phép đọc đó.
     *
     * Hệ quả phải biết trước khi viết chữ lên màn: độ dài khoá thật là `[P, 2P)` ở
     * tầng VALIDATOR, và `[P + 1 slot, 2P − 1 slot]` sau khi sổ cái loại cửa sổ rỗng
     * (bảng hai tầng: `Specs/MagicLamp-Tripletoken-Feat-(Vi).md` §6.1.4).
     *
     * 🔴 Phần lẻ **KHÔNG** do người gọi chọn — bản trước của dòng này viết thế và nó
     * dạy sai cho bên tích hợp về việc ai cầm cái nút đó. Mọi bộ dựng trong kho ghim
     * cận trên vào **cuối epoch giao thức** (`epochValidityWindow`), không vào
     * `now + TTL`, nên phần lẻ do **thời điểm sinh** quyết. Câu "ví đặt validity 3 giờ
     * thì khoá thành `P + 3h`" mô tả một bộ dựng giả định không tồn tại ở đây.
     *
     * Nên đừng in một quãng, cũng đừng in một câu cố định kiểu "khoá đúng một epoch"
     * — in MỐC.
     */
    instant_unlock_ms: string | null;
    /**
     * Cùng mốc đó, đọc từ datum ĐẦU VÀO. Có nó thì bên hiển thị nói được BA câu
     * khác nhau, thiếu nó thì cả ba ra một con số trơ giống hệt nhau:
     *
     *   before == after   lượt này KHÔNG dời mốc (bốn nhánh spend ghim nó đứng yên
     *                     — một lượt `burn_batch` vẫn hiện mốc tương lai, và không
     *                     có vế này thì nó đọc thành "giao dịch này khoá tôi")
     *   before == 0       lượt này ĐẶT khoá lần đầu
     *   0 < before < after lượt này KÉO DÀI một khoá đang có
     *
     * Mọi số vault khác trong bản tóm tắt đều đi theo cặp `_before`/`_after`; mốc
     * này từng là ngoại lệ duy nhất, và `before` thì đã nằm sẵn trong tay ở đây.
     */
    instant_unlock_ms_before: string | null;
  };
  outputs: OutputView[];
}

/**
 * Giải mã `txCborHex` rồi dựng bản tóm tắt.
 *
 * NÉM khi không đọc được, khi không tìm thấy output vault, hoặc khi datum output không
 * khớp lược đồ. Không có nhánh nào trả về một bản tóm tắt rỗng hay giá trị đệm: một
 * `summary` thiếu số là một màn hình xác nhận trắng, và người dùng vẫn bấm ký.
 */
export function summarizeTx(txCborHex: string, ctx: SummaryContext): TxSummary {
  const { body, outputs } = decodeBody(txCborHex);

  const vaultHit = findVaultOutput(outputs, ctx.vaultAddress);
  if (vaultHit === null) {
    throw new TxSummaryUndecodableError(
      `giao dịch không có output nào ở địa chỉ vault ${ctx.vaultAddress.slice(0, 20)}… mang datum ` +
      `inline đọc được bằng VaultDatumSchema`,
      { vault_address: ctx.vaultAddress, output_count: outputs.length },
    );
  }

  const before = decodeVaultDatum(ctx.inputVaultDatumHex, "datum của UTxO vault đang bị tiêu");
  const after = vaultHit.datum;

  // ── Ý ĐỊNH phải khớp HÌNH DẠNG datum ──────────────────────────────────────────
  //
  // Hai hình dạng `VaultDatum` phân biệt bằng SỐ TRƯỜNG (17 Schedule / 18 Instant),
  // và `decodeVaultDatumEitherShape` nhận cả hai ở MỌI địa chỉ. Nên trước cổng này
  // một lượt `instant_gen` dựng nhầm datum 17 trường đi trọn đường: dịch vụ trả 200,
  // ghi vào sổ phát-hành, và bản tóm tắt nói `instant_unlock_ms: null`.
  //
  // `null` thì lại được khai nghĩa ngay trên kia là *"két Schedule — trường KHÔNG
  // TỒN TẠI"*. Trên đường `instant_gen` câu đó SAI: nghĩa thật là *"datum đầu ra mất
  // trường khoá"*. Bên hiển thị đọc đúng tài liệu rồi kết luận ngược, và người dùng
  // ký một giao dịch validator chắc chắn bác. Không mất tài sản — chuỗi fail-closed
  // — nhưng cái hỏng đi qua đúng con đường không ai nhìn.
  //
  // Ném ở đây chứ không đệm: một bản tóm tắt tự mâu thuẫn là thứ không ai nên ký.
  if (ctx.requestedIntent === "instant_gen" && after.instant_unlock_ms === null) {
    throw new TxSummaryUndecodableError(
      "datum đầu ra của một lượt `instant_gen` mang hình dạng két Schedule " +
      "(17 trường, không có `instant_unlock_ms`). Giao dịch này sẽ bị validator " +
      "InstantGen từ chối, nên dịch vụ không phát nó ra kèm một bản tóm tắt " +
      "trông bình thường.",
      { requested_intent: ctx.requestedIntent, vault_datum_kind: after.vault_datum_kind },
    );
  }

  const magic = magicDelta(before, after);

  const lampInVaultOutput = vaultHit.view.assets.find(a => a.unit === ctx.lampUnit);

  return {
    requested_intent: ctx.requestedIntent,
    network: ctx.network,
    fee_lovelace: raw(body.fee),
    fee_ada: lovelaceToAda(body.fee),
    lamp: {
      locked_delta_oildrop: raw(after.lamp_locked - before.lamp_locked),
      locked_delta_lamp: oildropToLamp(after.lamp_locked - before.lamp_locked),
      balance_delta_oildrop: raw(after.lamp_balance - before.lamp_balance),
      balance_delta_lamp: oildropToLamp(after.lamp_balance - before.lamp_balance),
      in_vault_output_oildrop: lampInVaultOutput === undefined ? "0" : lampInVaultOutput.quantity,
      in_vault_output_lamp: oildropToLamp(BigInt(lampInVaultOutput?.quantity ?? "0")),
    },
    magic: {
      minted_nanogic: raw(magic.minted),
      minted_magic: nanogicToMagic(magic.minted),
      burned_nanogic: raw(magic.burned),
      burned_magic: nanogicToMagic(magic.burned),
      expired_dropped_nanogic: raw(magic.expiredDropped),
      expired_dropped_magic: nanogicToMagic(magic.expiredDropped),
      total_after_nanogic: raw(magic.totalAfter),
      total_after_magic: nanogicToMagic(magic.totalAfter),
    },
    vault: {
      address: vaultHit.view.address,
      output_index: vaultHit.view.index,
      owner: { type: after.owner.type, hash: after.owner.hash },
      owner_pkh: after.owner.type === "key" ? after.owner.hash : null,
      last_updated_epoch: raw(after.last_updated_epoch),
      // Đọc từ datum ĐẦU RA đã giải mã lại từ chính CBOR sắp ký, không từ tham số
      // của yêu cầu — cùng nguyên tắc với mọi số khác trong bản tóm tắt này.
      // `null` đi thẳng ra `null`: không đệm `"0"`, vì `0` là giá trị hợp lệ của một
      // két Instant chưa từng sinh, còn `null` nghĩa là két này không có trường đó.
      instant_unlock_ms: after.instant_unlock_ms === null ? null : raw(after.instant_unlock_ms),
      instant_unlock_ms_before:
        before.instant_unlock_ms === null ? null : raw(before.instant_unlock_ms),
      batch_count_before: before.magic_batches.length,
      batch_count_after: after.magic_batches.length,
      gen_schedule_count_before: before.gen_schedules.length,
      gen_schedule_count_after: after.gen_schedules.length,
    },
    outputs: outputs.map(o => o.view),
  };
}

/** Hash của THÂN giao dịch — thứ app đối chiếu sau khi ký. Suy từ chính CBOR. */
export function txBodyHash(txCborHex: string): string {
  let tx: CML.Transaction;
  try {
    tx = CML.Transaction.from_cbor_hex(txCborHex);
  } catch (e) {
    throw new TxSummaryUndecodableError(`không giải mã được CBOR giao dịch: ${(e as Error).message}`);
  }
  return CML.hash_transaction(tx.body()).to_hex();
}

// ── phần giải mã ───────────────────────────────────────────────────────────────

interface DecodedOutput {
  view: OutputView;
  /** Datum inline dạng hex, hoặc `null` khi output không mang datum inline. */
  inlineDatumHex: string | null;
}

function decodeBody(txCborHex: string): { body: { fee: bigint }; outputs: DecodedOutput[] } {
  if (!/^[0-9a-f]+$/i.test(txCborHex) || txCborHex.length % 2 !== 0) {
    throw new TxSummaryUndecodableError("tx_cbor không phải chuỗi hex hợp lệ");
  }
  let tx: CML.Transaction;
  try {
    tx = CML.Transaction.from_cbor_hex(txCborHex);
  } catch (e) {
    throw new TxSummaryUndecodableError(`không giải mã được CBOR giao dịch: ${(e as Error).message}`);
  }
  const body = tx.body();
  const list = body.outputs();
  const outputs: DecodedOutput[] = [];
  for (let i = 0; i < list.len(); i++) {
    const o = list.get(i);
    const assets = valueToAssets(o.amount());
    const lovelace = assets.lovelace ?? 0n;
    const others = Object.entries(assets)
      .filter(([unit]) => unit !== "lovelace")
      .map(([unit, qty]) => ({ unit, quantity: raw(qty) }))
      .sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));

    const datumOption = o.datum();
    const inlineDatumHex =
      datumOption !== undefined && datumOption.kind() === CML.DatumOptionKind.Datum
        ? (datumOption.as_datum()?.to_cbor_hex() ?? null)
        : null;

    outputs.push({
      view: {
        index: i,
        address: o.address().to_bech32(undefined),
        lovelace: raw(lovelace),
        ada: lovelaceToAda(lovelace),
        assets: others,
        has_inline_datum: inlineDatumHex !== null,
      },
      inlineDatumHex,
    });
  }
  return { body: { fee: body.fee() }, outputs };
}

function findVaultOutput(
  outputs: DecodedOutput[],
  vaultAddress: string,
): { view: OutputView; datum: DecodedVaultDatum } | null {
  // Đòi DUY NHẤT, không lấy cái đầu tiên.
  //
  // 🪦 Bản trước `return` ngay ở lần khớp đầu. Dưới đúng mô hình đe doạ mà đầu tệp này
  // tự khai — một máy chủ bị chiếm dựng một giao dịch khác hẳn rồi kèm một bản tóm tắt
  // đẹp đẽ — đó là đường đi lọt: output #0 ở địa chỉ vault mang datum vô hại, output #2
  // cũng ở địa chỉ vault mang toàn bộ tài sản và datum thật. Bản tóm tắt mô tả #0, và
  // người dùng ký. Mảng `outputs` thô CÓ liệt kê #2, nhưng màn hình xác nhận hiện các
  // trường đã tính chứ không hiện mảng thô.
  //
  // On-chain đã ép một-vào-một-ra (`C-VAULT-OUT-1`), nên hình dạng hai-output-vault bị
  // validator từ chối. Nhưng nó bị từ chối SAU KHI người dùng đã ký, và cả gói này tồn
  // tại để người dùng biết mình đang ký cái gì TRƯỚC lúc đó.
  const atVault = outputs.filter(o => o.view.address === vaultAddress && o.inlineDatumHex !== null);
  if (atVault.length > 1) {
    throw new TxSummaryUndecodableError(
      `Giao dịch có ${atVault.length} output ở địa chỉ vault. Bản tóm tắt chỉ mô tả được ` +
      `MỘT, nên mô tả bất kỳ cái nào trong số đó cũng là mô tả thiếu.`,
      { vault_output_indexes: atVault.map(o => o.view.index).join(",") },
    );
  }
  const o = atVault[0];
  if (o === undefined) return null;
  // Output ở địa chỉ vault mà datum KHÔNG đọc được là chuyện phải ném, không phải
  // chuyện bỏ qua rồi đi tìm output khác: nó nghĩa là lược đồ của kho đã trôi.
  return { view: o.view, datum: decodeVaultDatum(o.inlineDatumHex!, `datum của output #${o.view.index}`) };
}

function decodeVaultDatum(hex: string, where: string): DecodedVaultDatum {
  try {
    return decodeVaultDatumOrThrow(hex);
  } catch (e) {
    throw new TxSummaryUndecodableError(
      `${where} không khớp VaultDatumSchema hiện tại: ${(e as Error).message}`,
    );
  }
}

/**
 * MAGIC sinh / đốt / mất hạn, suy từ hai datum.
 *
 * `burned` lấy từ `activity_state.consumed_credit` chứ KHÔNG lấy từ chênh lệch tổng
 * batch, vì hai thứ khác nhau ở một chỗ đắt: một batch bị đốt cạn và một batch hết hạn
 * ĐỀU biến mất khỏi `magic_batches` (`prune_expired`), nên chênh lệch tổng gộp hai
 * nguyên nhân làm một. `consumed_credit` là con số on-chain cộng ĐÚNG phần đã tiêu
 * (`vault.ak` ▸ `validate_burn_batch`), nên nó tách được hai vế.
 *
 *   Σsau = Σtrước + sinh − đốt − mất hạn   ⟹   mất hạn = Σtrước + sinh − đốt − Σsau
 */
function magicDelta(before: DecodedVaultDatum, after: DecodedVaultDatum): {
  minted: bigint; burned: bigint; expiredDropped: bigint; totalAfter: bigint;
} {
  const sum = (d: DecodedVaultDatum): bigint =>
    d.magic_batches.reduce((t, b) => t + b.current_amount, 0n);

  const beforeIds = new Set(before.magic_batches.map(b => b.batch_id));
  const minted = after.magic_batches
    .filter(b => !beforeIds.has(b.batch_id))
    .reduce((t, b) => t + b.current_amount, 0n);

  const burned = after.activity_state.consumed_credit - before.activity_state.consumed_credit;
  const totalBefore = sum(before);
  const totalAfter = sum(after);
  const expiredDropped = totalBefore + minted - burned - totalAfter;

  // Đẳng thức kế toán vỡ ⟹ NÉM, đừng định dạng một số âm rồi trả ra như một sự thật.
  // `nanogicToMagic` xử lý dấu âm bình thường, nên không có gì kêu: màn hình xác nhận
  // sẽ hiện `expired_dropped_magic: "-0.004000000"` và người dùng không có cách nào
  // biết đó là "dịch vụ không hiểu giao dịch này" chứ không phải "một con số lạ".
  // Vỡ ở đây đúng nghĩa là dựng ra một CBOR mà không đọc lại được.
  if (expiredDropped < 0n) {
    throw new TxSummaryUndecodableError(
      "Kế toán MAGIC không khớp: tổng trước + lô mới − đã đốt − tổng sau ra số ÂM. " +
      "Một giả định của bản tóm tắt đã vỡ, nên mọi con số MAGIC ở đây không tin được.",
      { expired_dropped_nanogic: expiredDropped.toString() },
    );
  }

  return { minted, burned, expiredDropped, totalAfter };
}

// ── Tạo vault: tóm tắt SUY TỪ CBOR, cùng luật với `summarizeTx` ──────────────────
//
// Genesis không có datum vault đầu vào để so, nên bản này không tính "chênh lệch" mà ĐỌC
// thẳng thứ sắp nằm trên chuỗi: output ở địa chỉ vault (đúng MỘT), NFT danh-tính (đúng 1,
// và được ĐÚC trong chính tx này), số LAMP nạp, chủ trong datum, và danh sách khoá phải
// ký. Bất kỳ vế nào lệch với thứ bên dựng khai ⟹ `TX_SUMMARY_UNDECODABLE`: người dùng không
// được ký một giao dịch mà bản tóm tắt của nó không tự đứng được.

export interface CreateVaultSummaryContext {
  vaultAddress: string;
  vaultNftUnit: string;
  lampUnit: string;
  network: string;
}

export interface CreateVaultSummary {
  requested_intent: "create_vault";
  network: string;
  fee_lovelace: string;
  fee_ada: string;
  vault: {
    address: string;
    output_index: number;
    nft_unit: string;
    owner: OwnerRef;
    lamp_deposit_oildrop: string;
    lamp_deposit_lamp: string;
    lovelace: string;
    ada: string;
  };
  /** Khoá băm phải ký (trường `required_signers` của thân tx), theo thứ tự trong tx. */
  required_signers: string[];
  outputs: OutputView[];
  /** Chỉ khi yêu cầu có `funding`: đọc lại TỪ CBOR bởi `funding.ts` ▸ `checkFundingTx`. */
  funding?: import("./funding.js").FundingSummary;
}

export function summarizeCreateVaultTx(txCborHex: string, ctx: CreateVaultSummaryContext): CreateVaultSummary {
  const { body, outputs } = decodeBody(txCborHex);
  const atVault = outputs.filter(o => o.view.address === ctx.vaultAddress);
  if (atVault.length !== 1) {
    throw new TxSummaryUndecodableError(
      `giao dịch tạo vault có ${atVault.length} output ở địa chỉ vault (cần đúng 1)`,
      { vault_output_indexes: atVault.map(o => o.view.index).join(",") },
    );
  }
  const out = atVault[0]!;
  const nft = out.view.assets.find(a => a.unit === ctx.vaultNftUnit);
  if (nft === undefined || nft.quantity !== "1") {
    throw new TxSummaryUndecodableError("output vault không mang đúng 1 NFT danh-tính đã khai", { vault_nft: ctx.vaultNftUnit });
  }
  const tx = CML.Transaction.from_cbor_hex(txCborHex);
  const mint = tx.body().mint();
  const minted = mint === undefined ? {} : valueToAssets(CML.Value.new(0n, mint.as_positive_multiasset()));
  if (minted[ctx.vaultNftUnit] !== 1n) {
    throw new TxSummaryUndecodableError(
      "NFT danh-tính không được ĐÚC trong chính giao dịch này (INV-VAULT-IDENTITY đòi one-shot ở genesis)",
      { vault_nft: ctx.vaultNftUnit },
    );
  }
  if (out.inlineDatumHex === null) {
    throw new TxSummaryUndecodableError("output vault không mang datum inline");
  }
  let owner: OwnerRef;
  let lampBalance: bigint;
  try {
    const d = CML.PlutusData.from_cbor_hex(out.inlineDatumHex).as_constr_plutus_data();
    if (d === undefined) throw new Error("datum không phải Constr");
    const f = d.fields();
    const f0 = f.get(0).as_constr_plutus_data();
    const f0h = f0?.fields().get(0).as_bytes();
    if (f0 === undefined || f0h === undefined || f0.fields().len() !== 1) throw new Error("trường 0 không phải Credential");
    owner = ownerRefFromPlutusData({ index: Number(f0.alternative()), fields: [bytesToHex(f0h)] });
    const f1 = f.get(1).as_integer();
    if (f1 === undefined) throw new Error("trường 1 (lamp_balance) không phải số nguyên");
    lampBalance = BigInt(f1.to_str());
  } catch (e) {
    throw new TxSummaryUndecodableError(`datum vault vừa dựng không đọc được: ${(e as Error).message}`);
  }
  const lampInOutput = BigInt(out.view.assets.find(a => a.unit === ctx.lampUnit)?.quantity ?? "0");
  if (lampInOutput !== lampBalance || lampBalance <= 0n) {
    throw new TxSummaryUndecodableError(
      `datum khai lamp_balance = ${lampBalance} nhưng output vault mang ${lampInOutput} oildrop LAMP`,
    );
  }
  const rs = tx.body().required_signers();
  const requiredSigners: string[] = [];
  for (let i = 0; rs !== undefined && i < rs.len(); i++) requiredSigners.push(rs.get(i).to_hex());
  return {
    requested_intent: "create_vault",
    network: ctx.network,
    fee_lovelace: raw(body.fee),
    fee_ada: lovelaceToAda(body.fee),
    vault: {
      address: ctx.vaultAddress,
      output_index: out.view.index,
      nft_unit: ctx.vaultNftUnit,
      owner,
      lamp_deposit_oildrop: raw(lampBalance),
      lamp_deposit_lamp: oildropToLamp(lampBalance),
      lovelace: out.view.lovelace,
      ada: out.view.ada,
    },
    required_signers: requiredSigners,
    outputs: outputs.map(o => o.view),
  };
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
