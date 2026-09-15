import { describe, it, expect } from "@jest/globals";
import { ApprovalStore, approvalStore } from "../../../src/approval/approval-store";

function clockedStore(start = 1_000) {
  const clock = { now: start };
  return { clock, store: new ApprovalStore(() => clock.now) };
}

const request = { toolName: "update_invoice", category: "UPDATE" as const, payloadHash: "hash-a", ttlMs: 500 };

describe("ApprovalStore", () => {
  it("issues frozen records with unique ids and expiry", () => {
    const { store } = clockedStore();
    const first = store.issue(request);
    const second = store.issue(request);
    expect(first).toMatchObject({ toolName: "update_invoice", category: "UPDATE", payloadHash: "hash-a", issuedAt: 1_000, expiresAt: 1_500 });
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.id).not.toBe(second.id);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("consumes a matching record once and rejects replay", () => {
    const { store } = clockedStore();
    const record = store.issue(request);
    expect(store.consume(record.id, "update_invoice", "hash-a")).toEqual({ ok: true });
    expect(store.consume(record.id, "update_invoice", "hash-a")).toEqual({ ok: false, reason: "replayed" });
  });

  it("allows consumption exactly at expiry and rejects after it", () => {
    const { clock, store } = clockedStore();
    const atExpiry = store.issue(request);
    const pastExpiry = store.issue(request);
    clock.now = 1_500;
    expect(store.consume(atExpiry.id, "update_invoice", "hash-a")).toEqual({ ok: true });
    clock.now = 1_501;
    expect(store.consume(pastExpiry.id, "update_invoice", "hash-a")).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a different tool and burns the record", () => {
    const { store } = clockedStore();
    const record = store.issue(request);
    expect(store.consume(record.id, "delete_invoice", "hash-a")).toEqual({ ok: false, reason: "tool-mismatch" });
    expect(store.consume(record.id, "update_invoice", "hash-a")).toEqual({ ok: false, reason: "replayed" });
  });

  it("rejects a different payload hash and burns the record", () => {
    const { store } = clockedStore();
    const record = store.issue(request);
    expect(store.consume(record.id, "update_invoice", "hash-b")).toEqual({ ok: false, reason: "hash-mismatch" });
    expect(store.consume(record.id, "update_invoice", "hash-a")).toEqual({ ok: false, reason: "replayed" });
  });

  it("reports unknown ids", () => {
    const { store } = clockedStore();
    expect(store.consume("not-issued", "update_invoice", "hash-a")).toEqual({ ok: false, reason: "unknown" });
  });

  it("prunes expired records on issue so their ids read as unknown", () => {
    const { clock, store } = clockedStore();
    const old = store.issue(request);
    clock.now = 2_000;
    store.issue(request);
    expect(store.consume(old.id, "update_invoice", "hash-a")).toEqual({ ok: false, reason: "unknown" });
  });

  it("prunes expired records on consume", () => {
    const { clock, store } = clockedStore();
    const old = store.issue(request);
    clock.now = 2_000;
    expect(store.consume("other", "update_invoice", "hash-a")).toEqual({ ok: false, reason: "unknown" });
    expect(store.consume(old.id, "update_invoice", "hash-a")).toEqual({ ok: false, reason: "unknown" });
  });

  it("keeps consumed but unexpired records so replay is detected", () => {
    const { clock, store } = clockedStore();
    const record = store.issue(request);
    store.consume(record.id, "update_invoice", "hash-a");
    clock.now = 1_400;
    store.issue(request);
    expect(store.consume(record.id, "update_invoice", "hash-a")).toEqual({ ok: false, reason: "replayed" });
  });

  it("exports a default instance using the real clock", () => {
    const record = approvalStore.issue(request);
    expect(Math.abs(record.issuedAt - Date.now())).toBeLessThan(5_000);
    expect(approvalStore.consume(record.id, "update_invoice", "hash-a")).toEqual({ ok: true });
  });
});
