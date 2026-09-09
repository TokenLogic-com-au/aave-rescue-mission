import {createHash} from 'crypto';
import fs from 'fs';
import path from 'path';

/** Canonical JSON: sorted keys, two-space indent, trailing newline. */
export function canonicalJson(value: unknown): string {
  const sorted = (_: string, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => compareStrings(a, b)))
      : v;
  return JSON.stringify(value, sorted, 2) + '\n';
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Writes canonical JSON and returns its sha256. */
export function writeCanonical(filePath: string, value: unknown): string {
  const text = canonicalJson(value);
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, text);
  return sha256(text);
}

/** Locale-independent ordering, so sorted artifacts do not depend on the host locale. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareAddresses(a: string, b: string): number {
  return compareStrings(a.toLowerCase(), b.toLowerCase());
}
