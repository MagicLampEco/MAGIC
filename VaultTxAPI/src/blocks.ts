// VaultTxAPI/src/blocks.ts — dựng một `VaultTxService` cho MỖI khối triển khai, trên phần dùng CHUNG.
//
// Tách khỏi `server.ts` để phép kiểm gọi đúng hàm mà tiến trình thật gọi: câu "hai khối dùng chung
// khoá mềm" chỉ đúng chừng nào hàm này truyền CÙNG một bảng khoá cho mọi khối, và chỉ một bài kiểm
// trên chính hàm này mới giữ được câu đó.
//
// RIÊNG theo khối: khối cấu hình (`Deployment`) và bộ dựng (blueprint + ref-script của loại két đó).
// CHUNG cho mọi khối:
//   · `locks` (khoá mềm theo chủ) — một chủ có két Instant và két Schedule thì lượt dựng ở khối này
//     phải THAY lượt dựng ở khối kia, như hai lượt cùng khối (`locks.ts` ▸ `OwnerLockTable.acquire`);
//     hai bảng riêng thì hai tx của cùng chủ cùng sống mà không ai biết nhau;
//   · `issued` (sổ phát-hành) — `/tx/submit` chỉ đi qua khối chính, nên tx dựng ở khối phụ phải nằm
//     trong CÙNG sổ thì mới nộp được, và lượt nộp mới đánh dấu "bị thay" được tx của khối kia;
//   · `pending` (input vừa nộp), `chain`, nhân chứng chủ / bộ suy DID / bộ đọc anchor DID — cấu hình
//     `did_stake` đã ép trùng giữa các khối lúc nạp (`config.ts` ▸ `assertCompatibleBlocks`).

import type { Network } from "@magiclamp/protocol-utils";

import { VaultBlockRouter } from "./blockRouter.js";
import type { ChainReader } from "./chain.js";
import type { Deployment, VaultScope } from "./config.js";
import type { DidOwnerResolverPort } from "./didOwner.js";
import type { DidPaymentAnchorReader } from "./funding.js";
import type { IssuedTxRegistry, OwnerLockTable, PendingSpends } from "./locks.js";
import type { OwnerWitnessProvider } from "./owner.js";
import { VaultTxService, type WitnessCheck } from "./service.js";
import type { TxBuilderPort } from "./txBuilder.js";

export interface BlockSpec {
  deployment: Deployment;
  builder: TxBuilderPort;
}

export interface SharedServiceDeps {
  network: Network;
  chain: ChainReader;
  locks: OwnerLockTable;
  issued: IssuedTxRegistry;
  pending?: PendingSpends;
  lockTtlMs: number;
  /** Hạn ký tx (`AppConfig.txValidityMs`); vắng ⟹ mặc định của `validity.ts`. */
  txValidityMs?: number;
  ownerWitness?: OwnerWitnessProvider;
  didOwner?: DidOwnerResolverPort;
  didPaymentAnchor?: DidPaymentAnchorReader;
  now?: () => number;
  /** Chỉ phép kiểm truyền (`service.ts` ▸ `VaultTxServiceDeps.witnessCheck`); `server.ts` không. */
  witnessCheck?: WitnessCheck;
}

/**
 * Phần của `RouterDeps` (`http.ts`) suy từ danh sách dịch vụ khối — một chỗ, để `/health` của tiến
 * trình thật và của phép kiểm cùng ra từ một hàm:
 *   · `service` = khối CHÍNH (`/tx/submit`, `/fee/*` đi qua nó; sổ phát-hành dùng chung);
 *   · `deploymentSource` GIỮ là nhãn khối chính — app cũ dò mẫu trong chuỗi này;
 *   · `deploymentSources` = nhãn mọi khối; `vaultScopes` = HỢP địa chỉ két, khối chính trước.
 */
export function blockRoutingOf(services: readonly VaultTxService[]): {
  service: VaultTxService;
  blocks: VaultBlockRouter<VaultTxService>;
  deploymentSource: string;
  deploymentSources: string[];
  vaultScopes: VaultScope[];
} {
  const blocks = new VaultBlockRouter(services);
  return {
    service: blocks.primary,
    blocks,
    deploymentSource: blocks.primary.deploymentSource,
    deploymentSources: services.map(s => s.deploymentSource),
    vaultScopes: services.flatMap(s => s.vaultScopes),
  };
}

/** Một dịch vụ mỗi khối, cùng thứ tự với `specs` (khối chính trước). */
export function makeBlockServices(specs: readonly BlockSpec[], shared: SharedServiceDeps): VaultTxService[] {
  return specs.map(s => new VaultTxService({
    network: shared.network,
    deployment: s.deployment,
    chain: shared.chain,
    builder: s.builder,
    locks: shared.locks,
    issued: shared.issued,
    lockTtlMs: shared.lockTtlMs,
    ...(shared.txValidityMs === undefined ? {} : { txValidityMs: shared.txValidityMs }),
    ...(shared.pending === undefined ? {} : { pending: shared.pending }),
    ...(shared.ownerWitness === undefined ? {} : { ownerWitness: shared.ownerWitness }),
    ...(shared.didOwner === undefined ? {} : { didOwner: shared.didOwner }),
    ...(shared.didPaymentAnchor === undefined ? {} : { didPaymentAnchor: shared.didPaymentAnchor }),
    ...(shared.now === undefined ? {} : { now: shared.now }),
    ...(shared.witnessCheck === undefined ? {} : { witnessCheck: shared.witnessCheck }),
  }));
}
