// scripts/keeper/keeper.ts — việc bảo trì hằng ngày trên testnet, chạy lại nhiều lần vẫn an toàn.
// Run: npx tsx keeper/keeper.ts        (thường gọi qua scripts/run_keeper.sh)
//
// Vì sao cần: ba thứ trên chuỗi tự già đi theo ngày UTC, và không validator nào tự làm mới
// chúng — Cardano chỉ chạy validator khi có người gửi tx.
//   1. BackingBeacon — InstantGen đòi `backing_age <= max_backing_stale = 1`.
//   2. Price beacon của mỗi instance `consume` — đòi `current − pp.epoch <= max_price_stale`.
//   3. Lịch ScheduleGen — mỗi epoch được bắn một lần; không ai bắn thì ô đó chờ (bắn bù tối
//      đa MAX_FIRES_PER_TX_CATCHUP), nhưng MAGIC của batch chỉ sống đúng epoch nó sinh ra.
// Bước 4 (tuỳ chọn) cấp một lượt InstantGen mới cho ví keeper, để có số dư thử trong ngày.
//
// MỖI BƯỚC TỰ ĐO TRƯỚC RỒI MỚI GỬI: beacon đã ở epoch hiện tại thì bỏ qua, lịch chưa tới
// hạn thì bỏ qua, ví đã có batch InstantGen trong epoch này thì bỏ qua. Nên hẹn giờ chạy
// mỗi giờ cũng không gửi thừa tx nào.
//
// Price beacon làm mới bằng redeemer `PostPrice` trên `price_param` — TUYỆT ĐỐI không chạy
// lại `deploy/09_deploy_consume.ts`: bước đó đúc price NFT one-shot mới, đổi hash `consume`,
// và mọi thread Engage đang sống thành mồ côi.
//
// Ví keeper chỉ trả phí. Fire ScheduleGen là permissionless (C-SCH-FIRE-PERMISSION) nên
// keeper không giữ quyền gì trên vault. PostPrice thì cần chữ ký committee: ví keeper
// phải nằm trong committee của beacon đó, không thì bước ấy báo và bỏ qua.
//
// ENV (ngoài NETWORK/BLOCKFROST_KEY/WALLET_SEED và các biến chuẩn của state.<net>.sh):
//   KEEPER_PRICE_BEACONS  danh sách `<price_nft_policy>:<price_param_hash>`, phân cách dấu
//                         phẩy. Mỗi cặp là một instance `consume`. Bỏ trống ⟹ bỏ bước 2.
//   KEEPER_STEPS          tập bước chạy, mặc định `backing,price,fire`. Thêm `instant` để cấp.
//   KEEPER_INSTANT_LAMP   lượng LAMP khoá vào vault InstantGen mới ở bước 4 (mặc định 1001).
//   KEEPER_FIRE_OWNERS    pkh chủ vault được bắn, phân cách dấu phẩy. Bỏ trống ⟹ mọi vault.
//   KEEPER_DRY_RUN=1      chỉ đo và in việc sẽ làm, không gửi tx nào.
//
// Mã thoát: 0 = mọi bước xong hoặc không có việc · 1 = có bước hỏng · 2 = có tx đã gửi mà
// chưa đọc lại được kết quả (đừng chạy lại mù, soi explorer trước).

import { spawnSync } from "node:child_process";
import {
  Lucid, Blockfrost, Data, Constr,
  credentialToAddress, scriptHashToCredential, validatorToScriptHash,
  scriptFromNative, getAddressDetails,
  type LucidEvolution, type UTxO,
} from "@lucid-evolution/lucid";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet,
  POLICY_IDS, ASSET_NAMES, PROTOCOL,
} from "../config.js";
import { loadBlueprint, findValidator, appliedScript } from "../applyParams.js";
import { priceParamParams, scheduleVaultParams, shardSpendParams } from "../deployParams.js";
import {
  decodePriceParam, encodePriceParam, type PriceParamT,
} from "../../ConsumeMAGIC/offchain/src/types.js";
import { buildScheduleFireTx } from "../../ScheduleGen/offchain/src/schedule.js";
import { VaultDatum as ScheduleVaultDatum } from "../../ScheduleGen/offchain/src/types.js";
import { countEligibleFires, isExpired, nextFireEpoch } from "../../ScheduleGen/offchain/src/math.js";
import { VaultDatumSchema as InstantVaultDatumSchema } from "../../InstantGen/offchain/src/types.js";

const PRICE_NFT_NAME = "5052494345"; // "PRICE" — ConsumeMAGIC/onchain/validators/price_nft.ak

// Cùng thứ tự trường với scripts/deploy/04_deploy_backing_fixture.ts và
// InstantGen/onchain/lib/magiclamp/protocol/types.ak ▸ BackingBeaconDatum.
const BackingBeaconDatumSchema = Data.Object({
  br_q:               Data.Integer(),
  magic_supply:       Data.Integer(),
  depeg:              Data.Boolean(),
  last_updated_epoch: Data.Integer(),
});

const DRY = process.env.KEEPER_DRY_RUN === "1";
const STEPS = new Set((process.env.KEEPER_STEPS ?? "backing,price,fire").split(",").map((s) => s.trim()));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Outcome = "done" | "skip" | "fail" | "unverified";
const report: { step: string; outcome: Outcome; note: string }[] = [];
const record = (step: string, outcome: Outcome, note: string) => {
  report.push({ step, outcome, note });
  const mark = { done: "✔", skip: "·", fail: "✗", unverified: "?" }[outcome];
  console.log(`${mark} [${step}] ${note}`);
};

async function tipMs(): Promise<bigint> {
  const res = await fetch(`${BLOCKFROST_URL}/blocks/latest`, { headers: { project_id: BLOCKFROST_KEY } });
  if (!res.ok) throw new Error(`Blockfrost /blocks/latest trả ${res.status}`);
  const tip = await res.json() as { time?: number };
  if (typeof tip.time !== "number") throw new Error("Blockfrost /blocks/latest không có trường time");
  return BigInt(tip.time) * 1000n;
}

// Chạy một kịch bản sẵn có, trả stdout để đọc tx hash. Kế thừa môi trường của tiến trình này.
function runScript(file: string, extraEnv: Record<string, string>): { code: number; out: string } {
  const r = spawnSync("npx", ["tsx", file], {
    env: { ...process.env, ...extraEnv }, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  process.stdout.write(out.split("\n").map((l) => `    │ ${l}`).join("\n") + "\n");
  return { code: r.status ?? 1, out };
}

// ── 1. BackingBeacon ──────────────────────────────────────────────────────────
async function stepBacking(lucid: LucidEvolution, ownerPkh: string, epoch: bigint) {
  // Địa chỉ + policy suy từ ví, đúng như bước 04 dựng. Ví keeper khác ví dựng beacon thì
  // suy ra địa chỉ khác và thấy rỗng — báo rõ thay vì dựng một beacon thứ hai.
  const nftScript    = scriptFromNative({ type: "sig", keyHash: ownerPkh });
  const beaconScript = scriptFromNative({ type: "all", scripts: [{ type: "sig", keyHash: ownerPkh }] });
  const nftPolicy    = validatorToScriptHash(nftScript);
  const beaconAddr   = credentialToAddress(NETWORK, scriptHashToCredential(validatorToScriptHash(beaconScript)));
  const expected     = process.env.BACKING_NFT_POLICY_ID;
  if (expected && expected !== nftPolicy) {
    return record("backing", "fail",
      `ví này suy ra policy ${nftPolicy.slice(0, 8)}… nhưng BACKING_NFT_POLICY_ID=${expected.slice(0, 8)}… — sai ví, không gửi gì`);
  }
  const unit = nftPolicy + ASSET_NAMES.backing;
  const beacons = (await lucid.utxosAt(beaconAddr)).filter((u) => (u.assets[unit] ?? 0n) > 0n);
  if (beacons.length !== 1) {
    return record("backing", "fail", `thấy ${beacons.length} beacon ở ${beaconAddr} (cần đúng 1) — không gửi gì`);
  }
  const d = Data.from(beacons[0]!.datum!, BackingBeaconDatumSchema as never) as {
    br_q: bigint; magic_supply: bigint; last_updated_epoch: bigint;
  };
  if (d.last_updated_epoch >= epoch) {
    return record("backing", "skip", `đã ở epoch ${d.last_updated_epoch}`);
  }
  if (DRY) return record("backing", "skip", `DRY: sẽ làm mới ${d.last_updated_epoch} → ${epoch}`);
  // Giữ nguyên br_q và magic_supply đang có — keeper chỉ đẩy epoch, không đổi con số.
  const r = runScript("deploy/04_deploy_backing_fixture.ts", {
    BACKING_BR_Q: d.br_q.toString(), BACKING_MAGIC_SUPPLY: d.magic_supply.toString(),
  });
  const tx = r.out.match(/BACKING_BEACON_TX=([0-9a-f]{64})/)?.[1];
  if (r.code !== 0 || !tx) return record("backing", "fail", `bước 04 thoát ${r.code}, không đọc được tx`);
  record("backing", "done", `epoch ${d.last_updated_epoch} → ${epoch} · tx ${tx}`);
}

// ── 2. PostPrice ──────────────────────────────────────────────────────────────
async function stepPrice(lucid: LucidEvolution, ownerPkh: string, nowMs: bigint) {
  const pairs = (process.env.KEEPER_PRICE_BEACONS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (pairs.length === 0) return record("price", "skip", "KEEPER_PRICE_BEACONS trống");

  const mspe  = PROTOCOL.MS_PER_EPOCH;
  const epoch = nowMs / mspe;
  // Cửa sổ hiệu lực phải nằm TRỌN trong một epoch (`util.get_epoch`), và `out.epoch` không
  // được vượt epoch đó. Sát nửa đêm UTC thì slot làm tròn có thể đẩy biên trên sang ngày
  // sau ⟹ tx bị từ chối. Để lượt chạy sau lo.
  const epochEnd = (epoch + 1n) * mspe;
  if (epochEnd - nowMs < 15n * 60_000n) {
    return record("price", "skip", "còn < 15 phút tới nửa đêm UTC — để lượt sau");
  }
  const lowerMs = nowMs - 60_000n > epoch * mspe ? nowMs - 60_000n : epoch * mspe;
  const upperMs = nowMs + 10n * 60_000n;

  const blueprint   = await loadBlueprint("ConsumeMAGIC");
  const priceParamV = findValidator(blueprint, "price_param.price_param.spend");
  const committee   = (process.env.PRICE_COMMITTEE ?? ownerPkh).split(",").map((s) => s.trim()).filter(Boolean);
  const threshold   = BigInt(process.env.PRICE_THRESHOLD ?? "1");

  for (const pair of pairs) {
    const [policy, expectedHash] = pair.split(":");
    const tag = `price ${policy?.slice(0, 8)}…`;
    if (!policy || !expectedHash) { record(tag, "fail", `cặp sai dạng: "${pair}"`); continue; }

    // Dựng lại script từ tham số rồi ĐỐI CHIẾU hash. Lệch ⟹ committee/threshold khác lúc
    // deploy, tức ví này không ký được beacon đó. Dừng ở đây, đừng gửi một tx chắc chắn trượt.
    const { script, hash } = appliedScript(priceParamV, priceParamParams({
      committee, threshold, priceNftPolicy: policy, priceNftName: PRICE_NFT_NAME, msPerEpoch: mspe,
    }));
    if (hash !== expectedHash) {
      record(tag, "fail", `dựng lại ra ${hash.slice(0, 8)}… ≠ ${expectedHash.slice(0, 8)}… — committee/threshold khác lúc deploy, không gửi gì`);
      continue;
    }
    if (!committee.includes(ownerPkh)) {
      record(tag, "fail", "ví keeper không nằm trong committee — không gửi gì"); continue;
    }
    const addr = credentialToAddress(NETWORK, scriptHashToCredential(hash));
    const unit = policy + PRICE_NFT_NAME;
    const found = (await lucid.utxosAt(addr)).filter((u) => (u.assets[unit] ?? 0n) === 1n);
    if (found.length !== 1) { record(tag, "fail", `thấy ${found.length} beacon (cần đúng 1)`); continue; }
    const beacon = found[0]!;
    const pp = decodePriceParam(beacon.datum!);
    if (pp.epoch >= epoch) { record(tag, "skip", `đã ở epoch ${pp.epoch}`); continue; }
    if (DRY) { record(tag, "skip", `DRY: sẽ PostPrice ${pp.epoch} → ${epoch}`); continue; }

    // Chỉ đẩy epoch. Bảng giá, demand_mult, m_min, m_max giữ nguyên; value giữ nguyên
    // (validator đòi non-ADA y hệt và lovelace không giảm).
    const next: PriceParamT = { ...pp, epoch };
    try {
      const tx = await lucid.newTx()
        .collectFrom([beacon], Data.to(new Constr(0, [])) /* PostPrice = constr 0 (price_param.ak ▸ PriceParamRedeemer) */)
        .attach.SpendingValidator(script)
        .pay.ToContract(addr, { kind: "inline", value: encodePriceParam(next) }, beacon.assets)
        .addSignerKey(ownerPkh)
        .validFrom(Number(lowerMs))
        .validTo(Number(upperMs))
        .complete();
      const signed = await tx.sign.withWallet().complete();
      const txHash = await signed.submit();
      await lucid.awaitTx(txHash);
      record(tag, "done", `epoch ${pp.epoch} → ${epoch} · tx ${txHash} · beacon mới ${txHash}#0`);
    } catch (e) {
      record(tag, "fail", String((e as Error)?.message ?? e).slice(0, 400));
    }
  }
}

// ── 3. Fire ScheduleGen ───────────────────────────────────────────────────────
async function stepFire(lucid: LucidEvolution, nowMs: bigint) {
  const epoch = nowMs / PROTOCOL.MS_PER_EPOCH;
  const blueprint = await loadBlueprint("ScheduleGen");
  const { script: vaultScript, hash: vaultHash } = appliedScript(
    findValidator(blueprint, "vault.vault.spend"),
    scheduleVaultParams({
      lampPolicyId: POLICY_IDS.lamp, lampAssetName: ASSET_NAMES.lamp,
      shardPolicyId: POLICY_IDS.shard_nft, msPerEpoch: PROTOCOL.MS_PER_EPOCH,
    }),
  );
  const expected = process.env.VAULT_SCHEDULE_HASH;
  if (expected && expected !== vaultHash) {
    return record("fire", "fail", `dựng lại vault ra ${vaultHash.slice(0, 8)}… ≠ VAULT_SCHEDULE_HASH ${expected.slice(0, 8)}… — không gửi gì`);
  }
  const { script: shardScript, hash: shardHash } = appliedScript(
    findValidator(blueprint, "vault.shard.spend"),
    shardSpendParams({ shardPolicyId: POLICY_IDS.shard_nft, vaultScriptHash: vaultHash }),
  );
  const vaultAddr = credentialToAddress(NETWORK, scriptHashToCredential(vaultHash));
  const shardAddr = credentialToAddress(NETWORK, scriptHashToCredential(shardHash));
  const owners = (process.env.KEEPER_FIRE_OWNERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const refs = [process.env.REF_VAULT_SCHEDULE_UTXO, process.env.REF_SHARD_UTXO]
    .filter((s): s is string => !!s)
    .map((s) => { const [h, i] = s.split("#"); return { txHash: h!, outputIndex: Number(i) }; });
  if (refs.length !== 2) return record("fire", "fail", "thiếu REF_VAULT_SCHEDULE_UTXO / REF_SHARD_UTXO (tx vượt trần nếu đính kèm)");
  const refUtxos = await lucid.utxosByOutRef(refs);

  const vaultIdPrefix = vaultHash; // NFT danh-tính vault: policy = chính vault hash
  const decode = (u: UTxO) => {
    if (!u.datum) return undefined;
    if (!Object.keys(u.assets).some((k) => k.startsWith(vaultIdPrefix))) return undefined;
    try { return Data.from(u.datum, ScheduleVaultDatum); } catch { return undefined; }
  };

  // Liệt kê việc TRƯỚC, rồi mới bắn. Mỗi lần bắn đổi UTxO vault ⟹ đọc lại vault theo NFT.
  const due: { unit: string; scheduleId: string; fires: number }[] = [];
  const atAddr = await lucid.utxosAt(vaultAddr);
  let vaults = 0, schedules = 0, unreadable = 0;
  let nextDue: bigint | undefined;
  for (const u of atAddr) {
    const vd = decode(u);
    if (!vd) { unreadable++; continue; }
    if (owners.length > 0 && !owners.includes(vd.owner)) continue;
    vaults++;
    const unit = Object.keys(u.assets).find((k) => k.startsWith(vaultIdPrefix))!;
    const live = vd.magic_batches.filter((b) => !isExpired(b.created_epoch, b.decay_window, epoch)).length;
    for (const s of vd.gen_schedules) {
      if (s.fired_count >= s.schedule_length) continue;
      schedules++;
      const fires = countEligibleFires(s.start_fire_epoch, s.fired_count, s.schedule_length, epoch, live);
      if (fires > 0) due.push({ unit, scheduleId: s.schedule_id, fires });
      else {
        const n = nextFireEpoch(s.start_fire_epoch, s.fired_count);
        if (nextDue === undefined || n < nextDue) nextDue = n;
      }
    }
  }
  // In phạm vi đã quét: "không lịch nào tới hạn" trên 0 vault đọc được là KHÔNG ĐO ĐƯỢC,
  // không phải "không có việc" — thường là hash vault lệch hoặc schema datum đổi.
  const scope = `${atAddr.length} UTxO · ${vaults} vault đọc được · ${unreadable} bỏ qua (không NFT/không decode) · ${schedules} lịch còn ô`;
  if (vaults === 0) return record("fire", "fail", `không đọc được vault nào ở ${vaultAddr} (${scope})`);
  if (due.length === 0) {
    return record("fire", "skip", `không lịch nào tới hạn ở epoch ${epoch}; sớm nhất ${nextDue ?? "—"} (${scope})`);
  }

  for (const job of due) {
    const tag = `fire ${job.scheduleId.slice(0, 8)}…`;
    if (DRY) { record(tag, "skip", `DRY: sẽ bắn ${job.fires} lượt`); continue; }
    try {
      const vaultUtxo = (await lucid.utxosAt(vaultAddr)).find((u) => (u.assets[job.unit] ?? 0n) === 1n);
      if (!vaultUtxo) { record(tag, "fail", "không đọc lại được vault theo NFT"); continue; }
      const idsBefore = new Set(Data.from(vaultUtxo.datum!, ScheduleVaultDatum).magic_batches.map((b) => b.batch_id));
      const shardUtxos = (await lucid.utxosAt(shardAddr)).filter((u) =>
        Object.keys(u.assets).some((k) => k.startsWith(POLICY_IDS.shard_nft) && u.assets[k]! > 0n));
      const result = await buildScheduleFireTx({
        refScriptUtxos: refUtxos, lucid, vaultUtxo, shardUtxos, scheduleId: job.scheduleId,
        vaultScript, shardScript, lampPolicyId: POLICY_IDS.lamp, lampAssetName: ASSET_NAMES.lamp,
        network: NETWORK, tipPosixMs: await tipMs(),
      });
      const signed = await result.tx.sign.withWallet().complete();
      const txHash = await signed.submit();
      await lucid.awaitTx(txHash);
      // Đo bằng batch MỚI SINH, không bằng tổng: fire dọn batch chết trong cùng tx
      // (xem scripts/test/schedule_fire_only.ts, khối "ĐO BẰNG BATCH MỚI").
      let measured = false;
      for (let i = 0; i < 6 && !measured; i++) {
        const after = (await lucid.utxosAt(vaultAddr)).find((u) => u.txHash === txHash && u.datum);
        if (after) {
          const fresh = Data.from(after.datum!, ScheduleVaultDatum).magic_batches.filter((b) => !idsBefore.has(b.batch_id));
          const amount = fresh.reduce((s, b) => s + b.current_amount, 0n);
          if (fresh.length === 0 || amount === 0n) {
            record(tag, "fail", `tx ${txHash} vào khối nhưng không có batch mới`);
          } else {
            record(tag, "done", `+${amount} nanogic (${fresh.length} batch) · tx ${txHash} · vault ${txHash}#${after.outputIndex}`);
          }
          measured = true;
        } else {
          await sleep(20_000);
        }
      }
      if (!measured) record(tag, "unverified", `tx ${txHash} đã vào khối, chưa đọc lại được vault — soi explorer trước khi chạy lại`);
    } catch (e) {
      record(tag, "fail", String((e as Error)?.message ?? e).slice(0, 400));
    }
  }
}

// ── 4. InstantGen hằng ngày (tuỳ chọn) ────────────────────────────────────────
async function stepInstant(lucid: LucidEvolution, ownerPkh: string, epoch: bigint) {
  const addr = process.env.VAULT_INSTANT_ADDR;
  if (!addr) return record("instant", "fail", "thiếu VAULT_INSTANT_ADDR");
  // Đã có batch sinh trong epoch này ở một vault của ví ⟹ hôm nay đã cấp, không khoá thêm LAMP.
  const grantedToday = (await lucid.utxosAt(addr)).some((u) => {
    if (!u.datum) return false;
    try {
      const vd = Data.from(u.datum, InstantVaultDatumSchema as never) as {
        owner: string; magic_batches: { created_epoch: bigint }[];
      };
      return vd.owner === ownerPkh && vd.magic_batches.some((b) => b.created_epoch === epoch);
    } catch { return false; }
  });
  if (grantedToday) return record("instant", "skip", `ví đã có batch InstantGen ở epoch ${epoch}`);
  const lamp = process.env.KEEPER_INSTANT_LAMP ?? "1001";
  if (DRY) return record("instant", "skip", `DRY: sẽ tạo vault ${lamp} LAMP rồi cấp`);

  // Bước 05 nuốt lỗi và thoát 0 (`main().catch(console.error)`), nên phải đọc tx hash
  // trong output, không tin mã thoát.
  const created = runScript("deploy/05_create_instant_vault.ts", { LAMP_DEPOSIT: lamp, PROFILE: "Flame" });
  const vaultTx = created.out.match(/TX hash:\s+([0-9a-f]{64})/)?.[1];
  if (!vaultTx) return record("instant", "fail", "bước 05 không in tx hash — vault chưa tạo");
  await sleep(20_000); // indexer trễ sau awaitTx
  const granted = runScript("test/instant_only.ts", { VAULT_TX_HASH: vaultTx });
  const grantTx = granted.out.match(/([0-9a-f]{64})/g)?.filter((h) => h !== vaultTx).pop();
  if (granted.code !== 0) return record("instant", "fail", `vault ${vaultTx} đã tạo, bước cấp thoát ${granted.code}`);
  record("instant", "done", `vault ${vaultTx} · cấp ${grantTx ?? "(đọc tx ở log trên)"}`);
}

async function main() {
  console.log(`=== keeper · ${NETWORK} · bước: ${[...STEPS].join(",")}${DRY ? " · DRY RUN" : ""} ===`);
  if (NETWORK === "Mainnet") {
    throw new Error("Từ chối chạy trên Mainnet: bước backing dựng beacon GIẢ, và beacon thật thuộc phía CARP.");
  }
  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const ownerPkh = getAddressDetails(await lucid.wallet().address()).paymentCredential?.hash;
  if (!ownerPkh) throw new Error("Không lấy được payment credential của ví keeper");

  const nowMs = await tipMs();
  const epoch = nowMs / PROTOCOL.MS_PER_EPOCH;
  console.log(`ví keeper pkh ${ownerPkh} · epoch ${epoch} · tip ${new Date(Number(nowMs)).toISOString()}\n`);

  const guard = async (name: string, fn: () => Promise<unknown>) => {
    if (!STEPS.has(name)) return;
    try { await fn(); } catch (e) { record(name, "fail", String((e as Error)?.message ?? e).slice(0, 400)); }
  };
  await guard("backing", () => stepBacking(lucid, ownerPkh, epoch));
  await guard("price",   () => stepPrice(lucid, ownerPkh, nowMs));
  await guard("fire",    () => stepFire(lucid, nowMs));
  await guard("instant", () => stepInstant(lucid, ownerPkh, epoch));

  const fails = report.filter((r) => r.outcome === "fail").length;
  const unverified = report.filter((r) => r.outcome === "unverified").length;
  console.log(`\n=== tổng: ${report.length} mục · hỏng ${fails} · chưa đo được ${unverified} ===`);
  process.exit(fails > 0 ? 1 : unverified > 0 ? 2 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
