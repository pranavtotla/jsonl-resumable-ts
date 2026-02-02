import { describe, expect, it } from "vitest";

import { IndexMeta, LineInfo } from "../../src/core/models";
import { FORMAT_VERSION, deserializeIndex, serializeIndex } from "../../src/core/serialization";

describe("serializeIndex", () => {
  it("writes format version, meta, and lines", () => {
    const meta = new IndexMeta({
      filePath: "/path/to/file.jsonl",
      fileSize: 1234,
      fileMtime: 123.456,
      totalLines: 2,
      checkpointInterval: 1,
      checkpoints: { 0: 0, 1: 50 },
      indexedAt: "2024-01-01T00:00:00Z",
      version: "1.0",
    });
    const lines = [new LineInfo(0, 0, 50), new LineInfo(1, 50, 50)];

    const data = serializeIndex(meta, lines);

    expect(data.format_version).toBe(FORMAT_VERSION);
    expect(data.meta.file_path).toBe(meta.filePath);
    expect(data.meta.checkpoints["0"]).toBe(0);
    expect(data.lines[0]).toEqual([0, 50]);
  });
});

describe("deserializeIndex", () => {
  it("restores meta and lines", () => {
    const data = {
      format_version: FORMAT_VERSION,
      meta: {
        file_path: "/path/to/file.jsonl",
        file_size: 1234,
        file_mtime: 123.456,
        total_lines: 2,
        checkpoint_interval: 1,
        checkpoints: { "0": 0, "1": 50 },
        indexed_at: "2024-01-01T00:00:00Z",
        version: "1.0",
      },
      lines: [
        [0, 50],
        [50, 50],
      ],
    };

    const result = deserializeIndex(data);
    expect(result).not.toBeNull();
    expect(result?.meta.filePath).toBe("/path/to/file.jsonl");
    expect(result?.meta.checkpoints[0]).toBe(0);
    expect(result?.lines[1].offset).toBe(50);
  });

  it("defaults version when missing", () => {
    const data = {
      format_version: FORMAT_VERSION,
      meta: {
        file_path: "/path/to/file.jsonl",
        file_size: 1234,
        file_mtime: 123.456,
        total_lines: 2,
        checkpoint_interval: 1,
        checkpoints: {},
        indexed_at: "2024-01-01T00:00:00Z",
      },
      lines: [[0, 50]],
    };

    const result = deserializeIndex(data);
    expect(result?.meta.version).toBe("1.0");
  });

  it("returns null for wrong format version", () => {
    const result = deserializeIndex({
      format_version: "0.1",
      meta: {},
      lines: [],
    });

    expect(result).toBeNull();
  });

  it("returns null when meta is missing", () => {
    const result = deserializeIndex({
      format_version: FORMAT_VERSION,
      lines: [],
    });

    expect(result).toBeNull();
  });

  it("returns null when lines are malformed", () => {
    const result = deserializeIndex({
      format_version: FORMAT_VERSION,
      meta: {
        file_path: "/path/to/file.jsonl",
        file_size: 1234,
        file_mtime: 123.456,
        total_lines: 1,
        checkpoint_interval: 1,
        checkpoints: {},
        indexed_at: "2024-01-01T00:00:00Z",
      },
      lines: [{ bad: "format" }],
    });

    expect(result).toBeNull();
  });
});
