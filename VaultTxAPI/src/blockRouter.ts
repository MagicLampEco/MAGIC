// VaultTxAPI/src/blockRouter.ts — chọn KHỐI triển khai cho một yêu cầu dựng, khi một tiến trình
// phục vụ nhiều loại két (`config.ts` ▸ khối phụ).
//
// Mỗi khối một `VaultTxService` (`blocks.ts`). Tệp này chỉ quyết "khối nào", không dựng gì, không
// giữ khoá. Khối ĐẦU là khối CHÍNH (`VAULT_TX_API_DEPLOYMENT`).
//
// ── LUẬT ĐỊNH TUYẾN ────────────────────────────────────────────────────────────
//   create-vault                       → theo `kind` (`instant` → Instant, `schedule` → Schedule)
//   instant-gen · refresh-checkpoint   → Instant
//   schedule-commit · schedule-fire    → Schedule
//   consume · open-thread · bind-did   → `vault_type` TUỲ CHỌN trong thân bài ("Instant" | "Schedule"):
//       có   ⟹ đúng khối đó (không khối nào phục vụ ⟹ 400 `VAULT_TYPE_NOT_SERVED`)
//       vắng ⟹ một khối: khối đó, như trước
//              nhiều khối: tra két của chủ ở TỪNG khối — đúng một khối có ⟹ khối đó; không khối
//              nào ⟹ khối CHÍNH (nó trả đúng lỗi hiện có, ví dụ `VAULT_NOT_FOUND`); nhiều khối ⟹
//              409 `VAULT_TYPE_AMBIGUOUS`.
//
// Vì sao `open-thread` và `bind-did` cũng đi theo loại két: thread Engage được đúc dưới policy
// `consume`, mà `consume` được apply-param bằng hash của loại két nó phục vụ — nên địa chỉ thread
// (`consume.engage_address`) KHÁC nhau giữa khối Instant và khối Schedule (đo trên hai khối Preprod
// thật 2026-10-04: hai `engage_address` khác nhau). Mở thread ở khối sai là mở một thread mà
// `/tx/consume` của két kia không bao giờ thấy.
//
// Đường có loại két CỐ ĐỊNH mà thân bài gửi kèm `vault_type` khác loại đó ⟹ 400
// `VAULT_TYPE_ROUTE_CONFLICT`: lặng lẽ bỏ trường đó là để người gọi tin một lựa chọn không có hiệu lực.

import { CodedApiError } from "./errors.js";
import { ISSUED_ROUTES, type IssuedRoute } from "./locks.js";
import { parseOwnerFields, type OwnerInput } from "./owner.js";

/** Phần của dịch vụ mà bộ định tuyến cần — để phép kiểm dựng khối giả không cần chuỗi. */
export interface RoutableService {
  readonly vaultTypes: readonly string[];
  hasVaultOf(owner: OwnerInput): Promise<boolean>;
}

/** Giá trị `vault_type` mà thân bài được gửi. */
export const REQUESTABLE_VAULT_TYPES = ["Instant", "Schedule"] as const;
export type RequestableVaultType = typeof REQUESTABLE_VAULT_TYPES[number];

/** Đường có loại két cố định (ngoài `create-vault`, quyết theo `kind`). */
export const FIXED_VAULT_TYPE_OF_ROUTE: Readonly<Partial<Record<IssuedRoute, RequestableVaultType>>> = {
  "instant-gen": "Instant",
  "refresh-checkpoint": "Instant",
  "schedule-commit": "Schedule",
  "schedule-fire": "Schedule",
};

/** Đường mà loại két không suy được từ đường: chọn bằng `vault_type`, hoặc tra két của chủ. */
export const OWNER_ROUTED_ROUTES: ReadonlySet<IssuedRoute> = new Set<IssuedRoute>(["consume", "open-thread", "bind-did"]);

export class VaultBlockRouter<S extends RoutableService> {
  private readonly blocks: readonly S[];

  constructor(blocks: readonly S[]) {
    if (blocks.length === 0) throw new Error("[bất biến nội bộ] VaultBlockRouter cần ít nhất một khối.");
    this.blocks = blocks;
  }

  /** Khối CHÍNH — `/tx/submit`, `/fee/*`, tài trợ, và mọi ca "không tra được" đi qua nó. */
  get primary(): S {
    return this.blocks[0]!;
  }

  get all(): readonly S[] {
    return this.blocks;
  }

  /** Mọi loại két mà tiến trình phục vụ, khối chính trước. */
  get vaultTypes(): string[] {
    return this.blocks.flatMap(b => [...b.vaultTypes]);
  }

  /**
   * Khối cho một đường dựng. `body` là thân bài của đường dựng (với `/tx/quote`: `params`). Gọi SAU
   * khi thân bài đã qua `parseBuildRequest` ở đường dựng thật — nên lỗi hình dạng của thân bài ra
   * TRƯỚC mọi lượt đọc chuỗi ở đây.
   */
  async serviceFor(route: IssuedRoute, body: Record<string, unknown>): Promise<S> {
    const requested = parseRequestedVaultType(body.vault_type);
    const fixed = route === "create-vault" ? vaultTypeOfKind(body.kind) : FIXED_VAULT_TYPE_OF_ROUTE[route];

    if (fixed !== undefined) {
      if (requested !== undefined && requested !== fixed) {
        throw new CodedApiError(400, "VAULT_TYPE_ROUTE_CONFLICT",
          `Đường "${route}" chỉ phục vụ két "${fixed}", mà thân bài gửi "vault_type": "${requested}". ` +
          `Bỏ "vault_type", hoặc gọi đúng đường của loại két đó.`,
          { route, route_vault_type: fixed, vault_type: requested });
      }
      // Một khối: như trước — loại két mà khối không phục vụ thì chính dịch vụ trả lỗi của
      // `scopesFor`, nguyên câu nguyên mã.
      if (this.blocks.length === 1) return this.primary;
      return this.blockOf(fixed) ?? this.notServed(fixed);
    }

    // `create-vault` với `kind` hỏng: thân bài này không qua được `parseBuildRequest`; để khối
    // chính trả đúng câu 400 của nó (đường `/tx/quote` gọi tới đây trước khi đọc `params`).
    if (!OWNER_ROUTED_ROUTES.has(route)) return this.primary;

    if (requested !== undefined) return this.blockOf(requested) ?? this.notServed(requested);
    if (this.blocks.length === 1) return this.primary;

    const owner = parseOwnerFields(body);
    const has = await Promise.all(this.blocks.map(b => b.hasVaultOf(owner)));
    const hits = this.blocks.filter((_, i) => has[i] === true);
    if (hits.length === 1) return hits[0]!;
    if (hits.length === 0) return this.primary;
    const types = hits.flatMap(b => [...b.vaultTypes]);
    throw new CodedApiError(409, "VAULT_TYPE_AMBIGUOUS",
      `Chủ này có két ở nhiều loại (${types.join(", ")}) — không biết "${route}" nhắm két nào. ` +
      `Gửi kèm "vault_type": ${types.map(t => `"${t}"`).join(" hoặc ")}.`,
      { route, vault_types: types });
  }

  /**
   * Khối cho `/tx/quote`. Thân bài báo giá hỏng hình dạng (`route` lạ, `params` không phải đối tượng)
   * ⟹ khối chính, để `quoteFee` trả đúng câu 400 của nó.
   */
  async serviceForQuote(body: Record<string, unknown>): Promise<S> {
    const route = body.route;
    const params = body.params;
    if (typeof route !== "string" || !(ISSUED_ROUTES as readonly string[]).includes(route)) return this.primary;
    if (params === null || typeof params !== "object" || Array.isArray(params)) return this.primary;
    return this.serviceFor(route as IssuedRoute, params as Record<string, unknown>);
  }

  private blockOf(t: string): S | undefined {
    return this.blocks.find(b => b.vaultTypes.includes(t));
  }

  private notServed(t: string): never {
    throw new CodedApiError(400, "VAULT_TYPE_NOT_SERVED",
      `Không có địa chỉ vault nào được cấu hình cho loại "${t}".`,
      { vault_type: t, configured: this.vaultTypes });
  }
}

/** `vault_type` tuỳ chọn. Có mặt mà không phải một trong hai giá trị ⟹ 400 có mã. */
export function parseRequestedVaultType(v: unknown): RequestableVaultType | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string" && (REQUESTABLE_VAULT_TYPES as readonly string[]).includes(v)) {
    return v as RequestableVaultType;
  }
  throw new CodedApiError(400, "VAULT_TYPE_INVALID",
    `"vault_type" phải là ${REQUESTABLE_VAULT_TYPES.map(t => `"${t}"`).join(" hoặc ")} (bỏ trống = dịch vụ tự tra).`,
    { received_type: v === null ? "null" : typeof v });
}

function vaultTypeOfKind(kind: unknown): RequestableVaultType | undefined {
  if (kind === "instant") return "Instant";
  if (kind === "schedule") return "Schedule";
  return undefined;
}
