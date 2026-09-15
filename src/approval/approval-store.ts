import { randomUUID } from "node:crypto";
import type { MutationCategory } from "../helpers/register-tool.js";

export interface ApprovalRecord {
  readonly id: string;
  readonly toolName: string;
  readonly category: MutationCategory;
  readonly payloadHash: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export type ConsumeFailure = "unknown" | "replayed" | "expired" | "tool-mismatch" | "hash-mismatch";

export type ConsumeResult = { ok: true } | { ok: false; reason: ConsumeFailure };

interface Entry {
  readonly record: ApprovalRecord;
  consumed: boolean;
}

/**
 * Single-use approvals bound to one tool and payload hash. Any consume attempt
 * on a live record burns it, so a failed check cannot be retried against the
 * same approval. Records are dropped once past expiry; a dropped id reads as
 * "unknown".
 */
export class ApprovalStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(request: {
    toolName: string;
    category: MutationCategory;
    payloadHash: string;
    ttlMs: number;
  }): ApprovalRecord {
    const issuedAt = this.now();
    this.prune(issuedAt);
    const record: ApprovalRecord = Object.freeze({
      id: randomUUID(),
      toolName: request.toolName,
      category: request.category,
      payloadHash: request.payloadHash,
      issuedAt,
      expiresAt: issuedAt + request.ttlMs,
    });
    this.entries.set(record.id, { record, consumed: false });
    return record;
  }

  consume(id: string, toolName: string, payloadHash: string): ConsumeResult {
    const now = this.now();
    const result = this.check(id, toolName, payloadHash, now);
    this.prune(now);
    return result;
  }

  private check(id: string, toolName: string, payloadHash: string, now: number): ConsumeResult {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, reason: "unknown" };
    if (entry.consumed) return { ok: false, reason: "replayed" };
    entry.consumed = true;
    if (now > entry.record.expiresAt) return { ok: false, reason: "expired" };
    if (entry.record.toolName !== toolName) return { ok: false, reason: "tool-mismatch" };
    if (entry.record.payloadHash !== payloadHash) return { ok: false, reason: "hash-mismatch" };
    return { ok: true };
  }

  private prune(now: number): void {
    for (const [id, entry] of this.entries) {
      if (now > entry.record.expiresAt) this.entries.delete(id);
    }
  }
}

export const approvalStore = new ApprovalStore();
