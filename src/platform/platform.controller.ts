import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UserRole, type User } from '../generated/prisma';
import {
  IssueCardDto,
  RenewCardDto,
  ReplaceCardDto,
  TapPaymentDto,
  TopUpDto,
} from './dto/platform.dto';
import { PlatformService } from './platform.service';

@Controller('platform')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformController {
  constructor(private readonly platformService: PlatformService) {}

  @Post('cards')
  @Roles(UserRole.AGENT)
  issueCard(@Body() dto: IssueCardDto) {
    return this.platformService.issueCard(dto);
  }

  @Get('cards/uid/:nfcUid')
  lookupByUid(@Param('nfcUid') nfcUid: string) {
    return this.platformService.lookupCard(undefined, nfcUid);
  }

  @Get('cards/:serial')
  lookupCard(@Param('serial') serial: string) {
    return this.platformService.lookupCard(serial);
  }

  @Get('transactions')
  getTransactions(@CurrentUser() user: User) {
    return this.platformService.getTransactions(user);
  }

  @Post('cards/:serial/freeze')
  freezeCard(@Param('serial') serial: string) {
    return this.platformService.freezeCard(serial);
  }

  @Post('cards/:serial/replace')
  replaceCard(
    @Param('serial') serial: string,
    @Body() dto: ReplaceCardDto,
  ) {
    return this.platformService.replaceCard(serial, dto);
  }

  @Post('cards/:serial/renew')
  @Roles(UserRole.AGENT)
  renewCard(
    @Param('serial') serial: string,
    @Body() dto: RenewCardDto,
  ) {
    return this.platformService.renewCard(serial, dto);
  }

  @Post('payments/tap')
  @Roles(UserRole.CONDUCTOR)
  tap(@CurrentUser() user: User, @Body() dto: TapPaymentDto) {
    return this.platformService.tap(user, dto);
  }

  @Post('wallets/topup')
  @Roles(UserRole.AGENT)
  topUp(@Body() dto: TopUpDto) {
    return this.platformService.topUp(dto);
  }
}
