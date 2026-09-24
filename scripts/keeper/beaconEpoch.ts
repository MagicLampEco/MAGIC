// scripts/keeper/beaconEpoch.ts — so epoch ghi trong datum một beacon với epoch hiện tại.
//
// Ba trạng thái, không phải hai. Bản trước so bằng `datum >= hiện tại` rồi bỏ qua, nên một
// beacon ghi epoch TƯƠNG LAI đọc y hệt một beacon đã cập nhật: keeper in "đã ở epoch …", mã
// thoát 0, mỗi giờ, mãi mãi — trong khi validator từ chối beacon đó vì tuổi âm
// (`InstantGen/onchain/validators/vault.ak` ▸ `backing_age >= 0`,
//  `ConsumeMAGIC/onchain/validators/consume.ak` ▸ `current_epoch >= pp.epoch`).
//
// Epoch tương lai nghĩa là một bên khác đã ghi beacon theo NHỊP epoch khác nhịp của keeper này
// (ca thật 2026-09-23: keeper đời cũ nhịp 1 ngày ghi đè beacon backing của cụm nhịp 5 ngày —
// địa chỉ beacon backing suy từ khoá ví nên hai đời dùng chung). Keeper KHÔNG tự ghi đè ở ca
// này: hai keeper khác nhịp cùng tự ghi đè thì giành beacon của nhau mỗi lượt.

export type BeaconEpochState = "current" | "behind" | "ahead";

export function beaconEpochState(datumEpoch: bigint, currentEpoch: bigint): BeaconEpochState {
  if (datumEpoch === currentEpoch) return "current";
  return datumEpoch < currentEpoch ? "behind" : "ahead";
}

export function aheadMessage(datumEpoch: bigint, currentEpoch: bigint): string {
  return `beacon ghi epoch ${datumEpoch} > epoch hiện tại ${currentEpoch} — một bên đã ghi nó theo nhịp epoch khác nhịp keeper này; validator từ chối beacon có tuổi âm. Keeper KHÔNG ghi đè, không gửi gì`;
}
