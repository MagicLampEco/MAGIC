import { customAlphabet } from "nanoid";

const nano = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 20);

export function newRequestId(): string {
  return `req_${nano()}`;
}
