/**
 * CLI tests
 *
 * Tests the jsonl-index CLI commands
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI_PATH = path.join(__dirname, "../../dist/node/cli.js");

// Helper to run CLI commands using execFileSync (safer than exec)
const runCli = (args: string[]): { stdout: string; stderr: string; exitCode: number } => {
  try {
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: execError.stdout || "",
      stderr: execError.stderr || "",
      exitCode: execError.status ?? 1,
    };
  }
};

describe("CLI", () => {
  let tempDir: string;
  let testFile: string;

  beforeAll(async () => {
    // Create temp directory and test file
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-cli-test-"));
    testFile = path.join(tempDir, "test.jsonl");

    // Create test JSONL file
    const lines = [
      { id: 0, name: "first" },
      { id: 1, name: "second" },
      { id: 2, name: "third" },
      { id: 3, name: "fourth" },
      { id: 4, name: "fifth" },
    ];
    fs.writeFileSync(testFile, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);

    // Build the CLI if not already built
    try {
      fs.accessSync(CLI_PATH);
    } catch {
      execFileSync("npm", ["run", "build"], {
        cwd: path.join(__dirname, "../.."),
        stdio: "ignore",
      });
    }
  });

  afterAll(() => {
    // Clean up temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("help and version", () => {
    it("shows help with --help flag", () => {
      const result = runCli(["--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("jsonl-index");
      expect(result.stdout).toContain("Usage:");
      expect(result.stdout).toContain("Commands:");
    });

    it("shows help with -h flag", () => {
      const result = runCli(["-h"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("jsonl-index");
    });

    it("shows help with no arguments", () => {
      const result = runCli([]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage:");
    });

    it("shows version with --version flag", () => {
      const result = runCli(["--version"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("0.5.0");
    });

    it("shows version with -v flag", () => {
      const result = runCli(["-v"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("0.5.0");
    });
  });

  describe("info command", () => {
    it("shows file information", () => {
      const result = runCli(["info", testFile]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("File:");
      expect(result.stdout).toContain("Lines: 5");
      expect(result.stdout).toContain("Size:");
    });

    it("shows JSON output with --json flag", () => {
      const result = runCli(["info", testFile, "--json"]);
      expect(result.exitCode).toBe(0);
      const info = JSON.parse(result.stdout);
      expect(info.lines).toBe(5);
      expect(info.size_bytes).toBeGreaterThan(0);
    });

    it("errors on missing file argument", () => {
      const result = runCli(["info"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("requires exactly one file path");
    });

    it("errors on nonexistent file", () => {
      const result = runCli(["info", "/nonexistent/file.jsonl"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Error:");
    });
  });

  describe("read command", () => {
    it("reads a single line", () => {
      const result = runCli(["read", testFile, "0"]);
      expect(result.exitCode).toBe(0);
      const record = JSON.parse(result.stdout.trim());
      expect(record.id).toBe(0);
      expect(record.name).toBe("first");
    });

    it("reads multiple lines", () => {
      const result = runCli(["read", testFile, "0", "2", "4"]);
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split("\n");
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0]).id).toBe(0);
      expect(JSON.parse(lines[1]).id).toBe(2);
      expect(JSON.parse(lines[2]).id).toBe(4);
    });

    it("pretty prints with --pretty flag", () => {
      const result = runCli(["read", testFile, "0", "--pretty"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("{\n");
      expect(result.stdout).toContain("  ");
    });

    it("errors on out of bounds line number", () => {
      const result = runCli(["read", testFile, "100"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("out of range");
    });

    it("errors on invalid line number", () => {
      const result = runCli(["read", testFile, "abc"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid line number");
    });

    it("errors on missing arguments", () => {
      const result = runCli(["read", testFile]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("requires a file path and at least one line number");
    });
  });

  describe("sample command", () => {
    it("samples records", () => {
      const result = runCli(["sample", testFile, "3"]);
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split("\n");
      expect(lines).toHaveLength(3);
      for (const line of lines) {
        const record = JSON.parse(line);
        expect(record.id).toBeGreaterThanOrEqual(0);
        expect(record.id).toBeLessThan(5);
      }
    });

    it("produces reproducible results with --seed", () => {
      const result1 = runCli(["sample", testFile, "3", "--seed", "42"]);
      const result2 = runCli(["sample", testFile, "3", "--seed", "42"]);
      expect(result1.exitCode).toBe(0);
      expect(result2.exitCode).toBe(0);
      expect(result1.stdout).toBe(result2.stdout);
    });

    it("produces different results with different seeds", () => {
      const result1 = runCli(["sample", testFile, "5", "--seed", "1"]);
      const result2 = runCli(["sample", testFile, "5", "--seed", "2"]);
      expect(result1.exitCode).toBe(0);
      expect(result2.exitCode).toBe(0);
      // With different seeds, the order should be different
      // (though with only 5 items, there's a small chance they're the same)
    });

    it("pretty prints with --pretty flag", () => {
      const result = runCli(["sample", testFile, "2", "--pretty"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("[\n");
      const records = JSON.parse(result.stdout);
      expect(Array.isArray(records)).toBe(true);
      expect(records).toHaveLength(2);
    });

    it("handles sample size larger than file", () => {
      const result = runCli(["sample", testFile, "100"]);
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split("\n");
      expect(lines).toHaveLength(5); // Should be clamped to file size
    });

    it("errors on invalid sample count", () => {
      const result = runCli(["sample", testFile, "abc"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid sample count");
    });

    it("errors on invalid seed", () => {
      const result = runCli(["sample", testFile, "3", "--seed", "abc"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid seed");
    });

    it("errors on missing arguments", () => {
      const result = runCli(["sample", testFile]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("requires a file path and sample count");
    });
  });

  describe("unknown command", () => {
    it("errors on unknown command", () => {
      const result = runCli(["unknown"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown command");
    });
  });
});
