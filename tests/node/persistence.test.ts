import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { IndexMeta, JobProgress, LineInfo } from "../../src/core/models";
import { FileStorage } from "../../src/node/storage";
import { createTempDir } from "./helpers";

describe("FileStorage index persistence", () => {
  it("saves and loads index data", async () => {
    const dir = await createTempDir();
    const indexPath = path.join(dir, "test.idx");

    const meta = new IndexMeta({
      filePath: "/tmp/test.jsonl",
      fileSize: 1234,
      fileMtime: 123.456,
      totalLines: 2,
      checkpointInterval: 1,
      checkpoints: { 0: 0, 1: 50 },
      indexedAt: "2024-01-01T00:00:00Z",
      version: "1.0",
    });

    const lines = [new LineInfo(0, 0, 50), new LineInfo(1, 50, 50)];
    const storage = new FileStorage();

    await storage.save(indexPath, meta, lines);
    const loaded = await storage.load(indexPath);

    expect(loaded).not.toBeNull();
    expect(loaded?.meta.filePath).toBe(meta.filePath);
    expect(loaded?.lines.length).toBe(2);
  });

  it("writes compact json", async () => {
    const dir = await createTempDir();
    const indexPath = path.join(dir, "test.idx");

    const meta = new IndexMeta({
      filePath: "/tmp/test.jsonl",
      fileSize: 1,
      fileMtime: 1,
      totalLines: 0,
      checkpointInterval: 1,
    });

    const storage = new FileStorage();
    await storage.save(indexPath, meta, []);

    const content = fs.readFileSync(indexPath, "utf8");
    expect(content.includes(": ")).toBe(false);
    expect(content.includes(", ")).toBe(false);
  });
});

describe("FileStorage progress persistence", () => {
  it("saves, loads, and deletes jobs", async () => {
    const dir = await createTempDir();
    const progressPath = path.join(dir, "test.progress");
    const storage = new FileStorage();

    const job = new JobProgress({
      jobId: "job-1",
      position: 3,
      fileSize: 100,
      fileMtime: 123.45,
      status: "in_progress",
      createdAt: "2024-01-01T00:00:00Z",
      lastCheckpointAt: "2024-01-01T00:01:00Z",
    });

    await storage.saveJob(progressPath, job);
    const jobs = await storage.loadJobs(progressPath);
    expect(jobs?.get("job-1")?.position).toBe(3);

    const deleted = await storage.deleteJob(progressPath, "job-1");
    expect(deleted).toBe(true);
  });
});
