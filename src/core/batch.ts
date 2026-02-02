import type { IterOptions, JsonIterOptions, ProgressStorage } from "../types";
import { InvalidCheckpointError, StaleCheckpointError } from "./errors";
import { JobProgress } from "./models";

const nowIso = (): string => new Date().toISOString();

export interface BatchIndex {
  totalLines: number;
  progressKey: string;
  progressStorage: ProgressStorage;
  getStats(): Promise<{ size: number; mtime: number }>;
  asyncIter(options?: IterOptions): AsyncGenerator<string>;
  asyncIterJson<T = unknown>(options?: JsonIterOptions): AsyncGenerator<T>;
}

type BatchOptions = {
  progressStorage?: ProgressStorage;
  asJson?: boolean;
};

export class BatchProcessor {
  private readonly index: BatchIndex;
  private readonly jobIdInternal: string;
  private readonly progressKey: string;
  private readonly progressStorage: ProgressStorage;
  private readonly asJson: boolean;

  private job: JobProgress | null = null;
  private positionValue = 0;
  private exhausted = false;
  private started = false;

  constructor(index: BatchIndex, jobId: string, options: BatchOptions = {}) {
    this.index = index;
    this.jobIdInternal = jobId;
    this.progressKey = index.progressKey;
    this.progressStorage = options.progressStorage ?? index.progressStorage;
    this.asJson = options.asJson ?? true;
  }

  async start(): Promise<BatchProcessor> {
    const stats = await this.index.getStats();
    const jobs = await this.progressStorage.loadJobs(this.progressKey);

    if (jobs?.has(this.jobIdInternal)) {
      const existing = jobs.get(this.jobIdInternal) as JobProgress;
      if (existing.fileSize !== stats.size || existing.fileMtime !== stats.mtime) {
        throw new StaleCheckpointError(
          this.jobIdInternal,
          { size: existing.fileSize, mtime: existing.fileMtime },
          { size: stats.size, mtime: stats.mtime },
        );
      }
      if (existing.position > this.index.totalLines) {
        throw new InvalidCheckpointError(
          this.jobIdInternal,
          existing.position,
          this.index.totalLines,
        );
      }
      this.job = existing;
      this.positionValue = existing.position;
    } else {
      const now = nowIso();
      this.job = new JobProgress({
        jobId: this.jobIdInternal,
        position: 0,
        fileSize: stats.size,
        fileMtime: stats.mtime,
        status: "in_progress",
        createdAt: now,
        lastCheckpointAt: now,
      });
      await this.progressStorage.saveJob(this.progressKey, this.job);
      this.positionValue = 0;
    }

    this.started = true;
    return this;
  }

  async end(): Promise<void> {
    if (!this.job) {
      return;
    }
    if (this.exhausted) {
      const now = nowIso();
      this.job.status = "completed";
      this.job.completedAt = now;
      this.job.lastCheckpointAt = now;
      await this.progressStorage.saveJob(this.progressKey, this.job);
    }
  }

  async run<T>(callback: (batch: BatchProcessor) => Promise<T>): Promise<T> {
    await this.start();
    try {
      return await callback(this);
    } finally {
      await this.end();
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.end();
  }

  async checkpoint(): Promise<void> {
    if (!this.job) {
      throw new Error("Cannot checkpoint before start()");
    }
    const now = nowIso();
    this.job.position = this.positionValue;
    this.job.lastCheckpointAt = now;
    await this.progressStorage.saveJob(this.progressKey, this.job);
  }

  async reset(): Promise<void> {
    await this.progressStorage.deleteJob(this.progressKey, this.jobIdInternal);
    this.positionValue = 0;
    this.job = null;
    this.exhausted = false;
    this.started = false;
  }

  get position(): number {
    return this.positionValue;
  }

  get totalLines(): number {
    return this.index.totalLines;
  }

  get progress(): number {
    if (this.totalLines === 0) {
      return 100;
    }
    return (this.positionValue / this.totalLines) * 100;
  }

  get jobId(): string {
    return this.jobIdInternal;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<[number, unknown]> {
    if (!this.started) {
      throw new Error("BatchProcessor must be started before iteration");
    }

    if (this.job && this.job.status === "completed") {
      this.exhausted = true;
      return;
    }

    const start = this.positionValue;
    const options: JsonIterOptions = { start };

    if (this.asJson) {
      for await (const record of this.index.asyncIterJson(options)) {
        const lineNumber = this.positionValue;
        this.positionValue += 1;
        yield [lineNumber, record];
      }
    } else {
      for await (const line of this.index.asyncIter(options)) {
        const lineNumber = this.positionValue;
        this.positionValue += 1;
        yield [lineNumber, line];
      }
    }

    this.exhausted = true;
  }
}
