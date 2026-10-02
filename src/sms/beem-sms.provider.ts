import { Injectable, Logger } from '@nestjs/common';

import { normalizePhone, TZ_PHONE_PATTERN } from '../auth/identity';
import {
  maskPhone,
  redactSecret,
  transientHttpStatus,
  type SmsProviderName,
  type SmsSendResult,
  type SmsSender,
} from './sms-provider';

const DEFAULT_BASE_URL = 'https://apisms.beem.africa/v1';
const DELIVERY_URL = 'https://dlrapi.beem.africa/public/v1/delivery-reports';
const REQUEST_TIMEOUT_MS = 15_000;

@Injectable()
export class BeemSmsProvider implements SmsSender {
  readonly name: SmsProviderName = 'beem';
  private readonly logger = new Logger(BeemSmsProvider.name);

  private get apiKey() {
    return (
      process.env.BEEM_API_KEY?.trim() ||
      process.env.BEEM_SMS_API_KEY?.trim() ||
      ''
    );
  }

  private get secretKey() {
    return (
      process.env.BEEM_SECRET_KEY?.trim() ||
      process.env.BEEM_SMS_SECRET_KEY?.trim() ||
      ''
    );
  }

  private get senderId() {
    return (
      process.env.BEEM_SENDER_ID?.trim() ||
      process.env.BEEM_SMS_SENDER_NAME?.trim() ||
      ''
    );
  }

  private get baseUrl() {
    return (
      process.env.BEEM_SMS_BASE_URL?.trim() || DEFAULT_BASE_URL
    ).replace(/\/$/, '');
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey && this.secretKey && this.senderId);
  }

  /** Beem expects 2557XXXXXXXX without a leading +. */
  toDestAddr(phone: string): string | null {
    const recipient = normalizePhone(phone);
    if (!TZ_PHONE_PATTERN.test(recipient)) return null;
    return recipient.slice(1);
  }

  async send(
    phone: string,
    message: string,
    _outboxId: string,
  ): Promise<SmsSendResult> {
    const dest = this.toDestAddr(phone);
    if (!dest) {
      return {
        ok: false,
        provider: 'beem',
        error: 'Invalid Tanzanian phone number',
      };
    }
    if (!message.trim()) {
      return { ok: false, provider: 'beem', error: 'Message is required' };
    }
    const missing = this.missingCredential();
    if (missing) {
      return { ok: false, provider: 'beem', error: missing };
    }

    try {
      const response = await fetch(`${this.baseUrl}/send`, {
        method: 'POST',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Authorization: this.authorization(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          source_addr: this.senderId.slice(0, 11),
          encoding: 0,
          schedule_time: '',
          message,
          recipients: [{ recipient_id: 1, dest_addr: dest }],
        }),
      });
      return await this.readSendResponse(response, dest);
    } catch (err) {
      return {
        ok: false,
        provider: 'beem',
        uncertain: true,
        error: this.networkError(err),
      };
    }
  }

  async fetchDelivery(
    phone: string,
    requestId: string,
  ): Promise<SmsSendResult> {
    const dest = this.toDestAddr(phone);
    if (!dest || !/^[A-Za-z0-9-]{1,80}$/.test(requestId)) {
      return {
        ok: false,
        provider: 'beem',
        error: 'Invalid Beem delivery lookup',
      };
    }
    const missing = this.missingCredential();
    if (missing) return { ok: false, provider: 'beem', error: missing };

    const url = new URL(DELIVERY_URL);
    url.searchParams.set('dest_addr', dest);
    url.searchParams.set('request_id', requestId);
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Authorization: this.authorization() },
      });
      const raw = await this.readJson(response);
      if (response.status === 404) {
        return {
          ok: false,
          provider: 'beem',
          retryable: true,
          error: 'Beem delivery report not found',
        };
      }
      if (!response.ok) {
        return {
          ok: false,
          provider: 'beem',
          retryable: transientHttpStatus(response.status),
          error: this.errorMessage(raw, `Beem HTTP ${response.status}`),
        };
      }
      const providerStatus = this.deliveryStatus(raw, requestId);
      if (!providerStatus) {
        return {
          ok: false,
          provider: 'beem',
          error: 'Unexpected Beem delivery response',
        };
      }
      return {
        ok: true,
        provider: 'beem',
        requestId,
        providerStatus,
      };
    } catch (err) {
      return { ok: false, provider: 'beem', error: this.networkError(err) };
    }
  }

  private async readSendResponse(
    response: Response,
    dest: string,
  ): Promise<SmsSendResult> {
    const raw = await this.readJson(response);
    const successful =
      typeof raw === 'object' &&
      raw !== null &&
      'successful' in raw &&
      (raw as { successful: unknown }).successful === true;
    const requestId = this.requestIdOf(raw);
    if (response.ok && successful && requestId) {
      this.logger.log(
        `provider=beem messageId=${requestId} recipient=${maskPhone(dest)} status=accepted`,
      );
      return {
        ok: true,
        provider: 'beem',
        requestId,
        providerStatus: 'accepted',
      };
    }
    if (requestId || transientHttpStatus(response.status)) {
      const error = this.errorMessage(raw, `Beem HTTP ${response.status}`);
      this.logger.warn(
        `provider=beem recipient=${maskPhone(dest)} status=UNCERTAIN error=${error}`,
      );
      return {
        ok: false,
        provider: 'beem',
        requestId,
        uncertain: true,
        error,
      };
    }
    if (!response.ok || (raw && !successful && this.hasError(raw))) {
      const error = this.errorMessage(raw, `Beem HTTP ${response.status}`);
      this.logger.warn(
        `provider=beem recipient=${maskPhone(dest)} status=FAILED error=${error}`,
      );
      return { ok: false, provider: 'beem', error };
    }
    return {
      ok: false,
      provider: 'beem',
      uncertain: true,
      error: 'Beem response did not include a request id',
    };
  }

  private missingCredential(): string | null {
    if (!this.apiKey) return 'BEEM_API_KEY is not configured';
    if (!this.secretKey) return 'BEEM_SECRET_KEY is not configured';
    if (!this.senderId) return 'BEEM_SENDER_ID is not configured';
    return null;
  }

  private authorization(): string {
    return `Basic ${this.basicToken()}`;
  }

  private async readJson(response: Response): Promise<unknown> {
    const rawText = await response.text();
    if (!rawText) return null;
    try {
      return JSON.parse(rawText) as unknown;
    } catch {
      return null;
    }
  }

  private hasError(raw: unknown): boolean {
    return (
      typeof raw === 'object' &&
      raw !== null &&
      ('message' in raw || 'code' in raw)
    );
  }

  private requestIdOf(raw: unknown): string | undefined {
    if (typeof raw !== 'object' || raw === null || !('request_id' in raw)) {
      return undefined;
    }
    const id = (raw as { request_id: unknown }).request_id;
    if (typeof id === 'string' && id) return id;
    if (typeof id === 'number' && Number.isFinite(id)) return String(id);
    return undefined;
  }

  private deliveryStatus(raw: unknown, requestId: string): string | undefined {
    return this.reportList(raw).find((report) => report.requestId === requestId)
      ?.status;
  }

  private reportList(raw: unknown): { requestId?: string; status?: string }[] {
    if (Array.isArray(raw)) return raw.map((item) => this.asReport(item));
    if (typeof raw !== 'object' || raw === null) return [];
    const data = (raw as { data?: unknown }).data;
    if (Array.isArray(data)) return data.map((item) => this.asReport(item));
    const one = this.asReport(raw);
    return one.requestId || one.status ? [one] : [];
  }

  private asReport(value: unknown): { requestId?: string; status?: string } {
    if (typeof value !== 'object' || value === null) return {};
    const record = value as { request_id?: unknown; status?: unknown };
    const requestId =
      typeof record.request_id === 'string'
        ? record.request_id
        : typeof record.request_id === 'number' && Number.isFinite(record.request_id)
          ? String(record.request_id)
          : undefined;
    const status = typeof record.status === 'string' ? record.status : undefined;
    return { requestId, status };
  }

  private errorMessage(raw: unknown, fallback: string): string {
    const message =
      typeof raw === 'object' &&
      raw !== null &&
      'message' in raw &&
      typeof (raw as { message: unknown }).message === 'string'
        ? (raw as { message: string }).message
        : fallback;
    return redactSecret(
      message,
      this.apiKey,
      this.secretKey,
      this.basicToken(),
      `Basic ${this.basicToken()}`,
    );
  }

  private basicToken(): string {
    return Buffer.from(`${this.apiKey}:${this.secretKey}`).toString('base64');
  }

  private networkError(err: unknown): string {
    const timedOut =
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError');
    const error = timedOut ? 'Beem request timed out' : 'Beem request failed';
    this.logger.warn(`provider=beem error=${error}`);
    return error;
  }
}

export function localStatusFromBeem(providerStatus?: string): string {
  const status = (providerStatus ?? '').toUpperCase();
  if (status === 'DELIVERED') return 'DELIVERED';
  if (
    status === 'UNDELIVERED' ||
    status === 'FAILED' ||
    status === 'REJECTED'
  ) {
    return 'FAILED';
  }
  return 'SENT';
}
