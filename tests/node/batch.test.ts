import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { InvalidCheckpointError, StaleCheckpointError } from "../../src/core/errors";
import { JsonlIndex } from "../../src/node/JsonlIndex";
import { appendJsonlLine, createTempDir, writeJsonlFile } from "./helpers";

interface JobRecord {
  position: number;
  status: string;
  completed_at: string | null;
  file_size: number;
  file_mtime: number;
}

const readProgressFile = (filePath: string): { jobs: Record<string, JobRecord> } => {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as { jobs: Record<string, JobRecord> };
};

describe("BatchProcessor", () => {
  it("creates new job and checkpoints", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 10, (i) => ({ line: i }));
    const index = new JsonlIndex(filePath);

    await index.batchProcessor("job-1").run(async (batch) => {
      expect(batch.position).toBe(0);
      expect(batch.jobId).toBe("job-1");

      for await (const [lineNumber] of batch) {
        if (lineNumber === 3) {
          await batch.checkpoint();
          break;
        }
      }
    });

    const progressPath = path.join(dir, "sample.progress");
    const progress = readProgressFile(progressPath);
    const jobs = progress.jobs;
    expect(jobs["job-1"].position).toBe(4);
  });

  it("resumes from checkpoint", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 10, (i) => ({ line: i }));
    const index = new JsonlIndex(filePath);

    await index.batchProcessor("job-2").run(async (batch) => {
      for await (const [lineNumber] of batch) {
        if (lineNumber === 5) {
          await batch.checkpoint();
          break;
        }
      }
    });

    const batch = await index.batchProcessor("job-2").start();
    expect(batch.position).toBe(6);
    await batch.end();
  });

  it("marks job completed on exhaustion", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 5, (i) => ({ line: i }));
    const index = new JsonlIndex(filePath);

    await index.batchProcessor("job-3").run(async (batch) => {
      for await (const _ of batch) {
        // consume all
      }
    });

    const progressPath = path.join(dir, "sample.progress");
    const progress = readProgressFile(progressPath);
    const jobs = progress.jobs;
    expect(jobs["job-3"].status).toBe("completed");
    expect(jobs["job-3"].completed_at).not.toBeNull();
  });

  it("raises on stale checkpoint", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 5, (i) => ({ line: i }));
    const index = new JsonlIndex(filePath);

    await index.batchProcessor("job-4").run(async (batch) => {
      for await (const [lineNumber] of batch) {
        if (lineNumber === 1) {
          await batch.checkpoint();
          break;
        }
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    await appendJsonlLine(filePath, { line: 5 });
    const index2 = new JsonlIndex(filePath);

    await expect(index2.batchProcessor("job-4").start()).rejects.toThrow(StaleCheckpointError);
  });

  it("raises on invalid checkpoint position", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 5, (i) => ({ line: i }));
    const index = new JsonlIndex(filePath);

    await index.batchProcessor("job-5").run(async (batch) => {
      for await (const [lineNumber] of batch) {
        if (lineNumber === 4) {
          await batch.checkpoint();
          break;
        }
      }
    });

    await fs.promises.writeFile(filePath, '{"line":0}\n', "utf8");
    const progressPath = path.join(dir, "sample.progress");
    const progress = readProgressFile(progressPath);
    const jobs = progress.jobs;
    const stat = await fs.promises.stat(filePath);
    jobs["job-5"].file_size = stat.size;
    jobs["job-5"].file_mtime = stat.mtimeMs / 1000;
    await fs.promises.writeFile(progressPath, JSON.stringify(progress), "utf8");

    const index2 = new JsonlIndex(filePath);
    await expect(index2.batchProcessor("job-5").start()).rejects.toThrow(InvalidCheckpointError);
  });
});
