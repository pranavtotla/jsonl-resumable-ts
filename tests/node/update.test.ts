import { promises as fs } from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { FileModifiedError } from "../../src/core/errors";
import { JsonlIndex } from "../../src/node/JsonlIndex";
import { appendJsonlLine, createTempDir, writeJsonlFile } from "./helpers";

describe("update", () => {
  it("appends new lines without full rebuild", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 3, (i) => ({ line: i }));
    const index = new JsonlIndex(filePath);

    await appendJsonlLine(filePath, { line: 3 });
    await appendJsonlLine(filePath, { line: 4 });

    const added = await index.update();
    expect(added).toBe(2);
    expect(index.totalLines).toBe(5);
  });

  it("writes updated index when autoSave is enabled", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 3, (i) => ({ line: i }));
    const index = new JsonlIndex(filePath, { autoSave: true });

    await appendJsonlLine(filePath, { line: 3 });
    await index.update();

    const idxPath = path.join(dir, "sample.idx");
    await expect(fs.access(idxPath)).resolves.toBeUndefined();
  });

  it("throws when file shrinks", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 3, (i) => ({ line: i }));
    const index = new JsonlIndex(filePath);

    await fs.writeFile(filePath, '{"line":0}\n', "utf8");

    await expect(index.update()).rejects.toThrow(FileModifiedError);
  });
});
