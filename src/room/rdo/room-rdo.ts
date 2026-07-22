import { ApiProperty } from '@nestjs/swagger';
import { Language } from '@prisma/client';
import { Expose } from 'class-transformer';

export class RoomRdo {
  @ApiProperty({
    title: 'Room id',
    example: 'b5269a83-72cb-47ee-b8ab-4a7768565080',
  })
  @Expose()
  public id: string;

  @ApiProperty({
    title: 'Signed room access token',
    example: 'v1.payload.signature',
    required: false,
  })
  @Expose()
  public roomToken?: string;

  @ApiProperty({
    title: 'One-time launch code for opening the teacher room',
    required: false,
  })
  @Expose()
  public roomLaunchCode?: string;

  @ApiProperty({ title: 'Teacher telegram id', example: '54232526524' })
  @Expose()
  public teacher: string;

  @ApiProperty({
    title: 'Should cursor be enabled for students',
    example: true,
  })
  @Expose()
  studentCursorEnabled: boolean;

  @ApiProperty({
    title: 'Should selection be enabled for students',
    example: false,
  })
  @Expose()
  studentSelectionEnabled: boolean;

  @ApiProperty({
    title: 'Should code editing be enabled for students',
    example: true,
  })
  @Expose()
  studentEditCodeEnabled: boolean;

  @ApiProperty({
    title: 'Task id',
    example: true,
  })
  @Expose()
  taskId?: boolean;

  @ApiProperty({
    title: 'Is room completed',
    example: true,
  })
  @Expose()
  completed: boolean;

  @ApiProperty({ title: 'Students', example: ['4524263461', '4532452345'] })
  @Expose()
  public students: string[];

  @ApiProperty({ title: 'Language', enum: Language, example: Language.js })
  @Expose()
  public language: Language;

  @ApiProperty({
    title: 'Room creation date',
    example: '2026-04-25T15:30:00.000Z',
  })
  @Expose()
  public createdAt: Date;
}
