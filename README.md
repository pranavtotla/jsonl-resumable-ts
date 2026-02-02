# jsonl-resumable

O(1) random access and resumable iteration for large JSONL files via byte-offset indexing.

[![CI](https://github.com/pranavtotla/jsonl-resumable-js/actions/workflows/ci.yml/badge.svg)](https://github.com/pranavtotla/jsonl-resumable-js/actions/workflows/ci.yml)
[![npm version](https://badge.fury.io/js/jsonl-resumable.svg)](https://www.npmjs.com/package/jsonl-resumable)

## Why?

**Without this library:** Reading line 1,000,000 requires parsing 999,999 lines first.

**With this library:** Seek directly to byte offset, read single line in O(1).

## Features

- **O(1) random access** - Jump to any line instantly
- **Resumable iteration** - Continue processing from where you left off
- **Batch processing** - Built-in checkpointing for fault tolerance
- **Isomorphic** - Works in Node.js and browsers
- **Zero dependencies** - No runtime dependencies
- **TypeScript-first** - Full type safety with strict mode

## Installation

```bash
npm install jsonl-resumable
```

## Quick Start

### Node.js

```typescript
import { JsonlIndex } from 'jsonl-resumable/node';

// Create index (automatically builds and persists to .idx file)
const index = new JsonlIndex('./data.jsonl');

// O(1) random access
const record = await index.readJson<MyType>(1000000);

// Iterate from any position
for await (const line of index.asyncIter({ start: 500 })) {
  console.log(line);
}

// Random sampling
const sample = await index.sample<MyType>(100, { seed: 42 });
```

### Browser

```typescript
import { JsonlIndex } from 'jsonl-resumable/browser';

// Works with File objects from <input type="file">
const index = new JsonlIndex(file);

// Same API as Node.js
const record = await index.readJson(0);

for await (const data of index.asyncIterJson<MyType>()) {
  process(data);
}
```

## API Reference

### JsonlIndex

#### Constructor

**Node.js:**
```typescript
new JsonlIndex(filePath: string, options?: {
  checkpointInterval?: number;  // Default: 100
  indexPath?: string;           // Default: {filePath}.idx
  autoSave?: boolean;           // Default: true
  storage?: IndexStorage;       // Custom storage adapter
})
```

**Browser:**
```typescript
new JsonlIndex(file: File, options?: {
  checkpointInterval?: number;  // Default: 100
  autoSave?: boolean;           // Default: false
  storage?: IndexStorage;       // Optional persistence
})
```

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `totalLines` | `number` | Total number of lines in the file |
| `fileSize` | `number` | File size in bytes |
| `filePath` | `string` | Path to the JSONL file |

#### Random Access Methods

```typescript
// Get byte offset for a line
getOffset(lineNumber: number): { offset: number; length: number }

// Read single line as string
readLine(lineNumber: number): Promise<string>

// Read and parse single line as JSON
readJson<T>(lineNumber: number): Promise<T>

// Read multiple lines
readLineMany(lineNumbers: number[]): Promise<string[]>
readJsonMany<T>(lineNumbers: number[]): Promise<T[]>
```

#### Iteration Methods

```typescript
// Synchronous iteration (Node.js only)
*iterFrom(startLine?: number): Generator<string>
*iterJsonFrom<T>(startLine?: number): Generator<T>

// Async iteration (both environments)
asyncIter(options?: IterOptions): AsyncGenerator<string>
asyncIterJson<T>(options?: JsonIterOptions): AsyncGenerator<T>
asyncIterRaw(options?: IterOptions): AsyncGenerator<Uint8Array>
```

**IterOptions:**
```typescript
interface IterOptions {
  start?: number;      // Start line (default: 0)
  skip?: number;       // Lines to skip
  limit?: number;      // Max lines to yield
  batchSize?: number;  // Lines per I/O operation (default: 100)
}

interface JsonIterOptions extends IterOptions {
  onDecodeError?: 'raise' | 'skip' | 'raw';  // Default: 'raise'
}
```

#### Stream Methods

```typescript
toWebStream(options?: IterOptions): ReadableStream<string>
toNodeStream(options?: IterOptions): Readable  // Node.js only
```

#### Sampling

```typescript
// Random sample with optional seed for reproducibility
sample<T>(n: number, options?: { seed?: number }): Promise<T[]>
```

#### Index Management

```typescript
// Rebuild index from scratch
rebuild(): Promise<void>

// Update index with appended lines
update(): Promise<number>

// Save index to storage
save(): Promise<void>

// Serialize/deserialize
toJSON(): { meta: IndexMeta; lines: [number, number][] }
static fromJSON(data: object, file: FileSource): JsonlIndex
```

### BatchProcessor

For fault-tolerant processing with automatic checkpointing:

```typescript
await index.batchProcessor('my-job').run(async (batch) => {
  for await (const [lineNum, record] of batch) {
    await processRecord(record);

    // Checkpoint every N records
    if (lineNum % 1000 === 0) {
      await batch.checkpoint();
    }
  }
});

// Resume from last checkpoint automatically
await index.batchProcessor('my-job').run(async (batch) => {
  // Continues from where it left off
  for await (const [lineNum, record] of batch) {
    await processRecord(record);
  }
});
```

#### Job Management

```typescript
// List all jobs
const jobs = await index.listJobs();

// Get specific job
const job = await index.getJob('my-job');

// Reset job to start over
await index.resetJob('my-job');

// Delete job
await index.deleteJob('my-job');
```

## CLI

```bash
# Show file information
jsonl-index info data.jsonl
jsonl-index info data.jsonl --json

# Read specific lines
jsonl-index read data.jsonl 0 10 100
jsonl-index read data.jsonl 42 --pretty

# Random sample
jsonl-index sample data.jsonl 100
jsonl-index sample data.jsonl 10 --seed 42 --pretty
```

## Storage Adapters

### Node.js

```typescript
import { JsonlIndex, FileStorage, MemoryStorage } from 'jsonl-resumable/node';

// Default: FileStorage (persists to .idx files)
const index = new JsonlIndex('./data.jsonl');

// Memory-only (no persistence)
const index = new JsonlIndex('./data.jsonl', {
  storage: new MemoryStorage(),
  autoSave: false
});
```

### Browser

```typescript
import {
  JsonlIndex,
  IndexedDBStorage,
  LocalStorageAdapter,
  MemoryStorage
} from 'jsonl-resumable/browser';

// Default: no persistence
const index = new JsonlIndex(file);

// IndexedDB persistence
const index = new JsonlIndex(file, {
  storage: new IndexedDBStorage('my-app'),
  autoSave: true
});

// LocalStorage (small indexes only)
const index = new JsonlIndex(file, {
  storage: new LocalStorageAdapter('jsonl:')
});

// Custom server storage
const index = new JsonlIndex(file, {
  storage: {
    async save(key, meta, lines) {
      await fetch('/api/index', {
        method: 'POST',
        body: JSON.stringify({ key, meta, lines })
      });
    },
    async load(key) {
      const res = await fetch(`/api/index/${key}`);
      return res.ok ? res.json() : null;
    }
  }
});
```

## Error Handling

```typescript
import {
  IndexOutOfBoundsError,
  StaleCheckpointError,
  FileModifiedError,
  FileTruncatedError
} from 'jsonl-resumable/node';

try {
  await index.readJson(9999999);
} catch (error) {
  if (error instanceof IndexOutOfBoundsError) {
    console.log(`Line ${error.lineNumber} out of range (max: ${error.totalLines - 1})`);
  }
}
```

## Performance

The index enables O(1) random access by storing byte offsets:

| Operation | Without Index | With Index |
|-----------|--------------|------------|
| Read line N | O(N) | O(1) |
| Build index | - | O(N) (one-time) |
| Update index | - | O(new lines) |

Index files (.idx) are small JSON files that can be shared or committed to version control.

## Related

- [jsonl-resumable (Python)](https://github.com/pranavtotla/jsonl-resumable) - The original Python implementation

## License

MIT
