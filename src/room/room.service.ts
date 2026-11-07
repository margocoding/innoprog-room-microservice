import { isDeepStrictEqual } from 'node:util';
import { LessonTask, readLessonTask } from './lesson-task';
import { Language, Prisma } from '@prisma/client';
import { Injectable, Logger, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { fillDto } from 'helpers/fill-dto/fill-dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateRoomDto } from './dto/create-room-dto';
import { EditRoomDto } from './dto/edit-room-dto';
import { GetRoomsDto } from './dto/get-rooms-dto';
import { RoomRdo } from './rdo/room-rdo';

const personalTaskId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

@Injectable()
export class RoomService {
  private readonly logger: Logger = new Logger();

  constructor(private readonly prisma: PrismaService) {}

  async platformLesson(owner: string, path: string, credential: unknown) {
    const base = new URL(process.env.ROOM_LESSON_CATALOG_ORIGIN || 'https://api.innoprog.ru');
    const local = process.env.ROOM_LESSON_LOCAL_CATALOG === '1' && base.hostname === '127.0.0.1';
    if (path !== 'modules' && !local && (typeof credential !== 'string' || !credential || credential.length > 4096)) {
      throw new ForbiddenException('Войдите на платформу, чтобы открыть её задачи');
    }
    const url = new URL('/platform/ide/lesson-catalog/' + path, base);
    url.searchParams.set('owner', owner);
    const response = await fetch(url, {
      headers: local || path === 'modules' ? {} : { 'X-Platform-Auth': credential as string },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 401 || response.status === 403) {
      throw new ForbiddenException('Нет доступа к задаче платформы');
    }
    if (!response.ok) throw new BadRequestException('Каталог временно недоступен');
    return response.json();
  }

  async listPersonalLessons(owner: string) {
    const rows = await this.prisma.personalLessonTask.findMany({
      where: { owner }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 100,
    });
    return rows.map(row => ({ ...readLessonTask(row.payload), id: row.id }));
  }

  async createPersonalLesson(owner: string, raw: unknown) {
    const task = readLessonTask(raw);
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${'personal-lesson:' + owner}))`;
      if (await tx.personalLessonTask.count({ where: { owner } }) >= 100) {
        throw new BadRequestException('Достигнут лимит личных задач');
      }
      const row = await tx.personalLessonTask.create({
        data: { owner, moduleId: task.moduleId, payload: { ...task } },
      });
      return { ...task, id: row.id };
    });
  }

  async updatePersonalLesson(owner: string, id: string, raw: unknown) {
    if (!personalTaskId.test(id)) throw new NotFoundException('Задача не найдена');
    const task = readLessonTask(raw);
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${'personal-lesson:' + owner}))`;
      const previous = await tx.personalLessonTask.findFirst({ where: { id, owner }, select: { payload: true } });
      if (!previous) throw new NotFoundException('Задача не найдена');
      await tx.personalLessonTask.updateMany({
        where: { id, owner }, data: { moduleId: task.moduleId, payload: { ...task } },
      });
      if (task.language !== readLessonTask(previous.payload).language) {
        await tx.roomLessonDraft.updateMany({
          where: { key: 'personal:' + id, room: { teacher: owner } },
          data: { language: task.language },
        });
      }
      return { ...task, id };
    });
  }

  async deletePersonalLesson(owner: string, id: string) {
    if (!personalTaskId.test(id)) throw new NotFoundException('Задача не найдена');
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${'personal-lesson:' + owner}))`;
      const result = await tx.personalLessonTask.deleteMany({ where: { id, owner } });
      if (!result.count) throw new NotFoundException('Задача не найдена');
      await tx.roomLessonDraft.deleteMany({ where: { key: 'personal:' + id, room: { teacher: owner } } });
      return { success: true };
    });
  }

  async resolveLesson(owner: string, source: string, id: unknown, credential: unknown) {
    if (source === 'free') return { key: 'free', task: null };
    if (source === 'personal' && typeof id === 'string' && personalTaskId.test(id)) {
      const row = await this.prisma.personalLessonTask.findFirst({ where: { id, owner } });
      if (row) return { key: 'personal:' + id, task: readLessonTask(row.payload) };
    }
    if (source === 'platform' && typeof id === 'number' && Number.isSafeInteger(id) && id > 0) {
      const raw = await this.platformLesson(owner, 'task/' + id, credential);
      return { key: 'platform:' + id, task: { ...readLessonTask(raw, true), platformId: id } };
    }
    throw new NotFoundException('Задача не найдена');
  }

  async switchLesson(
    id: string, owner: string, revision: number, key: string, task: LessonTask | null,
    outgoing: string, prepare: (snapshot: string | null, task: LessonTask | null, codeInline: boolean) => string,
  ) {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${'personal-lesson:' + owner}))`;
      await tx.$queryRaw`SELECT id FROM rooms WHERE id = ${id} FOR UPDATE`;
      const room = await tx.room.findUnique({ where: { id } });
      if (!room || room.teacher !== owner || room.completed || room.lessonRevision !== revision) {
        throw new ForbiddenException('Комната изменилась. Повторите выбор');
      }
      const storedPersonalTask = async (personalKey: string) => {
        const row = await tx.personalLessonTask.findFirst({
          where: { id: personalKey.slice('personal:'.length), owner }, select: { payload: true },
        });
        return row ? readLessonTask(row.payload) : null;
      };
      if (key.startsWith('personal:')) {
        task = await storedPersonalTask(key);
        if (!task) throw new NotFoundException('Задача не найдена');
      }
      const sameDocument = room.lessonKey === key;
      if (sameDocument && revision > 0 && isDeepStrictEqual(room.lessonTask, task)) return null;
      const draft = await tx.roomLessonDraft.findUnique({ where: { roomId_key: { roomId: id, key } } });
      if (!draft && room.lessonKey !== key && await tx.roomLessonDraft.count({ where: { roomId: id } }) >= 40) {
        throw new BadRequestException('Достигнут лимит черновиков комнаты');
      }
      const snapshot = prepare(
        sameDocument ? outgoing : draft?.snapshot ?? null,
        task,
        sameDocument || Boolean(draft?.codeInline),
      );
      const outgoingTask = room.lessonTask as unknown as LessonTask | null;
      const outgoingPersonal = room.lessonKey.startsWith('personal:');
      const current = outgoingPersonal ? (sameDocument ? task : await storedPersonalTask(room.lessonKey)) : null;
      const draftLanguage = current && outgoingTask && current.language !== outgoingTask.language
        ? current.language : room.language;
      // Deleted library items cannot be reopened. Their visit still retains the final room code.
      if (!outgoingPersonal || current) {
        await tx.roomLessonDraft.upsert({
          where: { roomId_key: { roomId: id, key: room.lessonKey } },
          create: { roomId: id, key: room.lessonKey, language: draftLanguage, snapshot: outgoing, codeInline: true },
          update: { language: draftLanguage, snapshot: outgoing, codeInline: true },
        });
      }
      const language = task?.platformId ? task.language : sameDocument ? draftLanguage : draft?.language ?? task?.language ?? room.language;
      const now = new Date();
      await tx.roomLessonVisit.updateMany({
        where: { roomId: id, revision, endedAt: null },
        data: { endedAt: now, snapshot: outgoing, language: room.language },
      });
      if (task) {
        await tx.roomLessonVisit.create({
          data: { roomId: id, revision: revision + 1, taskKey: key, title: task.title, language, startedAt: now },
        });
      }
      const next = await tx.room.update({
        where: { id },
        data: {
          lessonKey: key, lessonTask: task ? { ...task } : Prisma.DbNull,
          lessonRevision: { increment: 1 }, lessonSnapshot: snapshot, lessonCodeInline: true,
          language,
        },
      });
      return fillDto(RoomRdo, next);
    });
  }

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

  async editRoom(id: string, dto: EditRoomDto, lessonRevision?: number): Promise<RoomRdo> {
    try {
      const currentRoom = await this.prisma.room.findUnique({
        where: { id, teacher: dto.telegramId },
      });

      if (!currentRoom) {
        throw new NotFoundException('Room not found');
      }

      const editedRoom = await this.prisma.room.update({
        where: {
          id, teacher: dto.telegramId, lessonRevision,
          ...(dto.language !== undefined && { NOT: { lessonKey: { startsWith: 'platform:' } } }),
        },
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

  async changeLanguage(id: string, telegramId: string, language: Language, lessonRevision?: number): Promise<RoomRdo> {
    const room = await this.prisma.room.update({
      where: {
        id,
        completed: false,
        NOT: { lessonKey: { startsWith: 'platform:' } },
        lessonRevision,
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

  async completeRoom(id: string, final?: { revision: number; snapshot: string; language: Language }) {
    const now = new Date();
    try {
      await this.prisma.room.update({
        where: { id, completed: false, lessonRevision: final?.revision },
        data: {
          completed: true,
          completedAt: now,
          ...(final && {
            lessonSnapshot: final.snapshot,
            lessonHistory: { updateMany: {
              where: { revision: final.revision, endedAt: null },
              data: { endedAt: now, snapshot: final.snapshot, language: final.language },
            } },
          }),
        },
      });

      return { success: true };
    } catch {
      this.logger.error('Cannot complete room');
      throw new NotFoundException('Room not found');
    }
  }

  async startPresence(id: string, roomId: string, participant: string, joinedAt: Date, displayName?: string) {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM rooms WHERE id = ${roomId} FOR UPDATE`;
      const room = await tx.room.findUnique({ where: { id: roomId } });
      if (!room || room.completed) return false;
      const now = new Date();
      if (room.lessonTask) {
        const task = readLessonTask(room.lessonTask, true);
        await tx.roomLessonVisit.upsert({
          where: { roomId_revision: { roomId, revision: room.lessonRevision } },
          create: { roomId, revision: room.lessonRevision, taskKey: room.lessonKey, title: task.title, language: room.language, startedAt: now },
          update: {},
        });
      }
      await tx.roomPresence.create({
        data: {
          id, roomId, participant, displayName, joinedAt, lastSeenAt: joinedAt,
          role: participant === room.teacher ? 'teacher' : 'student',
          kind: /^i\d+$/.test(participant) ? 'guest' : 'verified',
        },
      });
      return true;
    });
  }

  async recordPresence(ids: string[], at: Date, leaving = false) {
    if (!ids.length) return;
    await this.prisma.roomPresence.updateMany({
      where: { id: { in: ids }, leftAt: null, lastSeenAt: { lte: at } },
      data: { lastSeenAt: at, ...(leaving && { leftAt: at }) },
    });
  }

  async getRoomSnapshot(
    roomId: string, convert?: (snapshot: string | null, task: LessonTask) => string,
  ): Promise<string | null> {
    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      select: { lessonRevision: true, lessonSnapshot: true, lessonTask: true, lessonCodeInline: true },
    });
    if (room?.lessonRevision) {
      if (!convert || room.lessonCodeInline || !room.lessonTask) return room.lessonSnapshot;
      const task = readLessonTask(room.lessonTask, true);
      const snapshot = convert(room.lessonSnapshot, task);
      await this.prisma.room.update({
        where: { id: roomId, lessonRevision: room.lessonRevision, lessonCodeInline: false, lessonSnapshot: room.lessonSnapshot },
        data: { lessonSnapshot: snapshot, lessonCodeInline: true },
      });
      return snapshot;
    }
    const latestLog = await this.prisma.log.findFirst({
      where: { roomId },
      orderBy: { createdAt: 'desc' },
      select: { code: true },
    });

    return latestLog?.code ?? null;
  }

  async saveRoomSnapshot(roomId: string, snapshot: string, revision = 0): Promise<void> {
    if (revision > 0) {
      await this.prisma.room.update({
        where: { id: roomId, lessonRevision: revision },
        data: { lessonSnapshot: snapshot },
      });
      return;
    }
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
