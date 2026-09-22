import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { BeemSmsProvider } from './beem-sms.provider';
import { SmsAdminController } from './sms-admin.controller';
import { SmsDispatcherService } from './sms-dispatcher.service';
import { SmsService } from './sms.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [SmsAdminController],
  providers: [BeemSmsProvider, SmsService, SmsDispatcherService],
  exports: [SmsService, SmsDispatcherService, BeemSmsProvider],
})
export class SmsModule {}
