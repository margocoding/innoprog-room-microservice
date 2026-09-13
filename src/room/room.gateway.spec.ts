import {
  RoomGateway,
  SOCKET_PING_INTERVAL_MS,
  SOCKET_PING_TIMEOUT_MS,
} from './room.gateway';
import * as Y from 'yjs';
import { socketMetrics } from '../socket-metrics';

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
    conn: { transport: { name: 'websocket' }, readyState: 'closed' },
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
    changeLanguage: jest.fn().mockResolvedValue({ ...room, language: 'js' }),
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
    socketMetrics.reset();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('keeps the mobile heartbeat window above the ping interval', () => {
    expect(SOCKET_PING_INTERVAL_MS).toBeGreaterThanOrEqual(25_000);
    expect(SOCKET_PING_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    expect(SOCKET_PING_TIMEOUT_MS).toBeGreaterThan(SOCKET_PING_INTERVAL_MS);
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

  it('persists and broadcasts language changes from a joined student', async () => {
    const { gateway, roomService, roomEmit } = createGateway();
    const student = createClient('student-socket');
    await gateway.handleJoinRoom({ roomId: 'room-1', telegramId: 'student-1' }, student);
    await gateway.handleEditRoom(student, {
      roomId: 'room-1', telegramId: 'student-1', language: 'js',
    } as any);
    expect(roomService.changeLanguage).toHaveBeenCalledWith('room-1', 'student-1', 'js');
    expect(roomService.editRoom).not.toHaveBeenCalled();
    expect(roomEmit).toHaveBeenCalledWith('room-edited', expect.objectContaining({ language: 'js' }));
  });

  it.each([
    { studentEditCodeEnabled: true },
    { studentCursorEnabled: true },
    { studentSelectionEnabled: true },
    { taskId: 'other-task' },
  ])('rejects student changes to owner settings: %j', async (settings) => {
    const { gateway, roomService } = createGateway();
    const student = createClient('student-socket');
    await gateway.handleJoinRoom({ roomId: 'room-1', telegramId: 'student-1' }, student);
    await gateway.handleEditRoom(student, {
      roomId: 'room-1', telegramId: 'student-1', language: 'js', ...settings,
    } as any);
    expect(roomService.changeLanguage).not.toHaveBeenCalled();
    expect(roomService.editRoom).not.toHaveBeenCalled();
  });

  it('rejects language changes from a socket that has not joined', async () => {
    const { gateway, roomService } = createGateway();
    await gateway.handleEditRoom(createClient('outsider'), {
      roomId: 'room-1', telegramId: 'student-1', language: 'js',
    } as any);
    expect(roomService.changeLanguage).not.toHaveBeenCalled();
  });

  it('classifies a hidden-tab disconnect separately from ping timeouts', async () => {
    const { gateway } = createGateway();
    const client = createClient('socket-hidden');

    await gateway.handleJoinRoom(
      {
        telegramId: 'teacher-1',
        roomId: 'room-1',
        clientInstanceId: 'browser-hidden',
      },
      client,
    );
    await expect(
      gateway.handleClientLifecycle(client, {
        telegramId: 'teacher-1',
        roomId: 'room-1',
        clientInstanceId: 'browser-hidden',
        state: 'hidden',
      }),
    ).resolves.toEqual({ ok: true, persisted: true });

    await gateway.handleDisconnect(client);

    expect(socketMetrics.render()).toContain(
      'ide_socket_disconnect_total{reason="hidden_tab"} 1',
    );
    expect(socketMetrics.render()).not.toContain('reason="ping_timeout"');
  });

  it('rejects hidden lifecycle claims from a socket outside the room', async () => {
    const { gateway } = createGateway();
    const client = createClient('socket-outsider');

    await expect(
      gateway.handleClientLifecycle(client, {
        telegramId: 'outsider',
        roomId: 'room-1',
        clientInstanceId: 'browser-outsider',
        state: 'hidden',
      }),
    ).resolves.toEqual({ ok: false });
  });

  it('measures a successful reconnect for the same browser instance', async () => {
    const { gateway } = createGateway();
    const first = createClient('socket-first');
    const second = createClient('socket-second');

    await gateway.handleJoinRoom(
      {
        telegramId: 'teacher-1',
        roomId: 'room-1',
        clientInstanceId: 'browser-stable',
      },
      first,
    );
    (gateway as any).disconnectReasons.set(first.id, 'ping timeout');
    await gateway.handleDisconnect(first);
    jest.advanceTimersByTime(2_000);
    await gateway.handleJoinRoom(
      {
        telegramId: 'teacher-1',
        roomId: 'room-1',
        clientInstanceId: 'browser-stable',
      },
      second,
    );

    const rendered = socketMetrics.render();
    expect(rendered).toContain(
      'ide_socket_disconnect_total{reason="ping_timeout"} 1',
    );
    expect(rendered).toContain(
      'ide_socket_reconnect_success_total{reason="ping_timeout"} 1',
    );
    expect(rendered).toContain(
      'ide_socket_reconnect_duration_seconds_count{reason="ping_timeout"} 1',
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

  it('silently replaces a stale socket from the same browser instance', async () => {
    const { gateway, sockets } = createGateway();
    const firstClient = createClient('socket-old');
    const secondClient = createClient('socket-new');
    sockets.set(firstClient.id, firstClient);
    sockets.set(secondClient.id, secondClient);

    await gateway.handleJoinRoom(
      {
        telegramId: 'teacher-1',
        roomId: 'room-1',
        clientInstanceId: 'same-browser-instance',
      } as any,
      firstClient,
    );
    await gateway.handleJoinRoom(
      {
        telegramId: 'teacher-1',
        roomId: 'room-1',
        clientInstanceId: 'same-browser-instance',
      } as any,
      secondClient,
    );

    expect(firstClient.emit).not.toHaveBeenCalledWith(
      'room-session-replaced',
      expect.anything(),
    );
    expect(firstClient.disconnect).toHaveBeenCalledWith(true);
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

  it('performs a bidirectional state-vector handshake', async () => {
    const { gateway } = createGateway();
    const teacher = createClient('socket-teacher');
    await gateway.handleJoinRoom(
      { telegramId: 'teacher-1', roomId: 'room-1' },
      teacher,
    );

    const serverSource = new Y.Doc();
    serverSource.getText('codemirror').insert(0, 'server code');
    await gateway.handleCodeEdit(teacher, {
      telegramId: 'teacher-1',
      roomId: 'room-1',
      update: Y.encodeStateAsUpdate(serverSource),
    });

    const clientDoc = new Y.Doc();
    const response = await gateway.handleCodeSyncInit(
      {
        telegramId: 'teacher-1',
        roomId: 'room-1',
        clientInstanceId: 'browser-1',
        stateVector: Y.encodeStateVector(clientDoc),
      },
      teacher,
    );

    expect(response.ok).toBe(true);
    Y.applyUpdate(clientDoc, response.serverUpdate!);
    expect(clientDoc.getText('codemirror').toString()).toBe('server code');
  });

  it('acknowledges a sequenced update only after the snapshot is persisted', async () => {
    const { gateway, roomService } = createGateway();
    const teacher = createClient('socket-teacher');
    await gateway.handleJoinRoom(
      { telegramId: 'teacher-1', roomId: 'room-1' },
      teacher,
    );

    const source = new Y.Doc();
    source.getText('codemirror').insert(0, 'offline edit');
    let settled = false;
    const responsePromise = gateway
      .handleCodeSyncUpdate(
        {
          telegramId: 'teacher-1',
          roomId: 'room-1',
          clientInstanceId: 'browser-1',
          sequence: 7,
          update: Y.encodeStateAsUpdate(source),
        },
        teacher,
      )
      .then((value) => {
        settled = true;
        return value;
      });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(roomService.saveRoomSnapshot).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1_000);
    await expect(responsePromise).resolves.toEqual({
      ok: true,
      persisted: true,
      sequence: 7,
    });
    expect(roomService.saveRoomSnapshot).toHaveBeenCalledTimes(1);
    expect(teacher.broadcast.to).toHaveBeenCalledTimes(1);
  });

  it('does not rebroadcast a durable update already applied by the fast channel', async () => {
    const { gateway } = createGateway();
    const teacher = createClient('socket-teacher');
    await gateway.handleJoinRoom(
      { telegramId: 'teacher-1', roomId: 'room-1' },
      teacher,
    );
    teacher.broadcast.to.mockClear();

    const source = new Y.Doc();
    source.getText('codemirror').insert(0, 'fast then durable');
    const update = Y.encodeStateAsUpdate(source);
    await gateway.handleCodeEdit(teacher, {
      telegramId: 'teacher-1',
      roomId: 'room-1',
      update,
    });
    expect(teacher.broadcast.to).toHaveBeenCalledTimes(1);

    const response = gateway.handleCodeSyncUpdate(
      {
        telegramId: 'teacher-1',
        roomId: 'room-1',
        clientInstanceId: 'browser-1',
        sequence: 8,
        update,
      },
      teacher,
    );
    await jest.advanceTimersByTimeAsync(1_000);

    await expect(response).resolves.toEqual({
      ok: true,
      persisted: true,
      sequence: 8,
    });
    expect(teacher.broadcast.to).toHaveBeenCalledTimes(1);
  });

  it('does not rebroadcast a fast update already applied by the durable channel', async () => {
    const { gateway } = createGateway();
    const teacher = createClient('socket-teacher');
    await gateway.handleJoinRoom(
      { telegramId: 'teacher-1', roomId: 'room-1' },
      teacher,
    );
    teacher.broadcast.to.mockClear();

    const source = new Y.Doc();
    source.getText('codemirror').insert(0, 'durable then fast');
    const update = Y.encodeStateAsUpdate(source);
    const response = gateway.handleCodeSyncUpdate(
      {
        telegramId: 'teacher-1',
        roomId: 'room-1',
        clientInstanceId: 'browser-1',
        sequence: 9,
        update,
      },
      teacher,
    );
    await Promise.resolve();
    expect(teacher.broadcast.to).toHaveBeenCalledTimes(1);

    await gateway.handleCodeEdit(teacher, {
      telegramId: 'teacher-1',
      roomId: 'room-1',
      update,
    });
    expect(teacher.broadcast.to).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1_000);
    await expect(response).resolves.toEqual({
      ok: true,
      persisted: true,
      sequence: 9,
    });
  });

  it('broadcasts a deletion-only durable update on its first application', async () => {
    const { gateway } = createGateway();
    const teacher = createClient('socket-teacher');
    await gateway.handleJoinRoom(
      { telegramId: 'teacher-1', roomId: 'room-1' },
      teacher,
    );

    const source = new Y.Doc();
    let update = new Uint8Array();
    source.on('update', (value: Uint8Array) => {
      update = new Uint8Array(value);
    });
    source.getText('codemirror').insert(0, 'delete me');
    await gateway.handleCodeEdit(teacher, {
      telegramId: 'teacher-1',
      roomId: 'room-1',
      update,
    });
    teacher.broadcast.to.mockClear();

    source.getText('codemirror').delete(0, source.getText('codemirror').length);
    const response = gateway.handleCodeSyncUpdate(
      {
        telegramId: 'teacher-1',
        roomId: 'room-1',
        clientInstanceId: 'browser-1',
        sequence: 10,
        update,
      },
      teacher,
    );
    await Promise.resolve();

    expect(teacher.broadcast.to).toHaveBeenCalledTimes(1);
    expect(
      teacher.broadcast.to.mock.results.at(-1).value.emit,
    ).toHaveBeenCalledWith(
      'code-edit-action',
      expect.objectContaining({ update }),
    );
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(response).resolves.toEqual({
      ok: true,
      persisted: true,
      sequence: 10,
    });
  });

  it('broadcasts all integrated content when dependent updates arrive out of order', async () => {
    const { gateway } = createGateway();
    const teacher = createClient('socket-teacher');
    await gateway.handleJoinRoom(
      { telegramId: 'teacher-1', roomId: 'room-1' },
      teacher,
    );
    teacher.broadcast.to.mockClear();

    const source = new Y.Doc();
    const updates: Uint8Array[] = [];
    source.on('update', (update: Uint8Array) => {
      updates.push(new Uint8Array(update));
    });
    source.getText('codemirror').insert(0, 'a');
    source.getText('codemirror').insert(1, 'b');

    await gateway.handleCodeEdit(teacher, {
      telegramId: 'teacher-1',
      roomId: 'room-1',
      update: updates[1],
    });
    expect(teacher.broadcast.to).not.toHaveBeenCalled();

    await gateway.handleCodeEdit(teacher, {
      telegramId: 'teacher-1',
      roomId: 'room-1',
      update: updates[0],
    });
    expect(teacher.broadcast.to).toHaveBeenCalledTimes(1);
    const broadcast = teacher.broadcast.to.mock.results[0].value.emit.mock.calls.find(
      ([event]: [string]) => event === 'code-edit-action',
    )![1].update;
    const replica = new Y.Doc();
    Y.applyUpdate(replica, broadcast);
    expect(replica.getText('codemirror').toString()).toBe('ab');
  });

  it('deduplicates a repeated browser sequence including concurrent retries', async () => {
    const { gateway, roomService } = createGateway();
    const teacher = createClient('socket-teacher');
    await gateway.handleJoinRoom(
      { telegramId: 'teacher-1', roomId: 'room-1' },
      teacher,
    );
    const source = new Y.Doc();
    source.getText('codemirror').insert(0, 'one durable update');
    const payload = {
      telegramId: 'teacher-1',
      roomId: 'room-1',
      clientInstanceId: 'browser-1',
      sequence: 9,
      update: Y.encodeStateAsUpdate(source),
    };

    const first = gateway.handleCodeSyncUpdate(payload, teacher);
    const retry = gateway.handleCodeSyncUpdate(payload, teacher);
    await jest.advanceTimersByTimeAsync(1_000);

    await expect(first).resolves.toEqual({
      ok: true,
      persisted: true,
      sequence: 9,
    });
    await expect(retry).resolves.toEqual({
      ok: true,
      persisted: true,
      sequence: 9,
    });
    expect(roomService.saveRoomSnapshot).toHaveBeenCalledTimes(1);
    expect(teacher.broadcast.to).toHaveBeenCalledTimes(1);
  });

  it('does not acknowledge persistence when saving the snapshot fails', async () => {
    const { gateway, roomService } = createGateway();
    const teacher = createClient('socket-teacher');
    roomService.saveRoomSnapshot.mockRejectedValueOnce(new Error('db offline'));
    await gateway.handleJoinRoom(
      { telegramId: 'teacher-1', roomId: 'room-1' },
      teacher,
    );
    const source = new Y.Doc();
    source.getText('codemirror').insert(0, 'not acknowledged');
    const payload = {
      telegramId: 'teacher-1',
      roomId: 'room-1',
      clientInstanceId: 'browser-1',
      sequence: 11,
      update: Y.encodeStateAsUpdate(source),
    };
    const responsePromise = gateway.handleCodeSyncUpdate(payload, teacher);

    await jest.advanceTimersByTimeAsync(1_000);
    await expect(responsePromise).resolves.toEqual({
      ok: false,
      sequence: 11,
      error: 'Не удалось сохранить изменение кода',
    });

    const retryPromise = gateway.handleCodeSyncUpdate(payload, teacher);
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(retryPromise).resolves.toEqual({
      ok: true,
      persisted: true,
      sequence: 11,
    });
  });

  it('times out a stuck snapshot acknowledgement and releases the sequence cache', async () => {
    const { gateway, roomService } = createGateway();
    const teacher = createClient('socket-teacher');
    (gateway as any).SNAPSHOT_ACK_TIMEOUT_MS = 2_000;
    roomService.saveRoomSnapshot.mockImplementationOnce(
      () => new Promise<void>(() => undefined),
    );
    await gateway.handleJoinRoom(
      { telegramId: 'teacher-1', roomId: 'room-1' },
      teacher,
    );
    const source = new Y.Doc();
    source.getText('codemirror').insert(0, 'wait safely');

    const responsePromise = gateway.handleCodeSyncUpdate(
      {
        telegramId: 'teacher-1',
        roomId: 'room-1',
        clientInstanceId: 'browser-stuck',
        sequence: 12,
        update: Y.encodeStateAsUpdate(source),
      },
      teacher,
    );
    await jest.advanceTimersByTimeAsync(2_000);

    await expect(responsePromise).resolves.toEqual({
      ok: false,
      sequence: 12,
      error: 'Не удалось сохранить изменение кода',
    });
    expect((gateway as any).codeSyncRequests.size).toBe(0);
    expect((gateway as any).snapshotWaiters.size).toBe(0);
  });

  it('flushes a newer document version when an edit arrives during a save', async () => {
    const { gateway, roomService } = createGateway();
    const teacher = createClient('socket-teacher');
    let resolveFirstSave!: () => void;
    roomService.saveRoomSnapshot
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirstSave = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    await gateway.handleJoinRoom(
      { telegramId: 'teacher-1', roomId: 'room-1' },
      teacher,
    );

    const firstDoc = new Y.Doc();
    firstDoc.getText('codemirror').insert(0, 'first');
    const first = gateway.handleCodeSyncUpdate(
      {
        telegramId: 'teacher-1',
        roomId: 'room-1',
        clientInstanceId: 'browser-1',
        sequence: 1,
        update: Y.encodeStateAsUpdate(firstDoc),
      },
      teacher,
    );
    await jest.advanceTimersByTimeAsync(1_000);
    expect(roomService.saveRoomSnapshot).toHaveBeenCalledTimes(1);

    const secondDoc = new Y.Doc();
    secondDoc.getText('codemirror').insert(0, 'second');
    const second = gateway.handleCodeSyncUpdate(
      {
        telegramId: 'teacher-1',
        roomId: 'room-1',
        clientInstanceId: 'browser-1',
        sequence: 2,
        update: Y.encodeStateAsUpdate(secondDoc),
      },
      teacher,
    );
    resolveFirstSave();
    await Promise.resolve();
    await Promise.resolve();

    await expect(first).resolves.toEqual(expect.objectContaining({ ok: true }));
    await expect(second).resolves.toEqual(
      expect.objectContaining({ ok: true }),
    );
    expect(roomService.saveRoomSnapshot).toHaveBeenCalledTimes(2);
    expect((gateway as any).snapshotDirtyRooms.has('room-1')).toBe(false);
  });

  it('delivers edits made across a disconnect to a second room participant', async () => {
    const { gateway } = createGateway();
    const student = createClient('socket-student');
    const teacher = createClient('socket-teacher');
    await gateway.handleJoinRoom(
      { telegramId: 'student-1', roomId: 'room-1' },
      student,
    );
    await gateway.handleJoinRoom(
      { telegramId: 'teacher-1', roomId: 'room-1' },
      teacher,
    );

    const studentDoc = new Y.Doc();
    const teacherReplica = new Y.Doc();
    let firstUpdate = new Uint8Array();
    studentDoc.on('update', (update: Uint8Array) => {
      firstUpdate = new Uint8Array(update);
    });
    studentDoc.getText('codemirror').insert(0, 'before ');
    const first = gateway.handleCodeSyncUpdate(
      {
        telegramId: 'student-1',
        roomId: 'room-1',
        clientInstanceId: 'student-browser',
        sequence: 1,
        update: firstUpdate,
      },
      student,
    );
    await jest.advanceTimersByTimeAsync(1_000);
    await first;
    const firstBroadcast = student.broadcast.to.mock.results.at(-1).value.emit;
    Y.applyUpdate(
      teacherReplica,
      firstBroadcast.mock.calls.find(
        ([event]: [string]) => event === 'code-edit-action',
      )![1].update,
    );

    await gateway.handleDisconnect(student);
    let offlineUpdate = new Uint8Array();
    studentDoc.on('update', (update: Uint8Array) => {
      offlineUpdate = new Uint8Array(update);
    });
    studentDoc.getText('codemirror').insert(7, 'offline');
    const reconnectedStudent = createClient('socket-student-new');
    await gateway.handleJoinRoom(
      {
        telegramId: 'student-1',
        roomId: 'room-1',
        clientInstanceId: 'student-browser',
      },
      reconnectedStudent,
    );
    const second = gateway.handleCodeSyncUpdate(
      {
        telegramId: 'student-1',
        roomId: 'room-1',
        clientInstanceId: 'student-browser',
        sequence: 2,
        update: offlineUpdate,
      },
      reconnectedStudent,
    );
    await jest.advanceTimersByTimeAsync(1_000);
    await second;
    const secondBroadcast =
      reconnectedStudent.broadcast.to.mock.results.at(-1).value.emit;
    Y.applyUpdate(
      teacherReplica,
      secondBroadcast.mock.calls.find(
        ([event]: [string]) => event === 'code-edit-action',
      )![1].update,
    );

    expect(teacherReplica.getText('codemirror').toString()).toBe(
      'before offline',
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
    expect(joined.roomService.joinRoom).toHaveBeenCalledWith(
      'room-1',
      'new-student',
    );
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
    expect(client.emit).toHaveBeenCalledWith('edit-room:error', {
      message: 'Недостаточно прав для изменения настроек комнаты',
    });
  });

  it('validates and broadcasts cursor updates', () => {
    const { gateway } = createGateway();
    const client = createClient('socket');
    gateway.handleCursor(client, {
      roomId: 'missing',
      telegramId: 'student',
      position: [1, 2],
      logs: [],
    });
    gateway.activeRooms = [
      {
        ...createRoom(),
        members: [
          {
            telegramId: 'student',
            clientId: 'socket',
            online: true,
            userColor: '#fff',
          },
        ],
      },
    ] as any;
    gateway.handleCursor(client, {
      roomId: 'room-1',
      telegramId: 'student',
      position: [1],
      logs: [],
    });
    gateway.handleCursor(client, {
      roomId: 'room-1',
      telegramId: 'student',
      position: [4, 5],
      logs: [],
    });
    expect(client.broadcast.to).toHaveBeenCalledWith('room-1');
    expect(
      client.broadcast.to.mock.results.at(-1).value.emit,
    ).toHaveBeenCalledWith(
      'cursor-action',
      expect.objectContaining({ position: [4, 5], userColor: '#fff' }),
    );
  });

  it('tracks caret, range and cleared selections', () => {
    const { gateway } = createGateway();
    const client = createClient('socket');
    const member: any = {
      telegramId: 'student',
      clientId: 'socket',
      online: true,
      userColor: '#fff',
    };
    gateway.activeRooms = [{ ...createRoom(), members: [member] }] as any;
    gateway.handleSelection(client, {
      roomId: 'room-1',
      telegramId: 'student',
      line: 2,
      column: 3,
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
      roomId: 'room-1',
      telegramId: 'student',
      clearSelection: true,
    });
    expect(member.lastSelection).toEqual({});
  });

  it('enforces code edit permissions and broadcasts accepted updates', async () => {
    const { gateway } = createGateway(
      createRoom({
        studentEditCodeEnabled: false,
        students: ['student'],
      }),
    );
    const client = createClient('socket');
    await gateway.handleJoinRoom(
      { roomId: 'room-1', telegramId: 'student' },
      client,
    );
    const source = new Y.Doc();
    source.getText('codemirror').insert(0, 'allowed edit');
    const update = Y.encodeStateAsUpdate(source);
    await gateway.handleCodeEdit(client, {
      roomId: 'room-1',
      telegramId: 'student',
      update,
    });
    expect(client.emit).toHaveBeenCalledWith('error', {
      message: 'Редактирование кода отключено в этой комнате',
    });
    gateway.activeRooms[0].studentEditCodeEnabled = true;
    await gateway.handleCodeEdit(client, {
      roomId: 'room-1',
      telegramId: 'student',
      update,
    });
    expect(
      client.broadcast.to.mock.results.at(-1).value.emit,
    ).toHaveBeenCalledWith(
      'code-edit-action',
      expect.objectContaining({ telegramId: 'student', update }),
    );
  });

  it('rejects invalid sync payloads without exposing an internal error', async () => {
    const { gateway } = createGateway();
    const client = createClient('socket-invalid');
    await gateway.handleJoinRoom(
      { roomId: 'room-1', telegramId: 'teacher-1' },
      client,
    );

    await expect(
      gateway.handleCodeSyncInit(
        {
          roomId: 'room-1',
          telegramId: 'teacher-1',
          clientInstanceId: 'browser-1',
          stateVector: { invalid: true } as any,
        },
        client,
      ),
    ).resolves.toEqual({
      ok: false,
      error: 'Не удалось синхронизировать код',
    });
  });

  it('rejects a sequenced update from a socket replaced by a newer join', async () => {
    const { gateway, roomService } = createGateway();
    const oldClient = createClient('socket-old');
    const currentClient = createClient('socket-current');
    await gateway.handleJoinRoom(
      { roomId: 'room-1', telegramId: 'teacher-1', clientInstanceId: 'old' },
      oldClient,
    );
    await gateway.handleJoinRoom(
      { roomId: 'room-1', telegramId: 'teacher-1', clientInstanceId: 'new' },
      currentClient,
    );
    const source = new Y.Doc();
    source.getText('codemirror').insert(0, 'must not apply');

    await expect(
      gateway.handleCodeSyncUpdate(
        {
          roomId: 'room-1',
          telegramId: 'teacher-1',
          clientInstanceId: 'old-session',
          sequence: 1,
          update: Y.encodeStateAsUpdate(source),
        },
        oldClient,
      ),
    ).resolves.toEqual({
      ok: false,
      sequence: 1,
      error: 'Сессия комнаты устарела',
    });
    expect(roomService.saveRoomSnapshot).not.toHaveBeenCalled();

    oldClient.emit.mockClear();
    await gateway.handleCodeEdit(oldClient, {
      roomId: 'room-1',
      telegramId: 'teacher-1',
      update: Y.encodeStateAsUpdate(source),
    });
    expect(oldClient.emit).toHaveBeenCalledWith('error', {
      message: 'Сессия комнаты устарела',
    });
    expect(roomService.saveRoomSnapshot).not.toHaveBeenCalled();
  });

  it('rejects sequenced updates outside an editable active room', async () => {
    const { gateway } = createGateway();
    const client = createClient('socket');
    const payload = {
      roomId: 'room-1',
      telegramId: 'student',
      clientInstanceId: 'browser-1',
      sequence: 1,
      update: new Uint8Array([0]),
    };

    await expect(
      gateway.handleCodeSyncUpdate(payload, client),
    ).resolves.toEqual({
      ok: false,
      sequence: 1,
      error: 'Комната не найдена',
    });

    gateway.activeRooms = [
      {
        ...createRoom({ completed: true }),
        members: [{ telegramId: 'student', clientId: 'socket', online: true }],
      },
    ] as any;
    await expect(
      gateway.handleCodeSyncUpdate(payload, client),
    ).resolves.toEqual({
      ok: false,
      sequence: 1,
      error: 'Комната завершена',
    });

    gateway.activeRooms[0].completed = false;
    gateway.activeRooms[0].studentEditCodeEnabled = false;
    await expect(
      gateway.handleCodeSyncUpdate(payload, client),
    ).resolves.toEqual({
      ok: false,
      sequence: 1,
      error: 'Редактирование кода отключено в этой комнате',
    });
  });

  it('allows a member or teacher to rename a room member', () => {
    const { gateway, roomService, roomEmit } = createGateway();
    const client = createClient('socket');
    gateway.activeRooms = [
      {
        ...createRoom(),
        members: [{ telegramId: 'student', clientId: 'socket', online: true }],
      },
    ] as any;
    gateway.handleEditMember(client, {
      roomId: 'room-1',
      telegramId: 'teacher-1',
      changeTelegramId: 'student',
      username: 'Alice',
    });
    expect(roomService.upsertRoomMember).toHaveBeenCalledWith(
      'room-1',
      'student',
      'Alice',
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
      telegramId: 'teacher-1',
      roomId: 'room-1',
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
    const encoded = Buffer.from(Y.encodeStateAsUpdate(source)).toString(
      'base64',
    );
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
