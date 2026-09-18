import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

import { EmailField } from '../email';

export class AgentLoginDto {
  @EmailField()
  @IsEmail({}, { message: 'Use a valid email like name@gmail.com' })
  email: string;

  @IsString()
  @IsNotEmpty()
  password: string;
}
