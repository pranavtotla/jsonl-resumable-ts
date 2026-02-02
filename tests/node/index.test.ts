import { promises as fs } from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { FileModifiedError, IndexOutOfBoundsError } from "../../src/core/errors";
import { JsonlIndex } from "../../src/node/JsonlIndex";
import { appendJsonlLine, createTempDir, writeJsonlFile } from "./helpers";

describe("JsonlIndex basics", () => {
  it("creates index and exposes totals", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 100, (i) => ({ line: i }));

    const index = new JsonlIndex(filePath);

    expect(index.totalLines).toBe(100);
    expect(index.fileSize).toBeGreaterThan(0);
    expect(index.filePath).toBe(path.resolve(filePath));
  });

  it("getOffset throws on out of range", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 10, (i) => ({ line: i }));
    const index = new JsonlIndex(filePath);

    expect(() => index.getOffset(10)).toThrow(IndexOutOfBoundsError);
  });

  it("readLine and readJson return expected data", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 5, (i) => ({ line: i }));
    const index = new JsonlIndex(filePath);

    const line = await index.readLine(2);
    expect(line).toContain('"line":2');

    const record = await index.readJson<{ line: number }>(2);
    expect(record.line).toBe(2);
  });

  it("iterFrom yields correct lines", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 5, (i) => ({ line: i }));
    const index = new JsonlIndex(filePath);

    const lines = Array.from(index.iterFrom(2));
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('"line":2');
  });

  it("readLineMany preserves order and duplicates", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 5, (i) => ({ line: i }));
    const index = new JsonlIndex(filePath);

    const lines = await index.readLineMany([3, 1, 3]);
    expect(lines[0]).toContain('"line":3');
    expect(lines[1]).toContain('"line":1');
    expect(lines[2]).toContain('"line":3');
  });

  it("readJsonMany parses JSON in order", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 5, (i) => ({ line: i }));
    const index = new JsonlIndex(filePath);

    const records = await index.readJsonMany<{ line: number }>([4, 2, 0]);
    expect(records.map((r) => r.line)).toEqual([4, 2, 0]);
  });

  it("custom index path avoids default .idx", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 5, (i) => ({ line: i }));
    const customIndex = path.join(dir, "custom.idx");

    new JsonlIndex(filePath, { indexPath: customIndex });

    await expect(fs.access(customIndex)).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, "sample.idx"))).rejects.toThrow();
  });

  it("autoSave=false does not write index file", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 5, (i) => ({ line: i }));

    new JsonlIndex(filePath, { autoSave: false });

    await expect(fs.access(path.join(dir, "sample.idx"))).rejects.toThrow();
  });

  it("rebuild recreates index after file change", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 5, (i) => ({ line: i }));
    const index = new JsonlIndex(filePath);

    await appendJsonlLine(filePath, { line: 5 });
    await index.rebuild();

    expect(index.totalLines).toBe(6);
  });

  it("update indexes appended lines", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 5, (i) => ({ line: i }));
    const index = new JsonlIndex(filePath);

    await appendJsonlLine(filePath, { line: 5 });
    await appendJsonlLine(filePath, { line: 6 });

    const added = await index.update();
    expect(added).toBe(2);
    expect(index.totalLines).toBe(7);
  });

  it("update returns 0 when no changes", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 5, (i) => ({ line: i }));
    const index = new JsonlIndex(filePath);

    const added = await index.update();
    expect(added).toBe(0);
  });

  it("update throws on shrink", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 5, (i) => ({ line: i }));
    const index = new JsonlIndex(filePath);

    await fs.writeFile(filePath, '{"line":0}\n', "utf8");

    await expect(index.update()).rejects.toThrow(FileModifiedError);
  });

  it("sample is reproducible with seed and clamps size", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 50, (i) => ({ line: i }));
    const index = new JsonlIndex(filePath);

    const sample1 = await index.sample<{ line: number }>(10, { seed: 42 });
    const sample2 = await index.sample<{ line: number }>(10, { seed: 42 });
    expect(sample1).toEqual(sample2);

    const sampleAll = await index.sample<{ line: number }>(1000, { seed: 1 });
    expect(sampleAll.length).toBe(50);
  });
});
