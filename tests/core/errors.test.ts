import { describe, expect, it } from "vitest";

import {
  AsyncIterationError,
  FileDeletedError,
  FileModifiedError,
  FileTruncatedError,
  IndexOutOfBoundsError,
  InvalidCheckpointError,
  JsonlResumableError,
  LineCorruptedError,
  StaleCheckpointError,
} from "../../src/core/errors";

describe("base error", () => {
  it("creates a jsonl-resumable error", () => {
    const err = new JsonlResumableError("oops");
    expect(err.message).toBe("oops");
    expect(err.name).toBe("JsonlResumableError");
  });
});

describe("checkpoint errors", () => {
  it("creates stale checkpoint error with details", () => {
    const err = new StaleCheckpointError("job-1", { size: 10, mtime: 1 }, { size: 12, mtime: 2 });
    expect(err.jobId).toBe("job-1");
    expect(err.expected.size).toBe(10);
    expect(err.actual.size).toBe(12);
  });

  it("creates invalid checkpoint error with details", () => {
    const err = new InvalidCheckpointError("job-1", 12, 10);
    expect(err.jobId).toBe("job-1");
    expect(err.position).toBe(12);
    expect(err.totalLines).toBe(10);
  });
});

describe("async iteration errors", () => {
  it("bases async iteration error", () => {
    const err = new AsyncIterationError("oops");
    expect(err.message).toBe("oops");
    expect(err.name).toBe("AsyncIterationError");
  });

  it("captures file deleted metadata", () => {
    const err = new FileDeletedError("/tmp/file.jsonl");
    expect(err.filePath).toBe("/tmp/file.jsonl");
    expect(err.message).toContain("File was deleted");
  });

  it("captures file truncated metadata", () => {
    const err = new FileTruncatedError("/tmp/file.jsonl", 100, 50);
    expect(err.filePath).toBe("/tmp/file.jsonl");
    expect(err.expectedSize).toBe(100);
    expect(err.actualSize).toBe(50);
  });

  it("captures line corrupted metadata", () => {
    const err = new LineCorruptedError(5, 10, 8);
    expect(err.lineNumber).toBe(5);
    expect(err.expectedLength).toBe(10);
    expect(err.actualLength).toBe(8);
  });
});

describe("index errors", () => {
  it("creates index out of bounds error", () => {
    const err = new IndexOutOfBoundsError(5, 3);
    expect(err.lineNumber).toBe(5);
    expect(err.totalLines).toBe(3);
  });

  it("creates file modified error", () => {
    const err = new FileModifiedError("/tmp/file.jsonl");
    expect(err.filePath).toBe("/tmp/file.jsonl");
  });
});
