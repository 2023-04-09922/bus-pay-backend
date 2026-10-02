import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import { AuthRateLimitGuard } from '../auth/auth-rate-limit.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UserRole } from '../generated/prisma';
import { TestSmsDto } from './dto/test-sms.dto';
import { SmsDispatcherService } from './sms-dispatcher.service';

@Controller('admin/sms')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class SmsAdminController {
  constructor(private readonly dispatcher: SmsDispatcherService) {}

  @Get('providers')
  providers() {
    return this.dispatcher.providerHealth();
  }

  @Post('flush')
  @UseGuards(AuthRateLimitGuard)
  flush() {
    return this.dispatcher.flush(50);
  }

  @Post('test')
  @UseGuards(AuthRateLimitGuard)
  test(@Body() dto: TestSmsDto) {
    return this.dispatcher.sendTest(dto.phone, dto.message);
  }

  @Get('delivery/:messageId')
  delivery(@Param('messageId') messageId: string) {
    return this.dispatcher.refreshDelivery(messageId);
  }
}
