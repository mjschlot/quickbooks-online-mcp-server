import { describe, it, expect } from "@jest/globals";
import { canonicalJson, sha256Hex } from "../../../src/approval/canonicalize";

describe("canonicalJson", () => {
  it("is independent of key insertion order at every depth", () => {
    const a = { b: 1, a: { d: [1, { y: true, x: null }], c: "s" } };
    const b = { a: { c: "s", d: [1, { x: null, y: true }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":"s","d":[1,{"x":null,"y":true}]},"b":1}');
  });

  it("preserves array order", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it("omits object properties whose value is undefined", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("accepts null-prototype objects and escapes strings", () => {
    const value = Object.assign(Object.create(null), { 'k"ey': "line\nbreak" });
    expect(canonicalJson(value)).toBe('{"k\\"ey":"line\\nbreak"}');
  });

  it.each([
    ["undefined at top level", undefined],
    ["undefined inside an array", [1, undefined]],
    ["a sparse array hole", [1, , 3]],
    ["NaN", { n: NaN }],
    ["Infinity", { n: Infinity }],
    ["-Infinity", [-Infinity]],
    ["bigint", { n: BigInt(1) }],
    ["function", { f: () => 1 }],
    ["symbol", { s: Symbol("s") }],
    ["Date", { d: new Date(0) }],
    ["Map", { m: new Map() }],
    ["class instance", { c: new (class Widget {})() }],
  ])("rejects %s", (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });

  it("names the offending path", () => {
    expect(() => canonicalJson({ params: { Line: [{ Amount: NaN }] } })).toThrow(
      "$.params.Line[0].Amount"
    );
  });
});

describe("sha256Hex", () => {
  it("is stable for equal canonical payloads", () => {
    expect(sha256Hex(canonicalJson({ a: 1, b: 2 }))).toBe(sha256Hex(canonicalJson({ b: 2, a: 1 })));
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("changes when any value changes", () => {
    expect(sha256Hex(canonicalJson({ amount: 100 }))).not.toBe(sha256Hex(canonicalJson({ amount: 101 })));
    expect(sha256Hex(canonicalJson({ amount: 100 }))).not.toBe(sha256Hex(canonicalJson({ amount: "100" })));
  });
});
