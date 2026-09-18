import { Transform } from 'class-transformer';

export function nationalPhoneDigits(value: unknown): string {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.startsWith('255') && digits.length >= 12) {
    digits = digits.slice(3);
  }
  if (digits.startsWith('0') && digits.length >= 10) {
    digits = digits.slice(1);
  }
  return digits.slice(0, 9);
}

export function normalizePhone(value: unknown): string {
  const national = nationalPhoneDigits(value);
  if (!/^[1-9]\d{8}$/.test(national)) {
    return String(value ?? '').trim();
  }
  return `+255${national}`;
}

export function phoneLookupValues(value: unknown): string[] {
  const national = nationalPhoneDigits(value);
  if (!/^[1-9]\d{8}$/.test(national)) {
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
