import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const createTempDir = async (): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), "jsonl-resumable-"));

export const writeJsonlFile = async (
  dir: string,
  name: string,
  count: number,
  mapper: (index: number) => unknown,
): Promise<string> => {
  const filePath = path.join(dir, name);
  const lines = Array.from({ length: count }, (_, i) => JSON.stringify(mapper(i)));
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
};

export const appendJsonlLine = async (filePath: string, value: unknown): Promise<void> => {
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
};
