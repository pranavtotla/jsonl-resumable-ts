export class JsonlResumableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonlResumableError";
  }
}

export class StaleCheckpointError extends JsonlResumableError {
  readonly jobId: string;
  readonly expected: { size: number; mtime: number };
  readonly actual: { size: number; mtime: number };

  constructor(
    jobId: string,
    expected: { size: number; mtime: number },
    actual: { size: number; mtime: number },
  ) {
    super(
      `File has changed since last checkpoint for job '${jobId}'. Expected size=${expected.size}, mtime=${expected.mtime}; got size=${actual.size}, mtime=${actual.mtime}. Use resetJob() to restart from the beginning.`,
    );
    this.name = "StaleCheckpointError";
    this.jobId = jobId;
    this.expected = expected;
    this.actual = actual;
  }
}

export class InvalidCheckpointError extends JsonlResumableError {
  readonly jobId: string;
  readonly position: number;
  readonly totalLines: number;

  constructor(jobId: string, position: number, totalLines: number) {
    super(`Checkpoint position ${position} exceeds total lines ${totalLines} for job '${jobId}'.`);
    this.name = "InvalidCheckpointError";
    this.jobId = jobId;
    this.position = position;
    this.totalLines = totalLines;
  }
}

export class AsyncIterationError extends JsonlResumableError {
  constructor(message: string) {
    super(message);
    this.name = "AsyncIterationError";
  }
}

export class FileDeletedError extends AsyncIterationError {
  readonly filePath: string;

  constructor(filePath: string) {
    super(`File was deleted during iteration: ${filePath}`);
    this.name = "FileDeletedError";
    this.filePath = filePath;
  }
}

export class FileTruncatedError extends AsyncIterationError {
  readonly filePath: string;
  readonly expectedSize: number;
  readonly actualSize: number;

  constructor(filePath: string, expectedSize: number, actualSize: number) {
    super(
      `File was truncated during iteration: ${filePath} (expected ${expectedSize} bytes, got ${actualSize} bytes)`,
    );
    this.name = "FileTruncatedError";
    this.filePath = filePath;
    this.expectedSize = expectedSize;
    this.actualSize = actualSize;
  }
}

export class LineCorruptedError extends AsyncIterationError {
  readonly lineNumber: number;
  readonly expectedLength: number;
  readonly actualLength: number;

  constructor(lineNumber: number, expectedLength: number, actualLength: number) {
    super(
      `Line ${lineNumber} corrupted: expected ${expectedLength} bytes, got ${actualLength} bytes`,
    );
    this.name = "LineCorruptedError";
    this.lineNumber = lineNumber;
    this.expectedLength = expectedLength;
    this.actualLength = actualLength;
  }
}

export class IndexOutOfBoundsError extends JsonlResumableError {
  readonly lineNumber: number;
  readonly totalLines: number;

  constructor(lineNumber: number, totalLines: number) {
    super(`Line ${lineNumber} out of range (0-${Math.max(totalLines - 1, 0)})`);
    this.name = "IndexOutOfBoundsError";
    this.lineNumber = lineNumber;
    this.totalLines = totalLines;
  }
}

export class FileModifiedError extends JsonlResumableError {
  readonly filePath: string;

  constructor(filePath: string) {
    super(`File was modified and requires a full rebuild: ${filePath}`);
    this.name = "FileModifiedError";
    this.filePath = filePath;
  }
}
