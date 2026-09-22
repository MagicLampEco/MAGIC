// TestSupport/lucidFake.ts — bộ giả `LucidEvolution` dùng chung cho các bài kiểm
// bộ-dựng-giao-dịch, không chạm mạng.
//
// VÌ SAO CÓ TỆP NÀY (Nợ #79, `DevStatus.md`)
// ------------------------------------------
// Ba bộ kiểm `InstantGen` · `ScheduleGen` · `UMKeeper` từng XANH trong khi
// `epochValidityWindow` còn chưa tồn tại trong `dist/` mà chúng nạp. Lý do: không
// tệp kiểm nào NHẬP `instant.js` / `schedule.js` / `keeper.js` — chúng chỉ chạm
// `math.ts` và `constants.ts`. Màu xanh đó vì thế không nói gì về bộ dựng giao dịch;
// nó là một phép đo không đo được gì, phát ra bằng giọng của một phép đo đạt.
//
// Thứ chặn đường viết bài kiểm cho bộ dựng là `LucidEvolution`: nó đòi một nhà cung
// cấp và một mạng thật. Tệp này thay nó bằng một bộ GHI LẠI — mọi thứ bộ dựng gọi
// đều được giữ nguyên để bài kiểm khẳng định, đặc biệt là `validFrom`/`validTo`.
//
// HAI RÀNG BUỘC CỦA BỘ GIẢ NÀY, đừng nới
// --------------------------------------
// 1. **Gọi vào bề mặt chưa hiện thực thì NÉM, không trả `undefined`.** Một bộ giả
//    im lặng là đúng thứ `Forall §Cái vỏ im lặng` cấm, chỉ khác chỗ nó nói dối với
//    bài kiểm thay vì với người dùng: bộ dựng thêm `.mintAssets()` ngày mai sẽ đi
//    qua mà không gì đỏ, và bài kiểm vẫn khoe một con số xanh.
// 2. **Không suy hộ, không đệm giá trị.** Bộ giả không tính `validTo` thay ai, không
//    điền mặc định cho tham số thiếu. Nó chỉ ghi.

/** Một lượt `.pay.ToAddressWithData(...)`. */
export interface RecordedOutput {
  address : string;
  datum   : unknown;
  assets  : Record<string, bigint>;
}

/** Trọn vẹn thứ bộ dựng đã yêu cầu ở MỘT giao dịch. */
export interface RecordedTx {
  collectFrom : Array<{ utxos: unknown[]; redeemer?: string }>;
  readFrom    : unknown[][];
  attached    : unknown[];
  outputs     : RecordedOutput[];
  signerKeys  : string[];
  /** Mili-giây POSIX đúng như bộ dựng truyền vào — KHÔNG quy về slot. */
  validFrom   : number | undefined;
  validTo     : number | undefined;
  completed   : boolean;
}

/**
 * Chặn mọi truy cập vào thuộc tính chưa hiện thực.
 *
 * Danh sách cho qua là ĐÓNG và chỉ chứa thứ mà chính thời gian chạy của JS dò tới
 * (`await` dò `then`, `console.log` dò `Symbol.toStringTag`…). Thiếu rào này thì
 * `await` một đối tượng giả sẽ ném ở đúng chỗ không ai ngờ.
 */
const CHO_QUA = new Set<string>(["then", "catch", "finally", "toJSON", "constructor", "inspect"]);

function strict<T extends object>(target: T, ten: string): T {
  return new Proxy(target, {
    get(obj, prop, recv) {
      if (prop in obj) return Reflect.get(obj, prop, recv);
      if (typeof prop === "symbol") return undefined;
      if (CHO_QUA.has(prop)) return undefined;
      throw new Error(
        `Bộ giả Lucid (${ten}) chưa hiện thực \`${String(prop)}\`.\n` +
        `Bộ dựng giao dịch vừa gọi một bề mặt của Lucid mà bộ giả không biết — nghĩa là ` +
        `bộ dựng đã đổi kể từ lần bài kiểm này được viết.\n` +
        `Hiện thực nó trong TestSupport/lucidFake.ts rồi KHẲNG ĐỊNH thứ nó ghi lại. ` +
        `Đừng trả \`undefined\` cho xong: bài kiểm khi đó xanh mà không kiểm gì.`,
      );
    },
  });
}

export interface LucidFake {
  /** Ép kiểu ở chỗ gọi: `lucid: fake.lucid as unknown as LucidEvolution`. */
  lucid : unknown;
  /** Các giao dịch đã dựng, theo thứ tự. Một lượt `newTx()` là một mục. */
  txs   : RecordedTx[];
  /** Giao dịch duy nhất — ném nếu số lượng khác 1, để bài kiểm không đọc nhầm mục. */
  onlyTx(): RecordedTx;
}

/**
 * Dựng một `LucidEvolution` giả.
 *
 * `utxoByUnit` chỉ có mặt khi người gọi đưa bảng tra; không đưa mà bộ dựng gọi tới
 * thì bộ giả ném — đúng ràng buộc 1 ở đầu tệp.
 */
export function makeLucidFake(opts: { utxoByUnit?: Record<string, unknown> } = {}): LucidFake {
  const txs: RecordedTx[] = [];

  function newTx() {
    const ghi: RecordedTx = {
      collectFrom: [], readFrom: [], attached: [], outputs: [], signerKeys: [],
      validFrom: undefined, validTo: undefined, completed: false,
    };
    txs.push(ghi);

    const builder: Record<string, unknown> = {
      collectFrom(utxos: unknown[], redeemer?: string) {
        ghi.collectFrom.push({ utxos, redeemer });
        return proxied;
      },
      readFrom(utxos: unknown[]) {
        ghi.readFrom.push(utxos);
        return proxied;
      },
      attach: strict({
        SpendingValidator(v: unknown) { ghi.attached.push(v); return proxied; },
        MintingPolicy  (v: unknown) { ghi.attached.push(v); return proxied; },
      }, "txBuilder.attach"),
      pay: strict({
        ToAddressWithData(address: string, datum: unknown, assets: Record<string, bigint>) {
          ghi.outputs.push({ address, datum, assets });
          return proxied;
        },
      }, "txBuilder.pay"),
      validFrom(ms: number) { ghi.validFrom = ms; return proxied; },
      validTo  (ms: number) { ghi.validTo   = ms; return proxied; },
      addSignerKey(pkh: string) { ghi.signerKeys.push(pkh); return proxied; },
      async complete() {
        ghi.completed = true;
        // Đối tượng giao dịch: đủ cho `sign.withWallet().complete()` rồi `submit()`.
        // Băm trả về là hằng, và nó tự khai là hằng — không bài kiểm nào được coi
        // giá trị này là một băm thật.
        return {
          sign: { withWallet: () => ({ complete: async () => ({
            submit: async () => "txHashGia-KHONG-PHAI-BAM-THAT",
          }) }) },
        };
      },
    };
    const proxied = strict(builder, "txBuilder");
    return proxied;
  }

  const lucid = strict({
    newTx,
    ...(opts.utxoByUnit
      ? {
          async utxoByUnit(unit: string) {
            const u = opts.utxoByUnit![unit];
            if (u === undefined) throw new Error(`Bộ giả: không có UTxO cho đơn vị ${unit}.`);
            return u;
          },
        }
      : {}),
  }, "lucid");

  return {
    lucid,
    txs,
    onlyTx() {
      if (txs.length !== 1) {
        throw new Error(`Chờ đúng 1 giao dịch, bộ giả ghi được ${txs.length}.`);
      }
      return txs[0]!;
    },
  };
}
