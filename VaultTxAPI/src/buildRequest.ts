// VaultTxAPI/src/buildRequest.ts — thân bài JSON của BẢY đường dựng → yêu cầu của dịch vụ.
//
// Tách khỏi `http.ts` vì có HAI nơi đọc cùng thân bài: chính đường dựng (`/tx/<route>`) và
// `/tx/quote` (`feeQuote.ts`), nơi `params` là thân bài của đường dựng. Một hàm đọc cho cả hai
// là thứ bảo đảm lỗi của `params` trong báo giá mang ĐÚNG mã mà đường dựng trả — hai hàm đọc
// thì sớm muộn lệch nhau ở một trường, và không bài nào đỏ.
//
// ── VÌ SAO SỐ TIỀN PHẢI GỬI LÊN DƯỚI DẠNG CHUỖI ────────────────────────────────
// `lamp_per_epoch` tính bằng oildrop, và trần LAMP là 36×10^15 oildrop trong khi 2^53
// ≈ 9,007×10^15. Một literal số JSON ở đó KHÔNG lỗi khi vượt ngưỡng — nó LÀM TRÒN, và
// con số đã tròn vẫn dựng ra một giao dịch hợp lệ khoá nhầm số LAMP. Nên bộ đọc TỪ CHỐI
// số JSON cho mọi trường tiền và đếm, và nói rõ vì sao trong thông báo lỗi.
// `op_type` thì nhận số nguyên: nó là một nhãn nhỏ (1 = ảnh, 2 = CID), không phải tiền.

import type { Profile } from "@magiclamp/sdk";

import { parseDidCommit, parseEngageRef } from "./engage.js";
import { BadRequestError } from "./errors.js";
import { parseFeePayer, type OutRefLike } from "./feePayer.js";
import { parseFunding } from "./funding.js";
import type { IssuedRoute } from "./locks.js";
import { parseOwnerFields, parseOwnerWitness } from "./owner.js";
import {
  toBindDidBody, toBuildBody, toCreateVaultBody, toOpenThreadBody,
  type BindDidRequest, type BindDidResponse,
  type BuildResponse, type CreateVaultRequest, type CreateVaultResponse, type OpenThreadRequest,
  type OpenThreadResponse, type OwnerRequest, type QuoteMode, type VaultTxService,
} from "./service.js";

/** Đường dựng → tên route (cùng tập với sổ phát-hành và bảng mục đích Feecover). */
export const BUILD_ROUTE_OF_PATH: Readonly<Record<string, IssuedRoute>> = {
  "/tx/instant-gen": "instant-gen",
  "/tx/schedule-commit": "schedule-commit",
  "/tx/schedule-fire": "schedule-fire",
  "/tx/consume": "consume",
  "/tx/open-thread": "open-thread",
  "/tx/bind-did": "bind-did",
  "/tx/create-vault": "create-vault",
};

export type ParsedBuild =
  | { route: "instant-gen"; req: OwnerRequest }
  | { route: "schedule-commit"; req: OwnerRequest & { scheduleLength: bigint; lampPerEpoch: bigint } }
  | { route: "schedule-fire"; req: OwnerRequest & { scheduleId: string } }
  | { route: "consume"; req: OwnerRequest & { opType: number; opCount: bigint; engageRef?: OutRefLike } }
  | { route: "open-thread"; req: OpenThreadRequest }
  | { route: "bind-did"; req: BindDidRequest }
  | { route: "create-vault"; req: CreateVaultRequest };

export type BuildResult =
  | { route: "open-thread"; out: OpenThreadResponse }
  | { route: "bind-did"; out: BindDidResponse }
  | { route: "create-vault"; out: CreateVaultResponse }
  | { route: "instant-gen" | "schedule-commit" | "schedule-fire" | "consume"; out: BuildResponse };

/** Đọc thân bài của một đường dựng. Sai ⟹ 400 có mã, như đường dựng trả. */
export function parseBuildRequest(route: IssuedRoute, body: Record<string, unknown>): ParsedBuild {
  switch (route) {
    case "instant-gen":
      return { route, req: ownerReq(body) };
    case "schedule-commit":
      return {
        route,
        req: {
          ...ownerReq(body),
          scheduleLength: reqBigint(body, "schedule_length"),
          lampPerEpoch: reqBigint(body, "lamp_per_epoch"),
        },
      };
    case "schedule-fire":
      return { route, req: { ...ownerReq(body), scheduleId: reqHex(body, "schedule_id") } };
    case "consume":
      return {
        route,
        req: {
          ...ownerReq(body),
          opType: reqSmallInt(body, "op_type"),
          opCount: reqBigint(body, "op_count"),
          engageRef: parseEngageRef(body.engage_ref),
        },
      };
    case "open-thread":
      return { route, req: { ...ownerReq(body), fundingRequested: body.funding !== undefined } };
    case "bind-did":
      return {
        route,
        req: {
          ...ownerReq(body),
          didCommit: parseDidCommit(body.did_commit),
          engageRef: parseEngageRef(body.engage_ref),
        },
      };
    case "create-vault": {
      const kind = body.kind;
      if (kind !== "instant" && kind !== "schedule") {
        throw new BadRequestError(`"kind" phải là "instant" hoặc "schedule".`);
      }
      const profile = body.profile;
      if (profile !== undefined && profile !== "Ember" && profile !== "Flame" && profile !== "Lantern") {
        throw new BadRequestError(`"profile" phải là "Ember" | "Flame" | "Lantern" (bỏ trống = "Flame").`);
      }
      // `change_address` và `funding` loại trừ nhau — tầng dịch vụ quyết (400 có mã), không
      // phải ở đây, để lời gọi thẳng vào dịch vụ cũng bị kiểm.
      return {
        route,
        req: {
          ...ownerReq(body),
          kind,
          lampAmount: reqBigint(body, "lamp_amount"),
          profile: profile as Profile | undefined,
          funding: parseFunding(body),
        },
      };
    }
  }
}

/** Gọi đúng đường dựng của dịch vụ. `quote` có mặt ⟹ chế độ báo giá (`service.ts` ▸ `QuoteMode`). */
export async function runBuild(service: VaultTxService, p: ParsedBuild, quote?: QuoteMode): Promise<BuildResult> {
  switch (p.route) {
    case "instant-gen": return { route: p.route, out: await service.instantGen(p.req, quote) };
    case "schedule-commit": return { route: p.route, out: await service.scheduleCommit(p.req, quote) };
    case "schedule-fire": return { route: p.route, out: await service.scheduleFire(p.req, quote) };
    case "consume": return { route: p.route, out: await service.consume(p.req, quote) };
    case "open-thread": return { route: p.route, out: await service.openThread(p.req, quote) };
    case "bind-did": return { route: p.route, out: await service.bindDid(p.req, quote) };
    case "create-vault": return { route: p.route, out: await service.createVault(p.req, quote) };
  }
}

/** Thân bài trả về của một đường dựng. */
export function buildResultBody(r: BuildResult): Record<string, unknown> {
  switch (r.route) {
    case "open-thread": return toOpenThreadBody(r.out);
    case "bind-did": return toBindDidBody(r.out);
    case "create-vault": return toCreateVaultBody(r.out);
    default: return toBuildBody(r.out);
  }
}

// ── trường chung ───────────────────────────────────────────────────────────────

/** Chủ + nhân chứng + địa chỉ đổi tiền thừa (tuỳ chọn) — phần chung của mọi đường có chủ. */
function ownerReq(body: Record<string, unknown>): OwnerRequest {
  const changeAddress = body.change_address;
  if (changeAddress !== undefined && (typeof changeAddress !== "string" || changeAddress === "")) {
    throw new BadRequestError(`"change_address" phải là chuỗi địa chỉ bech32 khác rỗng.`);
  }
  return {
    owner: parseOwnerFields(body),
    ownerWitness: parseOwnerWitness(body),
    changeAddress: changeAddress as string | undefined,
    feePayer: parseFeePayer(body),
  };
}

export function reqString(body: Record<string, unknown>, name: string): string {
  const v = body[name];
  if (typeof v !== "string" || v === "") throw new BadRequestError(`Thiếu trường "${name}" (chuỗi khác rỗng).`);
  return v;
}

function reqHex(body: Record<string, unknown>, name: string): string {
  const v = reqString(body, name);
  if (!/^[0-9a-f]+$/.test(v) || v.length % 2 !== 0) {
    throw new BadRequestError(`"${name}" phải là hex thường, số ký tự CHẴN.`);
  }
  return v;
}

/**
 * Số nguyên lớn, BẮT BUỘC gửi dưới dạng CHUỖI thập phân.
 *
 * Số JSON bị từ chối có chủ đích: xem khối đầu tệp. Thông báo lỗi nói lý do, vì người
 * gặp nó sẽ nghĩ dịch vụ đang khó tính vô cớ.
 */
function reqBigint(body: Record<string, unknown>, name: string): bigint {
  const v = body[name];
  if (typeof v === "number") {
    throw new BadRequestError(
      `"${name}" phải là CHUỖI chữ số, không phải số JSON. Số JSON là số dấu-phẩy-động: ` +
      `một giá trị oildrop có thật vượt được 2^53 và lúc vượt thì nó không lỗi, nó làm tròn.`,
      { received_type: "number" },
    );
  }
  if (typeof v !== "string" || !/^\d+$/.test(v)) {
    throw new BadRequestError(`"${name}" phải là chuỗi chữ số thập phân không âm.`);
  }
  const n = BigInt(v);
  if (n <= 0n) throw new BadRequestError(`"${name}" phải > 0.`);
  return n;
}

/** Nhãn nhỏ (ví dụ `op_type`): số nguyên JSON là đúng kiểu ở đây. */
function reqSmallInt(body: Record<string, unknown>, name: string): number {
  const v = body[name];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 1_000_000) {
    throw new BadRequestError(`"${name}" phải là số nguyên trong [0, 1000000].`);
  }
  return v;
}
