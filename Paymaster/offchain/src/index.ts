// src/index.ts — Paymaster public API.
//
// Lớp app-sponsor (trả ADA+LAMP hộ user, trigger BurnBatch tiêu MAGIC qua delegate):
// codec datum/redeemer (P8 mirror types.ak) + Q-format math + tx-builder co-spend.
// KHÔNG mint MAGIC.

export * from "./types.js";
export * from "./math.js";
export * from "./paymaster.js";
