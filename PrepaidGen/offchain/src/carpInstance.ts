// src/carpInstance.ts — SOFT-PIN cặp định danh CARP với instance công khai của nhà
// CarpetMint.
//
// `constants.ts` ▸ `carpAssetClass(network)` giữ cặp MẶC ĐỊNH (bản chép có nhãn: URL +
// ngày đo). Bộ deploy KHÔNG tin bản chép đó một mình: trước khi biên dịch apply-param
// nó đọc instance công khai và đối chiếu — lệch ⟹ NÉM. Lý do: `carp_policy_id` /
// `carp_asset_name` là apply-param lúc biên dịch, nên ghim nhầm một đời CARP đã bị
// thay là dựng ra một quỹ không bao giờ nhìn thấy CARP thật, và `quantity_of` trên
// policy cũ trả 0 một cách bình thản (đã xảy ra ở đời 5 → 6, 2026-10-04).
//
// Hàm đọc mạng (`fetchCarpInstance`) tách khỏi hàm thuần (`parseCarpInstance`,
// `assertCarpMatchesInstance`) để bài kiểm chạy không cần mạng.

import type { CarpNetwork } from "./constants.js";

/** Host theo mạng: `api.` chỉ cho mainnet, mỗi mạng thử có host riêng (quy ước 2026-10-10). */
const CARP_HOST: Record<CarpNetwork, string> = {
  Mainnet: "api.magiclamp.eco",
  Preprod: "preprod.magiclamp.eco",
  Preview: "preview.magiclamp.eco",
};

/** Điểm cuối CHỈ ĐỌC của nhà CARP. Instance trả về do họ sinh, không sửa tay.
 *  `/carp/v1/instance/<mạng>` trả ĐỜI HIỆN HÀNH của CARP trên mạng đó (Preprod: đời 7, đo 200
 *  ngày 2026-10-10). Đời cũ còn CDP thì giữ một đường riêng (đời 6:
 *  `api.magiclamp.eco/carpetmint/v1/instance/Preprod`), nên đường này không đổi đời tại chỗ.
 *  Cặp trong `constants.ts` lệch đời hiện hành ⟹ bộ deploy NÉM vì lệch — đúng chiều an toàn. */
export const CARP_INSTANCE_URL = (network: CarpNetwork): string =>
  `https://${CARP_HOST[network]}/carp/v1/instance/${network}`;

const HEX28 = /^[0-9a-f]{56}$/;

export interface CarpInstanceView {
  network: CarpNetwork;
  /** Vai CARP trong instance CarpetMint là `anchor`. */
  policyId: string;
  assetName: string;
  label: string | null;
  deployedAt: string | null;
  /** Băm nội dung do điểm cuối khai — mang theo để ghi log, KHÔNG được kiểm ở đây. */
  sha256: string | null;
}

function fail(message: string): never {
  throw new Error(`PrepaidGen/carpInstance: ${message}`);
}

/** Đọc phản hồi instance; hình dạng lạ ⟹ NÉM (không đệm giá trị nào). */
export function parseCarpInstance(body: unknown, network: CarpNetwork): CarpInstanceView {
  if (typeof body !== "object" || body === null) fail("phản hồi không phải đối tượng JSON");
  const b = body as Record<string, unknown>;
  const inst = b.instance as Record<string, unknown> | undefined;
  if (typeof inst !== "object" || inst === null) fail("thiếu trường `instance`");
  if (b.network !== network || inst.net !== network) {
    fail(`instance của mạng ${String(b.network)}/${String(inst.net)}, cần ${network}`);
  }
  const a = inst.anchor as Record<string, unknown> | undefined;
  if (typeof a !== "object" || a === null) fail("thiếu `instance.anchor` (vai CARP)");
  const policyId = a.policyId;
  const assetName = a.name;
  if (typeof policyId !== "string" || !HEX28.test(policyId)) fail(`anchor.policyId sai hình dạng: ${String(policyId)}`);
  if (typeof assetName !== "string" || !HEX28.test(assetName)) fail(`anchor.name sai hình dạng: ${String(assetName)}`);
  if (a.unit !== policyId + assetName) fail("anchor.unit ≠ anchor.policyId ‖ anchor.name — instance tự mâu thuẫn");
  return {
    network,
    policyId,
    assetName,
    label: typeof a.label === "string" ? a.label : null,
    deployedAt: typeof inst.deployedAt === "string" ? inst.deployedAt : null,
    sha256: typeof b.sha256 === "string" ? b.sha256 : null,
  };
}

/** Cặp đang định dùng (mặc định hoặc đè bằng biến môi trường) phải trùng instance. */
export function assertCarpMatchesInstance(
  expected: { policyId: string; assetName: string },
  inst: CarpInstanceView,
): void {
  if (expected.policyId !== inst.policyId || expected.assetName !== inst.assetName) {
    fail(
      `cặp CARP lệch instance ${inst.network} của nhà CarpetMint (${CARP_INSTANCE_URL(inst.network)}, ` +
        `deployedAt ${inst.deployedAt ?? "?"}):\n` +
        `  đang dùng: ${expected.policyId} / ${expected.assetName}\n` +
        `  instance : ${inst.policyId} / ${inst.assetName}\n` +
        `Đời CARP đã đổi hoặc biến môi trường đè sai. KHÔNG biên dịch apply-param với cặp lệch.`,
    );
  }
}

/** Đọc instance qua mạng (chỉ GET). Mã HTTP khác 200 hoặc JSON hỏng ⟹ NÉM. */
export async function fetchCarpInstance(
  network: CarpNetwork,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<CarpInstanceView> {
  const url = CARP_INSTANCE_URL(network);
  const res = await fetchImpl(url);
  if (!res.ok) fail(`GET ${url} trả HTTP ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    fail(`GET ${url}: thân phản hồi không phải JSON (${(e as Error).message})`);
  }
  return parseCarpInstance(body, network);
}
