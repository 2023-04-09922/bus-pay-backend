import { randomInt } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import {
  AlertSeverity,
  AlertStatus,
  CardInventoryStatus,
  CardStatus,
  Prisma,
  RefundStatus,
  SettlementStatus,
  TopUpSource,
  TransactionStatus,
  UserRole,
  UserStatus,
  WalletStatus,
  WithdrawalStatus,
  type User,
} from '../generated/prisma';
import {
  normalizeNida,
  normalizePhone,
  phoneLookupValues,
} from '../auth/identity';
import { PrismaService } from '../prisma/prisma.service';
import { SmsService } from '../sms/sms.service';
import {
  AssignTerminalDto,
  BulkInventoryDto,
  CreateConductorDto,
  CreateSettlementDto,
  ListAlertsQueryDto,
  ListAuditLogsQueryDto,
  ListCardsQueryDto,
  ListCustomersQueryDto,
  ListInventoryQueryDto,
  ListRefundsQueryDto,
  ListSettlementsQueryDto,
  ListTopUpsQueryDto,
  ListTransactionsQueryDto,
  ListUsersQueryDto,
  ListWalletsQueryDto,
  ListWithdrawalsQueryDto,
  PaginationQueryDto,
  ReplaceCardDto,
  ReportsQueryDto,
  ReverseTransactionDto,
  UpdateCustomerStatusDto,
  UpdateSettingsDto,
  UpdateUserStatusDto,
  WithdrawalDecisionDto,
} from './dto/admin.dto';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
  ) {}

  async overview() {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [
      agents,
      conductors,
      activeCards,
      activeWallets,
      suspendedUsers,
      lockedUsers,
      tapAgg,
      topUpAgg,
    ] = await Promise.all([
      this.prisma.user.count({ where: { role: UserRole.AGENT } }),
      this.prisma.user.count({ where: { role: UserRole.CONDUCTOR } }),
      this.prisma.card.count({ where: { status: CardStatus.ACTIVE } }),
      this.prisma.wallet.count({ where: { status: WalletStatus.ACTIVE } }),
      this.prisma.user.count({ where: { status: UserStatus.SUSPENDED } }),
      this.prisma.user.count({
        where: { lockedUntil: { gt: new Date() } },
      }),
      this.prisma.paymentTransaction.aggregate({
        where: {
          status: TransactionStatus.SUCCESS,
          createdAt: { gte: startOfDay },
        },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.topUp.aggregate({
        where: { createdAt: { gte: startOfDay } },
        _sum: { amount: true },
        _count: true,
      }),
    ]);

    return {
      counts: {
        agents,
        conductors,
        activeCards,
        activeWallets,
        suspendedUsers,
        lockedUsers,
      },
      today: {
        tapVolume: tapAgg._sum.amount ?? 0,
        tapCount: tapAgg._count,
        topUpVolume: topUpAgg._sum.amount ?? 0,
        topUpCount: topUpAgg._count,
      },
    };
  }

  async listUsers(query: ListUsersQueryDto) {
    const { skip, take, page, limit } = this.pageOf(query);
    const where: Prisma.UserWhereInput = {};
    if (query.role) where.role = query.role;
    if (query.status) where.status = query.status;
    if (query.q?.trim()) {
      const q = query.q.trim();
      where.OR = [
        { username: { contains: q, mode: 'insensitive' } },
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
        { email: { contains: q, mode: 'insensitive' } },
        { nida: { contains: q } },
      ];
    }

    const [total, users] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          username: true,
          firstName: true,
          lastName: true,
          phone: true,
          email: true,
          nida: true,
          tillNumber: true,
          role: true,
          status: true,
          failedLoginAttempts: true,
          lockedUntil: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ]);

    return {
      page,
      limit,
      total,
      users: users.map((u) => ({
        ...u,
        role: this.toApiRole(u.role),
      })),
    };
  }

  async getUser(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        firstName: true,
        lastName: true,
        phone: true,
        email: true,
        nida: true,
        tillNumber: true,
        role: true,
        status: true,
        failedLoginAttempts: true,
        lockedUntil: true,
        createdAt: true,
        updatedAt: true,
        terminals: {
          select: {
            id: true,
            terminalCode: true,
            status: true,
            merchant: { select: { merchantCode: true, name: true } },
          },
        },
      },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return { ...user, role: this.toApiRole(user.role) };
  }

  async createConductor(actor: User, dto: CreateConductorDto) {
    const firstName = dto.firstName.trim();
    const lastName = dto.lastName.trim();
    const phone = normalizePhone(dto.phone);
    const nida = normalizeNida(dto.nida);

    const existingPhone = await this.prisma.user.findFirst({
      where: { phone: { in: phoneLookupValues(phone) } },
    });
    if (existingPhone) {
      throw new ConflictException('Phone number is already registered');
    }

    const existingNida = await this.prisma.user.findUnique({ where: { nida } });
    if (existingNida) {
      throw new ConflictException('NIDA is already registered');
    }

    const passwordHash = await bcrypt.hash(dto.pin, 12);
    const username = await this.uniqueConductorUsername();

    const user = await this.prisma.user.create({
      data: {
        username,
        passwordHash,
        firstName,
        lastName,
        phone,
        nida,
        role: UserRole.CONDUCTOR,
        status: UserStatus.ACTIVE,
      },
    });

    await this.audit(actor.id, 'USER_CREATE', 'User', user.id, {
      role: 'conductor',
      username: user.username,
    });

    return {
      message: 'Conductor created',
      username: user.username,
      role: 'conductor' as const,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      status: user.status,
    };
  }

  async updateUserStatus(
    actor: User,
    id: string,
    dto: UpdateUserStatusDto,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (user.role === UserRole.ADMIN && dto.status !== UserStatus.ACTIVE) {
      throw new BadRequestException('Cannot suspend or deactivate an admin');
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: { status: dto.status },
    });

    await this.audit(actor.id, 'USER_STATUS_UPDATE', 'User', id, {
      from: user.status,
      to: dto.status,
    });

    return {
      id: updated.id,
      username: updated.username,
      role: this.toApiRole(updated.role),
      status: updated.status,
    };
  }

  async listTerminals(query: PaginationQueryDto) {
    const { skip, take, page, limit } = this.pageOf(query);
    const [total, terminals] = await Promise.all([
      this.prisma.terminal.count(),
      this.prisma.terminal.findMany({
        skip,
        take,
        orderBy: { terminalCode: 'asc' },
        include: {
          merchant: {
            select: { id: true, merchantCode: true, name: true },
          },
          owner: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              role: true,
              status: true,
            },
          },
        },
      }),
    ]);

    return {
      page,
      limit,
      total,
      terminals: terminals.map((t) => ({
        id: t.id,
        terminalCode: t.terminalCode,
        type: t.type,
        status: t.status,
        merchant: t.merchant,
        conductor: t.owner
          ? {
              id: t.owner.id,
              username: t.owner.username,
              firstName: t.owner.firstName,
              lastName: t.owner.lastName,
              role: this.toApiRole(t.owner.role),
              status: t.owner.status,
            }
          : null,
      })),
    };
  }

  async assignTerminal(
    actor: User,
    terminalId: string,
    dto: AssignTerminalDto,
  ) {
    const terminal = await this.prisma.terminal.findUnique({
      where: { id: terminalId },
    });
    if (!terminal) {
      throw new NotFoundException('Terminal not found');
    }

    const conductor = await this.prisma.user.findUnique({
      where: { id: dto.conductorUserId },
    });
    if (!conductor || conductor.role !== UserRole.CONDUCTOR) {
      throw new BadRequestException('conductorUserId must be a conductor');
    }
    if (conductor.status !== UserStatus.ACTIVE) {
      throw new BadRequestException('Conductor must be ACTIVE');
    }

    const updated = await this.prisma.terminal.update({
      where: { id: terminalId },
      data: { ownerUserId: conductor.id },
      include: {
        merchant: { select: { merchantCode: true, name: true } },
        owner: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    await this.audit(actor.id, 'TERMINAL_ASSIGN', 'Terminal', terminalId, {
      conductorUserId: conductor.id,
      previousOwnerUserId: terminal.ownerUserId,
    });

    return {
      id: updated.id,
      terminalCode: updated.terminalCode,
      merchant: updated.merchant,
      conductor: updated.owner,
    };
  }

  async listCards(query: ListCardsQueryDto) {
    const { skip, take, page, limit } = this.pageOf(query);
    const where: Prisma.CardWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.q?.trim()) {
      const q = query.q.trim();
      where.OR = [
        { serialNumber: { contains: q, mode: 'insensitive' } },
        { nfcUid: { contains: q, mode: 'insensitive' } },
        {
          wallet: {
            customer: {
              OR: [
                { phone: { contains: q } },
                { firstName: { contains: q, mode: 'insensitive' } },
                { lastName: { contains: q, mode: 'insensitive' } },
              ],
            },
          },
        },
      ];
    }

    const [total, cards] = await Promise.all([
      this.prisma.card.count({ where }),
      this.prisma.card.findMany({
        where,
        skip,
        take,
        orderBy: { issuedAt: 'desc' },
        include: {
          wallet: {
            select: {
              id: true,
              publicCode: true,
              balance: true,
              status: true,
              customer: {
                select: {
                  firstName: true,
                  lastName: true,
                  phone: true,
                },
              },
            },
          },
        },
      }),
    ]);

    return { page, limit, total, cards };
  }

  async getCard(serial: string) {
    const card = await this.findCardBySerial(serial);
    return card;
  }

  async freezeCard(actor: User, serial: string) {
    const card = await this.findCardBySerial(serial);
    if (card.status === CardStatus.REPLACED) {
      throw new BadRequestException('Cannot freeze a replaced card');
    }
    const updated = await this.prisma.card.update({
      where: { id: card.id },
      data: { status: CardStatus.FROZEN },
    });
    await this.audit(actor.id, 'CARD_FREEZE', 'Card', card.id, {
      serialNumber: updated.serialNumber,
    });
    return {
      message: 'Card frozen',
      serialNumber: updated.serialNumber,
      status: updated.status,
    };
  }

  async unfreezeCard(actor: User, serial: string) {
    const card = await this.findCardBySerial(serial);
    if (card.status !== CardStatus.FROZEN) {
      throw new BadRequestException('Only frozen cards can be unfrozen');
    }
    const updated = await this.prisma.card.update({
      where: { id: card.id },
      data: { status: CardStatus.ACTIVE },
    });
    await this.audit(actor.id, 'CARD_UNFREEZE', 'Card', card.id, {
      serialNumber: updated.serialNumber,
    });
    return {
      message: 'Card unfrozen',
      serialNumber: updated.serialNumber,
      status: updated.status,
    };
  }

  async replaceCard(actor: User, oldSerial: string, dto: ReplaceCardDto) {
    const oldCard = await this.findCardBySerial(oldSerial);
    const serialNumber = dto.serialNumber?.trim().toUpperCase();
    const nfcUid = dto.nfcUid?.replace(/\s+/g, '').toUpperCase() || undefined;

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
          serialNumber: serialNumber || (await this.uniqueCardSerial(tx)),
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

    await this.audit(actor.id, 'CARD_REPLACE', 'Card', oldCard.id, {
      oldSerial: oldCard.serialNumber,
      newSerial: replacement.serialNumber,
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

  async listWallets(query: ListWalletsQueryDto) {
    const { skip, take, page, limit } = this.pageOf(query);
    const where: Prisma.WalletWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.q?.trim()) {
      const q = query.q.trim();
      where.OR = [
        { publicCode: { contains: q, mode: 'insensitive' } },
        {
          customer: {
            OR: [
              { phone: { contains: q } },
              { firstName: { contains: q, mode: 'insensitive' } },
              { lastName: { contains: q, mode: 'insensitive' } },
              { nida: { contains: q } },
            ],
          },
        },
      ];
    }

    const [total, wallets] = await Promise.all([
      this.prisma.wallet.count({ where }),
      this.prisma.wallet.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          customer: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              phone: true,
              status: true,
            },
          },
        },
      }),
    ]);

    return { page, limit, total, wallets };
  }

  async getWallet(id: string) {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id },
      include: {
        customer: true,
        cards: {
          select: {
            id: true,
            serialNumber: true,
            nfcUid: true,
            status: true,
            issuedAt: true,
          },
        },
      },
    });
    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }
    return wallet;
  }

  async freezeWallet(actor: User, id: string) {
    const wallet = await this.prisma.wallet.findUnique({ where: { id } });
    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }
    const updated = await this.prisma.wallet.update({
      where: { id },
      data: { status: WalletStatus.FROZEN },
    });
    await this.audit(actor.id, 'WALLET_FREEZE', 'Wallet', id, {
      publicCode: updated.publicCode,
    });
    return {
      message: 'Wallet frozen',
      id: updated.id,
      publicCode: updated.publicCode,
      status: updated.status,
    };
  }

  async unfreezeWallet(actor: User, id: string) {
    const wallet = await this.prisma.wallet.findUnique({ where: { id } });
    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }
    if (wallet.status !== WalletStatus.FROZEN) {
      throw new BadRequestException('Only frozen wallets can be unfrozen');
    }
    const updated = await this.prisma.wallet.update({
      where: { id },
      data: { status: WalletStatus.ACTIVE },
    });
    await this.audit(actor.id, 'WALLET_UNFREEZE', 'Wallet', id, {
      publicCode: updated.publicCode,
    });
    return {
      message: 'Wallet unfrozen',
      id: updated.id,
      publicCode: updated.publicCode,
      status: updated.status,
    };
  }

  async listTransactions(query: ListTransactionsQueryDto) {
    const { skip, take, page, limit } = this.pageOf(query);
    const where: Prisma.PaymentTransactionWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.terminalId) where.terminalId = query.terminalId;
    const range = this.dateRange(query.from, query.to);
    if (range) where.createdAt = range;
    if (query.q?.trim()) {
      const q = query.q.trim();
      where.OR = [
        { reference: { contains: q, mode: 'insensitive' } },
        { card: { serialNumber: { contains: q, mode: 'insensitive' } } },
        {
          wallet: {
            customer: {
              OR: [
                { firstName: { contains: q, mode: 'insensitive' } },
                { lastName: { contains: q, mode: 'insensitive' } },
                { phone: { contains: q } },
              ],
            },
          },
        },
      ];
    }

    const [total, transactions] = await Promise.all([
      this.prisma.paymentTransaction.count({ where }),
      this.prisma.paymentTransaction.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          card: { select: { serialNumber: true } },
          wallet: {
            select: {
              publicCode: true,
              customer: {
                select: { firstName: true, lastName: true, phone: true },
              },
            },
          },
          merchant: { select: { merchantCode: true, name: true } },
          terminal: { select: { id: true, terminalCode: true } },
        },
      }),
    ]);

    return {
      page,
      limit,
      total,
      transactions: transactions.map((t) => ({
        id: t.id,
        reference: t.reference,
        amount: t.amount,
        currency: t.currency,
        serviceType: t.serviceType,
        status: t.status,
        createdAt: t.createdAt,
        card: t.card.serialNumber,
        wallet: t.wallet.publicCode,
        passenger:
          `${t.wallet.customer.firstName} ${t.wallet.customer.lastName}`.trim(),
        phone: t.wallet.customer.phone,
        merchant: t.merchant,
        terminal: t.terminal,
      })),
    };
  }

  async listTopUps(query: ListTopUpsQueryDto) {
    const { skip, take, page, limit } = this.pageOf(query);
    const where: Prisma.TopUpWhereInput = {};
    if (query.agentUserId) where.agentUserId = query.agentUserId;
    const range = this.dateRange(query.from, query.to);
    if (range) where.createdAt = range;
    if (query.q?.trim()) {
      const q = query.q.trim();
      where.OR = [
        { reference: { contains: q, mode: 'insensitive' } },
        { wallet: { publicCode: { contains: q, mode: 'insensitive' } } },
        { card: { serialNumber: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const [total, topUps] = await Promise.all([
      this.prisma.topUp.count({ where }),
      this.prisma.topUp.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          wallet: { select: { publicCode: true } },
          card: { select: { serialNumber: true } },
          agent: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      }),
    ]);

    return { page, limit, total, topUps };
  }

  async listAuditLogs(query: ListAuditLogsQueryDto) {
    const { skip, take, page, limit } = this.pageOf(query);
    const where: Prisma.AuditLogWhereInput = {};
    if (query.actorUserId) where.actorUserId = query.actorUserId;
    if (query.action?.trim()) {
      where.action = {
        equals: query.action.trim(),
        mode: 'insensitive',
      };
    }
    const range = this.dateRange(query.from, query.to);
    if (range) where.createdAt = range;

    const [total, logs] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          actor: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              role: true,
            },
          },
        },
      }),
    ]);

    return {
      page,
      limit,
      total,
      logs: logs.map((log) => ({
        id: log.id,
        action: log.action,
        entityType: log.entityType,
        entityId: log.entityId,
        metadata: log.metadata,
        createdAt: log.createdAt,
        actor: {
          ...log.actor,
          role: this.toApiRole(log.actor.role),
        },
      })),
    };
  }

  async health() {
    const started = Date.now();
    let database: Record<string, unknown>;
    try {
      const [row] = await this.prisma.$queryRaw<
        Array<{ database: string; db_user: string; schema: string }>
      >`
        SELECT
          current_database() AS database,
          current_user AS db_user,
          current_schema() AS schema
      `;
      database = {
        status: 'up',
        database: row.database,
        schema: row.schema,
        user: row.db_user,
        responseTimeMs: Date.now() - started,
      };
    } catch {
      database = {
        status: 'down',
        responseTimeMs: Date.now() - started,
      };
    }

    const [smsPending, smsFailed] = await Promise.all([
      this.prisma.smsOutbox.count({ where: { status: 'PENDING' } }),
      this.prisma.smsOutbox.count({ where: { status: 'FAILED' } }),
    ]);

    return {
      status: database.status === 'up' ? 'ok' : 'degraded',
      database,
      smsOutbox: {
        pending: smsPending,
        failed: smsFailed,
      },
    };
  }

  async writeAudit(
    actorUserId: string,
    action: string,
    entityType: string,
    entityId?: string | null,
    metadata?: Prisma.InputJsonValue,
  ) {
    return this.audit(actorUserId, action, entityType, entityId, metadata);
  }

  async listCustomers(query: ListCustomersQueryDto) {
    const { skip, take, page, limit } = this.pageOf(query);
    const where: Prisma.CustomerWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.q?.trim()) {
      const q = query.q.trim();
      where.OR = [
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
        { nida: { contains: q } },
        { email: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [total, customers] = await Promise.all([
      this.prisma.customer.count({ where }),
      this.prisma.customer.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          wallet: {
            select: {
              id: true,
              publicCode: true,
              balance: true,
              status: true,
            },
          },
        },
      }),
    ]);

    return { page, limit, total, customers };
  }

  async getCustomer(id: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      include: {
        wallet: {
          include: {
            cards: {
              select: {
                id: true,
                serialNumber: true,
                nfcUid: true,
                status: true,
                issuedAt: true,
              },
            },
          },
        },
      },
    });
    if (!customer) {
      throw new NotFoundException('Customer not found');
    }
    return customer;
  }

  async updateCustomerStatus(
    actor: User,
    id: string,
    dto: UpdateCustomerStatusDto,
  ) {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    const updated = await this.prisma.customer.update({
      where: { id },
      data: { status: dto.status },
    });

    await this.audit(actor.id, 'CUSTOMER_STATUS_UPDATE', 'Customer', id, {
      from: customer.status,
      to: dto.status,
    });

    return {
      id: updated.id,
      firstName: updated.firstName,
      lastName: updated.lastName,
      phone: updated.phone,
      status: updated.status,
    };
  }

  async listWithdrawals(query: ListWithdrawalsQueryDto) {
    const { skip, take, page, limit } = this.pageOf(query);
    const where: Prisma.WithdrawalWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.q?.trim()) {
      const q = query.q.trim();
      where.OR = [
        { reference: { contains: q, mode: 'insensitive' } },
        {
          agent: {
            OR: [
              { username: { contains: q, mode: 'insensitive' } },
              { firstName: { contains: q, mode: 'insensitive' } },
              { lastName: { contains: q, mode: 'insensitive' } },
              { phone: { contains: q } },
            ],
          },
        },
      ];
    }

    const [total, withdrawals] = await Promise.all([
      this.prisma.withdrawal.count({ where }),
      this.prisma.withdrawal.findMany({
        where,
        skip,
        take,
        orderBy: { requestedAt: 'desc' },
        include: {
          agent: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              phone: true,
            },
          },
          processedBy: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      }),
    ]);

    return { page, limit, total, withdrawals };
  }

  async approveWithdrawal(
    actor: User,
    id: string,
    dto: WithdrawalDecisionDto,
  ) {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id },
    });
    if (!withdrawal) {
      throw new NotFoundException('Withdrawal not found');
    }
    if (withdrawal.status !== WithdrawalStatus.PENDING) {
      throw new BadRequestException('Only PENDING withdrawals can be approved');
    }

    const updated = await this.prisma.withdrawal.update({
      where: { id },
      data: {
        status: WithdrawalStatus.APPROVED,
        notes: dto.notes?.trim() || withdrawal.notes,
        processedById: actor.id,
        processedAt: new Date(),
      },
    });

    await this.audit(actor.id, 'WITHDRAWAL_APPROVE', 'Withdrawal', id, {
      reference: updated.reference,
      amount: updated.amount,
    });

    return updated;
  }

  async rejectWithdrawal(
    actor: User,
    id: string,
    dto: WithdrawalDecisionDto,
  ) {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id },
    });
    if (!withdrawal) {
      throw new NotFoundException('Withdrawal not found');
    }
    if (withdrawal.status !== WithdrawalStatus.PENDING) {
      throw new BadRequestException('Only PENDING withdrawals can be rejected');
    }

    const updated = await this.prisma.withdrawal.update({
      where: { id },
      data: {
        status: WithdrawalStatus.REJECTED,
        notes: dto.notes?.trim() || withdrawal.notes,
        processedById: actor.id,
        processedAt: new Date(),
      },
    });

    await this.audit(actor.id, 'WITHDRAWAL_REJECT', 'Withdrawal', id, {
      reference: updated.reference,
      amount: updated.amount,
    });

    return updated;
  }

  async markWithdrawalPaid(actor: User, id: string) {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id },
    });
    if (!withdrawal) {
      throw new NotFoundException('Withdrawal not found');
    }
    if (withdrawal.status !== WithdrawalStatus.APPROVED) {
      throw new BadRequestException('Only APPROVED withdrawals can be marked paid');
    }

    const updated = await this.prisma.withdrawal.update({
      where: { id },
      data: {
        status: WithdrawalStatus.PAID,
        processedById: actor.id,
        processedAt: new Date(),
      },
    });

    await this.audit(actor.id, 'WITHDRAWAL_PAID', 'Withdrawal', id, {
      reference: updated.reference,
      amount: updated.amount,
    });

    return updated;
  }

  async listRefunds(query: ListRefundsQueryDto) {
    const { skip, take, page, limit } = this.pageOf(query);
    const where: Prisma.RefundWhereInput = {};
    const range = this.dateRange(query.from, query.to);
    if (range) where.createdAt = range;
    if (query.q?.trim()) {
      const q = query.q.trim();
      where.OR = [
        { reference: { contains: q, mode: 'insensitive' } },
        {
          transaction: {
            reference: { contains: q, mode: 'insensitive' },
          },
        },
      ];
    }

    const [total, refunds] = await Promise.all([
      this.prisma.refund.count({ where }),
      this.prisma.refund.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          transaction: {
            select: {
              id: true,
              reference: true,
              amount: true,
              status: true,
            },
          },
          actor: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      }),
    ]);

    return { page, limit, total, refunds };
  }

  async reverseTransaction(
    actor: User,
    id: string,
    dto: ReverseTransactionDto,
  ) {
    const tx = await this.prisma.paymentTransaction.findUnique({
      where: { id },
      include: {
        refund: true,
        wallet: { include: { customer: true } },
      },
    });
    if (!tx) {
      throw new NotFoundException('Transaction not found');
    }
    if (tx.status === TransactionStatus.REVERSED || tx.refund) {
      throw new BadRequestException('Transaction is already reversed');
    }
    if (tx.status !== TransactionStatus.SUCCESS) {
      throw new BadRequestException('Only SUCCESS transactions can be reversed');
    }

    const result = await this.prisma.$transaction(async (db) => {
      const wallet = await db.wallet.findUnique({
        where: { id: tx.walletId },
        include: { customer: true },
      });
      if (!wallet) {
        throw new NotFoundException('Wallet not found');
      }

      const previousBalance = wallet.balance;
      const newBalance = previousBalance + tx.amount;

      await db.wallet.update({
        where: { id: wallet.id },
        data: { balance: newBalance },
      });

      await db.paymentTransaction.update({
        where: { id: tx.id },
        data: { status: TransactionStatus.REVERSED },
      });

      const topUpRef = await this.uniqueReference('ADJ', async (reference) => {
        const taken = await db.topUp.findUnique({ where: { reference } });
        return !!taken;
      });

      const topUp = await db.topUp.create({
        data: {
          reference: topUpRef,
          walletId: wallet.id,
          cardId: tx.cardId,
          agentUserId: actor.id,
          amount: tx.amount,
          previousBalance,
          newBalance,
          source: TopUpSource.ADMIN_ADJUST,
        },
      });

      const refundRef = await this.uniqueReference('RF', async (reference) => {
        const taken = await db.refund.findUnique({ where: { reference } });
        return !!taken;
      });

      const refund = await db.refund.create({
        data: {
          reference: refundRef,
          transactionId: tx.id,
          amount: tx.amount,
          reason: dto.reason?.trim() || undefined,
          actorUserId: actor.id,
          status: RefundStatus.COMPLETED,
        },
      });

      await this.sms.enqueue(
        wallet.customer.phone,
        'WALLET_REFUND',
        `Bus Pay: Marejesho TZS ${tx.amount}. Salio TZS ${newBalance}. Kumb. ${tx.reference}.`,
        db,
      );

      return { topUp, refund, previousBalance, newBalance };
    });

    await this.audit(actor.id, 'TRANSACTION_REVERSE', 'PaymentTransaction', id, {
      amount: tx.amount,
      refundId: result.refund.id,
      topUpId: result.topUp.id,
      reason: dto.reason ?? null,
    });

    return {
      message: 'Transaction reversed',
      transactionId: id,
      refund: result.refund,
      topUp: result.topUp,
      wallet: {
        previousBalance: result.previousBalance,
        newBalance: result.newBalance,
      },
    };
  }

  async listSettlements(query: ListSettlementsQueryDto) {
    const { skip, take, page, limit } = this.pageOf(query);
    const where: Prisma.SettlementWhereInput = {};
    if (query.status?.trim()) {
      const status = query.status.trim().toUpperCase();
      if (
        status === SettlementStatus.DRAFT ||
        status === SettlementStatus.FINALIZED ||
        status === SettlementStatus.PAID
      ) {
        where.status = status;
      }
    }

    const [total, settlements] = await Promise.all([
      this.prisma.settlement.count({ where }),
      this.prisma.settlement.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          lines: {
            include: {
              merchant: {
                select: { merchantCode: true, name: true },
              },
            },
          },
          paidBy: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      }),
    ]);

    return { page, limit, total, settlements };
  }

  async createSettlement(actor: User, dto: CreateSettlementDto) {
    const periodStart = new Date(dto.periodStart);
    const periodEnd = new Date(dto.periodEnd);
    if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime())) {
      throw new BadRequestException('Invalid periodStart or periodEnd');
    }
    if (periodEnd < periodStart) {
      throw new BadRequestException('periodEnd must be on or after periodStart');
    }

    const feeBps = dto.feeBps ?? 0;
    const grouped = await this.prisma.paymentTransaction.groupBy({
      by: ['merchantId'],
      where: {
        status: TransactionStatus.SUCCESS,
        createdAt: { gte: periodStart, lte: periodEnd },
      },
      _sum: { amount: true },
      _count: true,
    });

    if (grouped.length === 0) {
      throw new BadRequestException(
        'No SUCCESS transactions found in the given period',
      );
    }

    const merchantIds = grouped.map((g) => g.merchantId);
    const merchants = await this.prisma.merchant.findMany({
      where: { id: { in: merchantIds } },
      select: { id: true, settlementAccount: true },
    });
    const merchantMap = new Map(merchants.map((m) => [m.id, m]));

    const lines = grouped.map((g) => {
      const grossAmount = g._sum.amount ?? 0;
      const feeAmount = Math.floor((grossAmount * feeBps) / 10_000);
      const netAmount = grossAmount - feeAmount;
      return {
        merchantId: g.merchantId,
        grossAmount,
        feeAmount,
        netAmount,
        settlementAccount: merchantMap.get(g.merchantId)?.settlementAccount ?? null,
      };
    });

    const grossAmount = lines.reduce((sum, l) => sum + l.grossAmount, 0);
    const feeAmount = lines.reduce((sum, l) => sum + l.feeAmount, 0);
    const netAmount = lines.reduce((sum, l) => sum + l.netAmount, 0);

    const reference = await this.uniqueReference('ST', async (ref) => {
      const taken = await this.prisma.settlement.findUnique({
        where: { reference: ref },
      });
      return !!taken;
    });

    const settlement = await this.prisma.settlement.create({
      data: {
        reference,
        periodStart,
        periodEnd,
        status: SettlementStatus.DRAFT,
        grossAmount,
        feeAmount,
        netAmount,
        lines: { create: lines },
      },
      include: {
        lines: {
          include: {
            merchant: { select: { merchantCode: true, name: true } },
          },
        },
      },
    });

    await this.audit(actor.id, 'SETTLEMENT_CREATE', 'Settlement', settlement.id, {
      reference: settlement.reference,
      feeBps,
      grossAmount,
      netAmount,
      lineCount: lines.length,
    });

    return settlement;
  }

  async finalizeSettlement(actor: User, id: string) {
    const settlement = await this.prisma.settlement.findUnique({
      where: { id },
    });
    if (!settlement) {
      throw new NotFoundException('Settlement not found');
    }
    if (settlement.status !== SettlementStatus.DRAFT) {
      throw new BadRequestException('Only DRAFT settlements can be finalized');
    }

    const updated = await this.prisma.settlement.update({
      where: { id },
      data: {
        status: SettlementStatus.FINALIZED,
        finalizedAt: new Date(),
      },
    });

    await this.audit(actor.id, 'SETTLEMENT_FINALIZE', 'Settlement', id, {
      reference: updated.reference,
    });

    return updated;
  }

  async markSettlementPaid(actor: User, id: string) {
    const settlement = await this.prisma.settlement.findUnique({
      where: { id },
    });
    if (!settlement) {
      throw new NotFoundException('Settlement not found');
    }
    if (settlement.status !== SettlementStatus.FINALIZED) {
      throw new BadRequestException('Only FINALIZED settlements can be marked paid');
    }

    const updated = await this.prisma.settlement.update({
      where: { id },
      data: {
        status: SettlementStatus.PAID,
        paidAt: new Date(),
        paidById: actor.id,
      },
    });

    await this.audit(actor.id, 'SETTLEMENT_PAID', 'Settlement', id, {
      reference: updated.reference,
    });

    return updated;
  }

  async listInventory(query: ListInventoryQueryDto) {
    const { skip, take, page, limit } = this.pageOf(query);
    const where: Prisma.CardInventoryWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.q?.trim()) {
      const q = query.q.trim();
      where.OR = [
        { serialNumber: { contains: q, mode: 'insensitive' } },
        { nfcUid: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [total, items] = await Promise.all([
      this.prisma.cardInventory.count({ where }),
      this.prisma.cardInventory.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return { page, limit, total, items };
  }

  async addInventory(actor: User, dto: BulkInventoryDto) {
    if (!dto.items?.length) {
      throw new BadRequestException('items must not be empty');
    }

    const results = [];
    for (const item of dto.items) {
      const serialNumber = item.serialNumber.trim().toUpperCase();
      const nfcUid = item.nfcUid?.replace(/\s+/g, '').toUpperCase() || null;
      const upserted = await this.prisma.cardInventory.upsert({
        where: { serialNumber },
        create: {
          serialNumber,
          nfcUid: nfcUid ?? undefined,
          status: CardInventoryStatus.IN_STOCK,
        },
        update: {
          status: CardInventoryStatus.IN_STOCK,
          ...(nfcUid ? { nfcUid } : {}),
        },
      });
      results.push(upserted);
    }

    await this.audit(actor.id, 'CARD_INVENTORY_ADD', 'CardInventory', null, {
      count: results.length,
      serials: results.map((r) => r.serialNumber),
    });

    return { count: results.length, items: results };
  }

  async reportsSummary(query: ReportsQueryDto) {
    const range = this.dateRange(query.from, query.to);
    const tapWhere: Prisma.PaymentTransactionWhereInput = {
      status: TransactionStatus.SUCCESS,
    };
    const topUpWhere: Prisma.TopUpWhereInput = {};
    if (range) {
      tapWhere.createdAt = range;
      topUpWhere.createdAt = range;
    }

    const [tapAgg, topUpAgg, byMerchantRaw, byAgentRaw] = await Promise.all([
      this.prisma.paymentTransaction.aggregate({
        where: tapWhere,
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.topUp.aggregate({
        where: topUpWhere,
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.paymentTransaction.groupBy({
        by: ['merchantId'],
        where: tapWhere,
        _sum: { amount: true },
        _count: true,
        orderBy: { _sum: { amount: 'desc' } },
      }),
      this.prisma.topUp.groupBy({
        by: ['agentUserId'],
        where: {
          ...topUpWhere,
          agentUserId: { not: null },
        },
        _sum: { amount: true },
        _count: true,
        orderBy: { _sum: { amount: 'desc' } },
      }),
    ]);

    const merchantIds = byMerchantRaw.map((m) => m.merchantId);
    const agentIds = byAgentRaw
      .map((a) => a.agentUserId)
      .filter((id): id is string => !!id);

    const [merchants, agents] = await Promise.all([
      merchantIds.length
        ? this.prisma.merchant.findMany({
            where: { id: { in: merchantIds } },
            select: { id: true, merchantCode: true, name: true },
          })
        : Promise.resolve([]),
      agentIds.length
        ? this.prisma.user.findMany({
            where: { id: { in: agentIds } },
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const merchantMap = new Map(merchants.map((m) => [m.id, m]));
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    return {
      taps: {
        count: tapAgg._count,
        volume: tapAgg._sum.amount ?? 0,
      },
      topUps: {
        count: topUpAgg._count,
        volume: topUpAgg._sum.amount ?? 0,
      },
      byMerchant: byMerchantRaw.map((row) => {
        const merchant = merchantMap.get(row.merchantId);
        return {
          merchantCode: merchant?.merchantCode ?? row.merchantId,
          name: merchant?.name ?? 'Unknown',
          volume: row._sum.amount ?? 0,
          count: row._count,
        };
      }),
      byAgentTopUps: byAgentRaw.map((row) => {
        const agent = row.agentUserId
          ? agentMap.get(row.agentUserId)
          : undefined;
        return {
          agentUserId: row.agentUserId,
          username: agent?.username ?? null,
          name: agent
            ? `${agent.firstName} ${agent.lastName}`.trim()
            : null,
          volume: row._sum.amount ?? 0,
          count: row._count,
        };
      }),
    };
  }

  async listAlerts(query: ListAlertsQueryDto) {
    const { skip, take, page, limit } = this.pageOf(query);
    const where: Prisma.AlertWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.type?.trim()) {
      where.type = { equals: query.type.trim(), mode: 'insensitive' };
    }

    const [total, alerts] = await Promise.all([
      this.prisma.alert.count({ where }),
      this.prisma.alert.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return { page, limit, total, alerts };
  }

  async acknowledgeAlert(actor: User, id: string) {
    const alert = await this.prisma.alert.findUnique({ where: { id } });
    if (!alert) {
      throw new NotFoundException('Alert not found');
    }
    if (alert.status !== AlertStatus.OPEN) {
      throw new BadRequestException('Only OPEN alerts can be acknowledged');
    }

    const updated = await this.prisma.alert.update({
      where: { id },
      data: {
        status: AlertStatus.ACKED,
        ackedAt: new Date(),
      },
    });

    await this.audit(actor.id, 'ALERT_ACK', 'Alert', id, {
      type: updated.type,
    });

    return updated;
  }

  async syncAlerts() {
    const created: Array<{ type: string; id: string }> = [];

    const [smsFailed, lockedUsers, openSmsFailed, openLockedUsers] =
      await Promise.all([
        this.prisma.smsOutbox.count({ where: { status: 'FAILED' } }),
        this.prisma.user.count({
          where: { lockedUntil: { gt: new Date() } },
        }),
        this.prisma.alert.findFirst({
          where: { type: 'SMS_FAILED', status: AlertStatus.OPEN },
        }),
        this.prisma.alert.findFirst({
          where: { type: 'LOCKED_USERS', status: AlertStatus.OPEN },
        }),
      ]);

    if (smsFailed > 0 && !openSmsFailed) {
      const alert = await this.prisma.alert.create({
        data: {
          type: 'SMS_FAILED',
          severity: AlertSeverity.WARNING,
          message: `${smsFailed} SMS message(s) in FAILED status`,
          entityType: 'SmsOutbox',
          status: AlertStatus.OPEN,
        },
      });
      created.push({ type: alert.type, id: alert.id });
    }

    if (lockedUsers > 0 && !openLockedUsers) {
      const alert = await this.prisma.alert.create({
        data: {
          type: 'LOCKED_USERS',
          severity: AlertSeverity.WARNING,
          message: `${lockedUsers} user(s) currently locked`,
          entityType: 'User',
          status: AlertStatus.OPEN,
        },
      });
      created.push({ type: alert.type, id: alert.id });
    }

    return {
      smsFailed,
      lockedUsers,
      created,
    };
  }

  async unlockUser(actor: User, id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    await this.audit(actor.id, 'USER_UNLOCK', 'User', id, {
      username: updated.username,
      previousFailedLoginAttempts: user.failedLoginAttempts,
      previousLockedUntil: user.lockedUntil,
    });

    return {
      id: updated.id,
      username: updated.username,
      role: this.toApiRole(updated.role),
      failedLoginAttempts: updated.failedLoginAttempts,
      lockedUntil: updated.lockedUntil,
    };
  }

  async getSettings() {
    const keys = [
      'defaultFare',
      'lockoutMinutes',
      'smsEnabled',
      'settlementFeeBps',
    ] as const;
    const defaults: Record<(typeof keys)[number], string> = {
      defaultFare: '650',
      lockoutMinutes: '15',
      smsEnabled: 'true',
      settlementFeeBps: '0',
    };

    const rows = await this.prisma.systemSetting.findMany({
      where: { key: { in: [...keys] } },
    });
    const map = new Map(rows.map((r) => [r.key, r.value]));

    const settings: Record<string, string> = {};
    for (const key of keys) {
      settings[key] = map.get(key) ?? defaults[key];
    }
    return settings;
  }

  async updateSettings(actor: User, dto: UpdateSettingsDto) {
    const entries: Array<[string, string]> = [];
    if (dto.defaultFare !== undefined) {
      entries.push(['defaultFare', dto.defaultFare]);
    }
    if (dto.lockoutMinutes !== undefined) {
      entries.push(['lockoutMinutes', dto.lockoutMinutes]);
    }
    if (dto.smsEnabled !== undefined) {
      entries.push(['smsEnabled', dto.smsEnabled]);
    }
    if (dto.settlementFeeBps !== undefined) {
      entries.push(['settlementFeeBps', dto.settlementFeeBps]);
    }

    if (entries.length === 0) {
      throw new BadRequestException('No settings provided');
    }

    for (const [key, value] of entries) {
      await this.prisma.systemSetting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
    }

    await this.audit(actor.id, 'SETTINGS_UPDATE', 'SystemSetting', null, {
      keys: entries.map(([k]) => k),
    });

    return this.getSettings();
  }

  private async uniqueReference(
    prefix: string,
    isTaken: (reference: string) => Promise<boolean>,
  ): Promise<string> {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const reference = `${prefix}-${day}-${String(randomInt(0, 1_000_000)).padStart(6, '0')}`;
      if (!(await isTaken(reference))) {
        return reference;
      }
    }
    throw new ConflictException(
      `Could not generate a unique ${prefix} reference`,
    );
  }

  private async audit(
    actorUserId: string,
    action: string,
    entityType: string,
    entityId?: string | null,
    metadata?: Prisma.InputJsonValue,
  ) {
    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action,
        entityType,
        entityId: entityId ?? undefined,
        metadata: metadata ?? undefined,
      },
    });
  }

  private async findCardBySerial(serial: string) {
    const serialNumber = serial.trim().toUpperCase();
    const card = await this.prisma.card.findUnique({
      where: { serialNumber },
      include: {
        wallet: {
          include: {
            customer: {
              select: {
                firstName: true,
                lastName: true,
                phone: true,
                status: true,
              },
            },
          },
        },
      },
    });
    if (!card) {
      throw new NotFoundException('Card not found');
    }
    return card;
  }

  private pageOf(query: PaginationQueryDto) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
    return { page, limit, skip: (page - 1) * limit, take: limit };
  }

  private dateRange(from?: string, to?: string) {
    if (!from && !to) return undefined;
    const range: Prisma.DateTimeFilter = {};
    if (from) {
      const start = new Date(from);
      if (Number.isNaN(start.getTime())) {
        throw new BadRequestException('Invalid from date');
      }
      range.gte = start;
    }
    if (to) {
      const end = new Date(to);
      if (Number.isNaN(end.getTime())) {
        throw new BadRequestException('Invalid to date');
      }
      range.lte = end;
    }
    return range;
  }

  private toApiRole(role: UserRole): 'admin' | 'agent' | 'conductor' {
    if (role === UserRole.ADMIN) return 'admin';
    if (role === UserRole.AGENT) return 'agent';
    return 'conductor';
  }

  private async uniqueConductorUsername(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = String(randomInt(100000, 1000000));
      const username = `Bp-c${code}bus`;
      const taken = await this.prisma.user.findFirst({
        where: { username: { equals: username, mode: 'insensitive' } },
      });
      if (!taken) return username;
    }
    throw new ConflictException('Could not generate a unique username');
  }

  private async uniqueCardSerial(tx: Prisma.TransactionClient): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = `BP-${String(randomInt(100000000, 1000000000))}`;
      const taken = await tx.card.findUnique({ where: { serialNumber: code } });
      if (!taken) return code;
    }
    throw new ConflictException('Could not generate a unique card serial');
  }
}
