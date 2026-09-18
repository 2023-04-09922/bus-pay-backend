import { IsEmail } from 'class-validator';

import { EmailField } from '../email';

export class AgentForgotPasswordDto {
  @EmailField()
  @IsEmail({}, { message: 'Use a valid email like name@gmail.com' })
  email: string;
}
