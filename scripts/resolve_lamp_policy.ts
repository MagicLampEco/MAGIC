// scripts/resolve_lamp_policy.ts — CHỈ ĐỌC. Suy policy id của tLAMP/LAMP từ ví deploy
// rồi HỎI CHUỖI xem tài sản đó đã tồn tại chưa. Không dựng tx, không ghi gì lên chuỗi.
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
// Chạy: NETWORK=Preprod BLOCKFROST_KEY=… WALLET_SEED=… npx tsx resolve_lamp_policy.ts
// stdout (để wrapper `eval`/đọc):  LAMP_POLICY_ID=…  và  LAMP_ONCHAIN_SUPPLY=…
// stderr: chẩn đoán cho người đọc. Mã thoát 0 dù tài sản đã có hay chưa — người gọi
// tự quyết theo LAMP_ONCHAIN_SUPPLY. Thoát khác 0 chỉ khi KHÔNG dò được.

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

  console.log(`LAMP_POLICY_ID=${policyId}`);
  console.log(`LAMP_ONCHAIN_SUPPLY=${supply}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
