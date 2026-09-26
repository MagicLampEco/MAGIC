// VaultTxAPI/tests/instantGen.test.ts — đường `POST /tx/instant-gen`.
//
// ══ BÀI GHIM QUAN TRỌNG NHẤT CỦA TỆP NÀY ══════════════════════════════════════
// `đường ĐÓNG khi thiếu mục cấu hình instant`. Bốn giá trị (`um_datum_address` ·
// `um_nft_unit` · `backing_beacon_address` · `backing_beacon_nft_unit`) là dữ kiện
// dịch vụ không suy được từ yêu cầu. Thiếu chúng mà vẫn mở đường thì dịch vụ dựng
// được tx, trả 200, và MỌI tx chết trên chuỗi với một câu không trỏ về cấu hình.
//
// Bài này cắn đúng chỗ đó: `deployment.instant === undefined` ⟹ lượt dựng phải
// HỎNG, không được trả 200. Một hiện thực bỏ nhánh kiểm ấy đi thì bài này đỏ.
// ══════════════════════════════════════════════════════════════════════════════

import { describe, expect, it } from "vitest";

import { RecordedChainReader, type ChainTip } from "../src/chain.js";
import { parseDeployment, type Deployment } from "../src/config.js";
import { handle, type RouterDeps } from "../src/http.js";
import { IssuedTxRegistry, OwnerLockTable } from "../src/locks.js";
import { VaultTxService } from "../src/service.js";
import { RecordedTxBuilder } from "../src/txBuilder.js";
import {
  INPUT_TX_HASH, LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID, LAMP_UNIT, OWNER_PKH,
  SHARD_ADDRESS, VAULT_ADDRESS, VAULT_ID_UNIT, datumHex,
} from "./fixtures/preview.js";
import { buildTxCbor } from "./fixtures/tx.js";

const FEE = 178_000n;
const TTL = 180_000;
const NOW = 1_789_100_703_000;

const TIP: ChainTip = {
  blockHeight: 4_651_976,
  blockHash: "14ae149dd07cd25ce37a6a4336f3939446bd68d9ad4a2e820201a474cc3ad72f",
  blockTimePosixMs: BigInt(NOW),
};

const UM_NFT_UNIT = `${"66".repeat(28)}554d`;
const BACKING_NFT_UNIT = `${"77".repeat(28)}6242`;

/** Vault loại `Instant` — `instantGen()` gọi `buildOne("Instant", …)`. */
function deploymentJson(withInstant: boolean): string {
  const base: Record<string, unknown> = {
    source: "Preview, bản dựng thử của phép kiểm — không phải một lần deploy thật",
    lamp: { policy_id: LAMP_POLICY_ID, asset_name_hex: LAMP_ASSET_NAME_HEX },
    vaults: [{ vault_type: "Instant", address: VAULT_ADDRESS }],
    shard_address: SHARD_ADDRESS,
    ref_script_utxos: {
      vault: `${"11".repeat(32)}#0`, shard: `${"22".repeat(32)}#1`, consume: `${"33".repeat(32)}#2`,
    },
    consume: {
      engage_address: VAULT_ADDRESS,
      price_beacon_address: VAULT_ADDRESS,
      price_beacon_nft_unit: `${"55".repeat(28)}cafe`,
    },
  };
  if (withInstant) {
    base.instant = {
      um_datum_address: VAULT_ADDRESS,
      um_nft_unit: UM_NFT_UNIT,
      backing_beacon_address: VAULT_ADDRESS,
      backing_beacon_nft_unit: BACKING_NFT_UNIT,
    };
  }
  return JSON.stringify(base);
}

function instantTxCbor(): string {
  return buildTxCbor({
    inputs: [{ txHash: INPUT_TX_HASH, outputIndex: 0 }],
    feeLovelace: FEE,
    // LAMP phải Ở LẠI trong vault: `I-ACT-7` — sinh MAGIC KHÔNG làm LAMP rời vault.
    // Mô hình cũ "trả LAMP sang Treasury để mua MAGIC" đã bị bỏ. Một fixture đánh rơi
    // LAMP ở đây là một fixture mô tả đúng cái luật cấm.
    outputs: [{
      address: VAULT_ADDRESS,
      assets: { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
      // `instantUnlockMs` BẮT BUỘC ở đây: nó chọn hình dạng datum 18 trường của
      // InstantGen. Bỏ nó đi là dựng datum 17 trường (Schedule) trên đường instant —
      // một trạng thái on-chain bất khả thi, mà bộ kiểm vẫn xanh trọn vẹn cho tới khi
      // `summarizeTx` có cổng ý-định-khớp-hình-dạng. Giá trị: một mốc thật, khác 0.
      inlineDatumHex: datumHex({
        lampLockedOildrop: 0n,
        batches: [{ id: "c0".repeat(16), createdEpoch: 20_700n, amountNanogic: 4_000_000n }],
        instantUnlockMs: 1_789_000_000_000n,
      }),
    }],
  });
}

/** PHẢI nằm đúng ở `INPUT_TX_HASH#0` — đó là input mà `instantTxCbor()` tiêu. Lệch
 *  một chỗ thì `summarizeTx` không đọc lại được tx và dịch vụ trả 422, đúng như nó
 *  phải làm: một CBOR dựng ra mà không đọc lại được thì không ai nên ký nó. */
function vaultUtxo() {
  return {
    txHash: INPUT_TX_HASH, outputIndex: 0, address: VAULT_ADDRESS,
    assets: { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
    // Két Instant CHƯA TỪNG sinh ⟹ mốc `0n`, không phải vắng trường. Genesis ghim
    // đúng giá trị đó (`validate_mint_vault_id`), nên đây là hình dạng đầu vào thật.
    datum: datumHex({ lampLockedOildrop: 0n, batches: [], instantUnlockMs: 0n }),
  };
}

function harness(withInstant: boolean) {
  const deployment: Deployment = parseDeployment(deploymentJson(withInstant), "Preview");
  const chain = new RecordedChainReader({ [VAULT_ADDRESS]: [vaultUtxo()] }, TIP, []);
  const builder = new RecordedTxBuilder({ instant_gen: instantTxCbor() });
  const service = new VaultTxService({
    network: "Preview", deployment, chain, builder,
    locks: new OwnerLockTable(TTL), issued: new IssuedTxRegistry(TTL * 4),
    lockTtlMs: TTL, now: () => NOW,
  });
  const router: RouterDeps = {
    service,
    deploymentSource: deployment.source,
    vaultScopes: deployment.vaults,
    network: "Preview",
    chainLabel: "recorded",
    changeAddressStrategy: "enterprise_from_owner_pkh",
    token: "",
    logInternal: () => {},
  };
  return { service, builder, router, deployment };
}

const post = (url: string, body: unknown) => ({ method: "POST", url, headers: {}, body });

describe("POST /tx/instant-gen", () => {
  it("dựng được và trả về CẢ tx_cbor LẪN tx_hash", async () => {
    const h = harness(true);
    const r = await handle(post("/tx/instant-gen", { owner_pkh: OWNER_PKH }), h.router);

    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    // Hai trường này đi THÀNH CẶP: bên tiêu thụ tự tính băm từ `tx_cbor` rồi đối
    // chiếu với `tx_hash` để biết bộ phân tích CBOR của họ đọc đúng. Thiếu một vế
    // thì phép đối chiếu đó không dựng được.
    expect(typeof body.tx_cbor).toBe("string");
    expect(body.tx_cbor as string).not.toHaveLength(0);
    expect(body.tx_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("KHÔNG nhận tham số lượng — gửi `amount` lên thì nó bị bỏ, không được vào tx", async () => {
    const h = harness(true);
    const r = await handle(
      post("/tx/instant-gen", { owner_pkh: OWNER_PKH, amount: "999999999999" }),
      h.router,
    );

    expect(r.status).toBe(200);
    // Lượng cấp là `min(vế thưởng, cap_surplus, cap_pp)` do validator quyết. Bài này
    // ghim rằng tầng dịch vụ KHÔNG chuyển một con số của người gọi xuống tầng dựng —
    // nếu có, một cái nút hứa 999 999 999 999 rồi bị chuỗi bác.
    expect(h.builder.lastCall).toEqual({ route: "instant_gen", params: {} });
  });

  it("🔴 ĐÓNG khi thiếu mục cấu hình `instant` — không trả 200", async () => {
    const h = harness(false);
    expect(h.deployment.instant).toBeUndefined();

    const r = await handle(post("/tx/instant-gen", { owner_pkh: OWNER_PKH }), h.router);
    expect(r.status).not.toBe(200);
  });

  it("thiếu `owner_pkh` thì 400, không phải 500", async () => {
    const h = harness(true);
    expect((await handle(post("/tx/instant-gen", {}), h.router)).status).toBe(400);
  });

  it("GET vào đường này là 405, không phải 404", async () => {
    const h = harness(true);
    const r = await handle({ method: "GET", url: "/tx/instant-gen", headers: {} }, h.router);
    expect(r.status).toBe(405);
  });
});

describe("parseDeployment — mục `instant`", () => {
  it("vắng hẳn thì hợp lệ, và `instant` là undefined", () => {
    expect(parseDeployment(deploymentJson(false), "Preview").instant).toBeUndefined();
  });

  it("có thì đọc đủ bốn trường", () => {
    const d = parseDeployment(deploymentJson(true), "Preview");
    expect(d.instant).toEqual({
      umDatumAddress: VAULT_ADDRESS,
      umNftUnit: UM_NFT_UNIT,
      backingBeaconAddress: VAULT_ADDRESS,
      backingBeaconNftUnit: BACKING_NFT_UNIT,
    });
  });

  it("🔴 khai THIẾU một trường thì NÉM — không im lặng bỏ qua mục đó", () => {
    // Đây là chỗ dễ hỏng im lặng nhất: một mục `instant` khai ba trên bốn trường mà
    // được đọc thành "không có mục instant" sẽ ĐÓNG đường một cách khó hiểu, còn được
    // đọc thành "có" với một trường rỗng thì mở ra một đường mà mọi tx chết trên chuỗi.
    const broken = JSON.parse(deploymentJson(true));
    delete broken.instant.backing_beacon_nft_unit;
    expect(() => parseDeployment(JSON.stringify(broken), "Preview")).toThrow();
  });

  it("🔴 NFT unit sai hình dạng thì NÉM", () => {
    const broken = JSON.parse(deploymentJson(true));
    broken.instant.um_nft_unit = "không-phải-hex";
    expect(() => parseDeployment(JSON.stringify(broken), "Preview")).toThrow();
  });
});
