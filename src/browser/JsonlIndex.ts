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

/**
 * Options for creating a browser JsonlIndex instance.
 */
type JsonlIndexOptions = {
  /** Interval at which checkpoints are stored (default: 100) */
  checkpointInterval?: number;
  /** Whether to automatically save the index after building (default: false) */
  autoSave?: boolean;
  /** Custom storage adapter for index persistence (e.g., IndexedDBStorage) */
  storage?: IndexStorage;
  __preloaded?: { meta: IndexMeta; lines: LineInfo[] };
};

/**
 * O(1) random access and resumable iteration for JSONL files in the browser.
 *
 * Creates a byte-offset index that enables instant seeking to any line
 * without scanning the entire file. Works with File objects from file inputs.
 *
 * @example
 * ```typescript
 * import { JsonlIndex } from 'jsonl-resumable/browser';
 *
 * // Create index from file input
 * const index = new JsonlIndex(fileFromInput);
 *
 * // O(1) random access
 * const record = await index.readJson<MyType>(1000);
 *
 * // Iterate over all records
 * for await (const data of index.asyncIterJson<MyType>()) {
 *   process(data);
 * }
 * ```
 */
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

  /**
   * Creates a new JsonlIndex for the specified File object.
   *
   * The index is built asynchronously in the background.
   *
   * @param file - File object from file input or drag-and-drop
   * @param options - Configuration options
   */
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

  /**
   * Creates a JsonlIndex from serialized JSON data.
   *
   * @param data - Serialized index data from toJSON()
   * @param file - File object to associate with the index
   * @returns A new JsonlIndex instance with the loaded index
   */
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

  /** Total number of lines in the indexed file. */
  get totalLines(): number {
    return this.meta?.totalLines ?? 0;
  }

  /** Size of the indexed file in bytes. */
  get fileSize(): number {
    return this.meta?.fileSize ?? 0;
  }

  /** Name of the JSONL file. */
  get filePath(): string {
    return this.meta?.filePath ?? this.file.name;
  }

  /** Key used for progress storage. */
  get progressKey(): string {
    return `${this.file.name || "file"}.progress`;
  }

  /** Storage adapter for batch processing progress. */
  get progressStorage(): ProgressStorage {
    if (
      this.storage &&
      typeof (this.storage as unknown as ProgressStorage).saveJob === "function"
    ) {
      return this.storage as unknown as ProgressStorage;
    }
    return this.progressFallback;
  }

  /**
   * Gets current file stats (size and modification time).
   * @returns Object with size in bytes and mtime as Unix timestamp
   */
  async getStats(): Promise<{ size: number; mtime: number }> {
    const mtime = typeof this.file.lastModified === "number" ? this.file.lastModified / 1000 : 0;
    return { size: this.file.size, mtime };
  }

  /**
   * Gets the byte offset and length for a specific line.
   *
   * @param lineNumber - Zero-indexed line number
   * @returns Object with byte offset and length
   * @throws IndexOutOfBoundsError if line number is out of range
   */
  getOffset(lineNumber: number): { offset: number; length: number } {
    if (lineNumber < 0 || lineNumber >= this.lines.length) {
      throw new IndexOutOfBoundsError(lineNumber, this.lines.length);
    }
    const info = this.lines[lineNumber];
    return { offset: info.offset, length: info.length };
  }

  /**
   * Reads a single line as a string (O(1) operation).
   *
   * @param lineNumber - Zero-indexed line number
   * @returns The line content without trailing newline
   * @throws IndexOutOfBoundsError if line number is out of range
   */
  async readLine(lineNumber: number): Promise<string> {
    await this.ready();
    const { offset, length } = this.getOffset(lineNumber);
    const slice = this.file.slice(offset, offset + length);
    const buffer = new Uint8Array(await slice.arrayBuffer());
    return stripLineEnding(this.decoder.decode(buffer));
  }

  /**
   * Reads a single line and parses it as JSON (O(1) operation).
   *
   * @typeParam T - Expected type of the parsed JSON
   * @param lineNumber - Zero-indexed line number
   * @returns Parsed JSON object
   * @throws IndexOutOfBoundsError if line number is out of range
   */
  async readJson<T = unknown>(lineNumber: number): Promise<T> {
    const line = await this.readLine(lineNumber);
    return JSON.parse(line) as T;
  }

  /**
   * Reads multiple lines as strings.
   *
   * @param lineNumbers - Array of zero-indexed line numbers
   * @returns Array of line contents in the same order
   * @throws IndexOutOfBoundsError if any line number is out of range
   */
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

  /**
   * Reads multiple lines and parses them as JSON.
   *
   * @typeParam T - Expected type of the parsed JSON
   * @param lineNumbers - Array of zero-indexed line numbers
   * @returns Array of parsed JSON objects in the same order
   * @throws IndexOutOfBoundsError if any line number is out of range
   */
  async readJsonMany<T = unknown>(lineNumbers: number[]): Promise<T[]> {
    const lines = await this.readLineMany(lineNumbers);
    return lines.map((line) => JSON.parse(line) as T);
  }

  /**
   * Asynchronously iterates over lines with configurable options.
   *
   * @param options - Iteration options (start, skip, limit, batchSize)
   * @yields Lines as strings without trailing newlines
   */
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

  /**
   * Asynchronously iterates over lines as parsed JSON.
   *
   * @typeParam T - Expected type of the parsed JSON
   * @param options - Iteration options including onDecodeError behavior
   * @yields Parsed JSON objects (or raw strings if onDecodeError is 'raw')
   */
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

  /**
   * Asynchronously iterates over raw line bytes.
   *
   * @param options - Iteration options (start, skip, limit, batchSize)
   * @yields Raw line data as Uint8Array (including newlines)
   */
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

  /**
   * Creates a Web ReadableStream from the index.
   *
   * @param options - Iteration options (start, skip, limit, batchSize)
   * @returns Web ReadableStream of line strings
   */
  toWebStream(options: IterOptions = {}): ReadableStream<string> {
    return toWebStream(this.asyncIter(options));
  }

  /**
   * Returns a random sample of records from the file.
   *
   * @typeParam T - Expected type of the parsed JSON records
   * @param n - Number of records to sample
   * @param options - Optional seed for reproducible sampling
   * @returns Array of randomly sampled records
   */
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

  /**
   * Rebuilds the index from scratch.
   *
   * Use this after the file has been modified.
   */
  async rebuild(): Promise<void> {
    const stats = await this.getStats();
    await this.buildIndex(stats.size, stats.mtime);
    if (this.autoSave && this.storage && this.meta) {
      await this.storage.save(this.indexKey, this.meta, this.lines);
    }
  }

  /**
   * Updates the index if the file has changed.
   *
   * Note: In the browser, this rebuilds the entire index since
   * File objects don't support incremental reads.
   *
   * @returns Number of new lines added
   * @throws FileModifiedError if the file was truncated
   */
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

  /**
   * Saves the index to storage.
   *
   * Requires a storage adapter (e.g., IndexedDBStorage) to be configured.
   */
  async save(): Promise<void> {
    await this.ready();
    if (this.storage && this.meta) {
      await this.storage.save(this.indexKey, this.meta, this.lines);
    }
  }

  /**
   * Serializes the index to a JSON-compatible format.
   *
   * @returns Object containing meta and lines data
   * @throws Error if index is not initialized
   */
  toJSON(): { meta: IndexMeta; lines: [number, number][] } {
    if (!this.meta) {
      throw new Error("Index not initialized");
    }
    return {
      meta: new IndexMeta({ ...this.meta, checkpoints: { ...this.meta.checkpoints } }),
      lines: this.lines.map((line) => [line.offset, line.length]),
    };
  }

  /**
   * Creates a batch processor for fault-tolerant iteration.
   *
   * @param jobId - Unique identifier for the processing job
   * @param options - Optional progress storage and JSON parsing options
   * @returns BatchProcessor instance for processing with checkpointing
   */
  batchProcessor(
    jobId: string,
    options: { progressStorage?: ProgressStorage; asJson?: boolean } = {},
  ): BatchProcessor {
    return new BatchProcessor(this, jobId, options);
  }

  /**
   * Lists all processing jobs for this file.
   *
   * @param storage - Optional custom progress storage
   * @returns Array of job info objects
   */
  async listJobs(storage?: ProgressStorage): Promise<JobInfo[]> {
    const progressStorage = storage ?? this.progressStorage;
    const jobs = await progressStorage.loadJobs(this.progressKey);
    if (!jobs) {
      return [];
    }
    const stats = await this.getStats();
    return Array.from(jobs.values()).map((job) => this.jobToInfo(job, stats.size, stats.mtime));
  }

  /**
   * Gets information about a specific processing job.
   *
   * @param jobId - Job identifier
   * @param storage - Optional custom progress storage
   * @returns Job info or null if not found
   */
  async getJob(jobId: string, storage?: ProgressStorage): Promise<JobInfo | null> {
    const progressStorage = storage ?? this.progressStorage;
    const jobs = await progressStorage.loadJobs(this.progressKey);
    if (!jobs || !jobs.has(jobId)) {
      return null;
    }
    const stats = await this.getStats();
    return this.jobToInfo(jobs.get(jobId) as JobProgress, stats.size, stats.mtime);
  }

  /**
   * Resets a processing job to start from the beginning.
   *
   * @param jobId - Job identifier
   * @param storage - Optional custom progress storage
   * @returns True if the job was reset, false if not found
   */
  async resetJob(jobId: string, storage?: ProgressStorage): Promise<boolean> {
    const progressStorage = storage ?? this.progressStorage;
    return progressStorage.deleteJob(this.progressKey, jobId);
  }

  /**
   * Deletes a processing job's progress.
   *
   * @param jobId - Job identifier
   * @param storage - Optional custom progress storage
   * @returns True if the job was deleted, false if not found
   */
  async deleteJob(jobId: string, storage?: ProgressStorage): Promise<boolean> {
    return this.resetJob(jobId, storage);
  }

  /**
   * Closes the index and releases resources.
   */
  async close(): Promise<void> {
    await this.ready();
  }

  /**
   * Async dispose method for TC39 explicit resource management.
   */
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
