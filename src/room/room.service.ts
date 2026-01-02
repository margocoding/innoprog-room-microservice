import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { fillDto } from 'helpers/fill-dto/fill-dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateRoomDto } from './dto/create-room-dto';
import { EditRoomDto } from './dto/edit-room-dto';
import { GetRoomsDto } from './dto/get-rooms-dto';
import { RoomRdo } from './rdo/room-rdo';

@Injectable()
export class RoomService {
  private readonly logger: Logger = new Logger();

  constructor(private readonly prisma: PrismaService) { }

  async createRoom(dto: CreateRoomDto): Promise<RoomRdo> {
    const room = await this.prisma.room.create({
      data: {
        teacher: dto.telegramId,
        studentCursorEnabled: dto.studentCursorEnabled,
        studentEditCodeEnabled: dto.studentEditCodeEnabled,
        studentSelectionEnabled: dto.studentSelectionEnabled,
        taskId: dto.taskId,
      },
    });

    return fillDto(RoomRdo, room);
  }

  async editRoom(id: string, dto: EditRoomDto): Promise<RoomRdo> {
    try {
      const currentRoom = await this.prisma.room.findUnique({
        where: { id, teacher: dto.telegramId },
      });

      if (!currentRoom) {
        throw new NotFoundException('Room not found');
      }

      const editedRoom = await this.prisma.room.update({
        where: { id, teacher: dto.telegramId },
        data: {
          ...(dto.taskId !== undefined && { taskId: dto.taskId }),
          ...(dto.language !== undefined && { language: dto.language }),
          studentCursorEnabled: dto.studentCursorEnabled !== undefined 
            ? dto.studentCursorEnabled 
            : currentRoom.studentCursorEnabled,
          studentSelectionEnabled: dto.studentSelectionEnabled !== undefined 
            ? dto.studentSelectionEnabled 
            : currentRoom.studentSelectionEnabled,
          studentEditCodeEnabled: dto.studentEditCodeEnabled !== undefined 
            ? dto.studentEditCodeEnabled 
            : currentRoom.studentEditCodeEnabled,
        }
      });

      return fillDto(RoomRdo, editedRoom);
    } catch (e) {
      this.logger.error(`Cannot edit the room: ${e}`);
      throw new NotFoundException('Room not found');
    }
  }

  async deleteRoom(id: string, telegramId: string): Promise<{ success: boolean }> {
    try {
      await this.prisma.room.delete({ where: { id, teacher: telegramId } });

      return { success: true };
    } catch (e) {
      console.error(e);
      throw new NotFoundException('Room not found');
    }
  }

  async getRooms(id: string, dto: GetRoomsDto) {
    const { page = '1', limit = '5' } = dto;

    const where = {
      OR: [
        { teacher: id },
        {
          students: {
            has: id,
          },
        },
      ],
    };

    const [rooms, total] = await Promise.all([
      this.prisma.room.findMany({
        where,
        skip: (+page - 1) * +limit,
        take: +limit,
      }),
      this.prisma.room.count({ where }),
    ]);

    return { rooms: rooms.map((room) => fillDto(RoomRdo, room)), total };
  }

  async getRoom(id: string) {
    const room = await this.prisma.room.findUnique({
      where: { id },
    });

    return room ? fillDto(RoomRdo, room) : null;
  }

  async completeRoom(id: string) {
    try {
      await this.prisma.room.update({
        where: { id },
        data: { completed: true },
      });

      return { success: true };
    } catch (e) {
      this.logger.error(`Cannoe complete a room: ${e}`);
      throw new NotFoundException('Room not found');
    }
  }

  async joinRoom(id: string, member: string) {
    const room = await this.prisma.room.findUnique({ where: { id } });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    const foundStudentInRoom = room.students.find(
      (student) => student === member,
    );
    if (foundStudentInRoom || room.teacher === member)
      return fillDto(RoomRdo, room);

    const updatedRoom = await this.prisma.room.update({
      where: { id: room.id },
      data: {
        students: {
          push: member,
        },
      },
    });

    return fillDto(RoomRdo, updatedRoom);
  }
}
