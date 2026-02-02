import { describe, expect, it } from "vitest";

import { clamp, nowIso } from "../../src/core/utils";

describe("clamp", () => {
  it("clamps values into range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(20, 0, 10)).toBe(10);
  });

  it("throws when min is greater than max", () => {
    expect(() => clamp(1, 10, 0)).toThrow("min must be <= max");
  });
});

describe("nowIso", () => {
  it("returns an ISO timestamp string", () => {
    const value = nowIso();
    expect(typeof value).toBe("string");
    expect(value).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
