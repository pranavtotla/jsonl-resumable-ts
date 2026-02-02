import { describe, expect, it } from "vitest";

import { JsonlIndex } from "../../src/node/JsonlIndex";
import { createTempDir, writeJsonlFile } from "./helpers";

describe("sample", () => {
  it("returns random records", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 100, (i) => ({ line: i }));
    const index = new JsonlIndex(filePath);

    const sample = await index.sample<{ line: number }>(10);
    expect(sample.length).toBe(10);
    for (const record of sample) {
      expect(record.line).toBeGreaterThanOrEqual(0);
      expect(record.line).toBeLessThan(100);
    }
  });

  it("is reproducible with seed", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 50, (i) => ({ line: i }));
    const index = new JsonlIndex(filePath);

    const sample1 = await index.sample<{ line: number }>(10, { seed: 42 });
    const sample2 = await index.sample<{ line: number }>(10, { seed: 42 });
    expect(sample1).toEqual(sample2);
  });

  it("clamps when n exceeds total", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 5, (i) => ({ line: i }));
    const index = new JsonlIndex(filePath);

    const sample = await index.sample<{ line: number }>(20, { seed: 1 });
    expect(sample.length).toBe(5);
  });

  it("returns empty array for n=0", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 5, (i) => ({ line: i }));
    const index = new JsonlIndex(filePath);

    const sample = await index.sample<{ line: number }>(0, { seed: 1 });
    expect(sample).toEqual([]);
  });
});
