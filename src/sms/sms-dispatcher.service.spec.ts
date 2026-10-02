import { MockSmsProvider } from './mock-sms.provider';
import { SmsDispatcherService } from './sms-dispatcher.service';
import type { SmsSendResult } from './sms-provider';

type Row = {
  id: string;
  phone: string;
  message: string;
  status: string;
  provider: string | null;
  providerMessageId: string | null;
  providerStatus: string | null;
  attemptCount: number;
  deliveryPollCount: number;
  createdAt: Date;
  updatedAt: Date;
  nextAttemptAt: Date | null;
  nextDeliveryPollAt: Date | null;
  lastError: string | null;
};

function duePending(row: Row, where: { status?: string; OR?: { nextAttemptAt: Date | null }[] }) {
  if (where.status !== 'PENDING' || row.status !== 'PENDING') return false;
  if (!where.OR) return true;
  return where.OR.some((item) => {
    if (item.nextAttemptAt === null) return row.nextAttemptAt === null;
    return row.nextAttemptAt !== null && row.nextAttemptAt <= new Date();
  });
}

function memoryPrisma(row: Row) {
  const updates: Record<string, unknown>[] = [];
  return {
    updates,
    smsOutbox: {
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.status === 'SENDING') return [];
        if (where.provider === 'beem') return [];
        if (duePending(row, where as { status?: string; OR?: { nextAttemptAt: Date | null }[] })) {
          return [row];
        }
        return [];
      }),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id?: string; status?: string };
          data: Partial<Row>;
        }) => {
          if (where.status === 'PENDING' && where.id === row.id) {
            if (row.status !== 'PENDING') return { count: 0 };
            row.status = 'SENDING';
            if (data.provider) row.provider = data.provider;
            return { count: 1 };
          }
          return { count: 0 };
        },
      ),
      update: jest.fn(async ({ data }: { data: Partial<Row> }) => {
        Object.assign(row, data);
        updates.push(data);
        return row;
      }),
      create: jest.fn(),
      findUnique: jest.fn(),
    },
  };
}

function dispatcher(
  prisma: ReturnType<typeof memoryPrisma>,
  send: (phone: string, message: string, id: string) => Promise<SmsSendResult>,
  provider: 'mock' | 'swala' | 'beem' = 'swala',
) {
  process.env.SMS_PROVIDER = provider;
  const sender = {
    send: jest.fn(send),
    isConfigured: () => true,
    fetchDelivery: jest.fn(),
    fetchStatus: jest.fn(),
  };
  const service = new SmsDispatcherService(
    prisma as never,
    provider === 'mock' ? (sender as never) : new MockSmsProvider(),
    provider === 'beem' ? (sender as never) : ({} as never),
    provider === 'swala' ? (sender as never) : ({} as never),
  );
  return { service, sender };
}

describe('SmsDispatcherService', () => {
  const original = process.env.SMS_PROVIDER;

  afterEach(() => {
    if (original === undefined) delete process.env.SMS_PROVIDER;
    else process.env.SMS_PROVIDER = original;
  });

  function pendingRow(): Row {
    return {
      id: 'row-1',
      phone: '+255712345678',
      message: 'hello',
      status: 'PENDING',
      provider: null,
      providerMessageId: null,
      providerStatus: null,
      attemptCount: 0,
      deliveryPollCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      nextAttemptAt: null,
      nextDeliveryPollAt: null,
      lastError: null,
    };
  }

  it('lets only one of two workers send the same pending row', async () => {
    process.env.SMS_PROVIDER = 'mock';
    const row = pendingRow();
    let pendingReads = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sends: string[] = [];
    const mock = new MockSmsProvider();
    jest.spyOn(mock, 'send').mockImplementation(async (_phone, _message, id) => {
      sends.push(id);
      return {
        ok: true,
        provider: 'mock',
        mocked: true,
        requestId: `mock-${id}`,
        providerStatus: 'mock',
      };
    });
    const prisma = {
      smsOutbox: {
        findMany: jest.fn(async ({ where }: { where: { status?: string; provider?: string } }) => {
          if (where.provider === 'beem') return [];
          if (where.status === 'SENDING') return [];
          if (where.status === 'PENDING') {
            pendingReads += 1;
            if (pendingReads === 2) release();
            else await gate;
            return [row];
          }
          return [];
        }),
        updateMany: jest.fn(async ({ where }: { where: { status?: string; id?: string } }) => {
          if (where.status === 'PENDING' && where.id === row.id) {
            if (row.status !== 'PENDING') return { count: 0 };
            row.status = 'SENDING';
            return { count: 1 };
          }
          return { count: 0 };
        }),
        update: jest.fn(async ({ data }: { data: Partial<Row> }) => {
          Object.assign(row, data);
          return row;
        }),
      },
    };
    const service = new SmsDispatcherService(
      prisma as never,
      mock,
      {} as never,
      {} as never,
    );
    await Promise.all([service.flush(), service.flush()]);
    expect(sends).toEqual(['row-1']);
  });

  it('does not let the dispatcher send a test SMS that sendTest already owns', async () => {
    process.env.SMS_PROVIDER = 'mock';
    const mock = new MockSmsProvider();
    const send = jest.spyOn(mock, 'send').mockResolvedValue({
      ok: true,
      provider: 'mock',
      mocked: true,
      requestId: 'mock-t1',
      providerStatus: 'mock',
    });
    let storedStatus = '';
    const prisma = {
      smsOutbox: {
        create: jest.fn(async ({ data }: { data: { status: string } }) => {
          storedStatus = data.status;
          return {
            ...pendingRow(),
            id: 't1',
            status: data.status,
            provider: 'mock',
          };
        }),
        findMany: jest.fn(async () => []),
        update: jest.fn(async () => ({})),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
    };
    const service = new SmsDispatcherService(
      prisma as never,
      mock,
      {} as never,
      {} as never,
    );
    await Promise.all([
      service.sendTest('+255712345678', 'hello'),
      service.flush(),
    ]);
    expect(storedStatus).toBe('SENDING');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['timeout', 'SwalaSMS request timed out'],
    ['429', 'SwalaSMS HTTP 429'],
    ['500', 'SwalaSMS HTTP 500'],
  ])('keeps a Swala %s failure retryable', async (_label, error) => {
    const row = pendingRow();
    const prisma = memoryPrisma(row);
    const { service, sender } = dispatcher(prisma, async () => ({
      ok: false,
      provider: 'swala',
      error,
      retryable: true,
    }));
    await service.flush();
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(prisma.updates[0]).toMatchObject({
      status: 'PENDING',
      attemptCount: 1,
      lastError: error,
    });
    expect(prisma.updates[0].nextAttemptAt).toBeInstanceOf(Date);
    await service.flush();
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  it('marks a permanent 4xx failure as FAILED', async () => {
    const row = pendingRow();
    const prisma = memoryPrisma(row);
    const { service, sender } = dispatcher(prisma, async () => ({
      ok: false,
      provider: 'swala',
      error: 'Sender is not approved',
    }));
    await service.flush();
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(row.status).toBe('FAILED');
    expect(row.nextAttemptAt).toBeNull();
  });

  it('stores the Beem request id and not the outbox id', async () => {
    const row = pendingRow();
    const prisma = memoryPrisma(row);
    const { service } = dispatcher(
      prisma,
      async () => ({
        ok: true,
        provider: 'beem',
        requestId: '67',
        providerStatus: 'accepted',
      }),
      'beem',
    );
    await service.flush();
    expect(prisma.updates[0]).toMatchObject({
      status: 'SENT',
      providerMessageId: '67',
    });
    expect(prisma.updates[0].providerMessageId).not.toBe(row.id);
  });

  it('marks a rejected Beem response as FAILED without a provider message id', async () => {
    const row = pendingRow();
    const prisma = memoryPrisma(row);
    const { service, sender } = dispatcher(
      prisma,
      async () => ({
        ok: false,
        provider: 'beem',
        error: 'Missing or invalid reference ID.',
      }),
      'beem',
    );
    await service.flush();
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(prisma.updates[0]).toMatchObject({
      status: 'FAILED',
      lastError: 'Missing or invalid reference ID.',
    });
    expect(prisma.updates[0].providerMessageId).toBeUndefined();
    expect(row.status).toBe('FAILED');
  });

  it('keeps a timed-out Beem send uncertain and does not send it again', async () => {
    const row = pendingRow();
    const prisma = memoryPrisma(row);
    const { service, sender } = dispatcher(
      prisma,
      async () => ({
        ok: false,
        provider: 'beem',
        error: 'Beem request timed out',
        uncertain: true,
      }),
      'beem',
    );
    await service.flush();
    await service.flush();
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(row.status).toBe('UNCERTAIN');
  });

  it('leaves a delivered Beem row delivered when a stale report says pending', async () => {
    process.env.SMS_PROVIDER = 'beem';
    const row = {
      ...pendingRow(),
      status: 'DELIVERED',
      provider: 'beem',
      providerMessageId: '67',
      providerStatus: 'DELIVERED',
    };
    const update = jest.fn();
    const beem = {
      fetchDelivery: jest.fn().mockResolvedValue({
        ok: true,
        provider: 'beem',
        requestId: '67',
        providerStatus: 'PENDING',
      }),
      send: jest.fn(),
      isConfigured: () => true,
    };
    const prisma = {
      smsOutbox: {
        findUnique: jest.fn().mockResolvedValue(row),
        update,
      },
    };
    const service = new SmsDispatcherService(
      prisma as never,
      new MockSmsProvider(),
      beem as never,
      {} as never,
    );
    await expect(service.refreshDelivery('67')).resolves.toMatchObject({
      status: 'DELIVERED',
      providerStatus: 'PENDING',
    });
    expect(update).not.toHaveBeenCalled();
  });
});
