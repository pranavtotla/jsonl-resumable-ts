/**
 * Performance benchmarks for jsonl-resumable
 *
 * Run with: npx tsx benchmarks/run.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { JsonlIndex } from "../src/node/JsonlIndex";

const TEMP_DIR = "/tmp/jsonl-bench";
const SIZES = [1_000, 10_000, 100_000, 1_000_000];

interface BenchmarkResult {
  name: string;
  lines: number;
  timeMs: number;
  opsPerSec?: number;
}

async function generateTestFile(lines: number): Promise<string> {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  const filePath = path.join(TEMP_DIR, `test-${lines}.jsonl`);

  if (fs.existsSync(filePath)) {
    return filePath;
  }

  console.log(`Generating ${lines.toLocaleString()} line test file...`);

  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(filePath);
    stream.on("error", reject);
    stream.on("finish", () => resolve(filePath));

    for (let i = 0; i < lines; i++) {
      const record = {
        id: i,
        name: `Record ${i}`,
        timestamp: new Date().toISOString(),
        data: { value: Math.random(), tags: ["test", `tag-${i % 10}`] },
      };
      stream.write(`${JSON.stringify(record)}\n`);
    }
    stream.end();
  });
}

function benchmark(name: string, fn: () => void, iterations = 1): BenchmarkResult {
  const lines = 0;

  // Warmup
  fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const elapsed = performance.now() - start;

  return {
    name,
    lines,
    timeMs: elapsed / iterations,
    opsPerSec: iterations > 1 ? (iterations / elapsed) * 1000 : undefined,
  };
}

async function benchmarkAsync(
  name: string,
  fn: () => Promise<void>,
  iterations = 1,
): Promise<BenchmarkResult> {
  // Warmup
  await fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    await fn();
  }
  const elapsed = performance.now() - start;

  return {
    name,
    lines: 0,
    timeMs: elapsed / iterations,
    opsPerSec: iterations > 1 ? (iterations / elapsed) * 1000 : undefined,
  };
}

function formatResult(result: BenchmarkResult): string {
  let str = `${result.name}: ${result.timeMs.toFixed(2)}ms`;
  if (result.opsPerSec) {
    str += ` (${result.opsPerSec.toFixed(0)} ops/sec)`;
  }
  return str;
}

async function runBenchmarks(): Promise<void> {
  console.log("jsonl-resumable Performance Benchmarks\n");
  console.log("=".repeat(50));

  for (const size of SIZES) {
    const filePath = await generateTestFile(size);
    console.log(`\n## ${size.toLocaleString()} lines\n`);

    // Index build time
    const buildResult = benchmark("Build index", () => {
      // Delete existing index
      const idxPath = `${filePath}.idx`;
      if (fs.existsSync(idxPath)) {
        fs.unlinkSync(idxPath);
      }
      new JsonlIndex(filePath);
    });
    console.log(formatResult(buildResult));

    // Create index for other tests
    const idxPath = `${filePath}.idx`;
    if (fs.existsSync(idxPath)) {
      fs.unlinkSync(idxPath);
    }
    const index = new JsonlIndex(filePath);

    // Random access (single line)
    const randomLine = Math.floor(size / 2);
    const readResult = await benchmarkAsync(
      `Read single line (${randomLine})`,
      async () => {
        await index.readJson(randomLine);
      },
      100,
    );
    console.log(formatResult(readResult));

    // Random access (last line)
    const readLastResult = await benchmarkAsync(
      `Read last line (${size - 1})`,
      async () => {
        await index.readJson(size - 1);
      },
      100,
    );
    console.log(formatResult(readLastResult));

    // Batch read
    const batchLines = Array.from({ length: 100 }, (_, i) => Math.floor((i * size) / 100));
    const batchResult = await benchmarkAsync(
      "Read 100 scattered lines",
      async () => {
        await index.readJsonMany(batchLines);
      },
      10,
    );
    console.log(formatResult(batchResult));

    // Sampling
    const sampleResult = await benchmarkAsync(
      "Sample 100 records (seeded)",
      async () => {
        await index.sample(100, { seed: 42 });
      },
      10,
    );
    console.log(formatResult(sampleResult));

    // Iteration (first 1000 lines)
    const iterResult = await benchmarkAsync(
      "Iterate first 1000 lines",
      async () => {
        let count = 0;
        for await (const _ of index.asyncIter({ limit: 1000 })) {
          count++;
        }
      },
      5,
    );
    console.log(formatResult(iterResult));

    // Sync iteration (first 1000 lines)
    const syncIterResult = benchmark(
      "Sync iterate first 1000 lines",
      () => {
        let count = 0;
        for (const _ of index.iterFrom(0)) {
          count++;
          if (count >= 1000) break;
        }
      },
      5,
    );
    console.log(formatResult(syncIterResult));
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log("Benchmarks complete!");
}

runBenchmarks().catch(console.error);
