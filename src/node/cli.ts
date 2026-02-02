import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

import { JsonlIndex } from "./JsonlIndex";

const formatSize = (sizeBytes: number): string => {
  let size = sizeBytes;
  const units = ["B", "KB", "MB", "GB", "TB"];

  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (size < 1024 || i === units.length - 1) {
      if (unit === "B") {
        return `${Math.floor(size)} ${unit}`;
      }
      return `${size.toFixed(1)} ${unit}`;
    }
    size /= 1024;
  }

  return `${size.toFixed(1)} PB`;
};

const printHelp = (): void => {
  console.log(`jsonl-index - O(1) random access and sampling for JSONL files

Usage:
  jsonl-index <command> [options]

Commands:
  info <file>              Show file information
  read <file> <line...>    Read specific line(s) (0-indexed)
  sample <file> <n>        Random sample of n records

Options:
  -h, --help               Show this help
  -v, --version            Show version
  --json                   Output as JSON (info command)
  --pretty                 Pretty-print JSON output
  --seed <n>               Random seed for reproducibility (sample command)

Examples:
  jsonl-index info data.jsonl
  jsonl-index info data.jsonl --json
  jsonl-index read data.jsonl 0 10 100
  jsonl-index read data.jsonl 42 --pretty
  jsonl-index sample data.jsonl 100
  jsonl-index sample data.jsonl 10 --seed 42 --pretty`);
};

const printVersion = (): void => {
  console.log("0.5.0");
};

const cmdInfo = (file: string, asJson: boolean): number => {
  try {
    const index = new JsonlIndex(file);
    const resolvedPath = path.resolve(file);
    const indexPath = resolvedPath.replace(/\.[^.]+$/, ".idx");
    const indexExists = fs.existsSync(indexPath);

    if (asJson) {
      const info = {
        file: resolvedPath,
        lines: index.totalLines,
        size_bytes: index.fileSize,
        index_exists: indexExists,
      };
      console.log(JSON.stringify(info, null, 2));
    } else {
      console.log(`File: ${resolvedPath}`);
      console.log(`Lines: ${index.totalLines.toLocaleString()}`);
      console.log(`Size: ${formatSize(index.fileSize)}`);
      console.log(`Index: ${indexExists ? "exists" : "will be created"}`);
    }

    return 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
};

const cmdRead = async (file: string, lineNumbers: number[], pretty: boolean): Promise<number> => {
  try {
    const index = new JsonlIndex(file);
    let hasErrors = false;

    for (const lineNum of lineNumbers) {
      try {
        const data = await index.readJson(lineNum);
        if (pretty) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.log(JSON.stringify(data));
        }
      } catch (error) {
        if (error instanceof Error && error.name === "IndexOutOfBoundsError") {
          console.error(`Error: Line ${lineNum} out of range (0-${index.totalLines - 1})`);
        } else if (error instanceof SyntaxError) {
          console.error(`Error: Invalid JSON at line ${lineNum}: ${error.message}`);
        } else {
          console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
        hasErrors = true;
      }
    }

    return hasErrors ? 1 : 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
};

const cmdSample = async (
  file: string,
  n: number,
  seed: number | undefined,
  pretty: boolean,
): Promise<number> => {
  try {
    const index = new JsonlIndex(file);

    if (index.totalLines === 0) {
      if (pretty) {
        console.log("[]");
      }
      return 0;
    }

    const records = await index.sample(n, seed !== undefined ? { seed } : undefined);

    if (pretty) {
      console.log(JSON.stringify(records, null, 2));
    } else {
      for (const record of records) {
        console.log(JSON.stringify(record));
      }
    }

    return 0;
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error(`Error: Invalid JSON in file: ${error.message}`);
    } else {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 1;
  }
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    printHelp();
    process.exitCode = 0;
    return;
  }

  if (args.includes("-v") || args.includes("--version")) {
    printVersion();
    process.exitCode = 0;
    return;
  }

  const command = args[0];
  const restArgs = args.slice(1);

  switch (command) {
    case "info": {
      const { values, positionals } = parseArgs({
        args: restArgs,
        options: {
          json: { type: "boolean", default: false },
          help: { type: "boolean", short: "h", default: false },
        },
        allowPositionals: true,
      });

      if (values.help) {
        printHelp();
        process.exitCode = 0;
        return;
      }

      if (positionals.length !== 1) {
        console.error("Error: info command requires exactly one file path");
        printHelp();
        process.exitCode = 1;
        return;
      }

      process.exitCode = cmdInfo(positionals[0], values.json);
      return;
    }

    case "read": {
      const { values, positionals } = parseArgs({
        args: restArgs,
        options: {
          pretty: { type: "boolean", default: false },
          help: { type: "boolean", short: "h", default: false },
        },
        allowPositionals: true,
      });

      if (values.help) {
        printHelp();
        process.exitCode = 0;
        return;
      }

      if (positionals.length < 2) {
        console.error("Error: read command requires a file path and at least one line number");
        printHelp();
        process.exitCode = 1;
        return;
      }

      const file = positionals[0];
      const lineNumbers = positionals.slice(1).map((s) => {
        const n = Number.parseInt(s, 10);
        if (Number.isNaN(n)) {
          console.error(`Error: Invalid line number: ${s}`);
          process.exitCode = 1;
          throw new Error("Invalid line number");
        }
        return n;
      });

      process.exitCode = await cmdRead(file, lineNumbers, values.pretty);
      return;
    }

    case "sample": {
      const { values, positionals } = parseArgs({
        args: restArgs,
        options: {
          seed: { type: "string" },
          pretty: { type: "boolean", default: false },
          help: { type: "boolean", short: "h", default: false },
        },
        allowPositionals: true,
      });

      if (values.help) {
        printHelp();
        process.exitCode = 0;
        return;
      }

      if (positionals.length !== 2) {
        console.error("Error: sample command requires a file path and sample count");
        printHelp();
        process.exitCode = 1;
        return;
      }

      const file = positionals[0];
      const n = Number.parseInt(positionals[1], 10);
      if (Number.isNaN(n) || n < 0) {
        console.error(`Error: Invalid sample count: ${positionals[1]}`);
        process.exitCode = 1;
        return;
      }

      const seed = values.seed !== undefined ? Number.parseInt(values.seed, 10) : undefined;
      if (values.seed !== undefined && (seed === undefined || Number.isNaN(seed))) {
        console.error(`Error: Invalid seed: ${values.seed}`);
        process.exitCode = 1;
        return;
      }

      process.exitCode = await cmdSample(file, n, seed, values.pretty);
      return;
    }

    default:
      console.error(`Error: Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
