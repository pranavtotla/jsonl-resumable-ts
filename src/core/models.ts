import type {
  IndexMeta as IndexMetaShape,
  JobInfo as JobInfoShape,
  JobProgress as JobProgressShape,
  LineInfo as LineInfoShape,
} from "../types";

export class LineInfo implements LineInfoShape {
  readonly lineNumber: number;
  readonly offset: number;
  readonly length: number;

  constructor(lineNumber: number, offset: number, length: number) {
    this.lineNumber = lineNumber;
    this.offset = offset;
    this.length = length;
  }
}

export class IndexMeta implements IndexMetaShape {
  filePath: string;
  fileSize: number;
  fileMtime: number;
  totalLines: number;
  checkpointInterval: number;
  checkpoints: Record<number, number>;
  indexedAt: string;
  version: string;

  constructor(options: {
    filePath: string;
    fileSize: number;
    fileMtime: number;
    totalLines: number;
    checkpointInterval: number;
    checkpoints?: Record<number, number>;
    indexedAt?: string;
    version?: string;
  }) {
    this.filePath = options.filePath;
    this.fileSize = options.fileSize;
    this.fileMtime = options.fileMtime;
    this.totalLines = options.totalLines;
    this.checkpointInterval = options.checkpointInterval;
    this.checkpoints = options.checkpoints ?? {};
    this.indexedAt = options.indexedAt ?? new Date().toISOString();
    this.version = options.version ?? "1.0";
  }

  isFresh(currentSize: number, currentMtime: number): boolean {
    return this.fileSize === currentSize && this.fileMtime === currentMtime;
  }
}

export class JobProgress implements JobProgressShape {
  jobId: string;
  position: number;
  fileSize: number;
  fileMtime: number;
  status: "in_progress" | "completed";
  createdAt: string;
  lastCheckpointAt: string;
  completedAt: string | null;

  constructor(options: {
    jobId: string;
    position: number;
    fileSize: number;
    fileMtime: number;
    status: "in_progress" | "completed";
    createdAt: string;
    lastCheckpointAt: string;
    completedAt?: string | null;
  }) {
    this.jobId = options.jobId;
    this.position = options.position;
    this.fileSize = options.fileSize;
    this.fileMtime = options.fileMtime;
    this.status = options.status;
    this.createdAt = options.createdAt;
    this.lastCheckpointAt = options.lastCheckpointAt;
    this.completedAt = options.completedAt ?? null;
  }
}

export class JobInfo implements JobInfoShape {
  readonly jobId: string;
  readonly position: number;
  readonly status: "in_progress" | "completed";
  readonly totalLines: number;
  readonly progressPct: number;
  readonly createdAt: Date;
  readonly lastCheckpointAt: Date;
  readonly completedAt: Date | null;
  readonly isStale: boolean;

  constructor(options: {
    jobId: string;
    position: number;
    status: "in_progress" | "completed";
    totalLines: number;
    progressPct: number;
    createdAt: Date;
    lastCheckpointAt: Date;
    completedAt: Date | null;
    isStale: boolean;
  }) {
    this.jobId = options.jobId;
    this.position = options.position;
    this.status = options.status;
    this.totalLines = options.totalLines;
    this.progressPct = options.progressPct;
    this.createdAt = options.createdAt;
    this.lastCheckpointAt = options.lastCheckpointAt;
    this.completedAt = options.completedAt;
    this.isStale = options.isStale;
  }
}
