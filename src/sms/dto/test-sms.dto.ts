import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

import {
  PhoneField,
  TZ_PHONE_MESSAGE,
  TZ_PHONE_PATTERN,
} from '../../auth/identity';

export class TestSmsDto {
  @PhoneField()
  @IsString()
  @Matches(TZ_PHONE_PATTERN, { message: TZ_PHONE_MESSAGE })
  phone!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1600)
  message!: string;
}
