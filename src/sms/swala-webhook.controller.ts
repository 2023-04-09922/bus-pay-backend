import { Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

import { SwalaWebhookService } from './swala-webhook.service';

@Controller('webhooks/swala')
export class SwalaWebhookController {
  constructor(private readonly webhooks: SwalaWebhookService) {}

  @Post('sms')
  @HttpCode(200)
  receive(@Req() req: RawBodyRequest<Request>) {
    return this.webhooks.handle(req.rawBody, req.headers['x-swalasms-signature']);
  }
}
