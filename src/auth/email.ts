import { Transform } from 'class-transformer';

export function normalizeEmail(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/,/g, '.');
}

export function EmailField() {
  return Transform(({ value }: { value: unknown }) => normalizeEmail(value));
}
