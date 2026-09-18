import { randomInt } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CardStatus,
  MerchantCategory,
  Prisma,
  ServiceType,
  TerminalStatus,
  TransactionStatus,
  type User,
  UserRole,
  UserStatus,
  WalletStatus,
} from '../generated/prisma';

import { normalizeNida, normalizePhone } from '../auth/identity';
import { PrismaService } from '../prisma/prisma.service';
import {
  IssueCardDto,
  RenewCardDto,
  ReplaceCardDto,
  TapPaymentDto,
  TopUpDto,
} from './dto/platform.dto';

const SERVICE_TYPES = new Set<string>(Object.values(ServiceType));

@Injectable()
export class PlatformService {
  constructor(private readonly prisma: PrismaService) {}

  async issueCard(dto: IssueCardDto) {
    const phone = normalizePhone(dto.phone);
    const nidaRaw = normalizeNida(dto.nida);
    const nida = nidaRaw.length === 20 ? nidaRaw : undefined;
    const serialNumber = this.normalizeSerial(dto.serialNumber);
    const nfcUid = this.normalizeUid(dto.nfcUid);
    const initialLoad = Math.max(0, dto.initialLoad ?? 0);

    if (!serialNumber) {
      throw new BadRequestException('Card number is required');
    }

    const existingCustomer = await this.prisma.customer.findFirst({
      where: nida ? { OR: [{ phone }, { nida }] } : { phone },
      include: { wallet: true },
    });

    if (existingCustomer && nida && existingCustomer.phone !== phone) {
      throw new ConflictException('NIDA is already registered');
    }
    if (existingCustomer && nida && existingCustomer.nida !== nida) {
      throw new ConflictException('Phone number is already registered');
    }

    const taken = await this.prisma.card.findUnique({
      where: { serialNumber },
    });
    if (taken) {
      throw new ConflictException('Card number already exists');
    }
    if (nfcUid) {
      const takenUid = await this.prisma.card.findUnique({
        where: { nfcUid },
      });
      if (takenUid) {
        throw new ConflictException('NFC UID is already issued');
      }
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const customer =
        existingCustomer ??
        (await tx.customer.create({
          data: {
            firstName: dto.firstName.trim(),
            lastName: dto.lastName.trim(),
            phone,
            nida: nida ?? (await this.uniquePlaceholderNida()),
            status: UserStatus.ACTIVE,
          },
        }));

      const wallet =
        existingCustomer?.wallet ??
        (await tx.wallet.create({
          data: {
            publicCode: await this.uniqueCode('WAL'),
            customerId: customer.id,
            balance: initialLoad,
          },
        }));

      const nextWallet =
        existingCustomer?.wallet && initialLoad > 0
          ? await tx.wallet.update({
              where: { id: wallet.id },
              data: { balance: { increment: initialLoad } },
            })
          : wallet;

      const card = await tx.card.create({
        data: {
          serialNumber,
          nfcUid,
          walletId: nextWallet.id,
          status: CardStatus.ACTIVE,
        },
      });

      await tx.smsOutbox.create({
        data: {
          phone,
          type: 'CARD_REGISTERED',
          status: 'PENDING',
          message: `Bus Pay: Kadi ${serialNumber} imesajiliwa kwa ${dto.firstName.trim()} ${dto.lastName.trim()}. Salio TZS ${nextWallet.balance}.`,
        },
      });

      return { card, wallet: nextWallet, customer };
    });

    return {
      success: true,
      message: 'Card issued',
      smsQueued: true,
      ...this.cardView(result.card, result.wallet, result.customer),
    };
  }

  async tap(user: User, dto: TapPaymentDto) {
    if (dto.amount < 1) {
      throw new BadRequestException('Amount must be greater than 0');
    }

    const terminal = await this.requireConductorTerminal(user);
    const amount = dto.amount;
    const card = await this.findCard(dto.serialNumber, dto.nfcUid);
    if (card.status !== CardStatus.ACTIVE) {
      throw new BadRequestException(`Card is ${card.status.toLowerCase()}`);
    }

    const wallet = card.wallet;
    if (wallet.status !== WalletStatus.ACTIVE) {
      throw new BadRequestException('Wallet is not active');
    }
    if (wallet.customer.status !== UserStatus.ACTIVE) {
      throw new BadRequestException('Customer account is not active');
    }
    if (wallet.balance < amount) {
      throw new BadRequestException('Insufficient balance');
    }

    if (dto.nfcUid && !card.nfcUid) {
      const uid = this.normalizeUid(dto.nfcUid);
      if (uid) {
        const takenUid = await this.prisma.card.findUnique({
          where: { nfcUid: uid },
        });
        if (takenUid) {
          throw new ConflictException('NFC UID is already issued');
        }
        await this.prisma.card.update({
          where: { id: card.id },
          data: { nfcUid: uid },
        });
      }
    }

    const merchant = await this.prisma.merchant.findUnique({
      where: { id: terminal.merchantId },
    });
    if (!merchant) {
      throw new NotFoundException('Merchant not found');
    }

    const serviceType = this.parseService(
      dto.serviceType,
      merchant.category,
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: { decrement: amount } },
      });
      if (locked.balance < 0) {
        throw new BadRequestException('Insufficient balance');
      }

      const payment = await tx.paymentTransaction.create({
        data: {
          reference: await this.nextReference(tx),
          cardId: card.id,
          walletId: wallet.id,
          merchantId: merchant.id,
          terminalId: terminal.id,
          amount,
          serviceType,
          status: TransactionStatus.SUCCESS,
        },
      });

      return { payment, balance: locked.balance };
    });

    return {
      message: 'Payment successful',
      reference: updated.payment.reference,
      amount,
      currency: 'TZS',
      serviceType,
      status: updated.payment.status,
      wallet: {
        publicCode: wallet.publicCode,
        balance: updated.balance,
      },
      card: {
        serialNumber: card.serialNumber,
      },
      customer: {
        firstName: wallet.customer.firstName,
        lastName: wallet.customer.lastName,
      },
      merchant: {
        merchantCode: merchant.merchantCode,
        name: merchant.name,
      },
      terminal: terminal.terminalCode,
    };
  }

  async topUp(dto: TopUpDto) {
    const card = dto.serialNumber
      ? await this.findCard(dto.serialNumber, undefined)
      : undefined;
    const wallet = card?.wallet ?? (await this.findWalletByPhone(dto.phone));

    if (wallet.status !== WalletStatus.ACTIVE) {
      throw new BadRequestException('Wallet is not active');
    }

    const previousBalance = wallet.balance;
    const updated = await this.prisma.wallet.update({
      where: { id: wallet.id },
      data: { balance: { increment: dto.amount } },
    });

    const activeCard =
      card ??
      (await this.prisma.card.findFirst({
        where: { walletId: wallet.id, status: CardStatus.ACTIVE },
      }));

    return {
      success: true,
      message: 'Top-up successful',
      credited: dto.amount,
      previousBalance,
      ...this.cardView(
        activeCard ?? {
          serialNumber: dto.serialNumber ?? '',
          nfcUid: null,
          status: CardStatus.ACTIVE,
          issuedAt: new Date(),
        },
        updated,
        wallet.customer,
      ),
      wallet: {
        publicCode: updated.publicCode,
        balance: updated.balance,
        status: updated.status,
      },
    };
  }

  async renewCard(serialNumber: string, dto: RenewCardDto) {
    const card = await this.findCard(serialNumber, undefined);
    const nfcUid = this.normalizeUid(dto.nfcUid);
    const extra = Math.max(0, dto.amount ?? dto.initialLoad ?? 0);

    if (nfcUid) {
      const takenUid = await this.prisma.card.findFirst({
        where: { nfcUid, NOT: { id: card.id } },
      });
      if (takenUid) {
        throw new ConflictException('NFC UID is already issued');
      }
    }

    const customerData: {
      firstName?: string;
      lastName?: string;
      phone?: string;
    } = {};
    if (dto.firstName?.trim()) customerData.firstName = dto.firstName.trim();
    if (dto.lastName?.trim()) customerData.lastName = dto.lastName.trim();
    if (dto.phone) customerData.phone = normalizePhone(dto.phone);

    const [updatedCard, customer, wallet] = await this.prisma.$transaction(
      async (tx) => {
        const nextCard = await tx.card.update({
          where: { id: card.id },
          data: {
            status: CardStatus.ACTIVE,
            ...(nfcUid ? { nfcUid } : {}),
          },
        });
        const nextCustomer =
          Object.keys(customerData).length > 0
            ? await tx.customer.update({
                where: { id: card.wallet.customer.id },
                data: customerData,
              })
            : card.wallet.customer;
        const nextWallet =
          extra > 0
            ? await tx.wallet.update({
                where: { id: card.wallet.id },
                data: { balance: { increment: extra } },
              })
            : card.wallet;
        return [nextCard, nextCustomer, nextWallet] as const;
      },
    );

    return {
      success: true,
      message: 'Card renewed',
      ...this.cardView(updatedCard, wallet, customer),
    };
  }

  async freezeCard(serialNumber: string) {
    const card = await this.findCard(serialNumber, undefined);
    const updated = await this.prisma.card.update({
      where: { id: card.id },
      data: { status: CardStatus.FROZEN },
    });
    return {
      message: 'Card frozen',
      serialNumber: updated.serialNumber,
      status: updated.status,
    };
  }

  async replaceCard(oldSerial: string, dto: ReplaceCardDto) {
    const oldCard = await this.findCard(oldSerial, undefined);
    const serialNumber = this.normalizeSerial(dto.serialNumber);
    const nfcUid = this.normalizeUid(dto.nfcUid);

    if (serialNumber) {
      const taken = await this.prisma.card.findUnique({
        where: { serialNumber },
      });
      if (taken) {
        throw new ConflictException('Card serial is already issued');
      }
    }

    const replacement = await this.prisma.$transaction(async (tx) => {
      const created = await tx.card.create({
        data: {
          serialNumber: serialNumber || (await this.uniqueCode('BP')),
          nfcUid,
          walletId: oldCard.walletId,
          status: CardStatus.ACTIVE,
        },
      });
      await tx.card.update({
        where: { id: oldCard.id },
        data: {
          status: CardStatus.REPLACED,
          replacedById: created.id,
        },
      });
      return created;
    });

    return {
      message: 'Card replaced. Wallet balance is unchanged.',
      oldCard: oldCard.serialNumber,
      card: {
        serialNumber: replacement.serialNumber,
        nfcUid: replacement.nfcUid,
        status: replacement.status,
      },
      wallet: {
        publicCode: oldCard.wallet.publicCode,
        balance: oldCard.wallet.balance,
      },
    };
  }

  async lookupCard(serialNumber?: string, nfcUid?: string) {
    const card = await this.findCard(serialNumber, nfcUid);
    return this.cardView(card, card.wallet, card.wallet.customer);
  }

  async getTransactions(user: User) {
    const terminal = await this.requireConductorTerminal(user);

    const transactions = await this.prisma.paymentTransaction.findMany({
      where: {
        terminalId: terminal.id,
      },
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        card: {
          select: {
            serialNumber: true,
          },
        },
        wallet: {
          select: {
            customer: {
              select: {
                firstName: true,
                lastName: true,
              },
            },
          },
        },
        merchant: {
          select: {
            merchantCode: true,
            name: true,
          },
        },
        terminal: {
          select: {
            terminalCode: true,
          },
        },
      },
    });

    return {
      terminal: terminal.terminalCode,
      collected: transactions
        .filter((transaction) => transaction.status === TransactionStatus.SUCCESS)
        .reduce((sum, transaction) => sum + transaction.amount, 0),
      transactions: transactions.map((transaction) => ({
        reference: transaction.reference,
        amount: transaction.amount,
        currency: transaction.currency,
        serviceType: transaction.serviceType,
        status: transaction.status,
        card: transaction.card.serialNumber,
        passenger:
          `${transaction.wallet.customer.firstName} ${transaction.wallet.customer.lastName}`.trim(),
        merchant: transaction.merchant.name,
        terminal: transaction.terminal?.terminalCode ?? null,
        createdAt: transaction.createdAt,
      })),
    };
  }

  private async requireConductorTerminal(user: User) {
    if (user.role !== UserRole.CONDUCTOR) {
      throw new ForbiddenException(
        'Only conductors can use this terminal',
      );
    }

    const terminal = await this.prisma.terminal.findFirst({
      where: {
        ownerUserId: user.id,
        status: TerminalStatus.ACTIVE,
      },
    });

    if (!terminal) {
      throw new NotFoundException(
        'No active terminal is assigned to this conductor',
      );
    }

    return terminal;
  }

  private async findCard(serialNumber?: string, nfcUid?: string) {
    const serial = this.normalizeSerial(serialNumber);
    const uid = this.normalizeUid(nfcUid);
    if (!serial && !uid) {
      throw new BadRequestException('serialNumber or nfcUid is required');
    }

    const card = await this.prisma.card.findFirst({
      where: serial ? { serialNumber: serial } : { nfcUid: uid },
      include: {
        wallet: {
          include: { customer: true },
        },
      },
    });
    if (!card) {
      throw new NotFoundException('Card not found');
    }
    return card;
  }

  private async findWalletByPhone(phone?: string) {
    const normalized = normalizePhone(phone);
    const customer = await this.prisma.customer.findUnique({
      where: { phone: normalized },
      include: { wallet: true },
    });
    if (!customer?.wallet) {
      throw new NotFoundException('Wallet not found');
    }
    return { ...customer.wallet, customer };
  }

  private async resolveMerchant(merchantCode?: string) {
    const code = merchantCode?.trim() || 'DLD-PLATFORM';
    const merchant = await this.prisma.merchant.findUnique({
      where: { merchantCode: code },
    });
    if (!merchant) {
      throw new NotFoundException('Merchant not found');
    }
    return merchant;
  }

  private parseService(
    value: string | undefined,
    fallback: MerchantCategory,
  ): ServiceType {
    const raw = (value || fallback).toUpperCase();
    if (!SERVICE_TYPES.has(raw)) {
      return ServiceType.OTHER;
    }
    return raw as ServiceType;
  }

  private normalizeSerial(value?: string): string | undefined {
    const serial = value?.trim().toUpperCase();
    return serial ? serial : undefined;
  }

  private normalizeUid(value?: string): string | undefined {
    const uid = value?.replace(/\s+/g, '').toUpperCase();
    return uid ? uid : undefined;
  }

  private cardView(
    card: {
      serialNumber: string;
      nfcUid?: string | null;
      status: CardStatus;
      issuedAt?: Date;
    },
    wallet: { publicCode?: string; balance: number; status?: WalletStatus },
    customer?: { firstName: string; lastName: string; phone: string },
  ) {
    return {
      card: {
        serialNumber: card.serialNumber,
        nfcUid: card.nfcUid ?? '',
        status: card.status,
        frozen: card.status === CardStatus.FROZEN,
        balance: wallet.balance,
        issuedAt: card.issuedAt,
      },
      wallet: {
        publicCode: wallet.publicCode,
        balance: wallet.balance,
        status: wallet.status,
      },
      customer: {
        firstName: customer?.firstName ?? '',
        lastName: customer?.lastName ?? '',
        phone: customer?.phone ?? '',
      },
    };
  }

  private async uniquePlaceholderNida(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const nida = `9${Date.now()}${randomInt(100000, 999999)}`.slice(0, 20);
      const taken = await this.prisma.customer.findUnique({ where: { nida } });
      if (!taken) {
        return nida;
      }
    }
    throw new ConflictException('Could not generate a customer id');
  }

  private async uniqueCode(prefix: 'BP' | 'WAL'): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = `${prefix}-${String(randomInt(100000000, 1000000000))}`;
      const taken =
        prefix === 'BP'
          ? await this.prisma.card.findUnique({ where: { serialNumber: code } })
          : await this.prisma.wallet.findUnique({ where: { publicCode: code } });
      if (!taken) {
        return code;
      }
    }
    throw new ConflictException('Could not generate a unique code');
  }

  private async nextReference(
    tx: Prisma.TransactionClient,
  ): Promise<string> {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const reference = `BP-${day}-${String(randomInt(0, 1000000)).padStart(6, '0')}`;
      const taken = await tx.paymentTransaction.findUnique({
        where: { reference },
      });
      if (!taken) {
        return reference;
      }
    }
    throw new ConflictException('Could not generate a payment reference');
  }
}
