export const clamp = (value: number, min: number, max: number): number => {
  if (min > max) {
    throw new Error("min must be <= max");
  }
  return Math.min(max, Math.max(min, value));
};

export const nowIso = (): string => new Date().toISOString();
