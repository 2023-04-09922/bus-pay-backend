import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateIf,
} from 'class-validator';

import {
  NIDA_MESSAGE,
  NIDA_PATTERN,
  NidaField,
  PhoneField,
  TZ_PHONE_MESSAGE,
  TZ_PHONE_PATTERN,
} from '../../auth/identity';

export class IssueCardDto {
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @IsString()
  @IsNotEmpty()
  lastName: string;

  @PhoneField()
  @IsString()
  @Matches(TZ_PHONE_PATTERN, { message: TZ_PHONE_MESSAGE })
  phone: string;

  @IsOptional()
  @ValidateIf((_, value) => value != null && String(value).trim() !== '')
  @NidaField()
  @IsString()
  @Matches(NIDA_PATTERN, { message: NIDA_MESSAGE })
  nida?: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9]{4,24}$/, {
    message: 'Card number must be 4-24 letters or digits',
  })
  serialNumber: string;

  @IsOptional()
  @IsString()
  nfcUid?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  initialLoad?: number;
}

export class TapPaymentDto {
  @IsOptional()
  @IsString()
  serialNumber?: string;

  @IsOptional()
  @IsString()
  nfcUid?: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  amount: number;

  @IsOptional()
  @IsString()
  merchantCode?: string;

  @IsOptional()
  @IsString()
  terminalCode?: string;

  @IsOptional()
  @IsString()
  serviceType?: string;
}

export class TopUpDto {
  @IsOptional()
  @IsString()
  serialNumber?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount: number;
}

export class ReplaceCardDto {
  @IsOptional()
  @IsString()
  serialNumber?: string;

  @IsOptional()
  @IsString()
  nfcUid?: string;
}

export class RenewCardDto {
  @IsOptional()
  @IsString()
  nfcUid?: string;

  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  amount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  initialLoad?: number;
}
