// Verify per-network vault script hash differs.
// Loads unapplied vault from SnapshotGen plutus.json, applies slots_per_epoch
// for each network, prints resulting hash.
import { applyParamsToScript, validatorToScriptHash } from "@lucid-evolution/lucid";
import { readFile } from "node:fs/promises";

const plutusJson = JSON.parse(
  await readFile(new URL("../SnapshotGen/onchain/plutus.json", import.meta.url), "utf8"),
);
const unapplied = plutusJson.validators.find((v: any) => v.title === "vault.vault.spend");
console.log("unapplied hash:", unapplied.hash);
console.log();
for (const [net, msPer] of [["Preview", 86_400_000n], ["Preprod", 86_400_000n], ["Mainnet", 432_000_000n]] as const) {
  const applied = applyParamsToScript(unapplied.compiledCode, [msPer]);
  const h = validatorToScriptHash({ type: "PlutusV3", script: applied });
  console.log(`${net.padEnd(8)} ms_per_epoch=${msPer} → hash = ${h}`);
}
