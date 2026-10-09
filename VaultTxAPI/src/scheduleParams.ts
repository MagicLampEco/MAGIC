// VaultTxAPI/src/scheduleParams.ts — tham số lịch ScheduleGen mà `/health ▸ vault_scopes[].schedule_params` khai.
//
// KHÔNG gõ lại số. Nguồn là hằng của ScheduleGen: mã on-chain ở
// `ScheduleGen/onchain/lib/magiclamp/protocol/constants.ak` (`schedule_min_length`, `schedule_max_length`,
// `schedule_delay`, `min_lamp_per_fire`), bản chép off-chain ở `ScheduleGen/offchain/src/constants.ts`
// (`SCHEDULE_MIN_LENGTH`, …) — hai bên trùng bit theo BOUNDARIES P8 và bài `scheduleParams.test.ts` đọc THẲNG
// tệp `.ak` để so, nên số này không trôi khỏi validator mà không đỏ.
//
// Đơn vị: `min_length`/`max_length` đếm LỆNH bắn (mỗi lệnh một epoch); `delay_epochs` đếm epoch từ lúc ký tới lệnh
// bắn đầu; `min_lamp_per_fire` theo OILDROP (1 LAMP = 1_000_000 oildrop), chuỗi chữ số như mọi số tiền của hợp đồng.

import {
  MIN_LAMP_PER_FIRE, SCHEDULE_DELAY, SCHEDULE_MAX_LENGTH, SCHEDULE_MIN_LENGTH,
} from "@magiclamp/schedulegen-sdk";

export interface ScheduleParamsView {
  min_length: number;
  max_length: number;
  delay_epochs: number;
  min_lamp_per_fire: string;
}

export function scheduleParamsView(): ScheduleParamsView {
  return {
    min_length: Number(SCHEDULE_MIN_LENGTH),
    max_length: Number(SCHEDULE_MAX_LENGTH),
    delay_epochs: Number(SCHEDULE_DELAY),
    min_lamp_per_fire: MIN_LAMP_PER_FIRE.toString(),
  };
}
