import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcrypt';
import {
  PrismaClient,
  MerchantCategory,
  MerchantStatus,
  TerminalStatus,
  TerminalType,
  UserRole,
  UserStatus,
} from '../src/generated/prisma';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

const adapter = new PrismaPg({
  connectionString,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  keepAlive: true,
});

const prisma = new PrismaClient({
  adapter,
});

async function main() {
  const merchant = await prisma.merchant.upsert({
    where: {
      merchantCode: 'DLD-PLATFORM',
    },
    update: {
      name: 'Daladala Transport',
      category: MerchantCategory.TRANSPORT,
      status: MerchantStatus.ACTIVE,
    },
    create: {
      merchantCode: 'DLD-PLATFORM',
      name: 'Daladala Transport',
      category: MerchantCategory.TRANSPORT,
      status: MerchantStatus.ACTIVE,
    },
  });

  await prisma.terminal.upsert({
    where: {
      terminalCode: 'DLD-C001',
    },
    update: {
      merchantId: merchant.id,
      type: TerminalType.APP,
      status: TerminalStatus.ACTIVE,
    },
    create: {
      terminalCode: 'DLD-C001',
      merchantId: merchant.id,
      type: TerminalType.APP,
      status: TerminalStatus.ACTIVE,
    },
  });

  const agentEmail = 'richardtitomwele02@gmail.com';
  const agentPasswordHash = await bcrypt.hash('Richard02#', 10);
  const existingAgent = await prisma.user.findFirst({
    where: {
      email: { equals: agentEmail, mode: 'insensitive' },
    },
  });
  if (existingAgent) {
    await prisma.user.update({
      where: { id: existingAgent.id },
      data: {
        passwordHash: agentPasswordHash,
        role: UserRole.AGENT,
        status: UserStatus.ACTIVE,
        firstName: existingAgent.firstName || 'Richard',
        lastName: existingAgent.lastName || 'Titomwele',
        tillNumber: existingAgent.tillNumber || '8800-2202',
      },
    });
  } else {
    await prisma.user.create({
      data: {
        username: 'bp-arich02agent',
        passwordHash: agentPasswordHash,
        firstName: 'Richard',
        lastName: 'Titomwele',
        phone: '+255752000002',
        nida: '19900101000000000002',
        email: agentEmail,
        tillNumber: '8800-2202',
        role: UserRole.AGENT,
        status: UserStatus.ACTIVE,
      },
    });
  }

  const adminEmail = 'admin@buspay.co.tz';
  const adminPasswordHash = await bcrypt.hash('Admin02#', 10);
  const existingAdmin = await prisma.user.findFirst({
    where: {
      email: { equals: adminEmail, mode: 'insensitive' },
    },
  });
  if (existingAdmin) {
    await prisma.user.update({
      where: { id: existingAdmin.id },
      data: {
        passwordHash: adminPasswordHash,
        role: UserRole.ADMIN,
        status: UserStatus.ACTIVE,
      },
    });
  } else {
    await prisma.user.create({
      data: {
        username: 'Bp-x000001admin',
        passwordHash: adminPasswordHash,
        firstName: 'BusPay',
        lastName: 'Admin',
        phone: '+255750000001',
        nida: '19900101000000000001',
        email: adminEmail,
        role: UserRole.ADMIN,
        status: UserStatus.ACTIVE,
      },
    });
  }

  console.log('BusPay seed completed.');
  console.log(`Merchant: ${merchant.merchantCode}`);
  console.log('Terminal: DLD-C001');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });