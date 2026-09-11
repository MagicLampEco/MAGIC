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
import { lovelaceToAda, nanogicToMagic, oildropToLamp, raw } from "./units.js";

/** Nhãn của đường HTTP đã gọi. Đây là thứ DUY NHẤT trong `summary` không suy từ CBOR,
 *  nên nó mang tên nói rõ điều đó. Mọi con số đều suy từ CBOR. */
export type RequestedIntent = "schedule_commit" | "schedule_fire" | "consume";

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
    owner_pkh: string;
    last_updated_epoch: string;
    batch_count_before: number;
    batch_count_after: number;
    gen_schedule_count_before: number;
    gen_schedule_count_after: number;
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
      owner_pkh: after.owner,
      last_updated_epoch: raw(after.last_updated_epoch),
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
  for (const o of outputs) {
    if (o.view.address !== vaultAddress) continue;
    if (o.inlineDatumHex === null) continue;
    // Output ở địa chỉ vault mà datum KHÔNG đọc được là chuyện phải ném, không phải
    // chuyện bỏ qua rồi đi tìm output khác: nó nghĩa là lược đồ của kho đã trôi.
    return { view: o.view, datum: decodeVaultDatum(o.inlineDatumHex, `datum của output #${o.view.index}`) };
  }
  return null;
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

  return { minted, burned, expiredDropped, totalAfter };
}
