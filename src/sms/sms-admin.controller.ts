import { Body, Controller, Post, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UserRole } from '../generated/prisma';
import { SmsDispatcherService } from './sms-dispatcher.service';

@Controller('admin/sms')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class SmsAdminController {
  constructor(private readonly dispatcher: SmsDispatcherService) {}

  @Post('flush')
  flush() {
    return this.dispatcher.flush(50);
  }
}
