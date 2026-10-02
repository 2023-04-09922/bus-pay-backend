import { Transform } from 'class-transformer';

/** Exactly 9 Tanzanian national digits, or null when the length is wrong. */
export function nationalPhoneDigits(value: unknown): string | null {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.startsWith('255')) {
    if (digits.length !== 12) return null;
    digits = digits.slice(3);
  } else if (digits.startsWith('0')) {
    if (digits.length !== 10) return null;
    digits = digits.slice(1);
  }
  if (!/^[1-9]\d{8}$/.test(digits)) return null;
  return digits;
}

export function normalizePhone(value: unknown): string {
  const national = nationalPhoneDigits(value);
  if (!national) return String(value ?? '').trim();
  return `+255${national}`;
}

export function phoneLookupValues(value: unknown): string[] {
  const national = nationalPhoneDigits(value);
  if (!national) {
    const raw = String(value ?? '').trim();
    return raw ? [raw] : [];
  }
  return [`+255${national}`, `0${national}`, national];
}

export function PhoneField() {
  return Transform(({ value }: { value: unknown }) => normalizePhone(value));
}

export const TZ_PHONE_PATTERN = /^\+255[1-9]\d{8}$/;
export const TZ_PHONE_MESSAGE =
  'Use a Tanzanian number like +255 712 345678';

export function normalizeNida(value: unknown): string {
  return String(value ?? '')
    .replace(/\D/g, '')
    .slice(0, 20);
}

export function NidaField() {
  return Transform(({ value }: { value: unknown }) => normalizeNida(value));
}

export const NIDA_PATTERN = /^\d{20}$/;
export const NIDA_MESSAGE = 'NIDA must be 20 digits';
