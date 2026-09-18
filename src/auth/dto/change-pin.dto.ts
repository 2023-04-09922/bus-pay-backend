import { IsString, Matches } from 'class-validator';

const PIN_MESSAGE = 'PIN must be exactly 4 digits';

export class ChangePinDto {
  @IsString()
  @Matches(/^\d{4}$/, { message: PIN_MESSAGE })
  currentPin: string;

  @IsString()
  @Matches(/^\d{4}$/, { message: PIN_MESSAGE })
  newPin: string;

  @IsString()
  @Matches(/^\d{4}$/, { message: PIN_MESSAGE })
  confirmPin: string;
}
