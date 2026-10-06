// VaultTxAPI/tests/fixtures/witnessVectors.ts — vector chứng ký GHI SẴN cho cổng `/tx/submit`
// (`src/witnessCheck.ts` ▸ `assertWitnessesCoverTx`).
//
// ── VÌ SAO GHI SẴN ───────────────────────────────────────────────────────────────
// Bất biến số một của gói (`tests/noSigningMaterial.test.ts`): mã của gói, kể cả `tests/`, không
// chạm vật liệu ký, và phép quét không có danh sách miễn. Nên bài kiểm chữ ký không được tự sinh
// khoá rồi ký; nó chỉ được cầm thứ CÔNG KHAI: khoá công khai (vkey) và chữ ký đã ký sẵn.
//
// ── CÁCH TÁI TẠO ─────────────────────────────────────────────────────────────────
// Một kịch bản chạy một lần, NGOÀI gói: sinh hai khoá ed25519 dùng một lần (A, B) trong bộ nhớ,
// dựng đúng các thân tx mô tả ở từng mục dưới đây, ký `blake2b_256(body)` (= `hash_transaction`)
// bằng từng khoá, in ra vkey + chữ ký, rồi thoát — phần riêng của khoá không ghi ra đâu và đã huỷ
// cùng tiến trình. Đổi thân tx của một bài (kể cả một trường như `ttl`, phí, datum) thì chữ ký cũ
// không còn khớp: bài so `bodyHash` dưới đây với thân nó tự dựng và đỏ ngay ở phép so đó, không đỏ
// mù ở cổng chữ ký. Khi đó sinh lại cả tệp này.

/** vkey thô (32 byte, hex) của khoá thử A và B. */
export const VKEY_A_HEX = "4fe023d40129f139627e21dde180c0ba13287903ca597c973611ec0bf11f528d";
export const VKEY_B_HEX = "b00ba9a3cda4eb5ec1e100935afa1aa8a08f993c0456a0dc4409de5d0c91fd6d";

export interface WitnessVector {
  /** `hash_transaction(body)` — thông điệp đã được ký. */
  bodyHash: string;
  /** Chữ ký Ed25519 (64 byte, hex) của A và của B trên `bodyHash`. */
  sigA: string;
  sigB: string;
}

/**
 * Thân tx của `tests/witnessCheck.test.ts` ▸ `makeTx`: một input `11…11#0`, không output, phí
 * 170 000, `required_signers` theo thứ tự ghi trong tên.
 */
export const BODY_REQUIRES_A: WitnessVector = {
  bodyHash: "554fff15c0b4643ae249afe32cef575af212b6174927235517e3c28ef93e9fb9",
  sigA: "92d75bf7b4c560b79778a37161e87f69f83d3ba403352a46fe2144fc80bd4a3765239555ba180eeb082efef01f1fc88db2dc04ec87009d1cca605b11d76f4603",
  sigB: "e945b279f6f44c3c290c5e3511b6a4a3e48833a930fb08e4100a9113d61fbda34af36b6dddda1a8ec67e1f87869dfaed1c088318fb03c25bf16ee1141cfda80d",
};
export const BODY_REQUIRES_A_B: WitnessVector = {
  bodyHash: "3b8d325716f043291d8703713aed2bf106a4f5191cd124b04892cae75e68fd5e",
  sigA: "079fbc21074c2bf732e6ecef34d9c392bd370ee90b3c391b2f9be04305181a284dfc8932b0734a618ce2366a13e0340b48cfd33c2754b8fb1f5c8816874e5f03",
  sigB: "c8e59bcc134b2221815a2163734d3e3126276d8ef02d7c5d83a1818319a611802fd589c9af07e07585412065fd79b6f6cf10af98bda12331a1ae49f38f5d5d05",
};

/**
 * Thân tx của khối "chữ ký THẬT" cuối `tests/service.test.ts` (schedule-commit ghi sẵn, `ttl` =
 * `prerecordedTtlSlot(NOW)` với `NOW = 1_789_100_703_000`, `required_signers = [hash(A)]`).
 */
export const BODY_SERVICE_SUBMIT: WitnessVector = {
  bodyHash: "e7be4a04dcdad8e01445c1734adf1bb1c34d9a040bc5665cb642fac1595adc16",
  sigA: "e991f5ab40a20f3e3a86388f2dfa238eeb2d0f934dde8e146df5185cf3d655be5e68835d0fdfa0ba0de7431cead5d50aa435fb2cb11f1b28c462655674e22f08",
  sigB: "2511fb0795020cdf427d42f3388e6c01633501c262f7d27945d58a0b5d9cef61aac2169a04de26da1f7a709347064654b341ae9f3dd25990c72e2b8f4634350f",
};

/** Lật đúng một bit ở byte đầu của chữ ký — ca giả mạo: vkey đúng, chữ ký sai một bit. */
export function flipFirstByte(sigHex: string): string {
  const b = Buffer.from(sigHex, "hex");
  b[0] = b[0]! ^ 0x01;
  return b.toString("hex");
}
