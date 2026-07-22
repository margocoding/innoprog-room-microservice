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
    editRoom: jest.fn().mockResolvedValue(room),
    completeRoom: jest.fn().mockResolvedValue({ success: true }),
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

  it('keeps teacher privileges when a student opens the room first', async () => {
    const { gateway, roomService } = createGateway();
    const student = createClient('socket-student');
    const teacher = createClient('socket-teacher');

    await gateway.handleJoinRoom(
      { telegramId: 'student-1', roomId: 'room-1', username: 'Student' },
      student,
    );
    await gateway.handleJoinRoom(
      { telegramId: 'teacher-1', roomId: 'room-1', username: 'Teacher' },
      teacher,
    );

    expect(teacher.emit).toHaveBeenCalledWith(
      'joined',
      expect.objectContaining({ telegramId: 'teacher-1', isTeacher: true }),
    );

    await gateway.handleEditRoom(teacher, {
      roomId: 'room-1',
      telegramId: 'teacher-1',
      language: 'bash',
    } as any);
    expect(roomService.editRoom).toHaveBeenCalledWith(
      'room-1',
      expect.objectContaining({ telegramId: 'teacher-1', language: 'bash' }),
    );
  });

  it('restores the persisted teacher name on the first signed join', async () => {
    const { gateway, roomService } = createGateway();
    const teacher = createClient('socket-teacher');
    roomService.upsertRoomMember.mockResolvedValue({
      telegramId: 'teacher-1',
      username: 'Артемий Королёв',
    });

    await gateway.handleJoinRoom(
      { telegramId: 'teacher-1', roomId: 'room-1' },
      teacher,
    );

    expect(teacher.emit).toHaveBeenCalledWith(
      'joined',
      expect.objectContaining({
        telegramId: 'teacher-1',
        username: 'Артемий Королёв',
        isTeacher: true,
      }),
    );
  });

  it('rejects an empty language before it reaches the database', async () => {
    const { gateway, roomService } = createGateway();
    const teacher = createClient('socket-teacher');

    await gateway.handleEditRoom(teacher, {
      roomId: 'room-1',
      telegramId: 'teacher-1',
      language: '',
    } as any);

    expect(roomService.editRoom).not.toHaveBeenCalled();
    expect(teacher.emit).toHaveBeenCalledWith('edit-room:error', {
      message: 'Неподдерживаемый язык программирования',
    });
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

describe('RoomGateway events', () => {
  it('rejects a missing room and joins a new participant', async () => {
    const missing = createGateway(null as any);
    const client = createClient('socket-1');
    await missing.gateway.handleJoinRoom(
      { telegramId: 'student', roomId: 'missing' },
      client,
    );
    expect(client.emit).toHaveBeenCalledWith('join-room:error', {
      message: 'Комната не найдена',
    });

    const joined = createGateway();
    await joined.gateway.handleJoinRoom(
      { telegramId: 'new-student', roomId: 'room-1', username: 'New' },
      client,
    );
    expect(joined.roomService.joinRoom).toHaveBeenCalledWith('room-1', 'new-student');
    expect(joined.roomService.upsertRoomMember).toHaveBeenCalled();
  });

  it('edits room permissions only for the active teacher', async () => {
    const { gateway, roomService, roomEmit } = createGateway();
    roomService.editRoom.mockResolvedValue(
      createRoom({ studentCursorEnabled: false }),
    );
    const client = createClient('teacher');
    await gateway.handleJoinRoom(
      { telegramId: 'teacher-1', roomId: 'room-1' },
      client,
    );
    await gateway.handleEditRoom(client, {
      roomId: 'room-1',
      telegramId: 'teacher-1',
      studentCursorEnabled: false,
    } as any);
    expect(roomService.editRoom).toHaveBeenCalled();
    expect(roomEmit).toHaveBeenCalledWith(
      'room-edited',
      expect.objectContaining({ id: 'room-1' }),
    );

    roomService.getRoom.mockResolvedValueOnce(createRoom({ teacher: 'other' }));
    await gateway.handleEditRoom(client, {
      roomId: 'room-1',
      telegramId: 'teacher-1',
    } as any);
    expect(client.emit).toHaveBeenCalledWith('error', {
      message: 'Комната не найдена',
    });
  });

  it('validates and broadcasts cursor updates', () => {
    const { gateway } = createGateway();
    const client = createClient('socket');
    gateway.handleCursor(client, {
      roomId: 'missing', telegramId: 'student', position: [1, 2], logs: [],
    });
    gateway.activeRooms = [{
      ...createRoom(),
      members: [{ telegramId: 'student', clientId: 'socket', online: true, userColor: '#fff' }],
    }] as any;
    gateway.handleCursor(client, {
      roomId: 'room-1', telegramId: 'student', position: [1], logs: [],
    });
    gateway.handleCursor(client, {
      roomId: 'room-1', telegramId: 'student', position: [4, 5], logs: [],
    });
    expect(client.broadcast.to).toHaveBeenCalledWith('room-1');
    expect(client.broadcast.to.mock.results.at(-1).value.emit).toHaveBeenCalledWith(
      'cursor-action',
      expect.objectContaining({ position: [4, 5], userColor: '#fff' }),
    );
  });

  it('tracks caret, range and cleared selections', () => {
    const { gateway } = createGateway();
    const client = createClient('socket');
    const member: any = {
      telegramId: 'student', clientId: 'socket', online: true, userColor: '#fff',
    };
    gateway.activeRooms = [{ ...createRoom(), members: [member] }] as any;
    gateway.handleSelection(client, {
      roomId: 'room-1', telegramId: 'student', line: 2, column: 3,
    });
    expect(member.lastSelection).toEqual({ line: 2, column: 3 });
    gateway.handleSelection(client, {
      roomId: 'room-1',
      telegramId: 'student',
      selectionStart: { line: 1, column: 0 },
      selectionEnd: { line: 2, column: 2 },
      selectedText: 'abc',
    });
    expect(member.lastSelection.selectedText).toBe('abc');
    gateway.handleSelection(client, {
      roomId: 'room-1', telegramId: 'student', clearSelection: true,
    });
    expect(member.lastSelection).toEqual({});
  });

  it('enforces code edit permissions and broadcasts accepted updates', async () => {
    const { gateway } = createGateway();
    const client = createClient('socket');
    gateway.activeRooms = [{
      ...createRoom({ studentEditCodeEnabled: false }),
      members: [{ telegramId: 'student', clientId: 'socket', online: true }],
    }] as any;
    const update = Y.encodeStateAsUpdate(new Y.Doc());
    await gateway.handleCodeEdit(client, {
      roomId: 'room-1', telegramId: 'student', update,
    });
    expect(client.emit).toHaveBeenCalledWith('error', {
      message: 'Редактирование кода отключено в этой комнате',
    });
    gateway.activeRooms[0].studentEditCodeEnabled = true;
    await gateway.handleCodeEdit(client, {
      roomId: 'room-1', telegramId: 'student', update,
    });
    expect(client.broadcast.to.mock.results.at(-1).value.emit).toHaveBeenCalledWith(
      'code-edit-action',
      expect.objectContaining({ telegramId: 'student', update }),
    );
  });

  it('allows a member or teacher to rename a room member', () => {
    const { gateway, roomService, roomEmit } = createGateway();
    const client = createClient('socket');
    gateway.activeRooms = [{
      ...createRoom(),
      members: [{ telegramId: 'student', clientId: 'socket', online: true }],
    }] as any;
    gateway.handleEditMember(client, {
      roomId: 'room-1',
      telegramId: 'teacher-1',
      changeTelegramId: 'student',
      username: 'Alice',
    });
    expect(roomService.upsertRoomMember).toHaveBeenCalledWith(
      'room-1', 'student', 'Alice',
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'members-updated',
      expect.objectContaining({ trigger: 'username-update' }),
    );
    gateway.handleEditMember(client, {
      roomId: 'room-1',
      telegramId: 'stranger',
      changeTelegramId: 'student',
    });
    expect(client.emit).toHaveBeenCalledWith('error', {
      message: 'Участник не найден в комнате',
    });
  });

  it('closes an active teacher session', async () => {
    const { gateway, roomService, roomEmit } = createGateway();
    const client = createClient('teacher');
    await gateway.handleJoinRoom(
      { telegramId: 'teacher-1', roomId: 'room-1' },
      client,
    );
    roomService.completeRoom.mockResolvedValue({ success: true });
    await gateway.handleCloseSession(client, {
      telegramId: 'teacher-1', roomId: 'room-1',
    });
    expect(roomService.completeRoom).toHaveBeenCalledWith('room-1');
    expect(gateway.activeRooms).toHaveLength(0);
    expect(roomEmit).toHaveBeenCalledWith('complete-session', {
      message: 'Учитель завершил сессию',
    });
  });

  it('loads a saved Yjs snapshot and tolerates a damaged one', async () => {
    const source = new Y.Doc();
    source.getText('codemirror').insert(0, 'saved');
    const encoded = Buffer.from(Y.encodeStateAsUpdate(source)).toString('base64');
    const valid = createGateway();
    valid.roomService.getRoomSnapshot.mockResolvedValue(encoded);
    await valid.gateway.handleJoinRoom(
      { telegramId: 'teacher-1', roomId: 'room-1' },
      createClient('valid'),
    );
    expect(valid.roomService.getRoomSnapshot).toHaveBeenCalled();

    const invalid = createGateway();
    invalid.roomService.getRoomSnapshot.mockResolvedValue('not-yjs');
    await invalid.gateway.handleJoinRoom(
      { telegramId: 'teacher-1', roomId: 'room-1' },
      createClient('invalid'),
    );
    expect(invalid.gateway.activeRooms).toHaveLength(1);
  });
});
