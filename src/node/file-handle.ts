import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { FileHandle as FileHandleShape, FileSource } from "../types";

const DEFAULT_CHUNK_SIZE = 64 * 1024;

export class NodeFileHandle implements FileHandleShape {
  readonly size: number;
  readonly name: string;
  private readonly handle: fs.FileHandle;

  private constructor(handle: fs.FileHandle, size: number, name: string) {
    this.handle = handle;
    this.size = size;
    this.name = name;
  }

  static async open(filePath: string): Promise<NodeFileHandle> {
    const stat = await fs.stat(filePath);
    const handle = await fs.open(filePath, "r");
    return new NodeFileHandle(handle, stat.size, path.basename(filePath));
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (length <= 0) {
      return new Uint8Array();
    }
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await this.handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  }

  async readLine(offset: number): Promise<{ data: Uint8Array; bytesRead: number }> {
    const chunks: Buffer[] = [];
    let position = offset;

    while (true) {
      const buffer = Buffer.alloc(DEFAULT_CHUNK_SIZE);
      const { bytesRead } = await this.handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) {
        break;
      }

      const slice = buffer.subarray(0, bytesRead);
      const newlineIndex = slice.indexOf(0x0a);

      if (newlineIndex !== -1) {
        chunks.push(slice.subarray(0, newlineIndex + 1));
        break;
      }

      chunks.push(slice);
      position += bytesRead;
    }

    const data = chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks);
    return { data, bytesRead: data.length };
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

export class NodeFileSource implements FileSource {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async open(): Promise<NodeFileHandle> {
    return NodeFileHandle.open(this.filePath);
  }

  async getStats(): Promise<{ size: number; mtime: number }> {
    const stat = await fs.stat(this.filePath);
    return { size: stat.size, mtime: stat.mtimeMs / 1000 };
  }
}
