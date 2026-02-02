import * as fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import * as path from "node:path";

import { BatchProcessor } from "../core/batch";
import {
  FileDeletedError,
  FileModifiedError,
  FileTruncatedError,
  IndexOutOfBoundsError,
  LineCorruptedError,
} from "../core/errors";
import { IndexMeta, JobInfo, type JobProgress, LineInfo } from "../core/models";
import { clamp } from "../core/utils";
import type {
  FileSource,
  IndexStorage,
  IterOptions,
  JsonIterOptions,
  ProgressStorage,
} from "../types";
import { FileStorage, MemoryStorage } from "./storage";
import { toNodeStream, toWebStream } from "./streams";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_CHECKPOINT_INTERVAL = 100;
const DEFAULT_CHUNK_SIZE = 64 * 1024;

const stripLineEnding = (value: string): string => value.replace(/[\r\n]+$/, "");

const replaceSuffix = (filePath: string, suffix: string): string => {
  const parsed = path.parse(filePath);
  if (!parsed.ext) {
    return filePath + suffix;
  }
  return path.join(parsed.dir, `${parsed.name}${suffix}`);
};

type JsonlIndexOptions = {
  checkpointInterval?: number;
  indexPath?: string;
  autoSave?: boolean;
  storage?: IndexStorage;
  // Internal-only for fromJSON
  __preloaded?: { meta: IndexMeta; lines: LineInfo[] };
  __filePathOverride?: string;
};

export class JsonlIndex {
  private readonly storage: IndexStorage;
  private readonly progressFallback: ProgressStorage;
  private readonly autoSave: boolean;
  private readonly checkpointInterval: number;
  private readonly indexKey: string;
  private readonly filePathValue: string;
  private initPromise: Promise<void> | null = null;

  private meta: IndexMeta | null = null;
  private lines: LineInfo[] = [];

  constructor(filePath: string, options: JsonlIndexOptions = {}) {
    const resolvedPath = options.__filePathOverride
      ? path.resolve(options.__filePathOverride)
      : path.resolve(filePath);

    this.filePathValue = resolvedPath;
    this.checkpointInterval = options.checkpointInterval ?? DEFAULT_CHECKPOINT_INTERVAL;
    this.autoSave = options.autoSave ?? true;
    this.storage = options.storage ?? new FileStorage();
    this.progressFallback = new FileStorage();

    this.indexKey = options.indexPath
      ? path.resolve(options.indexPath)
      : replaceSuffix(this.filePathValue, ".idx");

    if (options.__preloaded) {
      this.meta = options.__preloaded.meta;
      this.lines = options.__preloaded.lines;
      return;
    }

    if (this.storage instanceof FileStorage || this.storage instanceof MemoryStorage) {
      this.loadOrBuildSync();
    } else {
      this.initPromise = this.loadOrBuildAsync();
    }
  }

  static fromJSON(
    data: { meta: IndexMeta; lines: [number, number][] },
    file: FileSource,
  ): JsonlIndex {
    const meta = data.meta;
    const lines = data.lines.map((line, index) => new LineInfo(index, line[0], line[1]));
    const filePath =
      typeof (file as unknown as { filePath?: string }).filePath === "string"
        ? (file as unknown as { filePath: string }).filePath
        : meta.filePath || "unknown";

    return new JsonlIndex(filePath, {
      __preloaded: {
        meta: new IndexMeta({ ...meta, checkpoints: { ...meta.checkpoints } }),
        lines,
      },
      __filePathOverride: filePath,
      autoSave: false,
      storage: new MemoryStorage(),
    });
  }

  private async ready(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }
  }

  private loadOrBuildSync(): void {
    if (!fs.existsSync(this.filePathValue)) {
      throw new Error(`JSONL file not found: ${this.filePathValue}`);
    }

    const stats = fs.statSync(this.filePathValue);
    const currentSize = stats.size;
    const currentMtime = stats.mtimeMs / 1000;

    if (this.storage instanceof FileStorage || this.storage instanceof MemoryStorage) {
      const loaded = this.storage.loadSync(this.indexKey);
      if (loaded?.meta.isFresh(currentSize, currentMtime)) {
        this.meta = loaded.meta;
        this.lines = loaded.lines;
        return;
      }
    }

    this.buildIndexSync(currentSize, currentMtime);

    if (this.autoSave) {
      if (this.storage instanceof FileStorage || this.storage instanceof MemoryStorage) {
        this.storage.saveSync(this.indexKey, this.meta as IndexMeta, this.lines);
      }
    }
  }

  private async loadOrBuildAsync(): Promise<void> {
    const stats = await fsPromises.stat(this.filePathValue);
    const currentSize = stats.size;
    const currentMtime = stats.mtimeMs / 1000;

    const loaded = await this.storage.load(this.indexKey);
    if (loaded?.meta.isFresh(currentSize, currentMtime)) {
      this.meta = loaded.meta;
      this.lines = loaded.lines;
      return;
    }

    await this.buildIndexAsync(currentSize, currentMtime);

    if (this.autoSave && this.meta) {
      await this.storage.save(this.indexKey, this.meta, this.lines);
    }
  }

  private buildIndexSync(fileSize: number, fileMtime: number): void {
    const fd = fs.openSync(this.filePathValue, "r");
    const lines: LineInfo[] = [];
    const checkpoints: Record<number, number> = {};

    let buffer = Buffer.alloc(0);
    let offset = 0;
    let readOffset = 0;
    let lineNumber = 0;

    try {
      while (readOffset < fileSize) {
        const toRead = Math.min(DEFAULT_CHUNK_SIZE, fileSize - readOffset);
        const chunk = Buffer.allocUnsafe(toRead);
        const bytesRead = fs.readSync(fd, chunk, 0, toRead, readOffset);
        if (bytesRead === 0) {
          break;
        }

        const slice = bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead);
        readOffset += bytesRead;
        const combined = buffer.length ? Buffer.concat([buffer, slice]) : slice;

        let start = 0;
        for (let i = 0; i < combined.length; i += 1) {
          if (combined[i] === 0x0a) {
            const length = i - start + 1;
            lines.push(new LineInfo(lineNumber, offset, length));
            if (lineNumber % this.checkpointInterval === 0) {
              checkpoints[lineNumber] = offset;
            }
            lineNumber += 1;
            offset += length;
            start = i + 1;
          }
        }

        buffer = combined.subarray(start);
      }

      if (buffer.length > 0) {
        lines.push(new LineInfo(lineNumber, offset, buffer.length));
        if (lineNumber % this.checkpointInterval === 0) {
          checkpoints[lineNumber] = offset;
        }
      }
    } finally {
      fs.closeSync(fd);
    }

    this.lines = lines;
    this.meta = new IndexMeta({
      filePath: this.filePathValue,
      fileSize,
      fileMtime,
      totalLines: lines.length,
      checkpointInterval: this.checkpointInterval,
      checkpoints,
    });
  }

  private async buildIndexAsync(fileSize: number, fileMtime: number): Promise<void> {
    const handle = await fsPromises.open(this.filePathValue, "r");
    const lines: LineInfo[] = [];
    const checkpoints: Record<number, number> = {};

    let buffer = Buffer.alloc(0);
    let offset = 0;
    let readOffset = 0;
    let lineNumber = 0;

    try {
      while (readOffset < fileSize) {
        const toRead = Math.min(DEFAULT_CHUNK_SIZE, fileSize - readOffset);
        const chunk = Buffer.allocUnsafe(toRead);
        const { bytesRead } = await handle.read(chunk, 0, toRead, readOffset);
        if (bytesRead === 0) {
          break;
        }

        const slice = bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead);
        readOffset += bytesRead;
        const combined = buffer.length ? Buffer.concat([buffer, slice]) : slice;

        let start = 0;
        for (let i = 0; i < combined.length; i += 1) {
          if (combined[i] === 0x0a) {
            const length = i - start + 1;
            lines.push(new LineInfo(lineNumber, offset, length));
            if (lineNumber % this.checkpointInterval === 0) {
              checkpoints[lineNumber] = offset;
            }
            lineNumber += 1;
            offset += length;
            start = i + 1;
          }
        }

        buffer = combined.subarray(start);
      }

      if (buffer.length > 0) {
        lines.push(new LineInfo(lineNumber, offset, buffer.length));
        if (lineNumber % this.checkpointInterval === 0) {
          checkpoints[lineNumber] = offset;
        }
      }
    } finally {
      await handle.close();
    }

    this.lines = lines;
    this.meta = new IndexMeta({
      filePath: this.filePathValue,
      fileSize,
      fileMtime,
      totalLines: lines.length,
      checkpointInterval: this.checkpointInterval,
      checkpoints,
    });
  }

  get totalLines(): number {
    return this.meta?.totalLines ?? 0;
  }

  get fileSize(): number {
    return this.meta?.fileSize ?? 0;
  }

  get filePath(): string {
    return this.filePathValue;
  }

  get progressPath(): string {
    return replaceSuffix(this.filePathValue, ".progress");
  }

  get progressKey(): string {
    return this.progressPath;
  }

  get progressStorage(): ProgressStorage {
    if (typeof (this.storage as unknown as ProgressStorage).saveJob === "function") {
      return this.storage as unknown as ProgressStorage;
    }
    return this.progressFallback;
  }

  async getStats(): Promise<{ size: number; mtime: number }> {
    const stats = await fsPromises.stat(this.filePathValue);
    return { size: stats.size, mtime: stats.mtimeMs / 1000 };
  }

  getOffset(lineNumber: number): { offset: number; length: number } {
    if (lineNumber < 0 || lineNumber >= this.lines.length) {
      throw new IndexOutOfBoundsError(lineNumber, this.lines.length);
    }
    const info = this.lines[lineNumber];
    return { offset: info.offset, length: info.length };
  }

  async readLine(lineNumber: number): Promise<string> {
    await this.ready();
    const { offset, length } = this.getOffset(lineNumber);
    const buffer = Buffer.alloc(length);
    const handle = await fsPromises.open(this.filePathValue, "r");
    try {
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return stripLineEnding(buffer.subarray(0, bytesRead).toString("utf8"));
    } finally {
      await handle.close();
    }
  }

  async readJson<T = unknown>(lineNumber: number): Promise<T> {
    const line = await this.readLine(lineNumber);
    return JSON.parse(line) as T;
  }

  async readLineMany(lineNumbers: number[]): Promise<string[]> {
    await this.ready();
    if (lineNumbers.length === 0) {
      return [];
    }

    for (const lineNumber of lineNumbers) {
      if (lineNumber < 0 || lineNumber >= this.lines.length) {
        throw new IndexOutOfBoundsError(lineNumber, this.lines.length);
      }
    }

    const handle = await fsPromises.open(this.filePathValue, "r");
    try {
      const results: string[] = [];
      for (const lineNumber of lineNumbers) {
        const info = this.lines[lineNumber];
        const buffer = Buffer.alloc(info.length);
        const { bytesRead } = await handle.read(buffer, 0, info.length, info.offset);
        results.push(stripLineEnding(buffer.subarray(0, bytesRead).toString("utf8")));
      }
      return results;
    } finally {
      await handle.close();
    }
  }

  async readJsonMany<T = unknown>(lineNumbers: number[]): Promise<T[]> {
    const lines = await this.readLineMany(lineNumbers);
    return lines.map((line) => JSON.parse(line) as T);
  }

  *iterFrom(startLine = 0): Generator<string> {
    const effectiveStart = Math.max(startLine, 0);
    if (effectiveStart >= this.lines.length) {
      return;
    }

    if (this.initPromise) {
      throw new Error("Index not ready. Await async initialization before iterating.");
    }

    const fd = fs.openSync(this.filePathValue, "r");
    try {
      for (let lineNumber = effectiveStart; lineNumber < this.lines.length; lineNumber += 1) {
        const info = this.lines[lineNumber];
        const buffer = Buffer.alloc(info.length);
        const bytesRead = fs.readSync(fd, buffer, 0, info.length, info.offset);
        yield stripLineEnding(buffer.subarray(0, bytesRead).toString("utf8"));
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  *iterJsonFrom<T = unknown>(startLine = 0): Generator<T> {
    for (const line of this.iterFrom(startLine)) {
      yield JSON.parse(line) as T;
    }
  }

  async *asyncIter(options: IterOptions = {}): AsyncGenerator<string> {
    await this.ready();
    const startLine = options.start ?? 0;
    const skip = options.skip ?? 0;
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    const limit = options.limit;

    if (limit !== undefined && limit <= 0) {
      return;
    }

    let currentLine = startLine + skip;
    if (currentLine < 0) {
      currentLine = 0;
    }
    if (currentLine >= this.lines.length) {
      return;
    }

    let yielded = 0;
    while (currentLine < this.lines.length) {
      if (limit !== undefined && yielded >= limit) {
        break;
      }

      let batchEnd = Math.min(currentLine + Math.max(batchSize, 1), this.lines.length);
      if (limit !== undefined) {
        batchEnd = Math.min(batchEnd, currentLine + (limit - yielded));
      }

      const batch = await this.readLineBatch(currentLine, batchEnd);
      for (const line of batch) {
        yield line;
        yielded += 1;
        if (limit !== undefined && yielded >= limit) {
          break;
        }
      }

      currentLine = batchEnd;
    }
  }

  async *asyncIterJson<T = unknown>(options: JsonIterOptions = {}): AsyncGenerator<T> {
    const onDecodeError = options.onDecodeError ?? "raise";
    for await (const line of this.asyncIter(options)) {
      try {
        yield JSON.parse(line) as T;
      } catch (error) {
        if (onDecodeError === "raise") {
          throw error;
        }
        if (onDecodeError === "raw") {
          yield line as unknown as T;
        }
      }
    }
  }

  async *asyncIterRaw(options: IterOptions = {}): AsyncGenerator<Uint8Array> {
    await this.ready();
    const startLine = options.start ?? 0;
    const skip = options.skip ?? 0;
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    const limit = options.limit;

    if (limit !== undefined && limit <= 0) {
      return;
    }

    let currentLine = startLine + skip;
    if (currentLine < 0) {
      currentLine = 0;
    }
    if (currentLine >= this.lines.length) {
      return;
    }

    let yielded = 0;
    while (currentLine < this.lines.length) {
      if (limit !== undefined && yielded >= limit) {
        break;
      }

      let batchEnd = Math.min(currentLine + Math.max(batchSize, 1), this.lines.length);
      if (limit !== undefined) {
        batchEnd = Math.min(batchEnd, currentLine + (limit - yielded));
      }

      const batch = await this.readRawBatch(currentLine, batchEnd);
      for (const raw of batch) {
        yield raw;
        yielded += 1;
        if (limit !== undefined && yielded >= limit) {
          break;
        }
      }

      currentLine = batchEnd;
    }
  }

  toWebStream(options: IterOptions = {}): ReadableStream<string> {
    return toWebStream(this.asyncIter(options));
  }

  toNodeStream(options: IterOptions = {}): NodeJS.ReadableStream {
    return toNodeStream(this.asyncIter(options));
  }

  async sample<T = unknown>(n: number, options: { seed?: number } = {}): Promise<T[]> {
    await this.ready();
    if (this.totalLines === 0 || n <= 0) {
      return [];
    }

    const clamped = clamp(n, 0, this.totalLines);
    const rng = options.seed === undefined ? Math.random : createSeededRng(options.seed);

    const lineNumbers = sampleWithoutReplacement(this.totalLines, clamped, rng);

    const indices = Array.from({ length: lineNumbers.length }, (_, i) => i).sort(
      (a, b) => lineNumbers[a] - lineNumbers[b],
    );

    const sortedLineNumbers = indices.map((i) => lineNumbers[i]);
    const sortedRecords = await this.readJsonMany<T>(sortedLineNumbers);

    const result: T[] = Array(clamped);
    for (let i = 0; i < indices.length; i += 1) {
      result[indices[i]] = sortedRecords[i];
    }

    return result;
  }

  async rebuild(): Promise<void> {
    await this.ready();
    const stats = await this.getStats();
    await this.buildIndexAsync(stats.size, stats.mtime);
    if (this.autoSave && this.meta) {
      await this.storage.save(this.indexKey, this.meta, this.lines);
    }
  }

  async update(): Promise<number> {
    await this.ready();
    if (!this.meta) {
      await this.rebuild();
      return this.totalLines;
    }

    const stats = await this.getStats();
    const oldSize = this.meta.fileSize;

    if (stats.size === oldSize) {
      return 0;
    }

    if (stats.size < oldSize) {
      throw new FileModifiedError(this.filePathValue);
    }

    const newLines = await this.buildAppendAsync(oldSize, stats.size);
    this.meta.fileSize = stats.size;
    this.meta.fileMtime = stats.mtime;
    this.meta.totalLines = this.lines.length;

    if (this.autoSave) {
      await this.storage.save(this.indexKey, this.meta, this.lines);
    }

    return newLines;
  }

  private async buildAppendAsync(startOffset: number, fileSize: number): Promise<number> {
    const handle = await fsPromises.open(this.filePathValue, "r");
    const newLines: LineInfo[] = [];
    const newCheckpoints: Record<number, number> = {};

    let buffer = Buffer.alloc(0);
    let offset = startOffset;
    let readOffset = startOffset;
    let lineNumber = this.lines.length;

    try {
      while (readOffset < fileSize) {
        const toRead = Math.min(DEFAULT_CHUNK_SIZE, fileSize - readOffset);
        const chunk = Buffer.allocUnsafe(toRead);
        const { bytesRead } = await handle.read(chunk, 0, toRead, readOffset);
        if (bytesRead === 0) {
          break;
        }

        const slice = bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead);
        readOffset += bytesRead;
        const combined = buffer.length ? Buffer.concat([buffer, slice]) : slice;

        let start = 0;
        for (let i = 0; i < combined.length; i += 1) {
          if (combined[i] === 0x0a) {
            const length = i - start + 1;
            newLines.push(new LineInfo(lineNumber, offset, length));
            if (lineNumber % this.checkpointInterval === 0) {
              newCheckpoints[lineNumber] = offset;
            }
            lineNumber += 1;
            offset += length;
            start = i + 1;
          }
        }

        buffer = combined.subarray(start);
      }

      if (buffer.length > 0) {
        newLines.push(new LineInfo(lineNumber, offset, buffer.length));
        if (lineNumber % this.checkpointInterval === 0) {
          newCheckpoints[lineNumber] = offset;
        }
      }
    } finally {
      await handle.close();
    }

    this.lines.push(...newLines);
    this.meta?.checkpoints && Object.assign(this.meta.checkpoints, newCheckpoints);

    return newLines.length;
  }

  async save(): Promise<void> {
    await this.ready();
    if (this.meta) {
      await this.storage.save(this.indexKey, this.meta, this.lines);
    }
  }

  toJSON(): { meta: IndexMeta; lines: [number, number][] } {
    if (!this.meta) {
      throw new Error("Index not initialized");
    }
    return {
      meta: new IndexMeta({ ...this.meta, checkpoints: { ...this.meta.checkpoints } }),
      lines: this.lines.map((line) => [line.offset, line.length]),
    };
  }

  batchProcessor(
    jobId: string,
    options: { progressStorage?: ProgressStorage; asJson?: boolean } = {},
  ): BatchProcessor {
    return new BatchProcessor(this, jobId, options);
  }

  async listJobs(storage?: ProgressStorage): Promise<JobInfo[]> {
    const progressStorage = storage ?? this.progressStorage;
    const jobs = await progressStorage.loadJobs(this.progressPath);
    if (!jobs) {
      return [];
    }

    const stats = await this.getStats();
    return Array.from(jobs.values()).map((job) => this.jobToInfo(job, stats.size, stats.mtime));
  }

  async getJob(jobId: string, storage?: ProgressStorage): Promise<JobInfo | null> {
    const progressStorage = storage ?? this.progressStorage;
    const jobs = await progressStorage.loadJobs(this.progressPath);
    if (!jobs || !jobs.has(jobId)) {
      return null;
    }

    const stats = await this.getStats();
    return this.jobToInfo(jobs.get(jobId) as JobProgress, stats.size, stats.mtime);
  }

  async resetJob(jobId: string, storage?: ProgressStorage): Promise<boolean> {
    const progressStorage = storage ?? this.progressStorage;
    return progressStorage.deleteJob(this.progressPath, jobId);
  }

  async deleteJob(jobId: string, storage?: ProgressStorage): Promise<boolean> {
    return this.resetJob(jobId, storage);
  }

  async close(): Promise<void> {
    await this.ready();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private jobToInfo(job: JobProgress, currentSize: number, currentMtime: number): JobInfo {
    const isStale = job.fileSize !== currentSize || job.fileMtime !== currentMtime;
    const progressPct = this.totalLines > 0 ? (job.position / this.totalLines) * 100 : 100;

    return new JobInfo({
      jobId: job.jobId,
      position: job.position,
      status: job.status,
      totalLines: this.totalLines,
      progressPct,
      createdAt: new Date(job.createdAt),
      lastCheckpointAt: new Date(job.lastCheckpointAt),
      completedAt: job.completedAt ? new Date(job.completedAt) : null,
      isStale,
    });
  }

  private async readLineBatch(start: number, end: number): Promise<string[]> {
    this.assertFileState();

    const buffer = await this.readBatchBuffer(start, end);
    const results: string[] = [];
    let cursor = 0;

    for (let lineNumber = start; lineNumber < end; lineNumber += 1) {
      const expected = this.lines[lineNumber].length;
      const slice = buffer.subarray(cursor, cursor + expected);
      if (slice.length !== expected) {
        throw new LineCorruptedError(lineNumber, expected, slice.length);
      }
      results.push(stripLineEnding(Buffer.from(slice).toString("utf8")));
      cursor += expected;
    }

    return results;
  }

  private async readRawBatch(start: number, end: number): Promise<Uint8Array[]> {
    this.assertFileState();

    const buffer = await this.readBatchBuffer(start, end);
    const results: Uint8Array[] = [];
    let cursor = 0;

    for (let lineNumber = start; lineNumber < end; lineNumber += 1) {
      const expected = this.lines[lineNumber].length;
      const slice = buffer.subarray(cursor, cursor + expected);
      if (slice.length !== expected) {
        throw new LineCorruptedError(lineNumber, expected, slice.length);
      }
      results.push(slice);
      cursor += expected;
    }

    return results;
  }

  private async readBatchBuffer(start: number, end: number): Promise<Uint8Array> {
    const startInfo = this.lines[start];
    const endInfo = this.lines[end - 1];
    const startOffset = startInfo.offset;
    const endOffset = endInfo.offset + endInfo.length;
    const totalLength = endOffset - startOffset;

    const handle = await fsPromises.open(this.filePathValue, "r");
    try {
      const buffer = Buffer.alloc(totalLength);
      const { bytesRead } = await handle.read(buffer, 0, totalLength, startOffset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  private assertFileState(): void {
    try {
      const stats = fs.statSync(this.filePathValue);
      if (this.meta && stats.size < this.meta.fileSize) {
        throw new FileTruncatedError(this.filePathValue, this.meta.fileSize, stats.size);
      }
    } catch (error) {
      if (error instanceof FileTruncatedError) {
        throw error;
      }
      throw new FileDeletedError(this.filePathValue);
    }
  }
}

const createSeededRng = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const sampleWithoutReplacement = (total: number, count: number, rng: () => number): number[] => {
  const result = Array.from({ length: total }, (_, i) => i);
  for (let i = 0; i < count; i += 1) {
    const j = i + Math.floor(rng() * (total - i));
    const temp = result[i];
    result[i] = result[j];
    result[j] = temp;
  }
  return result.slice(0, count);
};
