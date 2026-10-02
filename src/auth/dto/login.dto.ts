import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

import {
  PhoneField,
  TZ_PHONE_MESSAGE,
  TZ_PHONE_PATTERN,
} from '../identity';

export class LoginDto {
  /** Legacy conductor ID (bp-c…bus). Optional when phone is provided. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  username?: string;

  /** Registered phone — used when signing in on a new device. */
  @IsOptional()
  @IsString()
  @PhoneField()
  @Matches(TZ_PHONE_PATTERN, { message: TZ_PHONE_MESSAGE })
  phone?: string;

  @IsString()
  @Matches(/^\d{4}$/, {
    message: 'PIN must be exactly 4 digits',
  })
  pin: string;
}
