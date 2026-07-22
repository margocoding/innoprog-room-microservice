import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { EditRoomDto } from './edit-room-dto';

export class CreateRoomDto extends EditRoomDto {
  @ApiProperty({
    title: 'Teacher display name',
    required: false,
    example: 'Артемий Королёв',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  public username?: string;
}
