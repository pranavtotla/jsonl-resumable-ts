import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { JsonlIndex } from "../../src/node/JsonlIndex";
import { createTempDir, writeJsonlFile } from "./helpers";

describe("streams", () => {
  it("toNodeStream returns a readable stream", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 5, (i) => ({ line: i }));
    const index = new JsonlIndex(filePath);

    const stream = index.toNodeStream();
    expect(stream).toBeInstanceOf(Readable);

    const chunks: string[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk.toString());
    }

    expect(chunks.length).toBe(5);
  });

  it("toWebStream returns a web stream", async () => {
    const dir = await createTempDir();
    const filePath = await writeJsonlFile(dir, "sample.jsonl", 3, (i) => ({ line: i }));
    const index = new JsonlIndex(filePath);

    const stream = index.toWebStream();
    const reader = stream.getReader();

    const values: string[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      values.push(value);
    }

    expect(values.length).toBe(3);
  });
});
