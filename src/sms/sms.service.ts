import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';

export type SmsType =
  | 'CARD_REGISTERED'
  | 'TOP_UP'
  | 'PAYMENT_TAP'
  | 'PAYMENT_TAP_CONDUCTOR'
  | 'CARD_RENEWED'
  | 'WALLET_REFUND'

type DbClient = Prisma.TransactionClient | PrismaService

@Injectable()
export class SmsService {
  constructor(private readonly prisma: PrismaService) {}

  async enqueue(
    phone: string,
    type: SmsType,
    message: string,
    db: DbClient = this.prisma,
  ) {
    return db.smsOutbox.create({
      data: {
        phone,
        type,
        message,
        status: 'PENDING',
      },
    })
  }
}
