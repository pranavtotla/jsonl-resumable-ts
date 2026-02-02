import * as fs from "node:fs";

import { describe, expect, it } from "vitest";

import { JsonlIndex } from "../../src/node/JsonlIndex";
import { createTempDir, writeJsonlFile } from "./helpers";

const collectAsync = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const result: T[] = [];
  for await (const item of iterable) {
    result.push(item);
  }
  return result;
};

describe("async iteration", () => {
  it("iterates all lines", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 100, (i) => ({ line: i }));
    const index = new JsonlIndex(filePath);

    const lines = await collectAsync(index.asyncIter());
    expect(lines.length).toBe(100);
    expect(lines[0]).toContain('"line":0');
    expect(lines[99]).toContain('"line":99');
  });

  it("respects start, skip, and limit", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 100, (i) => ({ line: i }));
    const index = new JsonlIndex(filePath);

    const lines = await collectAsync(index.asyncIter({ start: 0, skip: 90, limit: 5 }));
    expect(lines.length).toBe(5);
    expect(lines[0]).toContain('"line":90');
  });

  it("asyncIterJson handles decode errors", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "mixed.jsonl", 0, () => ({}));
    await fs.promises.writeFile(filePath, '{"valid":1}\ninvalid json\n{"valid":2}\n', "utf8");
    const index = new JsonlIndex(filePath);

    const items = await collectAsync(index.asyncIterJson({ onDecodeError: "skip" }));
    expect(items.length).toBe(2);

    const rawItems = await collectAsync(index.asyncIterJson({ onDecodeError: "raw" }));
    expect(rawItems.length).toBe(3);
  });

  it("asyncIterRaw yields bytes with newline", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 10, (i) => ({ line: i }));
    const index = new JsonlIndex(filePath);

    const raw = await collectAsync(index.asyncIterRaw({ limit: 1 }));
    expect(raw.length).toBe(1);
    expect(Buffer.from(raw[0]).toString("utf8")).toContain('"line":0');
  });
});
