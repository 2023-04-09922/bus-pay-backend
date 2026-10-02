export type SmsProviderName = 'mock' | 'beem' | 'swala';

export type SmsSendResult = {
  ok: boolean;
  provider: SmsProviderName;
  requestId?: string;
  providerStatus?: string;
  error?: string;
  mocked?: boolean;
  /** Same outbox row can be sent again. Swala dedupes that retry with Idempotency-Key. */
  retryable?: boolean;
  /** The provider may already have accepted the SMS. Do not send it again. */
  uncertain?: boolean;
};

export const MAX_SEND_ATTEMPTS = 5;
export const MAX_DELIVERY_POLLS = 8;
export const SENDING_STALE_MS = 120_000;
export const DELIVERY_POLL_WINDOW_MS = 24 * 60 * 60 * 1000;
export const FIRST_DELIVERY_POLL_MS = 5 * 60 * 1000;

export function sendBackoffMs(attemptCount: number): number {
  const exponent = Math.max(0, attemptCount - 1);
  return Math.min(30_000 * 2 ** exponent, 15 * 60 * 1000);
}

export function deliveryPollDelayMs(pollCount: number): number {
  return Math.min(5 * 60 * 1000 * Math.max(1, pollCount), 30 * 60 * 1000);
}

export function transientHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export interface SmsSender {
  readonly name: SmsProviderName;
  isConfigured(): boolean;
  send(
    phone: string,
    message: string,
    recipientId: string,
  ): Promise<SmsSendResult>;
}

/** Explicit SMS_PROVIDER only. An unset or unknown value stays on mock. */
export function resolveSmsProvider(): SmsProviderName {
  const mode = (process.env.SMS_PROVIDER ?? '').trim().toLowerCase();
  if (mode === 'swala' || mode === 'beem' || mode === 'mock') return mode;
  return 'mock';
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return '***';
  return `${digits.slice(0, 4)}***${digits.slice(-2)}`;
}

export function redactSecret(value: string, ...secrets: string[]): string {
  const unique = [...new Set(secrets.map((secret) => secret.trim()).filter(Boolean))];
  unique.sort((left, right) => right.length - left.length);
  let redacted = value;
  for (const secret of unique) {
    redacted = redacted.split(secret).join('[redacted]');
  }
  return redacted;
}
