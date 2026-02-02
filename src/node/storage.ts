import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as path from "node:path";

import { JobProgress } from "../core/models";
import { deserializeIndex, serializeIndex } from "../core/serialization";
import type { IndexMeta, IndexStorage, LineInfo, ProgressStorage } from "../types";

const PROGRESS_FORMAT_VERSION = "1.0";

const resolveKey = (basePath: string | undefined, key: string): string => {
  if (!basePath) {
    return key;
  }
  if (path.isAbsolute(key)) {
    return key;
  }
  return path.resolve(basePath, key);
};

const serializeJobs = (jobs: Map<string, JobProgress>) => ({
  format_version: PROGRESS_FORMAT_VERSION,
  jobs: Object.fromEntries(
    Array.from(jobs.entries()).map(([jobId, job]) => [
      jobId,
      {
        position: job.position,
        file_size: job.fileSize,
        file_mtime: job.fileMtime,
        status: job.status,
        created_at: job.createdAt,
        last_checkpoint_at: job.lastCheckpointAt,
        completed_at: job.completedAt,
      },
    ]),
  ),
});

const deserializeJobs = (data: unknown): Map<string, JobProgress> | null => {
  if (data === null || typeof data !== "object") {
    return null;
  }
  const record = data as Record<string, unknown>;
  if (record.format_version !== PROGRESS_FORMAT_VERSION) {
    return null;
  }
  const jobsRaw = record.jobs;
  if (!jobsRaw || typeof jobsRaw !== "object") {
    return new Map();
  }

  const jobs = new Map<string, JobProgress>();
  for (const [jobId, value] of Object.entries(jobsRaw)) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const jobData = value as Record<string, unknown>;
    if (
      typeof jobData.position !== "number" ||
      typeof jobData.file_size !== "number" ||
      typeof jobData.file_mtime !== "number" ||
      typeof jobData.status !== "string" ||
      typeof jobData.created_at !== "string" ||
      typeof jobData.last_checkpoint_at !== "string"
    ) {
      return null;
    }

    jobs.set(
      jobId,
      new JobProgress({
        jobId,
        position: jobData.position,
        fileSize: jobData.file_size,
        fileMtime: jobData.file_mtime,
        status: jobData.status as "in_progress" | "completed",
        createdAt: jobData.created_at,
        lastCheckpointAt: jobData.last_checkpoint_at,
        completedAt:
          typeof jobData.completed_at === "string" || jobData.completed_at === null
            ? jobData.completed_at
            : null,
      }),
    );
  }

  return jobs;
};

export class FileStorage implements IndexStorage, ProgressStorage {
  private readonly basePath?: string;

  constructor(basePath?: string) {
    this.basePath = basePath;
  }

  private resolve(key: string): string {
    return resolveKey(this.basePath, key);
  }

  async save(key: string, meta: IndexMeta, lines: LineInfo[]): Promise<void> {
    const filePath = this.resolve(key);
    const data = serializeIndex(meta, lines);
    await fs.writeFile(filePath, JSON.stringify(data), "utf8");
  }

  async load(key: string): Promise<{ meta: IndexMeta; lines: LineInfo[] } | null> {
    const filePath = this.resolve(key);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      return deserializeIndex(parsed);
    } catch {
      return null;
    }
  }

  saveSync(key: string, meta: IndexMeta, lines: LineInfo[]): void {
    const filePath = this.resolve(key);
    const data = serializeIndex(meta, lines);
    fsSync.writeFileSync(filePath, JSON.stringify(data), "utf8");
  }

  loadSync(key: string): { meta: IndexMeta; lines: LineInfo[] } | null {
    const filePath = this.resolve(key);
    try {
      const raw = fsSync.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      return deserializeIndex(parsed);
    } catch {
      return null;
    }
  }

  async saveJob(key: string, job: JobProgress): Promise<void> {
    const filePath = this.resolve(key);
    const jobs = (await this.loadJobs(key)) ?? new Map();
    jobs.set(job.jobId, job);
    await fs.writeFile(filePath, JSON.stringify(serializeJobs(jobs)), "utf8");
  }

  async loadJobs(key: string): Promise<Map<string, JobProgress> | null> {
    const filePath = this.resolve(key);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      return deserializeJobs(parsed);
    } catch {
      return null;
    }
  }

  async deleteJob(key: string, jobId: string): Promise<boolean> {
    const filePath = this.resolve(key);
    const jobs = await this.loadJobs(key);
    if (!jobs || !jobs.has(jobId)) {
      return false;
    }
    jobs.delete(jobId);
    await fs.writeFile(filePath, JSON.stringify(serializeJobs(jobs)), "utf8");
    return true;
  }
}

export class MemoryStorage implements IndexStorage, ProgressStorage {
  private readonly indexStore = new Map<string, { meta: IndexMeta; lines: LineInfo[] }>();
  private readonly jobStore = new Map<string, Map<string, JobProgress>>();

  async save(key: string, meta: IndexMeta, lines: LineInfo[]): Promise<void> {
    this.indexStore.set(key, { meta, lines: [...lines] });
  }

  async load(key: string): Promise<{ meta: IndexMeta; lines: LineInfo[] } | null> {
    const stored = this.indexStore.get(key);
    if (!stored) {
      return null;
    }
    return { meta: stored.meta, lines: [...stored.lines] };
  }

  saveSync(key: string, meta: IndexMeta, lines: LineInfo[]): void {
    this.indexStore.set(key, { meta, lines: [...lines] });
  }

  loadSync(key: string): { meta: IndexMeta; lines: LineInfo[] } | null {
    const stored = this.indexStore.get(key);
    if (!stored) {
      return null;
    }
    return { meta: stored.meta, lines: [...stored.lines] };
  }

  async saveJob(key: string, job: JobProgress): Promise<void> {
    const jobs = this.jobStore.get(key) ?? new Map();
    jobs.set(job.jobId, job);
    this.jobStore.set(key, jobs);
  }

  async loadJobs(key: string): Promise<Map<string, JobProgress> | null> {
    return this.jobStore.get(key) ?? null;
  }

  async deleteJob(key: string, jobId: string): Promise<boolean> {
    const jobs = this.jobStore.get(key);
    if (!jobs || !jobs.has(jobId)) {
      return false;
    }
    jobs.delete(jobId);
    return true;
  }
}
