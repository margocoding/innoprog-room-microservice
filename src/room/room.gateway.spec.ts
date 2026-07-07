import { RoomGateway } from './room.gateway';
import * as Y from 'yjs';

const createRoom = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'room-1',
    teacher: 'teacher-1',
    students: [],
    studentCursorEnabled: true,
    studentSelectionEnabled: true,
    studentEditCodeEnabled: true,
    completed: false,
    language: 'py',
    ...overrides,
  }) as any;

const createClient = (id: string) =>
  ({
    id,
    join: jest.fn().mockResolvedValue(undefined),
    leave: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
    emit: jest.fn(),
    broadcast: {
      to: jest.fn(() => ({ emit: jest.fn() })),
    },
  }) as any;

const createGateway = (room = createRoom()) => {
  const roomService = {
    getRoom: jest.fn().mockResolvedValue(room),
    joinRoom: jest.fn(async (_roomId: string, telegramId: string) => ({
      ...room,
      students: [...room.students, telegramId],
    })),
    upsertRoomMember: jest.fn().mockResolvedValue(undefined),
    getRoomSnapshot: jest.fn().mockResolvedValue(null),
    saveRoomSnapshot: jest.fn().mockResolvedValue(undefined),
  };

  const roomEmit = jest.fn();
  const to = jest.fn(() => ({ emit: roomEmit }));
  const sockets = new Map<string, ReturnType<typeof createClient>>();
  const gateway = new RoomGateway(roomService as any);
  gateway.server = { to, sockets: { sockets } } as any;

  return { gateway, roomService, roomEmit, to, sockets };
};

const memberUpdates = (roomEmit: jest.Mock) =>
  roomEmit.mock.calls
    .filter(([eventName]) => eventName === 'members-updated')
    .map(([, payload]) => payload);

describe('RoomGateway membership sync', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('broadcasts all joined members without server-side isYourself', async () => {
    const { gateway, roomEmit } = createGateway();
    const teacher = createClient('socket-teacher');
    const student = createClient('socket-student');

    await gateway.handleJoinRoom(
      { telegramId: 'teacher-1', roomId: 'room-1', username: 'Teacher' },
      teacher,
    );
    await gateway.handleJoinRoom(
      { telegramId: 'student-1', roomId: 'room-1', username: 'Student' },
      student,
    );

    const updates = memberUpdates(roomEmit);
    const lastUpdate = updates[updates.length - 1];

    expect(lastUpdate.members).toHaveLength(2);
    expect(lastUpdate.members.map((member) => member.telegramId)).toEqual([
      'teacher-1',
      'student-1',
    ]);
    expect(lastUpdate.members.every((member) => member.online)).toBe(true);
    expect(lastUpdate.members.some((member) => 'isYourself' in member)).toBe(
      false,
    );
  });

  it('updates clientId on repeated join by the same member', async () => {
    const { gateway } = createGateway();
    const firstClient = createClient('socket-old');
    const secondClient = createClient('socket-new');

    await gateway.handleJoinRoom(
      { telegramId: 'teacher-1', roomId: 'room-1' },
      firstClient,
    );
    await gateway.handleJoinRoom(
      { telegramId: 'teacher-1', roomId: 'room-1' },
      secondClient,
    );
    await gateway.handleDisconnect(firstClient);

    expect(gateway.activeRooms[0].members).toHaveLength(1);
    expect(gateway.activeRooms[0].members[0]).toMatchObject({
      telegramId: 'teacher-1',
      clientId: 'socket-new',
      online: true,
    });
  });

  it('disconnects the previous socket when the same member rejoins', async () => {
    const { gateway, sockets } = createGateway();
    const firstClient = createClient('socket-old');
    const secondClient = createClient('socket-new');
    sockets.set(firstClient.id, firstClient);
    sockets.set(secondClient.id, secondClient);

    await gateway.handleJoinRoom(
      { telegramId: 'teacher-1', roomId: 'room-1' },
      firstClient,
    );
    await gateway.handleJoinRoom(
      { telegramId: 'teacher-1', roomId: 'room-1' },
      secondClient,
    );

    expect(firstClient.emit).toHaveBeenCalledWith('room-session-replaced', {
      roomId: 'room-1',
    });
    expect(firstClient.leave).toHaveBeenCalledWith('room-1');
    expect(firstClient.disconnect).toHaveBeenCalledWith(true);
    expect(gateway.activeRooms[0].members).toHaveLength(1);
    expect(gateway.activeRooms[0].members[0]).toMatchObject({
      telegramId: 'teacher-1',
      clientId: 'socket-new',
      online: true,
    });
  });

  it('replaces a previous identity on the same socket in one room', async () => {
    const { gateway } = createGateway();
    const client = createClient('socket-1');

    await gateway.handleJoinRoom(
      { telegramId: 'i123456', roomId: 'room-1', username: 'User' },
      client,
    );
    await gateway.handleJoinRoom(
      { telegramId: 'teacher-1', roomId: 'room-1', username: 'Teacher' },
      client,
    );

    expect(gateway.activeRooms[0].members).toHaveLength(1);
    expect(gateway.activeRooms[0].members[0]).toMatchObject({
      telegramId: 'teacher-1',
      clientId: 'socket-1',
      online: true,
    });
  });

  it('marks the disconnected socket offline in every active room', async () => {
    const { gateway, roomEmit } = createGateway();
    gateway.activeRooms = [
      {
        ...createRoom({ id: 'room-1' }),
        members: [
          { clientId: 'socket-1', telegramId: 'teacher-1', online: true },
          { clientId: 'socket-2', telegramId: 'student-1', online: true },
        ],
      },
      {
        ...createRoom({ id: 'room-2' }),
        members: [
          { clientId: 'socket-1', telegramId: 'teacher-1', online: true },
          { clientId: 'socket-3', telegramId: 'student-2', online: true },
        ],
      },
    ] as any;

    await gateway.handleDisconnect(createClient('socket-1'));

    expect(gateway.activeRooms[0].members[0].online).toBe(false);
    expect(gateway.activeRooms[1].members[0].online).toBe(false);
    expect(memberUpdates(roomEmit)).toHaveLength(2);
  });

  it('persists code edits shortly after receiving a yjs update', async () => {
    const { gateway, roomService } = createGateway();
    const teacher = createClient('socket-teacher');

    await gateway.handleJoinRoom(
      { telegramId: 'teacher-1', roomId: 'room-1', username: 'Teacher' },
      teacher,
    );

    const doc = new Y.Doc();
    doc.getText('codemirror').insert(0, 'print("saved")');
    const update = Y.encodeStateAsUpdate(doc);

    await gateway.handleCodeEdit(teacher, {
      telegramId: 'teacher-1',
      roomId: 'room-1',
      update,
    });

    expect(roomService.saveRoomSnapshot).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1000);

    expect(roomService.saveRoomSnapshot).toHaveBeenCalledTimes(1);
    expect(roomService.saveRoomSnapshot).toHaveBeenCalledWith(
      'room-1',
      expect.any(String),
    );
  });

  it('flushes active room snapshots before application shutdown', async () => {
    const { gateway, roomService } = createGateway();
    const teacher = createClient('socket-teacher');

    await gateway.handleJoinRoom(
      { telegramId: 'teacher-1', roomId: 'room-1', username: 'Teacher' },
      teacher,
    );

    await gateway.beforeApplicationShutdown('SIGTERM');

    expect(roomService.saveRoomSnapshot).toHaveBeenCalledTimes(1);
    expect(roomService.saveRoomSnapshot).toHaveBeenCalledWith(
      'room-1',
      expect.any(String),
    );
  });
});
