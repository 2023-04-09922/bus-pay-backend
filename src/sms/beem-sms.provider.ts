import { Injectable, Logger } from '@nestjs/common';

export type BeemSendResult = {
  ok: boolean
  requestId?: string
  raw?: unknown
  error?: string
  mocked?: boolean
}

@Injectable()
export class BeemSmsProvider {
  private readonly logger = new Logger(BeemSmsProvider.name)

  private get apiKey() {
    return process.env.BEEM_SMS_API_KEY?.trim() ?? ''
  }

  private get secretKey() {
    return process.env.BEEM_SMS_SECRET_KEY?.trim() ?? ''
  }

  private get senderName() {
    return process.env.BEEM_SMS_SENDER_NAME?.trim() || 'INFO'
  }

  private get baseUrl() {
    return (
      process.env.BEEM_SMS_BASE_URL?.trim() ||
      'https://apisms.beem.africa/v1'
    )
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey && this.secretKey)
  }

  isMockMode(): boolean {
    const mode = (process.env.SMS_PROVIDER ?? '').toLowerCase()
    if (mode === 'mock') return true
    if (mode === 'beem') return false
    return !this.isConfigured()
  }

  /** Beem expects 2557XXXXXXXX without leading +. */
  toDestAddr(phone: string): string {
    const digits = phone.replace(/\D/g, '')
    if (digits.startsWith('255') && digits.length >= 12) {
      return digits.slice(0, 12)
    }
    if (digits.startsWith('0') && digits.length >= 10) {
      return `255${digits.slice(1, 10)}`
    }
    if (digits.length === 9) {
      return `255${digits}`
    }
    return digits
  }

  async send(phone: string, message: string, recipientId: string): Promise<BeemSendResult> {
    const dest = this.toDestAddr(phone)
    if (!/^255[1-9]\d{8}$/.test(dest)) {
      return { ok: false, error: `Invalid TZ phone for SMS: ${phone}` }
    }

    if (this.isMockMode()) {
      this.logger.log(`[SMS MOCK] → ${dest} | ${message}`)
      return {
        ok: true,
        mocked: true,
        requestId: `mock-${recipientId}`,
      }
    }

    const url = `${this.baseUrl.replace(/\/$/, '')}/send`
    const body = {
      source_addr: this.senderName.slice(0, 11),
      encoding: 0,
      schedule_time: '',
      message,
      recipients: [
        {
          recipient_id: recipientId,
          dest_addr: dest,
        },
      ],
    }

    try {
      const auth = Buffer.from(`${this.apiKey}:${this.secretKey}`).toString(
        'base64',
      )
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      const rawText = await response.text()
      let raw: unknown = rawText
      try {
        raw = rawText ? JSON.parse(rawText) : null
      } catch {
        // keep text
      }

      if (!response.ok) {
        const error =
          typeof raw === 'object' &&
          raw &&
          'message' in raw &&
          typeof (raw as { message: unknown }).message === 'string'
            ? (raw as { message: string }).message
            : `Beem HTTP ${response.status}`
        this.logger.warn(`Beem send failed: ${error}`)
        return { ok: false, error, raw }
      }

      const requestId =
        typeof raw === 'object' &&
        raw &&
        'request_id' in raw &&
        (raw as { request_id: unknown }).request_id != null
          ? String((raw as { request_id: unknown }).request_id)
          : undefined

      return { ok: true, requestId, raw }
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Beem request failed'
      this.logger.error(error)
      return { ok: false, error }
    }
  }
}
