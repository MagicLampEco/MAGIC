// scripts/resolve_lamp_policy.ts — CHỈ ĐỌC, và là công cụ CHẨN ĐOÁN, không phải nguồn
// cấu hình. Suy policy chữ-ký-đơn từ khoá ví deploy rồi hỏi chuỗi xem token diễn tập
// dưới policy đó còn bao nhiêu. Không dựng tx, không ghi gì lên chuỗi.
//
// ── VÌ SAO TỆP NÀY TỒN TẠI ──────────────────────────────────────────────────
// `deploy/01_mint_lamp.ts` đúc bằng native script `{type:"sig", keyHash:<pkh ví>}`.
// Policy id của nó suy TẤT ĐỊNH từ khoá ví: cùng ví ⟹ cùng policy id, ở mọi mạng,
// ở mọi lần chạy. Cho nên câu "biến LAMP_POLICY_ID đang rỗng" KHÔNG đồng nghĩa với
// "trên chuỗi chưa có LAMP" — nó chỉ nói máy này chưa ghi lại giá trị đó.
//
// Chuỗi E2E trước đây kết luận theo biến môi trường, và ngày 2026-08-28 nó đúc lần
// thứ hai lên đúng tài sản cũ trên Preprod. Đo được ngay sau đó:
//     asset 28e916b0…744c414d50 · quantity = 72000000000000000 · mint_or_burn_count = 2
// tức 72 tỷ tLAMP, VƯỢT TRẦN 36 tỷ. Chú ý cách nói: 36 tỷ là TRẦN, không phải số đã
// đúc — LAMP lazy-mint, tổng lịch sử luôn ≤ trần (`LAMP/Papers/Whitepaper.md:48`), nên
// mainnet lúc đó mới ở mức vài triệu. Không validator nào gãy vì chuyện đó — và đó mới
// là phần đáng ngại: bất biến nổi bật nhất của hệ vỡ trên testnet mà không gì đỏ.
//
// ── 🔴 TỆP NÀY KHÔNG PHẢI NGUỒN CỦA `LAMP_POLICY_ID` ────────────────────────
// Nó suy policy TỪ KHOÁ VÍ, nên thứ nó tìm thấy là token do chính ví này tự đúc:
// chính sách chữ-ký-đơn, KHÔNG trần, KHÔNG `SupplyState` — không phải LAMP. Kho
// LAMP xếp bản Preprod của nó vào nhóm "trông giống LAMP nhưng KHÔNG phải LAMP".
//
// Bản trước, một runner đã dùng tệp này thay cho lệnh đúc và tự mô tả là "hỏi
// chuỗi, chỉ đọc, không đúc". Vế đó đúng. Nhưng nó chặn hành vi ĐÚC mà để nguyên
// hành vi DÙNG NHẦM, và cái sau đi qua êm hơn hẳn vì nó không ghi gì lên chuỗi.
//
// Nên stdout của tệp này CỐ Ý không còn in khoá `LAMP_POLICY_ID=`: không ai ống
// được nó vào biến đó nữa. Vai còn lại của nó là CHẨN ĐOÁN — "ví này có token nhái
// nào không, bao nhiêu" — và đó là vai có ích thật, vì số token nhái đang nằm trên
// Preprod là một dữ kiện cần biết.
//
// Chạy: NETWORK=Preprod BLOCKFROST_KEY=… WALLET_SEED=… npx tsx resolve_lamp_policy.ts
// stdout:  WALLET_DERIVED_LOOKALIKE_POLICY_ID=…  và  LOOKALIKE_ONCHAIN_SUPPLY=…
// stderr: chẩn đoán cho người đọc. Mã thoát 0 dù tài sản đã có hay chưa.

import {
  Lucid, Blockfrost, getAddressDetails, mintingPolicyToId, scriptFromNative,
  type MintingPolicy,
} from "@lucid-evolution/lucid";
import { NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet, ASSET_NAMES } from "./config.js";

/** Cung đang lưu hành của một unit. 404 = chưa từng đúc ⟹ 0, không phải lỗi. */
export async function onchainSupply(unit: string): Promise<bigint> {
  const res = await fetch(`${BLOCKFROST_URL}/assets/${unit}`, {
    headers: { project_id: BLOCKFROST_KEY },
  });
  if (res.status === 404) return 0n;
  if (!res.ok) throw new Error(`Blockfrost ${res.status} khi hỏi asset ${unit}`);
  const body = (await res.json()) as { quantity?: string };
  return BigInt(body.quantity ?? "0");
}

/** Policy id suy từ ví đang chọn — thuần dẫn xuất, không chạm chuỗi. */
export function lampPolicyOfWallet(address: string): string {
  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error("Không lấy được payment credential từ ví");
  const policy: MintingPolicy = scriptFromNative({ type: "sig", keyHash: paymentCredential.hash });
  return mintingPolicyToId(policy);
}

async function main() {
  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const address = await lucid.wallet().address();

  const policyId = lampPolicyOfWallet(address);
  const unit = policyId + ASSET_NAMES.lamp;
  const supply = await onchainSupply(unit);

  console.error(`  mạng          ${NETWORK}`);
  console.error(`  ví deploy     ${address.slice(0, 24)}…${address.slice(-8)}`);
  console.error(`  policy suy ra ${policyId}`);
  console.error(`  asset name    ${ASSET_NAMES.lamp}`);
  console.error(
    supply === 0n
      ? `  cung trên chuỗi 0 — tài sản này CHƯA từng được đúc trên ${NETWORK}.`
      : `  cung trên chuỗi ${supply.toLocaleString("en-US")} oildrop = ` +
        `${(supply / 1_000_000n).toLocaleString("en-US")} LAMP — ĐÃ CÓ, đừng đúc nữa.`,
  );

  // Tên khoá CỐ Ý không phải `LAMP_POLICY_ID` — xem khối đầu tệp.
  console.log(`WALLET_DERIVED_LOOKALIKE_POLICY_ID=${policyId}`);
  console.log(`LOOKALIKE_ONCHAIN_SUPPLY=${supply}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
