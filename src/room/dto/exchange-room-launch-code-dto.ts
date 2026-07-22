import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class ExchangeRoomLaunchCodeDto {
  @IsString()
  @MinLength(20)
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9_-]+$/)
  launchCode: string;
}
