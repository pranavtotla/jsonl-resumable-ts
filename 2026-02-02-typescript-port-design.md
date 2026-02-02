# jsonl-resumable TypeScript Port - Design Document

> **Date:** 2026-02-02
> **Status:** Ready for implementation
> **Target Package:** `jsonl-resumable` (npm)
> **Target Repo:** `jsonl-resumable-js` (new repository)

---

## How to Use This Plan

This document is designed to be handed to another Claude (or developer) to implement the TypeScript port in a separate repository.

### Prerequisites

1. Create a new repository: `jsonl-resumable-js`
2. Clone the Python reference implementation for comparison:
   ```bash
   git clone https://github.com/pranavtotla/jsonl-resumable.git jsonl-resumable-python
   ```

### Starting Instructions

```
You are implementing a TypeScript port of jsonl-resumable.

Reference materials:
- This design document (follow it precisely)
- Python source: https://github.com/pranavtotla/jsonl-resumable

Instructions:
1. Create a new npm package in the jsonl-resumable-js repository
2. Follow the phases in Section 9 sequentially
3. For each feature, refer to the corresponding Python file listed in Section 12
4. Port the Python tests to TypeScript as you implement each feature
5. Ensure index file format (.idx) is byte-compatible with Python

Start with Phase 1: Project Setup & Core.
After each phase, commit your work and verify tests pass before proceeding.
```

### Key Principles

- **Feature parity first** — Match Python behavior exactly before adding JS-specific features
- **Test as you go** — Port Python tests alongside implementation
- **Zero dependencies** — Do not add runtime dependencies
- **Strict TypeScript** — Enable all strict flags from the start

---

## Reference Implementation

- **Python Source:** `/Users/pranav/work/jsonl-resumable`
- **GitHub:** https://github.com/pranavtotla/jsonl-resumable
- **Version:** 0.5.0 (with async iteration support)

---

## 1. Overview & Goals

### What it does

O(1) random access and resumable iteration for large JSONL files via byte-offset indexing. This is a TypeScript port of the Python library with the same name, adapted for JavaScript idioms and isomorphic (Node.js + Browser) support.

### Core value proposition

- **Without this library:** Reading line 1,000,000 requires parsing 999,999 lines first
- **With this library:** Seek directly to byte offset, read single line in O(1)

### Goals

1. Feature parity with Python v0.5.0
2. Isomorphic — works in Node.js and browsers
3. TypeScript-first with strict types
4. Modern ESM, AsyncIterator-based API
5. Zero runtime dependencies

### Non-goals

- Backwards compatibility with CommonJS
- Support for Node.js < 18
- Streaming writes (this is read-only indexing)

---

## 2. Architecture & Module Structure

### Package Structure

```
jsonl-resumable/
├── src/
│   ├── core/                    # Shared, environment-agnostic logic
│   │   ├── index.ts             # JsonlIndexCore class (in-memory index operations)
│   │   ├── models.ts            # LineInfo, IndexMeta, JobProgress, JobInfo
│   │   ├── serialization.ts     # toJSON/fromJSON for index persistence
│   │   ├── errors.ts            # Custom error hierarchy
│   │   └── utils.ts             # Shared utilities
│   │
│   ├── node/                    # Node.js entry point
│   │   ├── index.ts             # Re-exports + Node-specific classes
│   │   ├── JsonlIndex.ts        # Node implementation (fs-based)
│   │   ├── storage.ts           # FileStorage adapter (.idx files)
│   │   ├── streams.ts           # toNodeStream() wrapper
│   │   └── cli.ts               # CLI implementation
│   │
│   ├── browser/                 # Browser entry point
│   │   ├── index.ts             # Re-exports + Browser-specific classes
│   │   ├── JsonlIndex.ts        # Browser implementation (File/Blob-based)
│   │   ├── storage.ts           # IndexedDBStorage adapter
│   │   └── streams.ts           # toWebStream() wrapper
│   │
│   └── types.ts                 # Shared TypeScript interfaces
│
├── tests/
│   ├── core/                    # Unit tests for core logic
│   ├── node/                    # Node-specific integration tests
│   └── browser/                 # Browser tests (Vitest browser mode)
│
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── vitest.config.ts
```

### Entry Points (package.json exports)

```json
{
  "name": "jsonl-resumable",
  "type": "module",
  "exports": {
    "./node": {
      "import": "./dist/node/index.js",
      "types": "./dist/node/index.d.ts"
    },
    "./browser": {
      "import": "./dist/browser/index.js",
      "types": "./dist/browser/index.d.ts"
    }
  },
  "bin": {
    "jsonl-index": "./dist/node/cli.js"
  }
}
```

### Import Examples

```typescript
// Node.js
import { JsonlIndex } from 'jsonl-resumable/node';
const index = new JsonlIndex('./data.jsonl');

// Browser
import { JsonlIndex } from 'jsonl-resumable/browser';
const index = new JsonlIndex(fileFromInput);
```

---

## 3. Core Data Models & Interfaces

### TypeScript Interfaces (src/types.ts)

```typescript
// ─────────────────────────────────────────────────────────────────
// Core Data Structures (mirror Python's models.py)
// ─────────────────────────────────────────────────────────────────

export interface LineInfo {
  readonly lineNumber: number;  // 0-indexed
  readonly offset: number;      // Byte offset from file start
  readonly length: number;      // Byte length including newline
}

export interface IndexMeta {
  filePath: string;
  fileSize: number;
  fileMtime: number;            // Unix timestamp (ms)
  totalLines: number;
  checkpointInterval: number;
  checkpoints: Record<number, number>;  // lineNumber → offset
  indexedAt: string;            // ISO timestamp
  version: string;              // "1.0"
}

export interface JobProgress {
  jobId: string;
  position: number;             // Next line to process
  fileSize: number;
  fileMtime: number;
  status: 'in_progress' | 'completed';
  createdAt: string;
  lastCheckpointAt: string;
  completedAt: string | null;
}

export interface JobInfo {
  readonly jobId: string;
  readonly position: number;
  readonly status: 'in_progress' | 'completed';
  readonly totalLines: number;
  readonly progressPct: number;  // 0-100
  readonly createdAt: Date;
  readonly lastCheckpointAt: Date;
  readonly completedAt: Date | null;
  readonly isStale: boolean;
}

// ─────────────────────────────────────────────────────────────────
// Storage Interface (pluggable persistence)
// ─────────────────────────────────────────────────────────────────

export interface IndexStorage {
  save(key: string, meta: IndexMeta, lines: LineInfo[]): Promise<void>;
  load(key: string): Promise<{ meta: IndexMeta; lines: LineInfo[] } | null>;
}

export interface ProgressStorage {
  saveJob(key: string, job: JobProgress): Promise<void>;
  loadJobs(key: string): Promise<Map<string, JobProgress> | null>;
  deleteJob(key: string, jobId: string): Promise<boolean>;
}

// ─────────────────────────────────────────────────────────────────
// File Handle Abstraction (Node vs Browser)
// ─────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────
// Iteration Options
// ─────────────────────────────────────────────────────────────────

export interface IterOptions {
  start?: number;           // Start line (default: 0)
  skip?: number;            // Lines to skip from start
  limit?: number;           // Max lines to yield
  batchSize?: number;       // Lines per I/O operation (default: 100)
}

export interface JsonIterOptions extends IterOptions {
  onDecodeError?: 'raise' | 'skip' | 'raw';
}
```

### Python → TypeScript Model Mapping

| Python | TypeScript | Difference |
|--------|------------|------------|
| `LineInfo(line_number, offset, length)` | `LineInfo { lineNumber, offset, length }` | snake_case → camelCase |
| `IndexMeta` | `IndexMeta` | Same fields, camelCase |
| `JobProgress` | `JobProgress` | Same fields, camelCase |
| `JobInfo` | `JobInfo` | Same fields, camelCase |

---

## 4. Main API Surface

### JsonlIndex Class

```typescript
class JsonlIndex {
  // ─────────────────────────────────────────────────────────────
  // Constructor (differs by environment)
  // ─────────────────────────────────────────────────────────────

  // Node.js:
  constructor(filePath: string, options?: {
    checkpointInterval?: number;   // Default: 100
    indexPath?: string;            // Default: {filePath}.idx
    autoSave?: boolean;            // Default: true
    storage?: IndexStorage;        // Default: FileStorage
  });

  // Browser:
  constructor(file: File, options?: {
    checkpointInterval?: number;
    autoSave?: boolean;            // Default: false
    storage?: IndexStorage;        // Optional: IndexedDBStorage, etc.
  });

  // ─────────────────────────────────────────────────────────────
  // Properties
  // ─────────────────────────────────────────────────────────────

  readonly totalLines: number;
  readonly fileSize: number;
  readonly filePath: string;

  // ─────────────────────────────────────────────────────────────
  // Random Access (O(1) seeking)
  // ─────────────────────────────────────────────────────────────

  getOffset(lineNumber: number): { offset: number; length: number };

  readLine(lineNumber: number): Promise<string>;
  readJson<T = unknown>(lineNumber: number): Promise<T>;

  readLineMany(lineNumbers: number[]): Promise<string[]>;
  readJsonMany<T = unknown>(lineNumbers: number[]): Promise<T[]>;

  // ─────────────────────────────────────────────────────────────
  // Sync Iteration (Node only)
  // ─────────────────────────────────────────────────────────────

  *iterFrom(startLine?: number): Generator<string>;
  *iterJsonFrom<T>(startLine?: number): Generator<T>;

  // ─────────────────────────────────────────────────────────────
  // Async Iteration (both environments)
  // ─────────────────────────────────────────────────────────────

  asyncIter(options?: IterOptions): AsyncGenerator<string>;
  asyncIterJson<T>(options?: JsonIterOptions): AsyncGenerator<T>;
  asyncIterRaw(options?: IterOptions): AsyncGenerator<Uint8Array>;

  // ─────────────────────────────────────────────────────────────
  // Stream Wrappers
  // ─────────────────────────────────────────────────────────────

  toWebStream(options?: IterOptions): ReadableStream<string>;
  toNodeStream(options?: IterOptions): Readable;  // Node only

  // ─────────────────────────────────────────────────────────────
  // Sampling
  // ─────────────────────────────────────────────────────────────

  sample<T = unknown>(n: number, options?: { seed?: number }): Promise<T[]>;

  // ─────────────────────────────────────────────────────────────
  // Index Management
  // ─────────────────────────────────────────────────────────────

  rebuild(): Promise<void>;
  update(): Promise<number>;
  save(): Promise<void>;

  toJSON(): { meta: IndexMeta; lines: [number, number][] };
  static fromJSON(data: object, file: FileSource): JsonlIndex;

  // ─────────────────────────────────────────────────────────────
  // Batch Processing
  // ─────────────────────────────────────────────────────────────

  batchProcessor(jobId: string, options?: {
    progressStorage?: ProgressStorage;
    asJson?: boolean;
  }): BatchProcessor;

  listJobs(storage?: ProgressStorage): Promise<JobInfo[]>;
  getJob(jobId: string, storage?: ProgressStorage): Promise<JobInfo | null>;
  resetJob(jobId: string, storage?: ProgressStorage): Promise<boolean>;
  deleteJob(jobId: string, storage?: ProgressStorage): Promise<boolean>;

  // ─────────────────────────────────────────────────────────────
  // Resource Management
  // ─────────────────────────────────────────────────────────────

  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
```

### Python → TypeScript Method Mapping

| Python | TypeScript | Notes |
|--------|------------|-------|
| `read_line(n)` | `readLine(n)` | Returns Promise |
| `read_json(n)` | `readJson<T>(n)` | Generic return type |
| `iter_from(n)` | `iterFrom(n)` | Node only (sync) |
| `iter_json_from(n)` | `iterJsonFrom<T>(n)` | Node only (sync) |
| `aiter_from(n)` | `asyncIter(opts)` | Options object pattern |
| `aiter_json_from(n)` | `asyncIterJson<T>(opts)` | Options object pattern |
| `sample(n, seed=x)` | `sample<T>(n, { seed })` | Options object |
| `batch_processor(id)` | `batchProcessor(id)` | Returns BatchProcessor |

---

## 5. BatchProcessor & Error Handling

### BatchProcessor Class

```typescript
class BatchProcessor {
  constructor(
    index: JsonlIndex,
    jobId: string,
    options?: {
      progressStorage?: ProgressStorage;
      asJson?: boolean;
    }
  );

  // Lifecycle
  async start(): Promise<BatchProcessor>;
  async end(): Promise<void>;

  // Callback pattern (recommended)
  async run<T>(callback: (batch: BatchIterator) => Promise<T>): Promise<T>;

  // TC39 Explicit Resource Management
  [Symbol.asyncDispose](): Promise<void>;

  // Properties
  readonly position: number;
  readonly totalLines: number;
  readonly progress: number;
  readonly jobId: string;

  // Methods
  checkpoint(): Promise<void>;
  reset(): Promise<void>;
}

interface BatchIterator {
  [Symbol.asyncIterator](): AsyncGenerator<[number, unknown]>;
  checkpoint(): Promise<void>;
}
```

### Usage Example

```typescript
// TypeScript equivalent of Python context manager
await index.batchProcessor("my_job").run(async (batch) => {
  for await (const [lineNum, record] of batch) {
    await process(record);
    await batch.checkpoint();
  }
});
```

### Error Hierarchy

```typescript
// Base class
export class JsonlResumableError extends Error {}

// Checkpoint Errors
export class StaleCheckpointError extends JsonlResumableError {
  constructor(
    public readonly jobId: string,
    public readonly expected: { size: number; mtime: number },
    public readonly actual: { size: number; mtime: number }
  );
}

export class InvalidCheckpointError extends JsonlResumableError {
  constructor(
    public readonly jobId: string,
    public readonly position: number,
    public readonly totalLines: number
  );
}

// Async Iteration Errors
export class AsyncIterationError extends JsonlResumableError {}

export class FileDeletedError extends AsyncIterationError {
  constructor(public readonly filePath: string);
}

export class FileTruncatedError extends AsyncIterationError {
  constructor(
    public readonly filePath: string,
    public readonly expectedSize: number,
    public readonly actualSize: number
  );
}

export class LineCorruptedError extends AsyncIterationError {
  constructor(
    public readonly lineNumber: number,
    public readonly expectedLength: number,
    public readonly actualLength: number
  );
}

// Index Errors
export class IndexOutOfBoundsError extends JsonlResumableError {
  constructor(
    public readonly lineNumber: number,
    public readonly totalLines: number
  );
}

export class FileModifiedError extends JsonlResumableError {
  constructor(public readonly filePath: string);
}
```

### Python → TypeScript Error Mapping

| Python | TypeScript |
|--------|------------|
| `StaleCheckpointError` | `StaleCheckpointError` |
| `InvalidCheckpointError` | `InvalidCheckpointError` |
| `AsyncIterationError` | `AsyncIterationError` |
| `FileDeletedError` | `FileDeletedError` |
| `FileTruncatedError` | `FileTruncatedError` |
| `LineCorruptedError` | `LineCorruptedError` |
| `IndexError` (built-in) | `IndexOutOfBoundsError` |
| `ValueError` (in update()) | `FileModifiedError` |

---

## 6. Storage Adapters

### Built-in Adapters

```typescript
// Node.js: File-based (default)
export class FileStorage implements IndexStorage, ProgressStorage {
  constructor(private basePath?: string);
}
// Saves: {file}.idx, {file}.progress (JSON format, matches Python)

// Browser: IndexedDB (optional)
export class IndexedDBStorage implements IndexStorage, ProgressStorage {
  constructor(private dbName?: string);  // Default: 'jsonl-resumable'
}

// Browser: LocalStorage (small indexes only)
export class LocalStorageAdapter implements IndexStorage {
  constructor(private prefix?: string);  // Default: 'jsonl:'
}

// Both: Memory-only (testing)
export class MemoryStorage implements IndexStorage, ProgressStorage {}
```

### Usage Examples

```typescript
// Node.js - default file storage
import { JsonlIndex } from 'jsonl-resumable/node';
const index = new JsonlIndex('./data.jsonl');

// Browser - no persistence
import { JsonlIndex } from 'jsonl-resumable/browser';
const index = new JsonlIndex(file);

// Browser - IndexedDB persistence
import { JsonlIndex, IndexedDBStorage } from 'jsonl-resumable/browser';
const index = new JsonlIndex(file, { storage: new IndexedDBStorage() });

// Browser - custom server storage
const index = new JsonlIndex(file, {
  storage: {
    async save(key, meta, lines) {
      await fetch('/api/index', { method: 'POST', body: JSON.stringify({ key, meta, lines }) });
    },
    async load(key) {
      const res = await fetch(`/api/index/${key}`);
      return res.ok ? res.json() : null;
    }
  }
});
```

---

## 7. CLI (Node.js only)

```
jsonl-index <command> [options]

Commands:
  build <file>              Build or rebuild index
  info <file>               Show index statistics
  read <file> <line>        Read specific line (0-indexed)
  sample <file>             Random sample of records

Options:
  -h, --help               Show help
  -v, --version            Show version
  --json                   Output as JSON
  -n, --count <n>          Number of samples (for sample command)
  --seed <n>               Random seed (for sample command)

Examples:
  jsonl-index build data.jsonl
  jsonl-index info data.jsonl
  jsonl-index read data.jsonl 1000
  jsonl-index sample data.jsonl -n 100 --seed 42
```

Implementation uses Node.js built-in `parseArgs` from `node:util` (no dependencies).

---

## 8. Testing Strategy

### Test Structure

```
tests/
├── core/                    # Unit tests (no I/O)
│   ├── serialization.test.ts
│   ├── models.test.ts
│   ├── errors.test.ts
│   └── utils.test.ts
├── node/                    # Node integration tests
│   ├── index.test.ts
│   ├── persistence.test.ts
│   ├── iteration.test.ts
│   ├── batch.test.ts
│   ├── streams.test.ts
│   ├── update.test.ts
│   ├── sample.test.ts
│   ├── large-files.test.ts
│   └── cli.test.ts
├── browser/                 # Browser tests
│   ├── index.test.ts
│   ├── indexeddb.test.ts
│   └── streams.test.ts
└── fixtures/
    ├── small.jsonl          # 10 lines
    ├── medium.jsonl         # 1,000 lines
    └── generate.ts
```

### Python Test → TypeScript Mapping

| Python Test File | TypeScript Equivalent |
|------------------|----------------------|
| `test_index.py` | `node/index.test.ts` |
| `test_persistence.py` | `node/persistence.test.ts` |
| `test_batch.py` | `node/batch.test.ts` |
| `test_progress_persistence.py` | `node/batch.test.ts` |
| `test_async.py` | `node/iteration.test.ts` |
| `test_large_files.py` | `node/large-files.test.ts` |
| `test_cli.py` | `node/cli.test.ts` |

### Configuration

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/browser/**'],
    coverage: { provider: 'v8', include: ['src/**'] },
  },
});
```

---

## 9. Implementation Phases

### Phase 1: Project Setup & Core

```
□ Initialize repo: package.json, tsconfig, tsup, vitest
□ Set up linting (ESLint + Prettier or Biome)
□ Create directory structure
□ Implement src/core/models.ts
□ Implement src/core/errors.ts
□ Implement src/core/serialization.ts
□ Implement src/types.ts
□ Write core unit tests
□ Verify build produces correct dist/
```

### Phase 2: Node.js Implementation

```
□ Implement src/node/file-handle.ts
□ Implement src/node/JsonlIndex.ts (full API)
□ Implement src/node/storage.ts (FileStorage)
□ Implement src/node/batch.ts (BatchProcessor)
□ Implement src/node/streams.ts
□ Port all Python test cases
□ Verify index file format matches Python
```

### Phase 3: Browser Implementation

```
□ Implement src/browser/file-handle.ts
□ Implement src/browser/JsonlIndex.ts
□ Implement src/browser/storage.ts (IndexedDBStorage)
□ Write browser tests (Vitest browser mode)
□ Create HTML demo page
```

### Phase 4: CLI & Polish

```
□ Implement src/node/cli.ts
□ Write CLI tests
□ Add README.md
□ Add CHANGELOG.md
□ Add JSDoc to all public APIs
□ Verify TypeScript declarations
□ Create GitHub Actions CI
```

### Phase 5: Performance Validation

```
□ Create benchmark suite
□ Compare with Python implementation
□ Optimize if needed
□ Document performance in README
```

---

## 10. Dependencies

```json
{
  "devDependencies": {
    "typescript": "^5.x",
    "tsup": "^8.x",
    "vitest": "^1.x",
    "@vitest/coverage-v8": "^1.x",
    "playwright": "^1.x"
  },
  "dependencies": {}
}
```

**Goal: Zero runtime dependencies.**

---

## 11. Technical Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Target environments | Node.js + Browser | Isomorphic for maximum reach |
| Entry points | Separate (`/node`, `/browser`) | Tree-shaking, clear boundaries |
| Async model | AsyncIterator core | Simplest, universal, wrappable |
| Module format | ESM only | Modern standard, 2024+ |
| TypeScript | Strict mode | Parity with Python's mypy strict |
| Build tool | tsup | Zero-config, fast, handles multiple entry points |
| Test framework | Vitest | ESM-native, fast, browser mode support |
| Min Node version | 18 | LTS, Web Streams, fs.promises |
| Browser persistence | Optional (IndexedDB adapter) | Not all apps need persistence |
| Index format | JSON (matches Python) | Cross-language compatibility |

---

## 12. Key Files in Python Reference

When implementing, refer to these Python files:

| File | What to learn |
|------|---------------|
| `src/jsonl_resumable/index.py` | Core JsonlIndex class, all methods |
| `src/jsonl_resumable/models.py` | Data structures |
| `src/jsonl_resumable/persistence.py` | Index serialization format |
| `src/jsonl_resumable/batch.py` | BatchProcessor implementation |
| `src/jsonl_resumable/async_stream.py` | Async context managers |
| `src/jsonl_resumable/exceptions.py` | Error hierarchy |
| `src/jsonl_resumable/progress.py` | Job progress persistence |
| `tests/test_*.py` | Test cases to port |

---

## 13. Success Criteria

1. **Feature parity:** All Python APIs have TypeScript equivalents
2. **Tests pass:** All ported test cases green
3. **Cross-platform:** Works in Node 18+ and modern browsers
4. **Performance:** O(1) seeking confirmed via benchmarks
5. **Zero deps:** No runtime dependencies
6. **Type-safe:** Full TypeScript coverage, strict mode
7. **Index compatibility:** .idx files readable by both Python and TypeScript

---

*End of design document*
