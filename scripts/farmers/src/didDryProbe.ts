// scripts/farmers/src/didDryProbe.ts — dựng THỬ một tx đúc DID mô phỏng mà KHÔNG cần khoá
// và KHÔNG gửi gì: hạt giống sinh tại chỗ (vứt đi sau lượt chạy), ví được "cấp vốn" bằng một
// UTxO GIẢ chỉ tồn tại trong bộ nhớ, mọi thứ còn lại (ref-script taad, shard-thread, tham số
// giao thức) đọc thật từ Preprod qua Koios công khai. Validator chạy cục bộ bằng
// `aiken tx simulate` (chain.ts ▸ withAikenEvaluator) — KHÔNG bằng bộ UPLC gói trong lucid,
// vì bộ đó định giá sai nhánh `RegisterName` (xem chú thích ở withAikenEvaluator).
//
// Dùng:  npx tsx src/didDryProbe.ts --taad-policy <56 hex> --taad-ref <txhash#ix> [--mutate] [--work-dir <thư mục>]
//
// Kết quả hợp lệ duy nhất cho "dựng được": validator chạy qua. `--mutate` lật một bit của
// rand_256 trong redeemer — lượt đó PHẢI chết ở validator; chết ở chỗ khác là phép đo hỏng.

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CML, Lucid, generateSeedPhrase, walletFromSeed, getAddressDetails, type UTxO } from "@lucid-evolution/lucid";

import { DID_SIM_LABEL, buildDidMintTx, SHARD_PREFIX_HEX } from "./did.ts";
import { chainAccess, classifyBuildError, refScriptUtxo, withAikenEvaluator } from "./chain.ts";
import { Rng } from "./rng.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function pkh(address: string): string {
  const c = getAddressDetails(address).paymentCredential;
  if (!c) throw new Error("không có payment credential");
  return c.hash;
}

async function main(): Promise<void> {
  const policy = arg("--taad-policy");
  const ref = arg("--taad-ref");
  const mutate = process.argv.includes("--mutate");
  if (!policy || !/^[0-9a-f]{56}$/.test(policy)) throw new Error("--taad-policy <56 hex> bắt buộc");
  if (!ref || !/^[0-9a-f]{64}#[0-9]+$/.test(ref)) throw new Error("--taad-ref <txhash#ix> bắt buộc");

  const network = "Preprod" as const;
  // Cố ý KHÔNG truyền môi trường: lượt thử này luôn đi Koios công khai, không cần khoá nào.
  const access = chainAccess(network, {});
  const pp = await access.provider.getProtocolParameters();
  console.log(`trần ExUnit mạng: mem ${pp.maxTxExMem} · steps ${pp.maxTxExSteps}`);

  const wd = arg("--work-dir");
  if (wd) mkdirSync(wd, { recursive: true });
  const workDir = wd ?? mkdtempSync(join(tmpdir(), "farmer-probe-"));

  // Ví dùng một lần — hạt giống sinh tại chỗ, không in, không ghi.
  const controller = walletFromSeed(generateSeedPhrase(), { network, addressType: "Base", accountIndex: 0 });
  const device = walletFromSeed(generateSeedPhrase(), { network, addressType: "Base", accountIndex: 0 });
  const guardians = [0, 1, 2].map(() => pkh(walletFromSeed(generateSeedPhrase(), { network, addressType: "Base", accountIndex: 0 }).address));
  const rng = new Rng(`probe:${Date.now()}`);
  // UTxO GIẢ: chỉ tồn tại trong bộ nhớ. Bộ đánh giá aiken phải giải được nó ⟹ đưa qua
  // `knownUtxos`, vì lucid không chuyển input ví cho `evaluateTx`.
  const fakeFunding: UTxO = {
    txHash: rng.hex(32),
    outputIndex: 0,
    address: controller.address,
    assets: { lovelace: 500_000_000n },
    datumHash: null,
    datum: null,
    scriptRef: null,
  };
  const provider = withAikenEvaluator(access.provider, network, { workDir, knownUtxos: () => [fakeFunding] });
  const lucid = await Lucid(provider, network);
  lucid.selectWallet.fromAddress(controller.address, [fakeFunding]);

  const taadRef = await refScriptUtxo(access, lucid, ref, policy);
  console.log(`ref-script: ${ref} · hash script khớp policy ${policy.slice(0, 8)}…`);

  const names = await access.policyAssetNames(policy);
  const anchors = names.filter((n) => !n.startsWith(SHARD_PREFIX_HEX));
  console.log(`tài sản dưới policy: ${names.length} (shard/cursor ${names.length - anchors.length} · anchor ${anchors.length})`);

  const validToMs = Math.floor((Date.now() + 20 * 60_000) / 1000) * 1000;
  try {
    const built = await buildDidMintTx({
      lucid,
      network,
      taadPolicyId: policy,
      taadRefUtxo: taadRef,
      controllerPkh: pkh(controller.address),
      devicePkh: pkh(device.address),
      guardians,
      rand256: rng.hex(32),
      existingAnchorNames: anchors,
      validToMs,
      metadataMsg: [DID_SIM_LABEL, "farmer:probe", "dry-probe; not submitted"],
      mutateRand: mutate,
      localEval: false,
    });
    console.log(`DỰNG ĐƯỢC · validator QUA (aiken tx simulate)`);
    console.log(`  did        ${built.did}`);
    console.log(`  anchor     ${built.anchorName}`);
    console.log(`  shard      ${built.shard} · siblings ${built.proof.siblings.length} · new_root ${built.proof.newRoot.slice(0, 16)}…`);
    console.log(`  genesis_ms ${built.genesisMs}`);
    console.log(`  fee        ${built.fee} lovelace · size ${built.sizeBytes} byte`);
    const rs = CML.Transaction.from_cbor_hex(built.txCbor).witness_set().redeemers();
    const legacy = rs?.as_arr_legacy_redeemer();
    const mapped = rs?.as_map_redeemer_key_to_redeemer_val();
    if (legacy) {
      for (let i = 0; i < legacy.len(); i++) {
        const r = legacy.get(i);
        console.log(`  redeemer tag=${r.tag()} index=${r.index()} mem=${r.ex_units().mem()} steps=${r.ex_units().steps()}`);
      }
    } else if (mapped) {
      const keys = mapped.keys();
      for (let i = 0; i < keys.len(); i++) {
        const k = keys.get(i);
        const v = mapped.get(k)!;
        console.log(`  redeemer tag=${k.tag()} index=${k.index()} mem=${v.ex_units().mem()} steps=${v.ex_units().steps()}`);
      }
    }
    console.log(`  (KHÔNG ký, KHÔNG gửi)`);
    console.log("  ExUnit trên là số của aiken (mô hình chi phí mặc định) cộng biên — bằng chứng về LOGIC, không phải về trần mạng");
    if (mutate) {
      console.error("✗ lượt ĐỘT BIẾN lại qua validator — phép đo không phân biệt được hai cực");
      process.exit(3);
    }
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    const cls = classifyBuildError(msg);
    console.log(`KHÔNG DỰNG ĐƯỢC · lớp lỗi: ${cls}`);
    console.log(msg.slice(0, 1500));
    if (mutate && cls === "script") {
      console.log("✓ lượt ĐỘT BIẾN bị validator từ chối, đúng kỳ vọng");
      return;
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
