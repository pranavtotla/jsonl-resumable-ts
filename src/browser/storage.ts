import { JobProgress } from "../core/models";
import { deserializeIndex, serializeIndex } from "../core/serialization";
import type { IndexMeta, IndexStorage, LineInfo, ProgressStorage } from "../types";

const PROGRESS_FORMAT_VERSION = "1.0";

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
  if (!data || typeof data !== "object") {
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

const requestToPromise = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const transactionDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

const openDb = (dbName: string): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("indexes")) {
        db.createObjectStore("indexes");
      }
      if (!db.objectStoreNames.contains("progress")) {
        db.createObjectStore("progress");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

export class IndexedDBStorage implements IndexStorage, ProgressStorage {
  private readonly dbName: string;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(dbName = "jsonl-resumable") {
    this.dbName = dbName;
  }

  private async getDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDb(this.dbName);
    }
    return this.dbPromise;
  }

  async save(key: string, meta: IndexMeta, lines: LineInfo[]): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction("indexes", "readwrite");
    const store = tx.objectStore("indexes");
    store.put(serializeIndex(meta, lines), key);
    await transactionDone(tx);
  }

  async load(key: string): Promise<{ meta: IndexMeta; lines: LineInfo[] } | null> {
    const db = await this.getDb();
    const tx = db.transaction("indexes", "readonly");
    const store = tx.objectStore("indexes");
    const record = await requestToPromise(store.get(key));
    if (!record) {
      return null;
    }
    return deserializeIndex(record);
  }

  async saveJob(key: string, job: JobProgress): Promise<void> {
    const jobs = (await this.loadJobs(key)) ?? new Map();
    jobs.set(job.jobId, job);
    const db = await this.getDb();
    const tx = db.transaction("progress", "readwrite");
    tx.objectStore("progress").put(serializeJobs(jobs), key);
    await transactionDone(tx);
  }

  async loadJobs(key: string): Promise<Map<string, JobProgress> | null> {
    const db = await this.getDb();
    const tx = db.transaction("progress", "readonly");
    const record = await requestToPromise(tx.objectStore("progress").get(key));
    if (!record) {
      return null;
    }
    return deserializeJobs(record);
  }

  async deleteJob(key: string, jobId: string): Promise<boolean> {
    const jobs = await this.loadJobs(key);
    if (!jobs || !jobs.has(jobId)) {
      return false;
    }
    jobs.delete(jobId);
    const db = await this.getDb();
    const tx = db.transaction("progress", "readwrite");
    tx.objectStore("progress").put(serializeJobs(jobs), key);
    await transactionDone(tx);
    return true;
  }
}

export class LocalStorageAdapter implements IndexStorage {
  private readonly prefix: string;

  constructor(prefix = "jsonl:") {
    this.prefix = prefix;
  }

  async save(key: string, meta: IndexMeta, lines: LineInfo[]): Promise<void> {
    const payload = serializeIndex(meta, lines);
    localStorage.setItem(`${this.prefix}${key}`, JSON.stringify(payload));
  }

  async load(key: string): Promise<{ meta: IndexMeta; lines: LineInfo[] } | null> {
    const raw = localStorage.getItem(`${this.prefix}${key}`);
    if (!raw) {
      return null;
    }
    try {
      return deserializeIndex(JSON.parse(raw));
    } catch {
      return null;
    }
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
