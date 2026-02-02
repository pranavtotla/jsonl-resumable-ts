# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-02-02

### Added

- Initial TypeScript port of [jsonl-resumable](https://github.com/pranavtotla/jsonl-resumable)
- **Node.js support**
  - `JsonlIndex` class with O(1) random access
  - Synchronous iteration via `iterFrom()` and `iterJsonFrom()`
  - Async iteration via `asyncIter()`, `asyncIterJson()`, `asyncIterRaw()`
  - Stream support via `toNodeStream()` and `toWebStream()`
  - `FileStorage` for .idx file persistence
  - `MemoryStorage` for testing
- **Browser support**
  - `JsonlIndex` class working with `File` objects
  - `IndexedDBStorage` for browser persistence
  - `LocalStorageAdapter` for small indexes
  - Web `ReadableStream` support
- **Batch processing**
  - `BatchProcessor` with checkpointing
  - Job progress persistence
  - Automatic resume from last checkpoint
- **CLI**
  - `jsonl-index info` - Show file information
  - `jsonl-index read` - Read specific lines
  - `jsonl-index sample` - Random sampling
- **Index management**
  - `rebuild()` - Full index rebuild
  - `update()` - Incremental update for appended lines
  - `sample()` - Random sampling with optional seed
  - `toJSON()` / `fromJSON()` - Serialization
- **Error hierarchy**
  - `StaleCheckpointError`
  - `InvalidCheckpointError`
  - `FileDeletedError`
  - `FileTruncatedError`
  - `LineCorruptedError`
  - `IndexOutOfBoundsError`
  - `FileModifiedError`

### Notes

- Feature parity with Python v0.5.0
- Zero runtime dependencies
- ESM-only (no CommonJS)
- Requires Node.js 18+
