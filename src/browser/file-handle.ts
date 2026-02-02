import type { FileHandle as FileHandleShape, FileSource } from "../types";

const DEFAULT_CHUNK_SIZE = 64 * 1024;

const concatChunks = (chunks: Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};

export class BrowserFileHandle implements FileHandleShape {
  readonly size: number;
  readonly name: string;
  private readonly file: File | Blob;

  constructor(file: File | Blob) {
    this.file = file;
    this.size = file.size;
    this.name = file instanceof File ? file.name : "blob";
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (length <= 0) {
      return new Uint8Array();
    }
    const slice = this.file.slice(offset, offset + length);
    const buffer = await slice.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async readLine(offset: number): Promise<{ data: Uint8Array; bytesRead: number }> {
    const chunks: Uint8Array[] = [];
    let position = offset;

    while (position < this.size) {
      const end = Math.min(position + DEFAULT_CHUNK_SIZE, this.size);
      const slice = this.file.slice(position, end);
      const buffer = new Uint8Array(await slice.arrayBuffer());
      if (buffer.length === 0) {
        break;
      }

      const newlineIndex = buffer.indexOf(0x0a);
      if (newlineIndex !== -1) {
        chunks.push(buffer.subarray(0, newlineIndex + 1));
        break;
      }

      chunks.push(buffer);
      position += buffer.length;
    }

    const data = concatChunks(chunks);
    return { data, bytesRead: data.length };
  }

  async close(): Promise<void> {
    return;
  }
}

export class BrowserFileSource implements FileSource {
  private readonly file: File | Blob;

  constructor(file: File | Blob) {
    this.file = file;
  }

  async open(): Promise<BrowserFileHandle> {
    return new BrowserFileHandle(this.file);
  }

  async getStats(): Promise<{ size: number; mtime: number }> {
    const mtime =
      this.file instanceof File && typeof this.file.lastModified === "number"
        ? this.file.lastModified / 1000
        : 0;
    return { size: this.file.size, mtime };
  }
}
