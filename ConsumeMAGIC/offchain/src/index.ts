// src/index.ts — ConsumeMAGIC v2 ENGAGEMENT layer public API.
//
// Lớp engagement v2 (tiêu MAGIC dạng kế toán): codec + tx-builder co-spend.
// KHÔNG export _appeconomics_legacy.ts (v1 reward/halving — model khác, giữ riêng
// cho test suite tests/consume.test.ts).

export * from "./types.js";
export * from "./engageId.js";
export * from "./consume.js";
