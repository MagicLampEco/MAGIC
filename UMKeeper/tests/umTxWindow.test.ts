// tests/umTxWindow.test.ts — Nợ #79, phần UMKeeper.
//
// `buildUMUpdateTx` là chỗ gọi `epochValidityWindow` thứ sáu và là chỗ duy nhất
// KHÔNG có chủ ký: giao dịch cập nhật UM là permissionless (§14.3). Trước tệp này
// bộ kiểm UMKeeper chỉ chạm `math.ts`, nên cả bộ dựng lẫn cửa sổ hiệu lực của nó
// chưa từng được chạy một lần nào.

import { describe, it, expect } from "vitest";
import { msPerEpoch, VALIDITY_MAX_AHEAD_MS } from "@magiclamp/protocol-utils";
import { makeLucidFake } from "../../TestSupport/lucidFake.js";
import {
  buildUMUpdateTx,
  LOG_MARKER_UPDATED, LOG_MARKER_EPOCH_SEEN, LOG_MARKER_ERROR,
} from "../offchain/src/keeper.js";

const NETWORK = "Preprod" as const;
const P    = msPerEpoch(NETWORK);
const E    = 100n;
const SLOT = 1_000n;

// UMDatum = 3 trường (smoothed_q, last_updated_epoch, history). CBOR dựng tay để
// bài kiểm không phụ thuộc vào lược đồ nội bộ của `keeper.ts`:
//   constr 0 [ 1_000_000_000, 99, [] ]
// d8799f  = constr 0, bắt đầu
//   1a3b9aca00 = 1_000_000_000
//   1863       = 99
//   80         = mảng rỗng
// ff      = kết thúc
const UM_DATUM_CBOR = "d8799f1a3b9aca001863" + "80" + "ff";

const UM_SCRIPT = { type: "PlutusV3" as const, script: "49480100002221200101" };

function umUtxo() {
  return {
    txHash: "cd".repeat(32), outputIndex: 0,
    address: "addr_test1wq" + "q".repeat(50),
    assets: { lovelace: 2_000_000n, ["ee".repeat(28) + "554d44"]: 1n },
    datum: UM_DATUM_CBOR, datumHash: null, scriptRef: null,
  } as any;
}

async function dung(tipPosixMs: bigint) {
  const fake = makeLucidFake();
  const res = await buildUMUpdateTx(
    fake.lucid as any,
    umUtxo(),
    { epoch: E, totalBurns: 1_000_000_000_000n, totalMints: 1_000_000_000_000n },
    UM_SCRIPT,
    NETWORK,
    tipPosixMs,
  );
  return { res, tx: fake.onlyTx() };
}

async function nemVoiChoDoi(tipPosixMs: bigint) {
  // Xem khối lý do ở `InstantGen/tests/instantTxWindow.test.ts` ▸ `nemVoiChoDoi`:
  // hai cây `node_modules` ⟹ hai đối tượng lớp ⟹ `instanceof` trả `false`.
  try {
    await dung(tipPosixMs);
  } catch (e) {
    const err = e as Error & { waitMs?: bigint; retryAfterMs?: bigint };
    if (err.name !== "EmptyValidityWindowError") throw err;
    return { waitMs: err.waitMs, retryAfterMs: err.retryAfterMs };
  }
  throw new Error(`Chờ NÉM ở tip ${tipPosixMs} nhưng bộ dựng chạy xong bình thường.`);
}

describe("buildUMUpdateTx — cửa sổ hiệu lực", () => {

  it("A-bis. đầu epoch ⟹ `validTo` = tip + trần, KHÔNG phải cuối epoch (chân trời node)", async () => {
    const tip = E * P + 1_000n;
    const { tx } = await dung(tip);

    expect(tx.validTo).toBe(Number(tip + VALIDITY_MAX_AHEAD_MS));
  });

  it("A. giờ cuối epoch, không chừa slot nào ⟹ `validTo` là slot CUỐI của epoch", async () => {
    const tip = (E + 1n) * P - 1_800_000n;
    const { tx } = await dung(tip);

    expect(tx.validFrom).toBe(Number(tip));
    // UMKeeper gọi `epochValidityWindow` KHÔNG kèm tham số chừa — khác InstantGen,
    // và đúng như thế: mốc khoá LAMP không sinh ra từ nhánh này nên không có ô chết
    // nào để né. Cận trên vì vậy là slot cuối.
    expect(tx.validTo).toBe(Number((E + 1n) * P - SLOT));
  });

  it("B. tip ở slot CUỐI ⟹ NÉM, kèm đúng số mili-giây phải chờ", async () => {
    await expect(nemVoiChoDoi((E + 1n) * P - SLOT)).resolves.toEqual({
      waitMs: 1_000n, retryAfterMs: (E + 1n) * P,
    });
  });

  it("B-bis. cực đối — tip ở slot ÁP CHÓT thì dựng được, khoảng đúng một slot", async () => {
    const tip = (E + 1n) * P - 2n * SLOT;
    const { tx } = await dung(tip);

    expect(tx.completed).toBe(true);
    expect(tx.validTo! - tx.validFrom!).toBe(Number(SLOT));
  });

  it("B-ter. redeemer mã hoá ra ĐÚNG byte của Constr(0,[new_raw])", async () => {
    const { tx } = await dung(E * P + 1_000n);

    // 🔴 Bài này ghim một bẫy đã ăn một lần: `Data.Enum` có ĐÚNG MỘT biến thể không
    // mã hoá được trên lucid 0.4.30, và `buildUMUpdateTx` vì thế NÉM ở mọi lần gọi.
    // Lý do đầy đủ + ba hình dạng đã đo ở `keeper.ts` ▸ khối trên `UMRedeemerSchema`.
    //
    // Ghim theo BYTE chứ không theo "có ném hay không": một lược đồ sai hình dạng mà
    // vẫn mã hoá được thì sẽ trượt qua phép kiểm "không ném" rồi chết trên chuỗi.
    //   d8799f       constr 0, độ dài bất định
    //     1a3b9aca00 1_000_000_000 (burns == mints ⟹ tỉ lệ 1.0 ⟹ new_raw = Q)
    //   ff           hết
    expect(tx.collectFrom[0]!.redeemer).toBe("d8799f1a3b9aca00ff");
  });

  it("C. giao dịch mang đúng hình dạng UM update — và KHÔNG có chữ ký nào", async () => {
    const { tx, res } = await dung(E * P + 1_000n);

    expect(tx.collectFrom).toHaveLength(1);
    expect(tx.outputs).toHaveLength(1);
    // §14.3: permissionless. Một `addSignerKey` lọt vào đây là đổi mô hình tin cậy
    // của cả nhánh keeper, nên nó phải đỏ ngay chứ không chỉ nằm trong chú thích.
    expect(tx.signerKeys).toEqual([]);
    expect(res.epoch).toBe(E);
  });

  it("D. ba dấu nhật ký đứng yên — bên vận hành canh theo chúng, không theo mã thoát", () => {
    // 🔴 Bài này KHÔNG kiểm hành vi. Nó ghim một BỀ MẶT CÔNG KHAI.
    //
    // Bên vận hành canh sức khoẻ keeper bằng sự CÓ MẶT của dấu "đã cập nhật" trong một
    // cửa sổ thời gian, vì mã thoát không phân biệt được chạy-được với hỏng: vòng lặp
    // bắt mọi lỗi vào `catch` rồi đi tiếp, nên tiến trình thoát 0 ở cả hai ca — và nó
    // đã làm đúng thế suốt thời gian `buildUMUpdateTx` ném ở mọi lần gọi.
    //
    // Đổi một chuỗi dưới đây là phá phép canh đó, và phá IM LẶNG: cảnh báo bên kia
    // đơn giản không bao giờ bắn nữa. Bài này biến "im lặng" thành "đỏ", để người đổi
    // biết mình đang đổi một hợp đồng chứ không phải một dòng trang trí.
    expect(LOG_MARKER_UPDATED).toBe("[UM Keeper] UPDATED");
    expect(LOG_MARKER_EPOCH_SEEN).toBe("[UM Keeper] NEW-EPOCH");
    expect(LOG_MARKER_ERROR).toBe("[UM Keeper] ERROR");

    // Và ba dấu phải PHÂN BIỆT được nhau bằng phép khớp tiền tố — nếu một dấu là tiền
    // tố của dấu khác thì phép canh "đếm dòng UPDATED" cũng đếm luôn dòng kia.
    const ds = [LOG_MARKER_UPDATED, LOG_MARKER_EPOCH_SEEN, LOG_MARKER_ERROR];
    for (const a of ds) for (const b of ds) {
      if (a !== b) expect(b.startsWith(a)).toBe(false);
    }
  });
});
