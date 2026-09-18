import { IsNotEmpty, IsString, Matches } from 'class-validator';

import {
  NIDA_MESSAGE,
  NIDA_PATTERN,
  NidaField,
  TZ_PHONE_MESSAGE,
  TZ_PHONE_PATTERN,
  PhoneField,
} from '../identity';

const PIN_MESSAGE = 'PIN must be exactly 4 digits';

export class RegisterDto {
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

  @NidaField()
  @IsString()
  @Matches(NIDA_PATTERN, { message: NIDA_MESSAGE })
  nida: string;

  @IsString()
  @Matches(/^\d{4}$/, { message: PIN_MESSAGE })
  pin: string;

  @IsString()
  @Matches(/^\d{4}$/, { message: PIN_MESSAGE })
  confirmPin: string;
}
