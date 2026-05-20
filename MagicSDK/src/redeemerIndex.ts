// MagicSDK/src/redeemerIndex.ts — auto-resolve redeemer constructor indices
// from Aiken plutus.json (avoids hardcoded indices that desync with onchain).
//
// Aiken plutus.json structure:
//   {
//     validators: [{ title: "vault.vault.spend", redeemer: { schema: { $ref } } }],
//     definitions: {
//       "magiclamp/protocol/types/VaultRedeemer": {
//         anyOf: [
//           { title: "WithdrawLamp", index: 6, dataType: "constructor", fields: [...] },
//           ...
//         ]
//       }
//     }
//   }
//
// SDK reads validator.redeemer.schema.$ref → looks up definition → finds variant
// by title → returns its index. Now the SDK can't desync with the Aiken enum:
// if onchain enum order changes, the new plutus.json will reflect it and SDK
// picks up the new index automatically.

/** Minimal Aiken plutus.json shape used by the resolver. */
export interface PlutusJson {
  validators: Array<{
    title: string;
    redeemer?: { schema?: { $ref?: string } };
    [k: string]: unknown;
  }>;
  definitions: Record<string, {
    anyOf?: Array<{
      title?: string;
      dataType?: string;
      index?: number;
      fields?: unknown[];
    }>;
    [k: string]: unknown;
  }>;
}

/**
 * Resolve a redeemer-constructor index by enum variant title.
 *
 * @example
 *   resolveConstrIndex(plutusJson, "vault.vault.spend", "WithdrawLamp") // → 6
 *
 * @throws if the validator/definition/variant is missing — fail loud so caller
 *         knows the plutus.json was rebuilt without the expected variant.
 */
export function resolveConstrIndex(
  plutusJson:     PlutusJson,
  validatorTitle: string,
  variantTitle:   string,
): number {
  const validator = plutusJson.validators.find(v => v.title === validatorTitle);
  if (!validator) {
    throw new Error(
      `[redeemerIndex] validator "${validatorTitle}" not found in plutus.json. ` +
      `Available: ${plutusJson.validators.map(v => v.title).join(", ")}`,
    );
  }

  const ref = validator.redeemer?.schema?.$ref;
  if (!ref) {
    throw new Error(`[redeemerIndex] validator "${validatorTitle}" has no redeemer.schema.$ref`);
  }

  // $ref form: "#/definitions/<path-with-~1-encoded-slashes>"
  // JSON Pointer escape: ~1 → /  (and ~0 → ~)
  const defPath = ref
    .replace(/^#\/definitions\//, "")
    .replace(/~1/g, "/")
    .replace(/~0/g, "~");
  const def = plutusJson.definitions[defPath];
  if (!def) {
    throw new Error(`[redeemerIndex] definition "${defPath}" not in plutus.json.definitions`);
  }

  const variants = def.anyOf;
  if (!variants || variants.length === 0) {
    throw new Error(`[redeemerIndex] definition "${defPath}" has no .anyOf — not an enum`);
  }

  const match = variants.find(v => v.title === variantTitle);
  if (!match) {
    const available = variants.map(v => v.title).filter(Boolean).join(", ");
    throw new Error(
      `[redeemerIndex] variant "${variantTitle}" not in "${defPath}". Available: ${available}`,
    );
  }
  if (typeof match.index !== "number") {
    throw new Error(`[redeemerIndex] variant "${variantTitle}" missing numeric .index`);
  }
  return match.index;
}

/**
 * Convenience: load plutus.json from a file path. Node-only (uses node:fs).
 * Browser callers should fetch+parse themselves.
 */
export async function loadPlutusJson(path: string | URL): Promise<PlutusJson> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as PlutusJson;
}
