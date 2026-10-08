import { Language } from '@prisma/client';
import { Injectable, Logger, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { fillDto } from 'helpers/fill-dto/fill-dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateRoomDto } from './dto/create-room-dto';
import { EditRoomDto } from './dto/edit-room-dto';
import { GetRoomsDto } from './dto/get-rooms-dto';
import { RoomRdo } from './rdo/room-rdo';

@Injectable()
export class RoomService {
  private readonly logger: Logger = new Logger();

  constructor(private readonly prisma: PrismaService) {}

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

    const teacherUsername = dto.username?.trim();
    if (teacherUsername) {
      await this.upsertRoomMember(room.id, room.teacher, teacherUsername);
    }

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
          studentCursorEnabled:
            dto.studentCursorEnabled !== undefined
              ? dto.studentCursorEnabled
              : currentRoom.studentCursorEnabled,
          studentSelectionEnabled:
            dto.studentSelectionEnabled !== undefined
              ? dto.studentSelectionEnabled
              : currentRoom.studentSelectionEnabled,
          studentEditCodeEnabled:
            dto.studentEditCodeEnabled !== undefined
              ? dto.studentEditCodeEnabled
              : currentRoom.studentEditCodeEnabled,
        },
      });

      return fillDto(RoomRdo, editedRoom);
    } catch (e) {
      this.logger.error(`Cannot edit the room: ${e}`);
      throw new NotFoundException('Room not found');
    }
  }

  async changeLanguage(id: string, telegramId: string, language: Language): Promise<RoomRdo> {
    const room = await this.prisma.room.update({
      where: {
        id,
        completed: false,
        OR: [{ teacher: telegramId }, { students: { has: telegramId } }],
      },
      data: { language },
    });
    return fillDto(RoomRdo, room);
  }

  async deleteRoom(
    id: string,
    telegramId: string,
  ): Promise<{ success: boolean }> {
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
        include: {
          roomMembers: {
            select: {
              telegramId: true,
              username: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (+page - 1) * +limit,
        take: +limit,
      }),
      this.prisma.room.count({ where }),
    ]);

    return {
      rooms: rooms.map((room) =>
        fillDto(RoomRdo, {
          ...room,
          students: room.students.map((studentTelegramId) => {
            const roomMember = room.roomMembers.find(
              (member) => member.telegramId === studentTelegramId,
            );

            return roomMember?.username || studentTelegramId;
          }),
        }),
      ),
      total,
    };
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

  async getRoomSnapshot(roomId: string): Promise<string | null> {
    const latestLog = await this.prisma.log.findFirst({
      where: { roomId },
      orderBy: { createdAt: 'desc' },
      select: { code: true },
    });

    return latestLog?.code ?? null;
  }

  async saveRoomSnapshot(roomId: string, snapshot: string): Promise<void> {
    const latestLog = await this.prisma.log.findFirst({
      where: { roomId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    if (latestLog) {
      await this.prisma.log.update({
        where: { id: latestLog.id },
        data: { code: snapshot },
      });
      return;
    }

    await this.prisma.log.create({
      data: {
        roomId,
        code: snapshot,
      },
    });
  }

  async joinRoom(id: string, member: string) {
    return this.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM rooms WHERE id = ${id} FOR UPDATE`;
    const room = await tx.room.findUnique({ where: { id } });
    if (!room) throw new NotFoundException('Room not found');
    const foundStudentInRoom = room.students.find(
      (student) => student === member,
    );
    if (foundStudentInRoom || room.teacher === member)
      return fillDto(RoomRdo, room);

    if (room.students.length >= 128 || (/^i\d+$/.test(member) && room.students.filter(x => /^i\d+$/.test(x)).length >= 64)) {
      throw new ForbiddenException('Достигнут лимит участников комнаты');
    }
    const updatedRoom = await tx.room.update({
      where: { id: room.id },
      data: {
        students: {
          push: member,
        },
      },
    });

    return fillDto(RoomRdo, updatedRoom);
    }, { maxWait: 1000, timeout: 3000 });
  }

  async upsertRoomMember(roomId: string, telegramId: string, username?: string) {
    if (username !== undefined && (typeof username !== 'string' || username.length > 120)) throw new BadRequestException('Слишком длинное имя участника');
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM rooms WHERE id = ${roomId} FOR UPDATE`;
      const existing = await tx.roomMember.findUnique({ where: { telegramId_roomId: { telegramId, roomId } } });
      if (!existing && await tx.roomMember.count({ where: { roomId } }) >= 256) {
        throw new ForbiddenException('Достигнут лимит записей участников');
      }
      return tx.roomMember.upsert({
      where: {
        telegramId_roomId: {
          telegramId,
          roomId,
        },
      },
      create: {
        roomId,
        telegramId,
        username,
      },
      update: {
        ...(username !== undefined ? { username } : {}),
      },
    });
    }, { maxWait: 1000, timeout: 3000 });
  }
}
