import { NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { RoomService } from './room.service';

const room = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'room-1',
    teacher: 'teacher-1',
    students: [],
    roomMembers: [],
    taskId: 7,
    language: 'python',
    studentCursorEnabled: true,
    studentSelectionEnabled: true,
    studentEditCodeEnabled: true,
    completed: false,
    ...overrides,
  }) as any;

describe('RoomService', () => {
  let service: RoomService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      room: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      log: {
        findFirst: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
      },
      roomMember: { upsert: jest.fn() },
    };
    service = new RoomService(prisma as PrismaService);
  });

  it('creates a room and maps every permission', async () => {
    prisma.room.create.mockResolvedValue(room());
    const dto = {
      telegramId: 'teacher-1',
      taskId: 7,
      studentCursorEnabled: true,
      studentSelectionEnabled: false,
      studentEditCodeEnabled: true,
    } as any;

    const result = await service.createRoom(dto);

    expect(prisma.room.create).toHaveBeenCalledWith({ data: {
      teacher: 'teacher-1',
      taskId: 7,
      studentCursorEnabled: true,
      studentSelectionEnabled: false,
      studentEditCodeEnabled: true,
    } });
    expect(result.id).toBe('room-1');
  });

  it('persists the teacher display name when the room is created', async () => {
    prisma.room.create.mockResolvedValue(room());
    prisma.roomMember.upsert.mockResolvedValue({
      roomId: 'room-1',
      telegramId: 'teacher-1',
      username: 'Артемий Королёв',
    });

    await service.createRoom({
      telegramId: 'teacher-1',
      username: '  Артемий Королёв  ',
    } as any);

    expect(prisma.roomMember.upsert).toHaveBeenCalledWith({
      where: {
        telegramId_roomId: {
          telegramId: 'teacher-1',
          roomId: 'room-1',
        },
      },
      create: {
        roomId: 'room-1',
        telegramId: 'teacher-1',
        username: 'Артемий Королёв',
      },
      update: { username: 'Артемий Королёв' },
    });
  });

  it('edits supplied fields and preserves omitted permissions', async () => {
    prisma.room.findUnique.mockResolvedValue(room());
    prisma.room.update.mockResolvedValue(room({ language: 'javascript' }));

    const result = await service.editRoom('room-1', {
      telegramId: 'teacher-1',
      language: 'javascript',
      studentCursorEnabled: false,
    } as any);

    expect(prisma.room.update.mock.calls[0][0].data).toEqual({
      language: 'javascript',
      studentCursorEnabled: false,
      studentSelectionEnabled: true,
      studentEditCodeEnabled: true,
    });
    expect(result.language).toBe('javascript');
  });

  it.each([
    ['missing room', null],
    ['database failure', new Error('db')],
  ])('normalizes edit errors for a %s', async (_label, value) => {
    value instanceof Error
      ? prisma.room.findUnique.mockRejectedValue(value)
      : prisma.room.findUnique.mockResolvedValue(value);
    await expect(service.editRoom('missing', { telegramId: 'teacher-1' } as any))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('deletes an owned room and normalizes failures', async () => {
    prisma.room.delete.mockResolvedValue(room());
    await expect(service.deleteRoom('room-1', 'teacher-1'))
      .resolves.toEqual({ success: true });
    prisma.room.delete.mockRejectedValue(new Error('missing'));
    jest.spyOn(console, 'error').mockImplementation();
    await expect(service.deleteRoom('room-1', 'teacher-1'))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('paginates rooms and resolves student usernames', async () => {
    prisma.room.findMany.mockResolvedValue([
      room({
        students: ['student-1', 'student-2'],
        roomMembers: [{ telegramId: 'student-1', username: 'Alice' }],
      }),
    ]);
    prisma.room.count.mockResolvedValue(1);

    const result = await service.getRooms('teacher-1', { page: '2', limit: '3' });

    expect(prisma.room.findMany.mock.calls[0][0]).toMatchObject({
      skip: 3,
      take: 3,
      orderBy: { createdAt: 'desc' },
    });
    expect(result.total).toBe(1);
    expect(result.rooms[0].students).toEqual(['Alice', 'student-2']);
  });

  it('uses default pagination', async () => {
    prisma.room.findMany.mockResolvedValue([]);
    prisma.room.count.mockResolvedValue(0);
    await service.getRooms('teacher-1', {});
    expect(prisma.room.findMany.mock.calls[0][0]).toMatchObject({ skip: 0, take: 5 });
  });

  it('returns a room or null', async () => {
    prisma.room.findUnique.mockResolvedValueOnce(room()).mockResolvedValueOnce(null);
    await expect(service.getRoom('room-1')).resolves.toMatchObject({ id: 'room-1' });
    await expect(service.getRoom('missing')).resolves.toBeNull();
  });

  it('completes a room and normalizes update errors', async () => {
    prisma.room.update.mockResolvedValue(room({ completed: true }));
    await expect(service.completeRoom('room-1')).resolves.toEqual({ success: true });
    prisma.room.update.mockRejectedValue(new Error('db'));
    await expect(service.completeRoom('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('loads the latest snapshot or null', async () => {
    prisma.log.findFirst.mockResolvedValueOnce({ code: 'print(1)' }).mockResolvedValueOnce(null);
    await expect(service.getRoomSnapshot('room-1')).resolves.toBe('print(1)');
    await expect(service.getRoomSnapshot('room-1')).resolves.toBeNull();
  });

  it('updates an existing snapshot and creates the first snapshot', async () => {
    prisma.log.findFirst.mockResolvedValueOnce({ id: 8 }).mockResolvedValueOnce(null);
    await service.saveRoomSnapshot('room-1', 'new code');
    expect(prisma.log.update).toHaveBeenCalledWith({
      where: { id: 8 }, data: { code: 'new code' },
    });
    await service.saveRoomSnapshot('room-1', 'first code');
    expect(prisma.log.create).toHaveBeenCalledWith({
      data: { roomId: 'room-1', code: 'first code' },
    });
  });

  it('joins a new student but does not duplicate students or the teacher', async () => {
    prisma.room.findUnique
      .mockResolvedValueOnce(room())
      .mockResolvedValueOnce(room({ students: ['student-1'] }))
      .mockResolvedValueOnce(room());
    prisma.room.update.mockResolvedValue(room({ students: ['student-1'] }));

    await service.joinRoom('room-1', 'student-1');
    expect(prisma.room.update).toHaveBeenCalledWith({
      where: { id: 'room-1' },
      data: { students: { push: 'student-1' } },
    });
    const calls = prisma.room.update.mock.calls.length;
    await service.joinRoom('room-1', 'student-1');
    await service.joinRoom('room-1', 'teacher-1');
    expect(prisma.room.update).toHaveBeenCalledTimes(calls);
  });

  it('rejects joining a missing room', async () => {
    prisma.room.findUnique.mockResolvedValue(null);
    await expect(service.joinRoom('missing', 'student-1'))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('upserts room member metadata with and without username', async () => {
    prisma.roomMember.upsert
      .mockResolvedValueOnce({ username: 'Alice' })
      .mockResolvedValueOnce({ username: 'Saved name' });
    await expect(service.upsertRoomMember('room-1', 'student-1', 'Alice'))
      .resolves.toEqual({ username: 'Alice' });
    await expect(service.upsertRoomMember('room-1', 'student-2'))
      .resolves.toEqual({ username: 'Saved name' });
    expect(prisma.roomMember.upsert.mock.calls[0][0]).toMatchObject({
      create: { roomId: 'room-1', telegramId: 'student-1', username: 'Alice' },
      update: { username: 'Alice' },
    });
    expect(prisma.roomMember.upsert.mock.calls[1][0].update).toEqual({});
  });
});
