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
  MerchantStatus,
  Prisma,
  ServiceType,
  TerminalStatus,
  TerminalType,
  TopUpSource,
  TransactionStatus,
  type User,
  UserRole,
  UserStatus,
  WalletStatus,
  WithdrawalStatus,
} from '../generated/prisma';

import { normalizeNida, normalizePhone } from '../auth/identity';
import { PrismaService } from '../prisma/prisma.service';
import { SmsDispatcherService } from '../sms/sms-dispatcher.service';
import { SmsService } from '../sms/sms.service';
import {
  ActivateCardDto,
  ConductorWithdrawDto,
  IssueCardDto,
  RenewCardDto,
  ReplaceCardDto,
  ScanCardDto,
  TapPaymentDto,
  TopUpDto,
} from './dto/platform.dto';

const SERVICE_TYPES = new Set<string>(Object.values(ServiceType));

@Injectable()
export class PlatformService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
    private readonly smsDispatcher: SmsDispatcherService,
  ) {}

  /**
   * Wakala NFC scan step: read UID from hardware, return preview card number.
   * Does not create a wallet yet — confirm via issueCard.
   */
  async previewScan(dto: ScanCardDto) {
    const nfcUid = this.normalizeUid(dto.nfcUid);
    if (!nfcUid) {
      throw new BadRequestException('nfcUid is required from the NFC scanner');
    }

    const existing = await this.prisma.card.findUnique({
      where: { nfcUid },
      include: {
        wallet: { include: { customer: true } },
      },
    });

    if (existing) {
      return {
        alreadyIssued: true,
        nfcUid: existing.nfcUid,
        cardNumber: existing.serialNumber,
        walletAccountNumber: existing.wallet.publicCode,
        status: existing.status,
        passenger: {
          firstName: existing.wallet.customer.firstName,
          lastName: existing.wallet.customer.lastName,
          phone: existing.wallet.customer.phone,
        },
        balance: existing.wallet.balance,
        message:
          existing.status === CardStatus.ACTIVE
            ? 'This NFC card is already linked to a BusPay wallet'
            : `This NFC card is already registered (${existing.status})`,
      };
    }

    const cardNumber = await this.uniqueCardNumber();
    return {
      alreadyIssued: false,
      step: 'SCAN_OK',
      nextStep: 'ACTIVATE',
      /** For app state only — do not show in wakala UI. */
      nfcUid,
      cardNumber,
      walletAccountNumber: null,
      message:
        'NFC scan OK. Show card number to wakala; keep NFC UID internal.',
    };
  }

  /**
   * Top-up scan: identify passenger from NFC UID (internal).
   * UI should show passenger name + card number only.
   */
  async previewTopUpScan(dto: ScanCardDto) {
    const nfcUid = this.normalizeUid(dto.nfcUid);
    if (!nfcUid) {
      throw new BadRequestException('nfcUid is required from the NFC scanner');
    }

    const card = await this.prisma.card.findUnique({
      where: { nfcUid },
      include: {
        wallet: { include: { customer: true } },
      },
    });

    if (!card) {
      throw new NotFoundException(
        'No BusPay card found for this NFC tag. Register the D-Card first.',
      );
    }

    if (card.status !== CardStatus.ACTIVE) {
      throw new BadRequestException(
        `Card cannot be topped up (status: ${card.status})`,
      );
    }

    if (card.wallet.status !== WalletStatus.ACTIVE) {
      throw new BadRequestException('Wallet is not active');
    }

    if (card.wallet.customer.status !== UserStatus.ACTIVE) {
      throw new BadRequestException('Passenger account is not active');
    }

    const passengerName =
      `${card.wallet.customer.firstName} ${card.wallet.customer.lastName}`.trim();

    return {
      step: 'TOPUP_SCAN_OK',
      nextStep: 'ENTER_AMOUNT',
      verified: true,
      /** Display fields for wakala UI */
      passenger: {
        name: passengerName,
        firstName: card.wallet.customer.firstName,
        lastName: card.wallet.customer.lastName,
        phone: card.wallet.customer.phone,
      },
      cardNumber: card.serialNumber,
      balance: card.wallet.balance,
      walletAccountNumber: card.wallet.publicCode,
      /** Keep in app memory for confirm top-up — do not render in UI */
      nfcUid: card.nfcUid,
      message: 'Card verified. Confirm passenger, then enter top-up amount.',
    };
  }

  /**
   * Step: passenger names + card number + NFC UID → create/activate wallet (balance 0).
   * Next: POST /platform/wallets/topup for initial credit + SMS.
   */
  async activateCard(dto: ActivateCardDto) {
    return this.issueCard({
      firstName: dto.firstName,
      lastName: dto.lastName,
      phone: dto.phone,
      nida: dto.nida,
      cardNumber: dto.cardNumber,
      serialNumber: dto.cardNumber,
      nfcUid: dto.nfcUid,
      initialLoad: 0,
    });
  }

  async issueCard(dto: IssueCardDto) {
    const phone = normalizePhone(dto.phone);
    const nidaRaw = normalizeNida(dto.nida);
    const nida = nidaRaw.length === 20 ? nidaRaw : undefined;
    const nfcUid = this.normalizeUid(dto.nfcUid);
    const initialLoad = Math.max(0, dto.initialLoad ?? 0);

    if (!nfcUid) {
      throw new BadRequestException('nfcUid is required from the NFC scanner');
    }

    const takenUid = await this.prisma.card.findUnique({
      where: { nfcUid },
    });
    if (takenUid) {
      throw new ConflictException('NFC UID is already issued');
    }

    let serialNumber = this.normalizeSerial(
      dto.cardNumber ?? dto.serialNumber,
    );
    if (!serialNumber) {
      serialNumber = await this.uniqueCardNumber();
    } else {
      const taken = await this.prisma.card.findUnique({
        where: { serialNumber },
      });
      if (taken) {
        throw new ConflictException('Card number already exists');
      }
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

      if (existingCustomer) {
        await tx.customer.update({
          where: { id: customer.id },
          data: {
            firstName: dto.firstName.trim(),
            lastName: dto.lastName.trim(),
          },
        });
      }

      const wallet =
        existingCustomer?.wallet ??
        (await tx.wallet.create({
          data: {
            publicCode: await this.uniqueWalletAccount(),
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

      if (initialLoad > 0) {
        await tx.topUp.create({
          data: {
            reference: await this.nextTopUpReference(tx),
            walletId: nextWallet.id,
            cardId: card.id,
            amount: initialLoad,
            previousBalance: nextWallet.balance - initialLoad,
            newBalance: nextWallet.balance,
            source: TopUpSource.INITIAL_LOAD,
          },
        });
      }

      const passengerName = `${dto.firstName.trim()} ${dto.lastName.trim()}`;
      const smsMessage =
        initialLoad > 0
          ? `Bus Pay: Akaunti ${serialNumber} imeamilishwa kwa ${passengerName}. Salio TZS ${nextWallet.balance}. Tumia namba ya akaunti kwa top-up.`
          : `Bus Pay: Akaunti ${serialNumber} imeamilishwa kwa ${passengerName}. Salio TZS 0. Top-up kwa namba ${serialNumber} au akaunti ya pochi.`;

      await this.sms.enqueue(phone, 'CARD_REGISTERED', smsMessage, tx);

      return {
        card,
        wallet: nextWallet,
        customer: {
          ...customer,
          firstName: dto.firstName.trim(),
          lastName: dto.lastName.trim(),
          phone,
        },
      };
    });

    void this.smsDispatcher.flush();

    const view = this.cardView(result.card, result.wallet, result.customer);
    return {
      success: true,
      step: 'WALLET_ACTIVATED',
      nextStep: initialLoad > 0 ? 'DONE' : 'TOP_UP',
      message:
        initialLoad > 0
          ? 'Wallet activated and credited'
          : 'Wallet activated. Enter initial top-up to credit balance.',
      smsQueued: true,
      ...view,
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

      await this.sms.enqueue(
        wallet.customer.phone,
        'PAYMENT_TAP',
        `Bus Pay: Umeliwa TZS ${amount}. Salio TZS ${locked.balance}. Kumb. ${payment.reference}.`,
        tx,
      );

      await this.sms.enqueue(
        user.phone,
        'PAYMENT_TAP_CONDUCTOR',
        `Bus Pay: Malipo TZS ${amount} yamepokewa. Abiria ${wallet.customer.firstName} ${wallet.customer.lastName}. Kadi ${card.serialNumber}. Kumb. ${payment.reference}.`,
        tx,
      );

      return { payment, balance: locked.balance };
    });

    void this.smsDispatcher.flush();

    return {
      message: 'Payment successful',
      reference: updated.payment.reference,
      amount,
      currency: 'TZS',
      serviceType,
      status: updated.payment.status,
      smsQueued: true,
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

  async topUp(user: User, dto: TopUpDto) {
    if (dto.amount < 1) {
      throw new BadRequestException('Amount must be greater than 0');
    }

    const account =
      dto.walletAccountNumber?.trim() ||
      dto.publicCode?.trim() ||
      undefined;

    const nfcUid = this.normalizeUid(dto.nfcUid);
    const card =
      nfcUid || dto.serialNumber
        ? await this.findCard(dto.serialNumber, nfcUid)
        : undefined;

    if (card) {
      if (card.status !== CardStatus.ACTIVE) {
        throw new BadRequestException(
          `Card cannot be topped up (status: ${card.status})`,
        );
      }
    }

    const wallet =
      card?.wallet ??
      (account
        ? await this.findWalletByAccount(account)
        : dto.phone
          ? await this.findWalletByPhone(dto.phone)
          : (() => {
              throw new BadRequestException(
                'Scan the D-Card (nfcUid) or provide card/wallet account number',
              );
            })());

    if (wallet.status !== WalletStatus.ACTIVE) {
      throw new BadRequestException('Wallet is not active');
    }

    if (wallet.customer.status !== UserStatus.ACTIVE) {
      throw new BadRequestException('Passenger account is not active');
    }

    const previousBalance = wallet.balance;
    const { updated, activeCard } = await this.prisma.$transaction(
      async (tx) => {
        const nextWallet = await tx.wallet.update({
          where: { id: wallet.id },
          data: { balance: { increment: dto.amount } },
        });

        const nextCard =
          card ??
          (await tx.card.findFirst({
            where: { walletId: wallet.id, status: CardStatus.ACTIVE },
          }));

        await tx.topUp.create({
          data: {
            reference: await this.nextTopUpReference(tx),
            walletId: wallet.id,
            cardId: nextCard?.id,
            agentUserId: user.id,
            amount: dto.amount,
            previousBalance,
            newBalance: nextWallet.balance,
            source: TopUpSource.AGENT_TOPUP,
          },
        });

        await this.sms.enqueue(
          wallet.customer.phone,
          'TOP_UP',
          `Bus Pay: Umepokea TZS ${dto.amount}. Salio jipya TZS ${nextWallet.balance}.`,
          tx,
        );

        return { updated: nextWallet, activeCard: nextCard };
      },
    );

    const view = this.cardView(
      activeCard ?? {
        serialNumber: dto.serialNumber ?? updated.publicCode,
        nfcUid: null,
        status: CardStatus.ACTIVE,
        issuedAt: new Date(),
      },
      updated,
      wallet.customer,
    );

    void this.smsDispatcher.flush();

    const passengerName =
      `${wallet.customer.firstName} ${wallet.customer.lastName}`.trim();

    return {
      success: true,
      step: 'WALLET_CREDITED',
      nextStep: 'DONE',
      message: 'Payment confirmed. Wallet credited.',
      paymentConfirmed: true,
      credited: dto.amount,
      previousBalance,
      smsQueued: true,
      passenger: {
        name: passengerName,
        firstName: wallet.customer.firstName,
        lastName: wallet.customer.lastName,
      },
      cardNumber: view.card.cardNumber,
      ...view,
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
        const previousBalance = card.wallet.balance;
        const nextWallet =
          extra > 0
            ? await tx.wallet.update({
                where: { id: card.wallet.id },
                data: { balance: { increment: extra } },
              })
            : card.wallet;

        if (extra > 0) {
          await tx.topUp.create({
            data: {
              reference: await this.nextTopUpReference(tx),
              walletId: nextWallet.id,
              cardId: nextCard.id,
              amount: extra,
              previousBalance,
              newBalance: nextWallet.balance,
              source: TopUpSource.AGENT_TOPUP,
            },
          });
          await this.sms.enqueue(
            nextCustomer.phone,
            'CARD_RENEWED',
            `Bus Pay: Kadi ${serialNumber} imesasishwa. Umepokea TZS ${extra}. Salio TZS ${nextWallet.balance}.`,
            tx,
          );
        }

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

    const grossCollected = transactions
      .filter((transaction) => transaction.status === TransactionStatus.SUCCESS)
      .reduce((sum, transaction) => sum + transaction.amount, 0);

    const withdrawn = await this.conductorWithdrawnTotal(user.id);
    const available = Math.max(0, grossCollected - withdrawn);

    const withdrawnRows = await this.prisma.withdrawal.findMany({
      where: { conductorUserId: user.id },
      orderBy: { requestedAt: 'desc' },
      include: {
        agent: {
          select: {
            firstName: true,
            lastName: true,
            tillNumber: true,
          },
        },
      },
    });

    return {
      terminal: terminal.terminalCode,
      collected: available,
      grossCollected,
      withdrawn,
      available,
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
      withdrawals: withdrawnRows.map((row) => ({
        reference: row.reference,
        amount: row.amount,
        status: row.status,
        tillNumber: row.agent.tillNumber,
        agent:
          `${row.agent.firstName} ${row.agent.lastName}`.trim(),
        createdAt: row.requestedAt,
      })),
    };
  }

  async lookupWakalaTill(tillNumber: string) {
    const till = this.normalizeTill(tillNumber);
    if (!till) {
      throw new BadRequestException('Enter a valid wakala TILL number');
    }
    const agent = await this.findAgentByTill(till);
    if (!agent) {
      throw new NotFoundException('Wakala TILL not found');
    }
    if (agent.status !== UserStatus.ACTIVE) {
      throw new BadRequestException('Wakala account is not active');
    }
    return {
      verified: true,
      tillNumber: agent.tillNumber,
      agent: {
        firstName: agent.firstName,
        lastName: agent.lastName,
        name: `${agent.firstName} ${agent.lastName}`.trim(),
      },
    };
  }

  /**
   * Conductor → wakala cash-out: enter wakala TILL + amount.
   * Deducts from terminal collections immediately (status PAID).
   */
  async withdrawToWakala(user: User, dto: ConductorWithdrawDto) {
    if (user.role !== UserRole.CONDUCTOR) {
      throw new ForbiddenException('Only conductors can withdraw via wakala');
    }
    if (dto.amount < 1) {
      throw new BadRequestException('Amount must be greater than 0');
    }

    const till = this.normalizeTill(dto.tillNumber);
    if (!till) {
      throw new BadRequestException('Enter a valid wakala TILL number');
    }

    const agent = await this.findAgentByTill(till);
    if (!agent) {
      throw new NotFoundException('Wakala TILL not found');
    }
    if (agent.status !== UserStatus.ACTIVE) {
      throw new BadRequestException('Wakala account is not active');
    }

    const terminal = await this.requireConductorTerminal(user);
    const available = await this.conductorAvailableBalance(user.id, terminal.id);
    if (dto.amount > available) {
      throw new BadRequestException(
        `Insufficient balance. Available TZS ${available}`,
      );
    }

    const withdrawal = await this.prisma.$transaction(async (tx) => {
      // Re-check inside transaction to avoid double-spend races.
      const lockedAvailable = await this.conductorAvailableBalance(
        user.id,
        terminal.id,
        tx,
      );
      if (dto.amount > lockedAvailable) {
        throw new BadRequestException(
          `Insufficient balance. Available TZS ${lockedAvailable}`,
        );
      }

      const created = await tx.withdrawal.create({
        data: {
          reference: await this.nextWithdrawalReference(tx),
          agentUserId: agent.id,
          conductorUserId: user.id,
          amount: dto.amount,
          status: WithdrawalStatus.PAID,
          notes: `Conductor cash-out via TILL ${agent.tillNumber ?? till}`,
          processedAt: new Date(),
        },
      });

      await this.sms.enqueue(
        user.phone,
        'WALLET_REFUND',
        `Bus Pay: Umefanikiwa kutoa TZS ${dto.amount} kwa wakala ${agent.tillNumber ?? till}. Salio TZS ${lockedAvailable - dto.amount}. Kumb. ${created.reference}.`,
        tx,
      );
      await this.sms.enqueue(
        agent.phone,
        'WALLET_REFUND',
        `Bus Pay: Malipo TZS ${dto.amount} kutoka kondakta ${user.firstName} ${user.lastName}. TILL ${agent.tillNumber ?? till}. Kumb. ${created.reference}.`,
        tx,
      );

      return created;
    });

    void this.smsDispatcher.flush();

    const nextAvailable = available - dto.amount;
    return {
      success: true,
      message: 'Withdrawal successful',
      reference: withdrawal.reference,
      amount: dto.amount,
      available: nextAvailable,
      smsQueued: true,
      agent: {
        tillNumber: agent.tillNumber,
        firstName: agent.firstName,
        lastName: agent.lastName,
        name: `${agent.firstName} ${agent.lastName}`.trim(),
      },
    };
  }

  private async conductorAvailableBalance(
    conductorUserId: string,
    terminalId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    const taps = await db.paymentTransaction.aggregate({
      where: {
        terminalId,
        status: TransactionStatus.SUCCESS,
      },
      _sum: { amount: true },
    });
    const gross = taps._sum.amount ?? 0;
    const withdrawn = await this.conductorWithdrawnTotal(conductorUserId, db);
    return Math.max(0, gross - withdrawn);
  }

  private async conductorWithdrawnTotal(
    conductorUserId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    const rows = await db.withdrawal.aggregate({
      where: {
        conductorUserId,
        status: {
          in: [
            WithdrawalStatus.PENDING,
            WithdrawalStatus.APPROVED,
            WithdrawalStatus.PAID,
          ],
        },
      },
      _sum: { amount: true },
    });
    return rows._sum.amount ?? 0;
  }

  private normalizeTill(value?: string): string | undefined {
    const digits = value?.replace(/\D/g, '') ?? '';
    if (digits.length < 4) return undefined;
    const padded = digits.padStart(8, '0').slice(-8);
    return `${padded.slice(0, 4)}-${padded.slice(4)}`;
  }

  private async findAgentByTill(till: string) {
    const digits = till.replace(/\D/g, '');
    const agents = await this.prisma.user.findMany({
      where: {
        role: UserRole.AGENT,
        tillNumber: { not: null },
      },
    });
    return (
      agents.find((a) => {
        const agentDigits = (a.tillNumber ?? '').replace(/\D/g, '');
        return (
          agentDigits === digits ||
          agentDigits.slice(-8) === digits.slice(-8) ||
          (a.tillNumber ?? '').toUpperCase() === till.toUpperCase()
        );
      }) ?? null
    );
  }

  private async nextWithdrawalReference(
    tx: Prisma.TransactionClient,
  ): Promise<string> {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const reference = `WD-${day}-${String(randomInt(0, 1000000)).padStart(6, '0')}`;
      const taken = await tx.withdrawal.findUnique({
        where: { reference },
      });
      if (!taken) {
        return reference;
      }
    }
    throw new ConflictException('Could not generate a withdrawal reference');
  }

  private async requireConductorTerminal(user: User) {
    if (user.role !== UserRole.CONDUCTOR) {
      throw new ForbiddenException(
        'Only conductors can use this terminal',
      );
    }

    const existing = await this.prisma.terminal.findFirst({
      where: {
        ownerUserId: user.id,
        status: TerminalStatus.ACTIVE,
      },
    });
    if (existing) {
      return existing;
    }

    // Auto-provision so fare collection works right after conductor signup.
    return this.provisionConductorTerminal(user.id);
  }

  private async provisionConductorTerminal(conductorUserId: string) {
    const merchant = await this.prisma.merchant.findUnique({
      where: { merchantCode: 'DLD-PLATFORM' },
    });
    if (!merchant || merchant.status !== MerchantStatus.ACTIVE) {
      throw new NotFoundException(
        'Transport merchant is not configured. Run database seed.',
      );
    }

    const free = await this.prisma.terminal.findFirst({
      where: {
        merchantId: merchant.id,
        ownerUserId: null,
        status: TerminalStatus.ACTIVE,
      },
      orderBy: { terminalCode: 'asc' },
    });

    if (free) {
      return this.prisma.terminal.update({
        where: { id: free.id },
        data: { ownerUserId: conductorUserId },
      });
    }

    const terminalCode = await this.uniqueTerminalCode();
    return this.prisma.terminal.create({
      data: {
        terminalCode,
        merchantId: merchant.id,
        ownerUserId: conductorUserId,
        type: TerminalType.APP,
        status: TerminalStatus.ACTIVE,
      },
    });
  }

  private async uniqueTerminalCode(): Promise<string> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const terminalCode = `DLD-C${String(randomInt(100, 9999)).padStart(4, '0')}`;
      const taken = await this.prisma.terminal.findUnique({
        where: { terminalCode },
      });
      if (!taken) {
        return terminalCode;
      }
    }
    throw new ConflictException('Could not allocate a terminal');
  }

  private async findCard(serialNumber?: string, nfcUid?: string) {
    const serial = this.normalizeSerial(serialNumber);
    const uid = this.normalizeUid(nfcUid);
    if (!serial && !uid) {
      throw new BadRequestException('serialNumber or nfcUid is required');
    }

    // Prefer NFC UID — that is what the conductor phone actually reads.
    const card = await this.prisma.card.findFirst({
      where: uid ? { nfcUid: uid } : { serialNumber: serial },
      include: {
        wallet: {
          include: { customer: true },
        },
      },
    });
    if (!card) {
      if (uid && serial) {
        const bySerial = await this.prisma.card.findFirst({
          where: { serialNumber: serial },
          include: {
            wallet: {
              include: { customer: true },
            },
          },
        });
        if (bySerial) {
          return bySerial;
        }
      }
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
        cardNumber: card.serialNumber,
        serialNumber: card.serialNumber,
        nfcUid: card.nfcUid ?? '',
        status: card.status,
        frozen: card.status === CardStatus.FROZEN,
        balance: wallet.balance,
        issuedAt: card.issuedAt,
      },
      wallet: {
        /** Public number for mobile money / M-Pesa top-ups (not NFC UID). */
        walletAccountNumber: wallet.publicCode,
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

  private async findWalletByAccount(account: string) {
    const code = account.trim().toUpperCase();
    const byWallet = await this.prisma.wallet.findFirst({
      where: {
        OR: [
          { publicCode: { equals: code, mode: 'insensitive' } },
          { publicCode: { equals: account.trim(), mode: 'insensitive' } },
        ],
      },
      include: { customer: true },
    });
    if (byWallet) {
      return { ...byWallet, customer: byWallet.customer };
    }

    const byCard = await this.prisma.card.findFirst({
      where: {
        serialNumber: { equals: code, mode: 'insensitive' },
        status: CardStatus.ACTIVE,
      },
      include: {
        wallet: { include: { customer: true } },
      },
    });
    if (byCard?.wallet) {
      return { ...byCard.wallet, customer: byCard.wallet.customer };
    }

    throw new NotFoundException('Wallet account not found');
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

  /** 12-digit public card number for display / top-up (not NFC UID). */
  private async uniqueCardNumber(): Promise<string> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const serialNumber = String(randomInt(100000000000, 1000000000000));
      const taken = await this.prisma.card.findUnique({
        where: { serialNumber },
      });
      if (!taken) {
        return serialNumber;
      }
    }
    throw new ConflictException('Could not generate a card number');
  }

  /** Wallet account number passengers use for mobile money. */
  private async uniqueWalletAccount(): Promise<string> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const publicCode = String(randomInt(100000000000, 1000000000000));
      const taken = await this.prisma.wallet.findUnique({
        where: { publicCode },
      });
      if (!taken) {
        return publicCode;
      }
    }
    throw new ConflictException('Could not generate a wallet account number');
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

  private async nextTopUpReference(
    tx: Prisma.TransactionClient,
  ): Promise<string> {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const reference = `TU-${day}-${String(randomInt(0, 1000000)).padStart(6, '0')}`;
      const taken = await tx.topUp.findUnique({
        where: { reference },
      });
      if (!taken) {
        return reference;
      }
    }
    throw new ConflictException('Could not generate a top-up reference');
  }
}
