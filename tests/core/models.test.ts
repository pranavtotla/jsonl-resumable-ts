import { describe, expect, it } from "vitest";

import { IndexMeta, JobInfo, JobProgress, LineInfo } from "../../src/core/models";

describe("LineInfo", () => {
  it("stores line metadata", () => {
    const info = new LineInfo(5, 250, 50);
    expect(info.lineNumber).toBe(5);
    expect(info.offset).toBe(250);
    expect(info.length).toBe(50);
  });
});

describe("IndexMeta", () => {
  it("defaults checkpoints, indexedAt, and version", () => {
    const meta = new IndexMeta({
      filePath: "/path/file.jsonl",
      fileSize: 100,
      fileMtime: 123.4,
      totalLines: 10,
      checkpointInterval: 5,
    });

    expect(meta.checkpoints).toEqual({});
    expect(meta.version).toBe("1.0");
    expect(typeof meta.indexedAt).toBe("string");
  });

  it("checks freshness against size and mtime", () => {
    const meta = new IndexMeta({
      filePath: "/path/file.jsonl",
      fileSize: 100,
      fileMtime: 123.4,
      totalLines: 10,
      checkpointInterval: 5,
    });

    expect(meta.isFresh(100, 123.4)).toBe(true);
    expect(meta.isFresh(101, 123.4)).toBe(false);
    expect(meta.isFresh(100, 999)).toBe(false);
  });
});

describe("JobProgress", () => {
  it("defaults completedAt to null", () => {
    const job = new JobProgress({
      jobId: "job-1",
      position: 0,
      fileSize: 100,
      fileMtime: 1,
      status: "in_progress",
      createdAt: "2024-01-01T00:00:00Z",
      lastCheckpointAt: "2024-01-01T00:00:01Z",
    });

    expect(job.completedAt).toBeNull();
  });
});

describe("JobInfo", () => {
  it("stores immutable job info fields", () => {
    const info = new JobInfo({
      jobId: "job-1",
      position: 10,
      status: "completed",
      totalLines: 100,
      progressPct: 100,
      createdAt: new Date("2024-01-01T00:00:00Z"),
      lastCheckpointAt: new Date("2024-01-01T00:10:00Z"),
      completedAt: new Date("2024-01-01T00:10:00Z"),
      isStale: false,
    });

    expect(info.jobId).toBe("job-1");
    expect(info.progressPct).toBe(100);
    expect(info.isStale).toBe(false);
  });
});
