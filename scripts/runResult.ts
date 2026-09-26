// scripts/runResult.ts — phần THUẦN của giao diện "script chạy làm tiến trình con".
//
// Một bộ điều phối (vd bộ mô phỏng nhiều ví) gọi các script `deploy/05`, `deploy/07`,
// `test/consume_only`, `test/schedule_fire_only` làm tiến trình con, mỗi tiến trình một ví
// riêng qua `PRIVATE_KEY`. Nó đọc kết quả ở DÒNG CUỐI stdout, không bới log. Mọi quyết định
// ở đây là hàm thuần để kiểm được không cần mạng: `test_run_result.ts`.
//
// Tệp này CỐ Ý không nhập `config.ts` (nạp nó là đòi khoá mạng + ví ngay lúc import) và
// không nhập `@magiclamp/protocol-utils` (bộ kiểm của tệp này không được phụ thuộc bản dựng
// `dist/` của gói khác).

const HEX64 = /^[0-9a-f]{64}$/;
const HEX56 = /^[0-9a-f]{56}$/;

export interface OutRef { txHash: string; outputIndex: number }

/**
 * `<txhash 64 hex chữ thường>#<chỉ số thập phân>`. Không cắt khoảng trắng, không hạ chữ
 * hoa: một giá trị lạ hình dạng là dấu của biến bị ghép sai, và đoán hộ thì mất dấu đó.
 */
export function parseOutRef(raw: string, label: string): OutRef {
  const m = /^([0-9a-f]{64})#(0|[1-9][0-9]{0,5})$/.exec(raw);
  if (!m) {
    throw new Error(
      `${label} sai định dạng: cần "<txhash 64 hex chữ thường>#<chỉ số>", nhận "${raw}".`,
    );
  }
  return { txHash: m[1]!, outputIndex: Number(m[2]) };
}

/**
 * Số nguyên DƯƠNG từ biến môi trường. Biến vắng mặt ⟹ `fallback`. Biến CÓ đặt thì phải
 * khớp `^[1-9][0-9]*$` — kể cả chuỗi rỗng cũng ném: `LAMP_DEPOSIT=` là một lệnh gõ sai,
 * không phải lời xin mặc định. (`BigInt(" 12 ")` và `BigInt("")` đều KHÔNG ném, nên không
 * dựa vào `BigInt` để kiểm.)
 */
export function parsePositiveInteger(raw: string | undefined, name: string, fallback: bigint): bigint {
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${name} phải là số nguyên dương (chữ số thập phân, không dấu, không 0 đầu), nhận "${raw}".`);
  }
  return BigInt(raw);
}

/**
 * Cờ nhị phân của môi trường: vắng/rỗng ⟹ false, "1" ⟹ true, "0" ⟹ false, mọi giá trị
 * khác NÉM. Lý do ném thay vì coi là false: `DRY_RUN=true` mà bị đọc thành "chạy thật" là
 * một giao dịch khoá LAMP đi lên chuỗi đúng lúc người gõ tin là đang chạy thử.
 */
export function parseFlag(raw: string | undefined, name: string): boolean {
  if (raw === undefined || raw === "") return false;
  if (raw === "1") return true;
  if (raw === "0") return false;
  throw new Error(`${name} chỉ nhận "1" hoặc "0", nhận "${raw}".`);
}

export interface StateBookDecision { write: boolean; reason: string }

/**
 * Có in các dòng dành cho SỔ TRẠNG THÁI (khối "Copy to .env", và ở bước 05 là cả bước
 * công bố ref-script mà dòng `REF_VAULT_INSTANT_UTXO=` phụ thuộc) hay không.
 *
 * Bối cảnh: bản thân 05/07 KHÔNG ghi tệp sổ. Sổ do các runner shell ghi, bằng cách
 * `grep` dòng `KHOÁ=giá_trị` trong stdout rồi `persist`. Nên "không ghi sổ" ở đây nghĩa là
 * KHÔNG phát ra các dòng đó — không có dòng thì không runner nào persist được.
 *
 * "Ví deploy" = ví mà sổ thuộc về. Mọi runner hiện có ký bằng `WALLET_SEED` và không đặt
 * `PRIVATE_KEY`; `config.ts ▸ selectWallet` ưu tiên `PRIVATE_KEY` khi có. Không có định danh
 * ví deploy nào tách được hơn thế (không biến nào ghi pkh của nó), nên quy tắc là:
 *   · DRY_RUN            ⟹ KHÔNG BAO GIỜ (không có giao dịch nào để ghi).
 *   · WRITE_STATE_BOOK=1 ⟹ ghi · WRITE_STATE_BOOK=0 ⟹ không.
 *   · không đặt cờ, ví từ PRIVATE_KEY ⟹ KHÔNG: đó là đường ví-riêng-mỗi-tiến-trình, và
 *     không chứng minh được nó là ví deploy. Nghiêng về không ghi vì chiều hỏng ngược lại
 *     (một ví nông dân ghi đè `REF_VAULT_INSTANT_UTXO` của sổ bằng ref-script ở bãi đỗ của
 *     chính nó) là sai im lặng, còn chiều này hỏng ồn: runner báo "không đọc được …".
 *   · không đặt cờ, ví từ WALLET_SEED ⟹ ghi — giữ nguyên hành vi mọi runner đang dựa vào.
 */
export function decideStateBook(o: {
  dryRun: boolean;
  flag: string | undefined;
  signsWithPrivateKey: boolean;
}): StateBookDecision {
  // Kiểm hình dạng cờ TRƯỚC nhánh DRY_RUN: một cờ gõ sai phải kêu cả ở lượt chạy thử,
  // không thì nó chỉ lộ ra ở lượt chạy thật đầu tiên.
  const flagSet = o.flag !== undefined && o.flag !== "";
  if (flagSet && o.flag !== "1" && o.flag !== "0") {
    throw new Error(`WRITE_STATE_BOOK chỉ nhận "1" hoặc "0", nhận "${o.flag}".`);
  }
  if (o.dryRun) return { write: false, reason: "DRY_RUN — không có giao dịch nào lên chuỗi" };
  if (flagSet) {
    return o.flag === "1"
      ? { write: true, reason: "WRITE_STATE_BOOK=1" }
      : { write: false, reason: "WRITE_STATE_BOOK=0" };
  }
  if (o.signsWithPrivateKey) {
    return {
      write: false,
      reason: "ví ký lấy từ PRIVATE_KEY (ví riêng của tiến trình, không chứng minh được là ví deploy); đặt WRITE_STATE_BOOK=1 nếu đúng là ví deploy",
    };
  }
  return { write: true, reason: "ví ký lấy từ WALLET_SEED (ví deploy của các runner)" };
}

export interface OutputLike { address: string; assets: Record<string, bigint> }

/**
 * Chỉ số output DUY NHẤT nằm ở `address` và mang đúng 1 `unit`. Không có hoặc có hơn một
 * ⟹ ném: vault ra đời thiếu NFT danh tính là vault không ai tiêu được (INV-VAULT-IDENTITY),
 * và hai ứng viên thì không có cách nào chọn đúng.
 */
export function singleOutputIndexWithUnit(outputs: readonly OutputLike[], address: string, unit: string): number {
  const hits: number[] = [];
  outputs.forEach((o, i) => {
    if (o.address === address && (o.assets[unit] ?? 0n) === 1n) hits.push(i);
  });
  if (hits.length !== 1) {
    throw new Error(
      `Cần đúng 1 output tại ${address} mang 1 ${unit}, thấy ${hits.length} (chỉ số: [${hits.join(", ")}]).`,
    );
  }
  return hits[0]!;
}

export interface VaultCreateResult {
  vault_outref: string;
  vault_nft: string;
  owner: { type: "key" | "script"; hash: string };
  dry_run: boolean;
}

/**
 * Dòng kết quả máy đọc: `RESULT <JSON một dòng>`. Kiểm hình dạng TRƯỚC khi in — một dòng
 * RESULT sai hình dạng đi thẳng vào bộ điều phối và thành dữ liệu của nó.
 *
 * `dry_run` luôn có mặt (true/false), không chỉ khi true: vắng mặt và `false` là hai thứ
 * bộ đọc phải tự đoán nếu trường này tuỳ chọn.
 */
export function resultLine(r: VaultCreateResult): string {
  parseOutRef(r.vault_outref, "vault_outref");
  // unit = policy (56 hex) + asset name; asset name của NFT danh tính là blake2b_256 (64 hex).
  if (!/^[0-9a-f]{56}[0-9a-f]{0,64}$/.test(r.vault_nft) || r.vault_nft.length % 2 !== 0) {
    throw new Error(`vault_nft sai hình dạng unit (policy 56 hex + asset name hex): "${r.vault_nft}".`);
  }
  if (r.owner.type !== "key" && r.owner.type !== "script") {
    throw new Error(`owner.type phải là "key" hoặc "script", nhận "${String(r.owner.type)}".`);
  }
  if (!HEX56.test(r.owner.hash)) throw new Error(`owner.hash phải là 56 hex chữ thường, nhận "${r.owner.hash}".`);
  if (typeof r.dry_run !== "boolean") throw new Error("dry_run phải là boolean.");
  const body = {
    vault_outref: r.vault_outref,
    vault_nft: r.vault_nft,
    owner: { type: r.owner.type, hash: r.owner.hash },
    dry_run: r.dry_run,
  };
  return `RESULT ${JSON.stringify(body)}`;
}

/** Tx hash 64 hex chữ thường — kiểm giá trị Lucid trả về trước khi đưa vào RESULT. */
export function assertTxHash(h: string, label: string): string {
  if (!HEX64.test(h)) throw new Error(`${label} không phải tx hash 64 hex chữ thường: "${h}".`);
  return h;
}
