import { describe, expect, it } from "vitest";

import { JsonlIndex } from "../../src/browser/JsonlIndex";

const makeFile = (lines: string[], name = "sample.jsonl"): File => {
  const content = `${lines.join("\n")}\n`;
  return new File([content], name, { type: "application/jsonl" });
};

describe("browser JsonlIndex", () => {
  it("reads lines and json", async () => {
    const file = makeFile(['{"line":0}', '{"line":1}']);
    const index = new JsonlIndex(file);

    const line = await index.readLine(1);
    expect(line).toContain('"line":1');

    const record = await index.readJson<{ line: number }>(0);
    expect(record.line).toBe(0);
  });

  it("iterates asynchronously", async () => {
    const file = makeFile(['{"line":0}', '{"line":1}', '{"line":2}']);
    const index = new JsonlIndex(file);

    const lines: string[] = [];
    for await (const line of index.asyncIter()) {
      lines.push(line);
    }

    expect(lines.length).toBe(3);
  });
});
