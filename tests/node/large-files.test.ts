import { describe, expect, it } from "vitest";

import { JsonlIndex } from "../../src/node/JsonlIndex";
import { createTempDir, writeJsonlFile } from "./helpers";

describe("large files", () => {
  it("indexes a larger file without losing count", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "large.jsonl", 2000, (i) => ({ id: i }));
    const index = new JsonlIndex(filePath);

    expect(index.totalLines).toBe(2000);

    const line = await index.readJson<{ id: number }>(1999);
    expect(line.id).toBe(1999);
  });
});
