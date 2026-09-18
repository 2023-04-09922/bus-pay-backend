import { IsEmail, IsNotEmpty, IsString, Matches, MinLength } from 'class-validator';

import { EmailField } from '../email';
import {
  NIDA_MESSAGE,
  NIDA_PATTERN,
  NidaField,
  TZ_PHONE_MESSAGE,
  TZ_PHONE_PATTERN,
  PhoneField,
} from '../identity';

export class AgentRegisterDto {
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

  @EmailField()
  @IsEmail({}, { message: 'Use a valid email like name@gmail.com' })
  email: string;

  @IsString()
  @MinLength(8)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/, {
    message:
      'Password must be at least 8 characters with upper, lower, number and symbol',
  })
  password: string;

  @IsString()
  @MinLength(8)
  confirmPassword: string;
}
