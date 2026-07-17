/**
 * GenMAGIC v0.2 — test ép bất biến §7.
 * Mỗi khối "TÁI LẬP ĐÒN" chạy lại đúng đòn hội đồng đã đánh sập v0.1 (PoC PASS),
 * chứng minh v0.2 chặn được. Neo: Specs/_council/GenMAGIC-v0.1-council-2026-07-17.md
 */
import { describe, it, expect } from 'vitest';
import {
  Q, OIL_PER_LAMP, D_CAP, TRAN_TUOI, SLOTS_PER_EPOCH,
  TRONG_SO_MAC_DINH, TRONG_SO_CHUA_CO_BIEU_PHI, tuCachTran, tongTrongSo, kiemINV_G4,
  docVault, tuoiEpoch, rTieu, rThapDiem, tuCach, trongSoVault, tongTrongSoMang,
  nhipGen, magicVault, magicColdStart,
  type HoSo, type VaultDoc,
} from '../offchain/src/math.js';

const NEO = { hDid: 'hash_canonical_that' };
const SLOT = 500_000_000n;

const hoSo = (o: Partial<HoSo> = {}): HoSo => ({
  slotNow: SLOT, vestStartSlot: SLOT, daTieu: 0n, daSinh: 0n,
  tieuThapDiem: 0n, magicCamKet: 0n, ...o,
});
const vaultThat = (o: Partial<VaultDoc> = {}): VaultDoc => ({
  scriptHash: NEO.hDid, soLuongVaultNft: 1n,
  lampOildropDo: 1000n * OIL_PER_LAMP, cDatum: 1000n,
  vestStartSlot: SLOT, didCommit: 'did_a', ...o,
});

// ══ INV-G4 — công dân hạng nhất ══════════════════════════════════════════
describe('INV-G4 — công dân hạng nhất (ưu tiên số 1 của anh Aladin)', () => {
  it('w_tieu > w_tuoi + w_thap + w_cam (0.90 > 0.60)', () => {
    expect(kiemINV_G4(TRONG_SO_MAC_DINH)).toBe(true);
    const { tuoi, tieu, thap, cam } = TRONG_SO_MAC_DINH;
    expect(tieu).toBeGreaterThan(tuoi + thap + cam);
  });

  it('bộ trọng số CHƯA-CÓ-BIỂU-PHÍ cũng thoả INV-G4 (1.10 > 0.40)', () => {
    expect(kiemINV_G4(TRONG_SO_CHUA_CO_BIEU_PHI)).toBe(true);
  });

  it('Σw = 1.5Q ⟹ tư_cách ∈ [1.00×, 2.50×] ở CẢ HAI bộ trọng số', () => {
    for (const w of [TRONG_SO_MAC_DINH, TRONG_SO_CHUA_CO_BIEU_PHI]) {
      expect(tongTrongSo(w)).toBe(Q + Q / 2n);
      expect(tuCachTran(w)).toBe(Q * 5n / 2n);
    }
  });

  it('người TIÊU-THẬT (mọi thứ khác = 0) THẮNG người ÔM tối đa mọi thứ khác', () => {
    // tiêu hết suất, tuổi 0, không thấp điểm, không cam kết
    const tieuThat = tuCach(hoSo({ daSinh: 1000n, daTieu: 1000n }));
    // KHÔNG tiêu, nhưng tuổi max + thấp điểm max + cam kết max
    const omGiu = tuCach(hoSo({
      vestStartSlot: SLOT - TRAN_TUOI * SLOTS_PER_EPOCH,
      daSinh: 1000n, daTieu: 0n, tieuThapDiem: 1000n, magicCamKet: 1000n,
    }));
    expect(tieuThat).toBe(Q + (Q * 9n) / 10n); // 1.90×
    expect(omGiu).toBe(Q + (Q * 6n) / 10n);    // 1.60×
    expect(tieuThat).toBeGreaterThan(omGiu);
  });

  it('TÁI LẬP ĐÒN — v0.1 (tích): ôm-tối-ưu 4.95× ĐÈ tiêu-thật 4.74×. v0.2 lật lại', () => {
    // Dạng tích cũ: tuổi 2.20 × thấp 1.50 × cam 1.50 = 4.95 (trả 0 đồng)
    const tichOm = (2200n * 1500n * 1500n) / (1000n * 1000n); // 4.950
    const tichTieu = (1000n * 2500n * 1500n * 1265n) / (1000n * 1000n * 1000n); // ≈4.74
    expect(tichOm).toBeGreaterThan(tichTieu); // v0.1 GÃY — tái lập được

    // v0.2 (tổng): người ôm KHÔNG thể vượt người tiêu, bất kể tối ưu thế nào
    const omTotUu = tuCach(hoSo({
      vestStartSlot: SLOT - 999n * SLOTS_PER_EPOCH,
      daSinh: 10n ** 9n, daTieu: 0n, tieuThapDiem: 10n ** 9n, magicCamKet: 10n ** 12n,
    }));
    const tieuToiThieu = tuCach(hoSo({ daSinh: 1000n, daTieu: 1000n }));
    expect(tieuToiThieu).toBeGreaterThan(omTotUu); // v0.2 ĐÚNG
  });
});

// ══ TÁI LẬP ĐÒN: vault giả 2 ADA (PoC PASS trên v0.1) ════════════════════
describe('INV-vault-thật — §3 năm bước', () => {
  it('TÁI LẬP ĐÒN — UTxO 2 ADA, datum bịa c=10^12, KHÔNG NFT KHÔNG LAMP ⟹ LOẠI', () => {
    const gia = vaultThat({ soLuongVaultNft: 0n, lampOildropDo: 0n, cDatum: 10n ** 12n });
    expect(docVault(gia, NEO)).toBeNull();
  });

  it('TÁI LẬP ĐÒN — c=10^24 (đòn "toàn mạng gen = 0") ⟹ LOẠI', () => {
    const gia = vaultThat({ soLuongVaultNft: 0n, lampOildropDo: 0n, cDatum: 10n ** 24n });
    expect(docVault(gia, NEO)).toBeNull();
  });

  it('TÁI LẬP ĐÒN — param-substitution: script-hash không khớp canonical ⟹ LOẠI', () => {
    expect(docVault(vaultThat({ scriptHash: 'hash_attacker_apply_param' }), NEO)).toBeNull();
  });

  it('có NFT nhưng KHAI MAN c (datum 1000, LAMP thật chỉ 5) ⟹ dùng c=5, KHÔNG tin datum', () => {
    const man = vaultThat({ cDatum: 1000n, lampOildropDo: 5n * OIL_PER_LAMP });
    expect(docVault(man, NEO)).toBe(5n);
  });

  it('vault thật ⟹ nhận, c = min(datum, LAMP đo được)', () => {
    expect(docVault(vaultThat(), NEO)).toBe(1000n);
  });

  it('c vượt D_CAP=1001 ⟹ LOẠI (biên I-ACT-6 không tự đúng cho UTxO chưa qua genesis)', () => {
    const qua = vaultThat({ cDatum: 5000n, lampOildropDo: 5000n * OIL_PER_LAMP });
    expect(docVault(qua, NEO)).toBeNull();
  });

  it('NFT > 1 ⟹ LOẠI (singleton)', () => {
    expect(docVault(vaultThat({ soLuongVaultNft: 2n }), NEO)).toBeNull();
  });
});

// ══ TÁI LẬP ĐÒN: kíp nổ 1 LAMP (PoC PASS trên v0.1) ══════════════════════
describe('INV-sàn-trần + INV-không-âm — kíp nổ vest_start_slot', () => {
  it('TÁI LẬP ĐÒN — vest_start_slot = 10^18 ⟹ tuổi KHÔNG âm (v0.1: tuổi ≈ −2.3×10^12)', () => {
    expect(tuoiEpoch(SLOT, 10n ** 18n)).toBe(0n);
  });

  it('TÁI LẬP ĐÒN — vest_start_slot = 10^18 ⟹ tư_cách KHÔNG thủng sàn Q', () => {
    const tc = tuCach(hoSo({ vestStartSlot: 10n ** 18n }));
    expect(tc).toBeGreaterThanOrEqual(Q);
    expect(tc).toBe(Q); // sàn đúng 1.00×
  });

  it('TÁI LẬP ĐÒN — tư_cách âm ⟹ W âm ⟹ max(W,1)=1 ⟹ nhịp nổ. v0.2: W ≥ 0', () => {
    const tc = tuCach(hoSo({ vestStartSlot: 10n ** 18n }));
    const w = trongSoVault(1n, tc);
    expect(w).toBeGreaterThanOrEqual(0n);
    expect(tongTrongSoMang([w, trongSoVault(1000n, tc)])).toBeGreaterThan(0n);
  });

  it('tuổi giả (vest_start_slot rất xa quá khứ) bị kẹp TRẦN_TUỔI, không vô hạn', () => {
    expect(tuoiEpoch(SLOT, SLOT - 10_000n * SLOTS_PER_EPOCH)).toBe(TRAN_TUOI);
  });

  it('tư_cách LUÔN ∈ [Q, 2.5Q] với mọi đầu vào ác ý', () => {
    const acY: HoSo[] = [
      hoSo({ vestStartSlot: 10n ** 18n }),
      hoSo({ vestStartSlot: 0n }),
      hoSo({ daSinh: 0n, daTieu: 10n ** 30n }),
      hoSo({ daSinh: 1n, daTieu: 10n ** 30n, tieuThapDiem: 10n ** 30n, magicCamKet: 10n ** 30n }),
      hoSo({ slotNow: 0n, vestStartSlot: 10n ** 18n, daSinh: 1n, daTieu: 10n ** 30n }),
    ];
    for (const h of acY) {
      const tc = tuCach(h);
      expect(tc).toBeGreaterThanOrEqual(Q);
      expect(tc).toBeLessThanOrEqual(tuCachTran(TRONG_SO_MAC_DINH));
    }
  });
});

// ══ INV-G1 — nắm LAMP là CÓ gen, không cổng ══════════════════════════════
describe('INV-G1-mọi-c — tiên đề: chỉ cần nắm LAMP là sinh được MAGIC', () => {
  it('TÁI LẬP ĐÒN — v0.1 floor thứ nhất: c×nhịp < Q ⟹ M=0 với MỌI tư_cách', () => {
    // v0.1: M = ⌊⌊c×nhịp/Q⌋ × tư_cách/Q⌋ — floor trong cùng nuốt hết
    const nhipNho = 100n;
    const v01 = ((1n * nhipNho) / Q) * (Q * 5n / 2n) / Q;
    expect(v01).toBe(0n); // v0.1 GÃY — cổng im lặng, luỹ thoái

    // v0.2: max(1, ·) ÉP G1
    const tc = tuCach(hoSo());
    expect(magicVault(trongSoVault(1n, tc), nhipNho)).toBeGreaterThanOrEqual(1n);
  });

  it('∀ c ∈ [1..1001], ∀ tư_cách ∈ [Q, 2.5Q] ⟹ M_v ≥ 1 (kể cả nhịp cực nhỏ)', () => {
    const tcs = [Q, Q + Q / 2n, tuCachTran(TRONG_SO_MAC_DINH)];
    for (const c of [1n, 2n, 7n, 500n, D_CAP]) {
      for (const tc of tcs) {
        for (const nhip of [1n, 100n, Q]) {
          expect(magicVault(trongSoVault(c, tc), nhip)).toBeGreaterThanOrEqual(1n);
        }
      }
    }
  });

  it('vault bị LOẠI ở §3 ⟹ M = 0 (không phải người nắm LAMP)', () => {
    expect(magicVault(0n, Q)).toBe(0n);
  });
});

// ══ INV-tổng — thứ nguyên Q ══════════════════════════════════════════════
describe('INV-tổng — Σ M_v bám ngân sách (v0.1 lệch đúng 10^9)', () => {
  const chay = (n: number) => {
    const tc = tuCach(hoSo({ daSinh: 1000n, daTieu: 500n }));
    const ws = Array.from({ length: n }, () => trongSoVault(1000n, tc));
    const W = tongTrongSoMang(ws);
    const B = 10n ** 6n * Q; // 10^6 MAGIC
    const nhip = nhipGen(B, W, 10n ** 30n, 10n ** 30n);
    const tong = ws.reduce((a, w) => a + magicVault(w, nhip), 0n);
    return { B, tong };
  };

  it('TÁI LẬP ĐÒN — v0.1: Σ M_v = ngân_sách / 10^9 (phát một phần tỷ)', () => {
    const tc = Q + Q / 2n, c = 1000n, n = 1000n;
    const W_v01 = n * c * tc;              // tích THÔ — đã mang sẵn một Q
    const B = 10n ** 6n * Q;
    const nhip_v01 = (B * Q) / W_v01;      // chỉ nhân Q MỘT lần
    const M_v01 = ((c * nhip_v01) / Q) * tc / Q; // chia Q HAI lần
    expect(n * M_v01).toBeLessThan(B / 10n ** 6n); // lệch cỡ tỷ — tái lập được
  });

  it('v0.2: |Σ M_v − B| / B < 10^-6 với N = 10^3', () => {
    const { B, tong } = chay(1000);
    const lech = tong > B ? tong - B : B - tong;
    expect((lech * 10n ** 6n) / B).toBe(0n);
  });

  it('v0.2: |Σ M_v − B| / B < 10^-6 với N = 10^4', () => {
    const { B, tong } = chay(10_000);
    const lech = tong > B ? tong - B : B - tong;
    expect((lech * 10n ** 6n) / B).toBe(0n);
  });

  it('kiểm thứ nguyên: Σ w_v × nhịp / Q = B', () => {
    const W = 10n ** 6n, B = 10n ** 15n;
    const nhip = nhipGen(B, W, 10n ** 30n, 10n ** 30n);
    expect((W * nhip) / Q).toBe(B);
  });
});

// ══ Thang giờ-thấp-điểm ══════════════════════════════════════════════════
describe('giờ-thấp-điểm — chuẩn hoá theo đã_SINH (v0.1 chia đã_tiêu ⟹ không thang)', () => {
  it('TÁI LẬP ĐÒN — v0.1: tiêu 1 nanogic lúc thấp điểm ăn TRỌN 1.5×', () => {
    const v01 = (1n * Q) / 1n; // ⌊tiêu_thấp × Q / max(đã_tiêu,1)⌋ với đã_tiêu = 1
    expect(v01).toBe(Q);       // full — GÃY

    // v0.2: chia đã_sinh = 1000 ⟹ chỉ 1/1000 mức
    expect(rThapDiem(1n, 1000n)).toBe(Q / 1000n);
  });

  it('muốn ăn trọn phải tiêu THẬT NHIỀU và ĐÚNG GIỜ', () => {
    expect(rThapDiem(1000n, 1000n)).toBe(Q);
  });
});

// ══ Cold-start + van ═════════════════════════════════════════════════════
describe('§5 cold-start + van + trần tuyệt đối', () => {
  it('cold-start e=0 chia pro-rata, không dùng W(−1)', () => {
    const B = 1000n * Q;
    const ws = [100n, 200n, 700n];
    const W = tongTrongSoMang(ws);
    const tong = ws.reduce((a, w) => a + magicColdStart(B, w, W), 0n);
    expect(tong).toBe(B);
  });

  it('van TRẦN_TĂNG chặn nhịp nhảy bậc (1.25×/epoch)', () => {
    expect(nhipGen(10n ** 30n, 1n, 1000n, 10n ** 30n)).toBe(1250n);
  });

  it('NHỊP_TRẦN chặn MỨC — van chỉ chặn TỐC ĐỘ', () => {
    expect(nhipGen(10n ** 30n, 1n, 10n ** 20n, 5000n)).toBe(5000n);
  });

  it('TÁI LẬP ĐÒN — W=0 ⟹ v0.1 max(W,1)=1 ⟹ nhịp nổ. v0.2: NHỊP_TRẦN chặn', () => {
    const tran = 10n ** 12n;
    expect(nhipGen(10n ** 30n, 0n, 10n ** 30n, tran)).toBe(tran);
  });
});

// ══ BigInt ═══════════════════════════════════════════════════════════════
describe('C-OVERFLOW — BigInt, cấm Number', () => {
  it('c=1001, tư_cách=2.5Q, nhịp lớn ⟹ không mất chính xác', () => {
    const w = trongSoVault(D_CAP, Q * 5n / 2n);
    expect(w).toBe(2502n);
    const m = magicVault(w, 10n ** 18n);
    expect(m).toBe(2502n * 10n ** 9n);
    expect(typeof m).toBe('bigint');
  });

  it('giá trị vượt Number.MAX_SAFE_INTEGER vẫn đúng bit', () => {
    const m = magicVault(trongSoVault(D_CAP, Q * 5n / 2n), 10n ** 24n);
    expect(m).toBe(2502n * 10n ** 15n);
    expect(m).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  });
});
