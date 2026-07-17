/**
 * GenMAGIC — math (v0.2)
 * Neo: Specs/GenMAGIC-Math-Vi.md · Wakeme GenDrip (I-ACT-7)
 *
 * BigInt TOÀN BỘ. Cấm Number (C-OVERFLOW). Nhân-chia-floor TUẦN TỰ, không gộp một phép.
 */

// ── Hằng ──────────────────────────────────────────────────────────────────
export const Q = 1_000_000_000n;            // Q-format
export const OIL_PER_LAMP = 1_000_000n;     // oildrop / NGUYÊN-LAMP
export const SLOTS_PER_EPOCH = 432_000n;    // 1 epoch = 5 ngày
export const D_CAP = 1001n;                 // trần conditional_lamp (Wakeme I-ACT-6)
export const TRAN_TUOI = 24n;               // epoch — trần tuổi-LAMP
export const CUA_SO = 6n;                   // độ dài cửa sổ (INV-cửa-sổ-đối-xứng — KHÔNG đổi)
export const TRAN_TANG = 1_250_000_000n;    // 1.25Q — van tốc độ nhịp_gen

/** Trọng số tư-cách. Σ = 1.5Q ⟹ tư_cách ∈ [Q, 2.5Q]. */
export interface TrongSo {
  tuoi: bigint;
  tieu: bigint;
  thap: bigint;
  cam: bigint;
}

/** Mặc định — anh Aladin chốt 17/7. w_tieu chiếm 60% dải (công dân hạng nhất). */
export const TRONG_SO_MAC_DINH: TrongSo = {
  tuoi: 300_000_000n, // 0.30Q
  tieu: 900_000_000n, // 0.90Q
  thap: 200_000_000n, // 0.20Q
  cam: 100_000_000n,  // 0.10Q
};

/**
 * Chưa có nguồn biểu-phí-công-bố ⟹ TẮT giờ-thấp-điểm (w_thap = 0), chia lại phần
 * của nó cho tiêu-thật. KHÔNG bịa số. Σ giữ 1.5Q, INV-G4 vẫn thoả (1.10 > 0.40).
 */
export const TRONG_SO_CHUA_CO_BIEU_PHI: TrongSo = {
  tuoi: 300_000_000n,
  tieu: 1_100_000_000n, // 0.90Q + 0.20Q
  thap: 0n,
  cam: 100_000_000n,
};

export const tongTrongSo = (w: TrongSo): bigint => w.tuoi + w.tieu + w.thap + w.cam;
export const tuCachTran = (w: TrongSo): bigint => Q + tongTrongSo(w);

/**
 * INV-G4 — công-dân-hạng-nhất là bất biến SỐ HỌC, không phải tuyên bố.
 * w_tieu > w_tuoi + w_thap + w_cam ⟹ người tiêu-thật hoàn toàn (mọi thứ khác = 0)
 * LUÔN thắng người không tiêu dù tối đa mọi thứ khác.
 */
export const kiemINV_G4 = (w: TrongSo = TRONG_SO_MAC_DINH): boolean =>
  w.tieu > w.tuoi + w.thap + w.cam;

// ── §3. Đọc vault — engine TỰ XÁC THỰC ────────────────────────────────────
// v0.1 SAI: "bất biến bắc cầu, không cần engine kiểm". (SỔ-VALUE) là bất biến
// CHUYỂN-TRẠNG-THÁI — chỉ ép KHI validator chạy. UTxO chưa spend thì không ai kiểm.

export interface VaultDoc {
  /** payment_credential của UTxO đọc được */
  scriptHash: string;
  /** vault-NFT: số lượng asset (H_did, owner_commit) trong value */
  soLuongVaultNft: bigint;
  /** TỰ ĐO từ value: oildrop LAMP canonical thật sự nằm trong UTxO */
  lampOildropDo: bigint;
  /** conditional_lamp KHAI trong datum — KHÔNG BAO GIỜ tin trực tiếp */
  cDatum: bigint;
  vestStartSlot: bigint;
  didCommit: string;
}

export interface NeoCanonical {
  /** script-hash apply-param canonical do engine TỰ TÍNH LẠI — không suy từ datum */
  hDid: string;
}

/**
 * 5 bước §3 — thiếu 1 là LOẠI. Trả về c_dùng (NGUYÊN-LAMP) hoặc null nếu loại.
 * Chống: UTxO giả 2 ADA datum bịa (PoC PASS), param-substitution, khai man c.
 */
export function docVault(v: VaultDoc, neo: NeoCanonical): bigint | null {
  // (1) địa chỉ phải là script canonical engine tự tính — không tin địa chỉ tự khai
  if (v.scriptHash !== neo.hDid) return null;
  // (2) vault-NFT singleton
  if (v.soLuongVaultNft !== 1n) return null;
  // (3)+(4) TỰ ĐO LAMP, không bao giờ tin c trong datum
  const cTuLamp = v.lampOildropDo / OIL_PER_LAMP;
  const cDung = v.cDatum < cTuLamp ? v.cDatum : cTuLamp;
  // (5) biên I-ACT-6 — chỉ đúng cho UTxO đã thật sự qua genesis_vault_ok
  if (cDung < 1n || cDung > D_CAP) return null;
  return cDung;
}

// ── §4. Bốn tỷ-lệ thành phần ∈ [0, Q] ─────────────────────────────────────

const kep = (x: bigint, lo: bigint, hi: bigint): bigint => (x < lo ? lo : x > hi ? hi : x);

/**
 * max(0, ·) là LOAD-BEARING: v0.1 chỉ kẹp TRÊN ⟹ vest_start_slot = 10^18
 * → tuổi ÂM → tư-cách ÂM → W ÂM → max(W,1)=1 → nhịp_gen = ngân_sách×Q/1. PoC PASS, giá 1 LAMP.
 */
export function tuoiEpoch(slotNow: bigint, vestStartSlot: bigint): bigint {
  const troi = slotNow - vestStartSlot;
  if (troi <= 0n) return 0n;
  return kep(troi / SLOTS_PER_EPOCH, 0n, TRAN_TUOI);
}

export const rTuoi = (slotNow: bigint, vestStartSlot: bigint): bigint =>
  (tuoiEpoch(slotNow, vestStartSlot) * Q) / TRAN_TUOI;

/** Tỷ-lệ-tận-dụng-suất. Chia cho đã_sinh ⟹ đo TỶ LỆ không đo LƯỢNG ⟹ cá voi không lợi thế. */
export const rTieu = (daTieu: bigint, daSinh: bigint): bigint =>
  kep((daTieu * Q) / (daSinh > 0n ? daSinh : 1n), 0n, Q);

/**
 * Chuẩn hoá theo đã_SINH (KHÔNG theo đã_tiêu) là LOAD-BEARING.
 * v0.1 chia cho đã_tiêu ⟹ tỷ lệ không có thang ⟹ tiêu 1 nanogic lúc thấp điểm ăn TRỌN 1.5×.
 */
export const rThapDiem = (tieuThapDiem: bigint, daSinh: bigint): bigint =>
  kep((tieuThapDiem * Q) / (daSinh > 0n ? daSinh : 1n), 0n, Q);

export const rCamKet = (magicCamKet: bigint, daSinh: bigint): bigint =>
  kep((magicCamKet * Q) / (daSinh > 0n ? daSinh : 1n), 0n, Q);

// ── §4. Gộp — TỔNG-CÓ-TRỌNG-SỐ (bỏ tích: tích làm G4 GÃY) ─────────────────

export interface HoSo {
  slotNow: bigint;
  vestStartSlot: bigint;
  daTieu: bigint;       // nanogic, cửa sổ [e−6, e)
  daSinh: bigint;       // nanogic, CÙNG cửa sổ (INV-cửa-sổ-đối-xứng)
  tieuThapDiem: bigint; // nanogic, cùng cửa sổ
  magicCamKet: bigint;  // nanogic đang cam kết trong ScheduleGen
}

/** ĐÚNG MỘT tham số (G2). Ép sàn+trần tường minh — v0.1 chỉ TUYÊN sàn Q mà không ép. */
export function tuCach(h: HoSo, w: TrongSo = TRONG_SO_MAC_DINH): bigint {
  const t = rTuoi(h.slotNow, h.vestStartSlot);
  const c = rTieu(h.daTieu, h.daSinh);
  const p = rThapDiem(h.tieuThapDiem, h.daSinh);
  const k = rCamKet(h.magicCamKet, h.daSinh);
  const tong = (w.tuoi * t + w.tieu * c + w.thap * p + w.cam * k) / Q;
  return kep(Q + tong, Q, tuCachTran(w));
}

// ── §5. Trần toàn cầu ─────────────────────────────────────────────────────

/** LAMP-hiệu-dụng. Nhân tư_cách TRƯỚC khi floor theo c ⟹ đẩy lùi cổng floor-về-0. */
export function trongSoVault(c: bigint, tc: bigint): bigint {
  const w = (c * tc) / Q;
  return w > 0n ? w : 0n; // INV-không-âm
}

export const tongTrongSoMang = (ws: bigint[]): bigint =>
  ws.reduce((a, w) => a + (w > 0n ? w : 0n), 0n);

/**
 * NHỊP_TRẦN (trần tuyệt đối) BẮT BUỘC — van TRẦN_TĂNG chặn TỐC ĐỘ, không chặn MỨC.
 * max(W,1) là kíp nổ, không phải phòng thủ: mẫu số tụt 10^15 → nhịp nhân 10^15, im lặng.
 */
export function nhipGen(
  nganSach: bigint,
  wTruoc: bigint,
  nhipTruoc: bigint,
  nhipTran: bigint,
): bigint {
  const theoNganSach = (nganSach * Q) / (wTruoc > 0n ? wTruoc : 1n);
  const theoVan = (nhipTruoc * TRAN_TANG) / Q;
  let r = theoNganSach < theoVan ? theoNganSach : theoVan;
  if (r > nhipTran) r = nhipTran;
  return r > 0n ? r : 0n;
}

/** max(1, ·) ÉP G1 — G1 là tiên đề, phải ÉP chứ không phải "kiểm". */
export function magicVault(wV: bigint, nhip: bigint): bigint {
  if (wV <= 0n) return 0n; // vault bị loại ở §3 — không phải người nắm LAMP
  const m = (wV * nhip) / Q;
  return m > 1n ? m : 1n;
}

/** Cold-start e=0: KHÔNG có W(−1) ⟹ chia pro-rata cuối epoch. Công bố trước: "epoch 0 không đoán trước được". */
export function magicColdStart(nganSach: bigint, wV: bigint, wTong: bigint): bigint {
  if (wV <= 0n) return 0n;
  const m = (nganSach * wV) / (wTong > 0n ? wTong : 1n);
  return m > 1n ? m : 1n;
}
