import { BatchProcessor } from "../core/batch";
import { FileModifiedError, IndexOutOfBoundsError, LineCorruptedError } from "../core/errors";
import { IndexMeta, JobInfo, type JobProgress, LineInfo } from "../core/models";
import { clamp } from "../core/utils";
import type { IndexStorage, IterOptions, JsonIterOptions, ProgressStorage } from "../types";
import { MemoryStorage } from "./storage";
import { toWebStream } from "./streams";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_CHECKPOINT_INTERVAL = 100;
const DEFAULT_CHUNK_SIZE = 64 * 1024;

const stripLineEnding = (value: string): string => value.replace(/[\r\n]+$/, "");

const concatChunks = (chunks: Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};

type JsonlIndexOptions = {
  checkpointInterval?: number;
  autoSave?: boolean;
  storage?: IndexStorage;
  __preloaded?: { meta: IndexMeta; lines: LineInfo[] };
};

export class JsonlIndex {
  private readonly file: File;
  private readonly storage: IndexStorage | null;
  private readonly autoSave: boolean;
  private readonly checkpointInterval: number;
  private readonly indexKey: string;
  private readonly progressFallback: ProgressStorage;

  private meta: IndexMeta | null = null;
  private lines: LineInfo[] = [];
  private initPromise: Promise<void> | null = null;

  private readonly decoder = new TextDecoder("utf-8");

  constructor(file: File, options: JsonlIndexOptions = {}) {
    this.file = file;
    this.storage = options.storage ?? null;
    this.autoSave = options.autoSave ?? false;
    this.checkpointInterval = options.checkpointInterval ?? DEFAULT_CHECKPOINT_INTERVAL;
    this.indexKey = `${file.name || "file"}.idx`;
    this.progressFallback = new MemoryStorage();

    if (options.__preloaded) {
      this.meta = options.__preloaded.meta;
      this.lines = options.__preloaded.lines;
      return;
    }

    this.initPromise = this.loadOrBuild();
  }

  static fromJSON(data: { meta: IndexMeta; lines: [number, number][] }, file: File): JsonlIndex {
    const meta = data.meta;
    const lines = data.lines.map((line, index) => new LineInfo(index, line[0], line[1]));
    return new JsonlIndex(file, {
      __preloaded: {
        meta: new IndexMeta({ ...meta, checkpoints: { ...meta.checkpoints } }),
        lines,
      },
      autoSave: false,
      storage: new MemoryStorage(),
    });
  }

  private async ready(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }
  }

  private async loadOrBuild(): Promise<void> {
    const stats = await this.getStats();

    if (this.storage) {
      const loaded = await this.storage.load(this.indexKey);
      if (loaded?.meta.isFresh(stats.size, stats.mtime)) {
        this.meta = loaded.meta;
        this.lines = loaded.lines;
        return;
      }
    }

    await this.buildIndex(stats.size, stats.mtime);

    if (this.autoSave && this.storage && this.meta) {
      await this.storage.save(this.indexKey, this.meta, this.lines);
    }
  }

  private async buildIndex(fileSize: number, fileMtime: number): Promise<void> {
    const lines: LineInfo[] = [];
    const checkpoints: Record<number, number> = {};

    let buffer = new Uint8Array();
    let offset = 0;
    let readOffset = 0;
    let lineNumber = 0;

    while (readOffset < fileSize) {
      const toRead = Math.min(DEFAULT_CHUNK_SIZE, fileSize - readOffset);
      const slice = this.file.slice(readOffset, readOffset + toRead);
      const chunk = new Uint8Array(await slice.arrayBuffer());
      if (chunk.length === 0) {
        break;
      }

      readOffset += chunk.length;
      const combined = buffer.length ? concatChunks([buffer, chunk]) : chunk;

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

      buffer = new Uint8Array(combined.subarray(start));
    }

    if (buffer.length > 0) {
      lines.push(new LineInfo(lineNumber, offset, buffer.length));
      if (lineNumber % this.checkpointInterval === 0) {
        checkpoints[lineNumber] = offset;
      }
    }

    this.lines = lines;
    this.meta = new IndexMeta({
      filePath: this.file.name || "file",
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
    return this.meta?.filePath ?? this.file.name;
  }

  get progressKey(): string {
    return `${this.file.name || "file"}.progress`;
  }

  get progressStorage(): ProgressStorage {
    if (
      this.storage &&
      typeof (this.storage as unknown as ProgressStorage).saveJob === "function"
    ) {
      return this.storage as unknown as ProgressStorage;
    }
    return this.progressFallback;
  }

  async getStats(): Promise<{ size: number; mtime: number }> {
    const mtime = typeof this.file.lastModified === "number" ? this.file.lastModified / 1000 : 0;
    return { size: this.file.size, mtime };
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
    const slice = this.file.slice(offset, offset + length);
    const buffer = new Uint8Array(await slice.arrayBuffer());
    return stripLineEnding(this.decoder.decode(buffer));
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

    const results: string[] = [];
    for (const lineNumber of lineNumbers) {
      results.push(await this.readLine(lineNumber));
    }
    return results;
  }

  async readJsonMany<T = unknown>(lineNumbers: number[]): Promise<T[]> {
    const lines = await this.readLineMany(lineNumbers);
    return lines.map((line) => JSON.parse(line) as T);
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
    const stats = await this.getStats();
    await this.buildIndex(stats.size, stats.mtime);
    if (this.autoSave && this.storage && this.meta) {
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
    if (stats.size === this.meta.fileSize) {
      return 0;
    }

    if (stats.size < this.meta.fileSize) {
      throw new FileModifiedError(this.file.name || "file");
    }

    const oldTotal = this.totalLines;
    await this.buildIndex(stats.size, stats.mtime);
    if (this.autoSave && this.storage && this.meta) {
      await this.storage.save(this.indexKey, this.meta, this.lines);
    }
    return this.totalLines - oldTotal;
  }

  async save(): Promise<void> {
    await this.ready();
    if (this.storage && this.meta) {
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
    const jobs = await progressStorage.loadJobs(this.progressKey);
    if (!jobs) {
      return [];
    }
    const stats = await this.getStats();
    return Array.from(jobs.values()).map((job) => this.jobToInfo(job, stats.size, stats.mtime));
  }

  async getJob(jobId: string, storage?: ProgressStorage): Promise<JobInfo | null> {
    const progressStorage = storage ?? this.progressStorage;
    const jobs = await progressStorage.loadJobs(this.progressKey);
    if (!jobs || !jobs.has(jobId)) {
      return null;
    }
    const stats = await this.getStats();
    return this.jobToInfo(jobs.get(jobId) as JobProgress, stats.size, stats.mtime);
  }

  async resetJob(jobId: string, storage?: ProgressStorage): Promise<boolean> {
    const progressStorage = storage ?? this.progressStorage;
    return progressStorage.deleteJob(this.progressKey, jobId);
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

  private async readLineBatch(start: number, end: number): Promise<string[]> {
    const buffer = await this.readBatchBuffer(start, end);
    const results: string[] = [];
    let cursor = 0;

    for (let lineNumber = start; lineNumber < end; lineNumber += 1) {
      const expected = this.lines[lineNumber].length;
      const slice = buffer.subarray(cursor, cursor + expected);
      if (slice.length !== expected) {
        throw new LineCorruptedError(lineNumber, expected, slice.length);
      }
      results.push(stripLineEnding(this.decoder.decode(slice)));
      cursor += expected;
    }

    return results;
  }

  private async readRawBatch(start: number, end: number): Promise<Uint8Array[]> {
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

    const slice = this.file.slice(startOffset, endOffset);
    const buffer = new Uint8Array(await slice.arrayBuffer());
    if (buffer.length < totalLength) {
      return buffer;
    }
    return buffer;
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
