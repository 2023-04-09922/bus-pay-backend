import { Injectable, Logger } from '@nestjs/common';

import { normalizePhone, TZ_PHONE_PATTERN } from '../auth/identity';
import {
  maskPhone,
  redactSecret,
  transientHttpStatus,
  type SmsSendResult,
} from './sms-provider';

const DEFAULT_BASE_URL = 'https://swalasms.com/api/v1';
const REQUEST_TIMEOUT_MS = 15_000;

@Injectable()
export class SwalaSmsProvider {
  private readonly logger = new Logger(SwalaSmsProvider.name);

  private get apiKey() {
    return process.env.SWALA_API_KEY?.trim() ?? '';
  }

  private get senderId() {
    return process.env.SWALA_SENDER_ID?.trim() ?? '';
  }

  private get baseUrl() {
    return (
      process.env.SWALA_API_BASE_URL?.trim() || DEFAULT_BASE_URL
    ).replace(/\/$/, '');
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey && this.senderId);
  }

  async send(
    phone: string,
    message: string,
    recipientId: string,
  ): Promise<SmsSendResult> {
    const recipient = normalizePhone(phone);
    if (!TZ_PHONE_PATTERN.test(recipient)) {
      return { ok: false, provider: 'swala', error: 'Invalid Tanzanian phone number' };
    }
    if (!message.trim()) {
      return { ok: false, provider: 'swala', error: 'Message is required' };
    }
    if (message.length > 1600) {
      return { ok: false, provider: 'swala', error: 'Message exceeds 1600 characters' };
    }
    if (!this.apiKey) {
      return { ok: false, provider: 'swala', error: 'SWALA_API_KEY is not configured' };
    }
    if (!this.senderId) {
      return { ok: false, provider: 'swala', error: 'SWALA_SENDER_ID is not configured' };
    }

    const url = `${this.baseUrl}/sms/messages`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': recipientId,
        },
        body: JSON.stringify({
          recipient,
          sender_id: this.senderId,
          body: message,
        }),
      });
      return await this.readSendResponse(response, recipient);
    } catch (err) {
      const timedOut =
        err instanceof Error &&
        (err.name === 'TimeoutError' || err.name === 'AbortError');
      const error = timedOut
        ? 'SwalaSMS request timed out'
        : 'SwalaSMS request failed';
      this.logger.warn(
        `provider=swala recipient=${maskPhone(recipient)} status=RETRY error=${error}`,
      );
      return { ok: false, provider: 'swala', error, retryable: true };
    }
  }

  async fetchStatus(messageId: string): Promise<SmsSendResult> {
    if (!/^[A-Za-z0-9-]{8,80}$/.test(messageId)) {
      return { ok: false, provider: 'swala', error: 'Invalid SwalaSMS message id' };
    }
    if (!this.apiKey) {
      return { ok: false, provider: 'swala', error: 'SWALA_API_KEY is not configured' };
    }

    const url = `${this.baseUrl}/sms/messages/${encodeURIComponent(messageId)}`;
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });
      const raw = await this.readJson(response);
      if (!response.ok || this.isFailure(raw)) {
        return {
          ok: false,
          provider: 'swala',
          retryable: transientHttpStatus(response.status),
          error: this.errorMessage(raw, `SwalaSMS HTTP ${response.status}`),
        };
      }
      const data = this.messageData(raw, messageId);
      if (!data?.status) {
        return {
          ok: false,
          provider: 'swala',
          error: 'Unexpected SwalaSMS status response',
        };
      }
      return {
        ok: true,
        provider: 'swala',
        requestId: data.uid ?? messageId,
        providerStatus: data.status,
      };
    } catch (err) {
      const timedOut =
        err instanceof Error &&
        (err.name === 'TimeoutError' || err.name === 'AbortError');
      return {
        ok: false,
        provider: 'swala',
        retryable: true,
        error: timedOut
          ? 'SwalaSMS request timed out'
          : 'SwalaSMS request failed',
      };
    }
  }

  private async readSendResponse(
    response: Response,
    recipient: string,
  ): Promise<SmsSendResult> {
    const raw = await this.readJson(response);
    if (!response.ok || this.isFailure(raw)) {
      const error = this.errorMessage(raw, `SwalaSMS HTTP ${response.status}`);
      const retryable = transientHttpStatus(response.status);
      this.logger.warn(
        `provider=swala recipient=${maskPhone(recipient)} status=${retryable ? 'RETRY' : 'FAILED'} error=${error}`,
      );
      return { ok: false, provider: 'swala', error, retryable };
    }

    const data = this.messageData(raw);
    if (!data?.uid) {
      this.logger.warn(
        `provider=swala recipient=${maskPhone(recipient)} status=RETRY error=missing message id`,
      );
      return {
        ok: false,
        provider: 'swala',
        retryable: true,
        error: 'SwalaSMS response did not include a message id',
      };
    }

    const providerStatus = data.status ?? 'queued';
    this.logger.log(
      `provider=swala messageId=${data.uid} recipient=${maskPhone(recipient)} status=${providerStatus}`,
    );
    return { ok: true, provider: 'swala', requestId: data.uid, providerStatus };
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

  private isFailure(raw: unknown): boolean {
    return (
      typeof raw === 'object' &&
      raw !== null &&
      'success' in raw &&
      (raw as { success: unknown }).success === false
    );
  }

  private messageData(
    raw: unknown,
    expectedUid?: string,
  ): { uid?: string; status?: string } | null {
    if (typeof raw !== 'object' || raw === null || !('data' in raw)) {
      return null;
    }
    const data = (raw as { data: unknown }).data;
    if (Array.isArray(data)) {
      const match = data.find(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          (!expectedUid ||
            (item as { uid?: unknown }).uid === expectedUid),
      );
      return this.asMessage(match);
    }
    return this.asMessage(data);
  }

  private asMessage(value: unknown): { uid?: string; status?: string } | null {
    if (typeof value !== 'object' || value === null) return null;
    const record = value as { uid?: unknown; status?: unknown };
    return {
      uid: typeof record.uid === 'string' ? record.uid : undefined,
      status: typeof record.status === 'string' ? record.status : undefined,
    };
  }

  private errorMessage(raw: unknown, fallback: string): string {
    const message =
      typeof raw === 'object' &&
      raw !== null &&
      'message' in raw &&
      typeof (raw as { message: unknown }).message === 'string'
        ? (raw as { message: string }).message
        : fallback;
    return redactSecret(message, this.apiKey);
  }
}
