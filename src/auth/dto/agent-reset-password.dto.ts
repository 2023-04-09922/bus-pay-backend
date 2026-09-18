import { IsEmail, IsString, Length, Matches, MinLength } from 'class-validator';

import { EmailField } from '../email';

export class AgentResetPasswordDto {
  @EmailField()
  @IsEmail({}, { message: 'Use a valid email like name@gmail.com' })
  email: string;

  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'Reset code must be 6 digits' })
  code: string;

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
