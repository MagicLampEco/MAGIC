// src/checkpoint.ts — "checkpoint" của két InstantGen Gen v2.0: năm ô `wakeme_link` (6),
// `cap_epoch` (12), `cap_nanogic` (14), `usage_window` (18), `usage_window_epoch` (19).
//
// P8: gương của `onchain/lib/magiclamp/protocol/checkpoint.ak` (`current_checkpoint`,
// `read_rho` vế datum, `expected_checkpoint`, `expected_checkpoint_for_gen`,
// `resolve_link`, `refreshed`). Luật 1–6 ghi ở đầu tệp Aiken; ở đây chỉ gương.
// Công thức cap dùng lại `genFormula.ts ▸ amountByLamp` (đã trùng bit với
// `gen_formula.ak`) — KHÔNG viết lại công thức.
//
// Kết quả đọc két Wakeme đi vào dưới dạng `WakemeRead | null` (null = không có két trong
// reference input), đúng hình dạng `wakeme_read` trả `Option<(owner_commit, L)>`.
// Vế nào validator `fail` thì ở đây NÉM `GEN-INST-011`.

import { INSTANT_SCALE_HORIZON, RHO_MAX_Q } from "./constants.js";
import { amountByLamp, shiftWindow, type EpochUsage } from "./genFormula.js";
import type { RateParam, VaultDatum } from "./types.js";

export interface Checkpoint {
  wakeme_link        : string;
  cap_epoch          : bigint;
  cap_nanogic        : bigint;
  usage_window       : EpochUsage[];
  usage_window_epoch : bigint;
}

/** Kết quả đọc ĐÚNG MỘT két Wakeme hợp lệ: `(owner_commit, L_lent)`. */
export interface WakemeRead {
  ownerCommit: string;
  lent       : bigint;
}

/** Quyền của nhánh với `wakeme_link` — gương `checkpoint.ak ▸ LinkMode`. */
export type LinkMode = "FollowVault" | "FollowVaultOrUnlink" | "KeepLink";

export function currentCheckpoint(d: VaultDatum): Checkpoint {
  return {
    wakeme_link:        d.wakeme_link,
    cap_epoch:          d.cap_epoch,
    cap_nanogic:        d.cap_nanogic,
    usage_window:       d.usage_window.map(u => ({ ...u })),
    usage_window_epoch: d.usage_window_epoch,
  };
}

/** ρ hiệu lực ở `e` (gương `read_rho` vế datum): kèm phòng thủ `0 ≤ ρ ≤ RHO_MAX_Q`. */
export function rhoAt(rp: RateParam, e: bigint): bigint {
  const rho = e >= rp.effective_epoch ? rp.rho_q : rp.prev_rho_q;
  if (rho < 0n || rho > RHO_MAX_Q) {
    throw new Error(`GEN-INST-011: ρ hiệu lực ${rho} ngoài [0, ${RHO_MAX_Q}] — validator từ chối.`);
  }
  return rho;
}

function resolveLink(read: WakemeRead | null, mode: LinkMode, d: VaultDatum): [string, bigint] {
  if (read !== null) {
    if (mode === "KeepLink" && read.ownerCommit !== d.wakeme_link) {
      throw new Error(
        `GEN-INST-011: nhánh không chữ ký chỉ đọc được két Wakeme ĐÃ ghim ` +
        `(${d.wakeme_link || "<rỗng>"}), két đưa vào là ${read.ownerCommit}.`,
      );
    }
    // Luật 6 (gương `resolve_link` nhánh `FollowVault`, 2026-10-02): nhánh chủ ký thường
    // chỉ ĐỔI link khi link cũ rỗng, hoặc két đọc được đang ghim chính két IG này
    // (`lent > 0`). RefreshCheckpoint (`FollowVaultOrUnlink`) giữ luật cũ.
    if (
      mode === "FollowVault" &&
      d.wakeme_link !== "" &&
      read.ownerCommit !== d.wakeme_link &&
      read.lent <= 0n
    ) {
      throw new Error(
        `GEN-INST-011: két đã nối két Wakeme ${d.wakeme_link}; két đưa vào là ` +
        `${read.ownerCommit} và KHÔNG ghim két IG này (L_lent = 0) ⟹ nhánh chủ ký thường ` +
        `không đổi link được (luật 6). Đưa đúng két đã nối vào, hoặc đổi link qua ` +
        `RefreshCheckpoint.`,
      );
    }
    return [read.ownerCommit, read.lent];
  }
  if (mode === "FollowVaultOrUnlink") return ["", 0n];
  if (d.wakeme_link !== "") {
    throw new Error(
      `GEN-INST-011: két đã ghim két Wakeme ${d.wakeme_link} và lượt này làm mới cap ⟹ ` +
      `BẮT BUỘC có két đó trong reference input (luật 2). Không còn két ⟹ RefreshCheckpoint để gỡ.`,
    );
  }
  return ["", 0n];
}

function refreshed(
  d: VaultDatum, e: bigint, link: string, lent: bigint, rate: RateParam | null,
): Checkpoint {
  if (rate === null) {
    throw new Error(
      `GEN-INST-011: lượt này làm mới checkpoint (cap_epoch ${d.cap_epoch} → ${e}) nên cần ` +
      `beacon ρ trong reference input — chưa truyền rateBeaconUtxo.`,
    );
  }
  const window = shiftWindow(d.usage_window, d.usage_window_epoch, e);
  const rho = rhoAt(rate, e);
  const cap = amountByLamp(d.lamp_balance - d.lamp_locked, lent, window, rho, INSTANT_SCALE_HORIZON);
  return { wakeme_link: link, cap_epoch: e, cap_nanogic: cap, usage_window: window, usage_window_epoch: e };
}

/** Gương `expected_checkpoint`. `force = true` chỉ cho RefreshCheckpoint. */
export function expectedCheckpoint(
  d: VaultDatum, e: bigint, mode: LinkMode, force: boolean,
  wakeme: WakemeRead | null, rate: RateParam | null,
): Checkpoint {
  if (e < d.cap_epoch) {
    throw new Error(`GEN-INST-011: epoch ${e} < cap_epoch ${d.cap_epoch} — thời gian lùi.`);
  }
  if (!force && d.cap_epoch === e) return currentCheckpoint(d);
  const [link, lent] = resolveLink(wakeme, mode, d);
  return refreshed(d, e, link, lent, rate);
}

/**
 * Gương `expected_checkpoint_for_gen`: như `expectedCheckpoint(.., FollowVault, false, ..)`
 * nhưng trả thêm `L_lent` của lượt sinh — kể cả khi KHÔNG làm mới. Cùng epoch mà có két
 * Wakeme ⟹ két đó phải là két ĐÃ ghim.
 */
export function expectedCheckpointForGen(
  d: VaultDatum, e: bigint, wakeme: WakemeRead | null, rate: RateParam | null,
): { checkpoint: Checkpoint; lent: bigint; refreshed: boolean } {
  if (e < d.cap_epoch) {
    throw new Error(`GEN-INST-011: epoch ${e} < cap_epoch ${d.cap_epoch} — thời gian lùi.`);
  }
  if (d.cap_epoch === e) {
    let lent = 0n;
    if (wakeme !== null) {
      if (wakeme.ownerCommit !== d.wakeme_link) {
        throw new Error(
          `GEN-INST-011: giữa epoch chỉ két Wakeme ĐÃ ghim (${d.wakeme_link || "<rỗng>"}) ` +
          `được góp L_lent; két đưa vào là ${wakeme.ownerCommit}. Muốn nối két mới thì ` +
          `RefreshCheckpoint trước.`,
        );
      }
      lent = wakeme.lent;
    }
    return { checkpoint: currentCheckpoint(d), lent, refreshed: false };
  }
  const [link, lent] = resolveLink(wakeme, "FollowVault", d);
  return { checkpoint: refreshed(d, e, link, lent, rate), lent, refreshed: true };
}
