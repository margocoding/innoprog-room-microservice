import { IsOptional, IsString, Matches } from 'class-validator';

export class CreateAnonymousRoomTokenDto {
  @IsOptional()
  @IsString()
  @Matches(/^i\d+$/)
  telegramId?: string;
}
