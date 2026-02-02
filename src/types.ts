// Core Data Structures (mirror Python's models.py)
export interface LineInfo {
  readonly lineNumber: number;
  readonly offset: number;
  readonly length: number;
}

export interface IndexMeta {
  filePath: string;
  fileSize: number;
  fileMtime: number; // Unix timestamp (seconds)
  totalLines: number;
  checkpointInterval: number;
  checkpoints: Record<number, number>;
  indexedAt: string;
  version: string;
  isFresh(currentSize: number, currentMtime: number): boolean;
}

export interface JobProgress {
  jobId: string;
  position: number;
  fileSize: number;
  fileMtime: number; // Unix timestamp (seconds)
  status: "in_progress" | "completed";
  createdAt: string;
  lastCheckpointAt: string;
  completedAt: string | null;
}

export interface JobInfo {
  readonly jobId: string;
  readonly position: number;
  readonly status: "in_progress" | "completed";
  readonly totalLines: number;
  readonly progressPct: number;
  readonly createdAt: Date;
  readonly lastCheckpointAt: Date;
  readonly completedAt: Date | null;
  readonly isStale: boolean;
}

// Storage Interfaces
export interface IndexStorage {
  save(key: string, meta: IndexMeta, lines: LineInfo[]): Promise<void>;
  load(key: string): Promise<{ meta: IndexMeta; lines: LineInfo[] } | null>;
}

export interface ProgressStorage {
  saveJob(key: string, job: JobProgress): Promise<void>;
  loadJobs(key: string): Promise<Map<string, JobProgress> | null>;
  deleteJob(key: string, jobId: string): Promise<boolean>;
}

// File Handle Abstraction
export interface FileHandle {
  readonly size: number;
  readonly name: string;
  read(offset: number, length: number): Promise<Uint8Array>;
  readLine(offset: number): Promise<{ data: Uint8Array; bytesRead: number }>;
  close(): Promise<void>;
}

export interface FileSource {
  open(): Promise<FileHandle>;
  getStats(): Promise<{ size: number; mtime: number }>;
}

// Iteration Options
export interface IterOptions {
  start?: number;
  skip?: number;
  limit?: number;
  batchSize?: number;
}

export interface JsonIterOptions extends IterOptions {
  onDecodeError?: "raise" | "skip" | "raw";
}
