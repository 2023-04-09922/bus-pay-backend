import { nationalPhoneDigits, normalizePhone } from './identity';

describe('Tanzanian phone numbers', () => {
  it('accepts the three common local forms as the same number', () => {
    expect(normalizePhone('0712345678')).toBe('+255712345678');
    expect(normalizePhone('+255712345678')).toBe('+255712345678');
    expect(normalizePhone('255712345678')).toBe('+255712345678');
    expect(nationalPhoneDigits('0712345678')).toBe('712345678');
  });

  it('rejects an over-long number instead of truncating it', () => {
    expect(normalizePhone('071234567890')).toBe('071234567890');
    expect(normalizePhone('+2557123456789')).toBe('+2557123456789');
    expect(normalizePhone('2557123456789')).toBe('2557123456789');
    expect(nationalPhoneDigits('071234567890')).toBeNull();
  });
});
