import { IsString, Length, Matches } from 'class-validator';

import {
  NIDA_MESSAGE,
  NIDA_PATTERN,
  NidaField,
  TZ_PHONE_MESSAGE,
  TZ_PHONE_PATTERN,
  PhoneField,
} from '../identity';

const PIN_MESSAGE = 'PIN must be exactly 4 digits';

export class ResetPinDto {
  @PhoneField()
  @IsString()
  @Matches(TZ_PHONE_PATTERN, { message: TZ_PHONE_MESSAGE })
  phone: string;

  @NidaField()
  @IsString()
  @Matches(NIDA_PATTERN, { message: NIDA_MESSAGE })
  nida: string;

  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'Reset code must be 6 digits' })
  code: string;

  @IsString()
  @Matches(/^\d{4}$/, { message: PIN_MESSAGE })
  pin: string;

  @IsString()
  @Matches(/^\d{4}$/, { message: PIN_MESSAGE })
  confirmPin: string;
}
