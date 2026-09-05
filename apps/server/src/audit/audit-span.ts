import { randomBytes } from "node:crypto";

/** 16-hex-char span id. */
export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

/** 32-hex-char trace id. */
export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}
