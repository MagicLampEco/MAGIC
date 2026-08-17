// scripts/refScripts.ts — bãi đỗ script tham chiếu CIP-33, dùng chung cho mọi bước deploy.
//
// VÌ SAO TÁCH RA: có HAI bước công bố ref-script (06 cho vault+shard, 09 cho
// `consume` — hash của consume chỉ tính được sau khi bước 09 đúc price_nft và
// price_param). Nếu mỗi bước tự dựng địa chỉ bãi đỗ theo cách riêng thì chỉ cần
// một bên đổi cách dẫn xuất là script đỗ ở nơi bên kia không nhìn tới: bước sau
// báo MISSING_SCRIPT trong khi explorer vẫn thấy output. Một nguồn, một nơi giữ.
//
// 🔴 KHÔNG đỗ script ở địa chỉ ví. Bản đầu làm vậy và mất script ngay trong cùng
// đợt chạy: bộ chọn UTxO của ví coi đó là tiền lẻ và tiêu mất. Bãi đỗ là một
// script native `sig` — ví không bao giờ tự chọn UTxO ở đó, mà chủ khoá vẫn thu
// hồi được khi cần.

import {
  credentialToAddress, scriptHashToCredential, validatorToScriptHash,
  scriptFromNative, getAddressDetails,
  type LucidEvolution, type Network, type Script, type UTxO,
} from "@lucid-evolution/lucid";

/** Địa chỉ bãi đỗ của một ví: script native `sig` trên chính payment key của ví. */
export function parkAddressFor(network: Network, walletAddress: string): string {
  const { paymentCredential } = getAddressDetails(walletAddress);
  if (!paymentCredential) throw new Error("Không lấy được payment credential của ví");
  const parkScript = scriptFromNative({ type: "sig", keyHash: paymentCredential.hash });
  return credentialToAddress(
    network,
    scriptHashToCredential(validatorToScriptHash(parkScript)),
  );
}

/**
 * Công bố MỘT script làm ref-script tại bãi đỗ, chạy được nhiều lần.
 *
 * Idempotent: đã thấy UTxO nào ở bãi mang đúng script hash này thì trả về ngay,
 * không tiêu thêm ADA.
 *
 * Mỗi script MỘT tx riêng: hai validator cộng lại đã vượt trần 16.384 byte nếu
 * công bố chung (đo thật: cặp vault+shard ScheduleGen = 16.643 byte).
 *
 * Blockfrost trả danh sách UTxO trễ vài giây sau khi tx trước xác nhận, nên lần
 * dựng đầu hay chọn phải input vừa bị tiêu ("All inputs are spent"). Dựng lại là
 * hết — không phải lỗi logic, nên thử lại thay vì bỏ cuộc.
 *
 * @returns chuỗi `txHash#index` của UTxO mang ref-script.
 */
export async function publishRefScript(args: {
  lucid: LucidEvolution;
  parkAddr: string;
  label: string;
  script: Script;
  hash: string;
  lovelace: bigint;
  parked?: UTxO[];       // danh sách đã lấy sẵn; bỏ trống thì tự truy vấn
  attempts?: number;     // default 5
  retryDelayMs?: number; // default 15_000
}): Promise<string> {
  const {
    lucid, parkAddr, label, script, hash, lovelace,
    attempts = 5, retryDelayMs = 15_000,
  } = args;

  const parked = args.parked ?? (await lucid.utxosAt(parkAddr));
  const already = parked.find(
    (u) => u.scriptRef && validatorToScriptHash(u.scriptRef) === hash,
  );
  if (already) {
    console.log(`✓ ${label} đã có sẵn: ${already.txHash}#${already.outputIndex}`);
    return `${already.txHash}#${already.outputIndex}`;
  }

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const tx = await lucid.newTx()
        .pay.ToAddressWithData(parkAddr, undefined, { lovelace }, script)
        .complete();
      const signed = await tx.sign.withWallet().complete();
      const txHash = await signed.submit();
      await lucid.awaitTx(txHash);
      console.log(`✔ ${label}: ${txHash}#0`);
      return `${txHash}#0`;
    } catch (e) {
      lastErr = e;
      console.log(`  … lần ${attempt} chưa được, dựng lại sau ${retryDelayMs / 1000}s`);
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  throw lastErr;
}

/**
 * Nạp một UTxO ref-script theo `txHash#idx` và CHỨNG MINH nó mang đúng script cần.
 *
 * Vì sao kiểm ở đây: đưa nhầm UTxO ref-script thì tx chết ở phase-1 với
 * "MissingScriptWitness" — thông điệp không nói nhầm cái nào, mà lúc đó đã tốn một
 * vòng dựng tx. Hai ref-script lại đỗ cạnh nhau ở CÙNG một bãi nên đảo hai biến môi
 * trường cho nhau là chuyện rất dễ xảy ra.
 */
export async function fetchRefScriptUtxo(args: {
  lucid: LucidEvolution;
  outRef: string;   // "txHash#idx"
  wantHash: string;
  label: string;    // tên biến env, để thông điệp lỗi chỉ thẳng chỗ sửa
}): Promise<UTxO> {
  const { lucid, outRef, wantHash, label } = args;
  const [h, i] = outRef.split("#");
  if (!h || i === undefined) {
    throw new Error(`${label} sai định dạng (cần txHash#idx): ${outRef}`);
  }
  const [u] = await lucid.utxosByOutRef([{ txHash: h, outputIndex: Number(i) }]);
  if (!u) throw new Error(`${label}=${outRef} không tìm thấy trên chuỗi.`);
  if (!u.scriptRef) throw new Error(`${label}=${outRef} không mang scriptRef.`);
  const gotHash = validatorToScriptHash(u.scriptRef);
  if (gotHash !== wantHash) {
    throw new Error(
      `${label}=${outRef} mang script hash ${gotHash}, cần ${wantHash}. ` +
      `Nhiều khả năng hai biến ref-script bị đảo cho nhau.`,
    );
  }
  return u;
}
