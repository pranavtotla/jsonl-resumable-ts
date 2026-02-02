import type { IndexMeta as IndexMetaShape, LineInfo as LineInfoShape } from "../types";
import { IndexMeta, LineInfo } from "./models";

export const FORMAT_VERSION = "1.0";

export interface SerializedIndex {
  format_version: string;
  meta: {
    file_path: string;
    file_size: number;
    file_mtime: number;
    total_lines: number;
    checkpoint_interval: number;
    checkpoints: Record<string, number>;
    indexed_at: string;
    version?: string;
  };
  lines: [number, number][];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isString = (value: unknown): value is string => typeof value === "string";

export function serializeIndex(meta: IndexMetaShape, lines: LineInfoShape[]): SerializedIndex {
  return {
    format_version: FORMAT_VERSION,
    meta: {
      file_path: meta.filePath,
      file_size: meta.fileSize,
      file_mtime: meta.fileMtime,
      total_lines: meta.totalLines,
      checkpoint_interval: meta.checkpointInterval,
      checkpoints: meta.checkpoints,
      indexed_at: meta.indexedAt,
      version: meta.version,
    },
    lines: lines.map((line) => [line.offset, line.length]),
  };
}

export function deserializeIndex(data: unknown): { meta: IndexMeta; lines: LineInfo[] } | null {
  try {
    if (!isRecord(data)) {
      return null;
    }

    if (data.format_version !== FORMAT_VERSION) {
      return null;
    }

    const metaData = data.meta;
    if (!isRecord(metaData)) {
      return null;
    }

    const filePath = metaData.file_path;
    const fileSize = metaData.file_size;
    const fileMtime = metaData.file_mtime;
    const totalLines = metaData.total_lines;
    const checkpointInterval = metaData.checkpoint_interval;
    const checkpointsRaw = metaData.checkpoints;
    const indexedAt = metaData.indexed_at;
    const version = metaData.version;

    if (!isString(filePath)) {
      return null;
    }
    if (!isNumber(fileSize) || !isNumber(fileMtime) || !isNumber(totalLines)) {
      return null;
    }
    if (!isNumber(checkpointInterval)) {
      return null;
    }
    if (!isString(indexedAt)) {
      return null;
    }
    if (!isRecord(checkpointsRaw)) {
      return null;
    }

    const checkpoints: Record<number, number> = {};
    for (const [key, value] of Object.entries(checkpointsRaw)) {
      if (!isNumber(value)) {
        return null;
      }
      const parsedKey = Number.parseInt(key, 10);
      if (!Number.isFinite(parsedKey)) {
        return null;
      }
      checkpoints[parsedKey] = value;
    }

    if (!Array.isArray(data.lines)) {
      return null;
    }

    const lines: LineInfo[] = data.lines.map((entry, index) => {
      if (!Array.isArray(entry) || entry.length < 2) {
        throw new Error("Invalid line entry");
      }
      const [offset, length] = entry;
      if (!isNumber(offset) || !isNumber(length)) {
        throw new Error("Invalid line entry");
      }
      return new LineInfo(index, offset, length);
    });

    return {
      meta: new IndexMeta({
        filePath,
        fileSize,
        fileMtime,
        totalLines,
        checkpointInterval,
        checkpoints,
        indexedAt,
        version: isString(version) ? version : "1.0",
      }),
      lines,
    };
  } catch {
    return null;
  }
}

export const toJSON = serializeIndex;
export const fromJSON = deserializeIndex;
