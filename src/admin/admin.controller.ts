import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UserRole, type User } from '../generated/prisma';
import { AdminService } from './admin.service';
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

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('overview')
  overview() {
    return this.adminService.overview();
  }

  @Get('users')
  listUsers(@Query() query: ListUsersQueryDto) {
    return this.adminService.listUsers(query);
  }

  @Get('users/:id')
  getUser(@Param('id') id: string) {
    return this.adminService.getUser(id);
  }

  @Post('conductors')
  createConductor(
    @CurrentUser() user: User,
    @Body() dto: CreateConductorDto,
  ) {
    return this.adminService.createConductor(user, dto);
  }

  @Patch('users/:id/status')
  updateUserStatus(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: UpdateUserStatusDto,
  ) {
    return this.adminService.updateUserStatus(user, id, dto);
  }

  @Post('users/:id/unlock')
  unlockUser(@CurrentUser() user: User, @Param('id') id: string) {
    return this.adminService.unlockUser(user, id);
  }

  @Get('customers')
  listCustomers(@Query() query: ListCustomersQueryDto) {
    return this.adminService.listCustomers(query);
  }

  @Get('customers/:id')
  getCustomer(@Param('id') id: string) {
    return this.adminService.getCustomer(id);
  }

  @Patch('customers/:id/status')
  updateCustomerStatus(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: UpdateCustomerStatusDto,
  ) {
    return this.adminService.updateCustomerStatus(user, id, dto);
  }

  @Get('terminals')
  listTerminals(@Query() query: PaginationQueryDto) {
    return this.adminService.listTerminals(query);
  }

  @Post('terminals/:terminalId/assign')
  assignTerminal(
    @CurrentUser() user: User,
    @Param('terminalId') terminalId: string,
    @Body() dto: AssignTerminalDto,
  ) {
    return this.adminService.assignTerminal(user, terminalId, dto);
  }

  @Get('cards')
  listCards(@Query() query: ListCardsQueryDto) {
    return this.adminService.listCards(query);
  }

  @Get('cards/inventory')
  listInventory(@Query() query: ListInventoryQueryDto) {
    return this.adminService.listInventory(query);
  }

  @Post('cards/inventory')
  addInventory(
    @CurrentUser() user: User,
    @Body() dto: BulkInventoryDto,
  ) {
    return this.adminService.addInventory(user, dto);
  }

  @Get('cards/:serial')
  getCard(@Param('serial') serial: string) {
    return this.adminService.getCard(serial);
  }

  @Post('cards/:serial/freeze')
  freezeCard(
    @CurrentUser() user: User,
    @Param('serial') serial: string,
  ) {
    return this.adminService.freezeCard(user, serial);
  }

  @Post('cards/:serial/unfreeze')
  unfreezeCard(
    @CurrentUser() user: User,
    @Param('serial') serial: string,
  ) {
    return this.adminService.unfreezeCard(user, serial);
  }

  @Post('cards/:serial/replace')
  replaceCard(
    @CurrentUser() user: User,
    @Param('serial') serial: string,
    @Body() dto: ReplaceCardDto,
  ) {
    return this.adminService.replaceCard(user, serial, dto);
  }

  @Get('wallets')
  listWallets(@Query() query: ListWalletsQueryDto) {
    return this.adminService.listWallets(query);
  }

  @Get('wallets/:id')
  getWallet(@Param('id') id: string) {
    return this.adminService.getWallet(id);
  }

  @Post('wallets/:id/freeze')
  freezeWallet(@CurrentUser() user: User, @Param('id') id: string) {
    return this.adminService.freezeWallet(user, id);
  }

  @Post('wallets/:id/unfreeze')
  unfreezeWallet(@CurrentUser() user: User, @Param('id') id: string) {
    return this.adminService.unfreezeWallet(user, id);
  }

  @Get('transactions')
  listTransactions(@Query() query: ListTransactionsQueryDto) {
    return this.adminService.listTransactions(query);
  }

  @Post('transactions/:id/reverse')
  reverseTransaction(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: ReverseTransactionDto,
  ) {
    return this.adminService.reverseTransaction(user, id, dto);
  }

  @Get('topups')
  listTopUps(@Query() query: ListTopUpsQueryDto) {
    return this.adminService.listTopUps(query);
  }

  @Get('withdrawals')
  listWithdrawals(@Query() query: ListWithdrawalsQueryDto) {
    return this.adminService.listWithdrawals(query);
  }

  @Post('withdrawals/:id/approve')
  approveWithdrawal(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: WithdrawalDecisionDto,
  ) {
    return this.adminService.approveWithdrawal(user, id, dto);
  }

  @Post('withdrawals/:id/reject')
  rejectWithdrawal(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: WithdrawalDecisionDto,
  ) {
    return this.adminService.rejectWithdrawal(user, id, dto);
  }

  @Post('withdrawals/:id/paid')
  markWithdrawalPaid(@CurrentUser() user: User, @Param('id') id: string) {
    return this.adminService.markWithdrawalPaid(user, id);
  }

  @Get('refunds')
  listRefunds(@Query() query: ListRefundsQueryDto) {
    return this.adminService.listRefunds(query);
  }

  @Get('settlements')
  listSettlements(@Query() query: ListSettlementsQueryDto) {
    return this.adminService.listSettlements(query);
  }

  @Post('settlements')
  createSettlement(
    @CurrentUser() user: User,
    @Body() dto: CreateSettlementDto,
  ) {
    return this.adminService.createSettlement(user, dto);
  }

  @Post('settlements/:id/finalize')
  finalizeSettlement(@CurrentUser() user: User, @Param('id') id: string) {
    return this.adminService.finalizeSettlement(user, id);
  }

  @Post('settlements/:id/paid')
  markSettlementPaid(@CurrentUser() user: User, @Param('id') id: string) {
    return this.adminService.markSettlementPaid(user, id);
  }

  @Get('reports/summary')
  reportsSummary(@Query() query: ReportsQueryDto) {
    return this.adminService.reportsSummary(query);
  }

  @Get('alerts')
  listAlerts(@Query() query: ListAlertsQueryDto) {
    return this.adminService.listAlerts(query);
  }

  @Post('alerts/sync')
  syncAlerts() {
    return this.adminService.syncAlerts();
  }

  @Post('alerts/:id/ack')
  acknowledgeAlert(@CurrentUser() user: User, @Param('id') id: string) {
    return this.adminService.acknowledgeAlert(user, id);
  }

  @Get('settings')
  getSettings() {
    return this.adminService.getSettings();
  }

  @Patch('settings')
  updateSettings(
    @CurrentUser() user: User,
    @Body() dto: UpdateSettingsDto,
  ) {
    return this.adminService.updateSettings(user, dto);
  }

  @Get('audit-logs')
  listAuditLogs(@Query() query: ListAuditLogsQueryDto) {
    return this.adminService.listAuditLogs(query);
  }

  @Get('health')
  health() {
    return this.adminService.health();
  }
}
