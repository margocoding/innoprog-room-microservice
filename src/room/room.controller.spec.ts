import { Test, TestingModule } from '@nestjs/testing';
import { AppService } from 'src/app.service';
import { RoomService } from './room.service';
import { RoomController } from './room.controller';
import { AuthRoomGuard } from './auth-room.guard';

describe('RoomController', () => {
  let controller: RoomController;
  let roomService: { getRoom: jest.Mock; createRoom: jest.Mock; deleteRoom: jest.Mock; getRooms: jest.Mock };
  let appService: {
    createAnonymousRoomUserId: jest.Mock;
    createRoomToken: jest.Mock;
    createRoomLaunchCode: jest.Mock;
    consumeRoomLaunchCode: jest.Mock;
    createRoomBrowserSession: jest.Mock;
    getRoomSessionCookieName: jest.Mock;
    verifyRoomBrowserSession: jest.Mock;
    verifyRoomToken: jest.Mock;
  };
  let response: { cookie: jest.Mock; clearCookie: jest.Mock };

  beforeEach(async () => {
    roomService = {
      getRoom: jest.fn().mockResolvedValue({ id: 'room-1', teacher: 'teacher-1' }),
      createRoom: jest.fn().mockResolvedValue({ id: 'room-1', teacher: 'teacher-1' }),
      deleteRoom: jest.fn().mockResolvedValue({ success: true }),
      getRooms: jest.fn().mockResolvedValue({ rooms: [], total: 0 }),
    };
    appService = {
      createAnonymousRoomUserId: jest.fn(() => 'i999999'),
      createRoomToken: jest.fn((roomId: string, telegramId: string) => {
        return `token-${roomId}-${telegramId}`;
      }),
      createRoomLaunchCode: jest.fn().mockResolvedValue('one-time-launch-code-123456'),
      consumeRoomLaunchCode: jest.fn().mockResolvedValue({ roomId: 'room-1', userId: 'teacher-1' }),
      createRoomBrowserSession: jest.fn(() => 'browser-session-token'),
      getRoomSessionCookieName: jest.fn(() => 'ide_room_session_hash'),
      verifyRoomBrowserSession: jest.fn(),
      verifyRoomToken: jest.fn(),
    };
    response = { cookie: jest.fn(), clearCookie: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RoomController],
      providers: [
        {
          provide: RoomService,
          useValue: roomService,
        },
        {
          provide: AppService,
          useValue: appService,
        },
      ],
    }).compile();

    controller = module.get<RoomController>(RoomController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('rejects global room enumeration using a chosen guest identifier', async () => {
    appService.verifyRoomToken.mockReturnValue({ roomId: 'room-1', userId: 'i123456' });
    await expect(controller.getRooms('i123456', {} as any, { headers: { 'x-room-token': 'signed' } } as any)).rejects.toMatchObject({ status: 403 });
    expect(roomService.getRooms).not.toHaveBeenCalled();
    expect(roomService.getRoom).not.toHaveBeenCalled();
  });

  it('blocks discovery through an actual signed guest token and ignores chosen guest ids', async () => {
    const previousSecret = process.env.ROOM_TOKEN_SECRET;
    process.env.ROOM_TOKEN_SECRET = 'test-only-room-discovery-secret';
    try {
      const realService = new AppService();
      const actualController = new RoomController(roomService as any, realService);
      const session = await actualController.createAnonymousRoomToken(
        'room-1', { telegramId: 'i123456' }, { headers: {} } as any, response as any,
      );
      expect(session.telegramId).not.toBe('i123456');
      const request = { headers: { 'x-room-token': session.roomToken }, params: { telegramId: session.telegramId }, query: {}, body: {} };
      const guard = new AuthRoomGuard(realService);
      expect(await guard.canActivate({ getType: () => 'http', switchToHttp: () => ({ getRequest: () => request }) } as any)).toBe(true);
      await expect(actualController.getRooms(request.params.telegramId, {} as any, request as any)).rejects.toMatchObject({ status: 403 });
      expect(roomService.getRooms).not.toHaveBeenCalled();
    } finally {
      if (previousSecret === undefined) delete process.env.ROOM_TOKEN_SECRET;
      else process.env.ROOM_TOKEN_SECRET = previousSecret;
    }
  });

  it('permits a verified current room teacher to list their rooms', async () => {
    appService.verifyRoomToken.mockReturnValue({ roomId: 'room-1', userId: '123' });
    roomService.getRoom.mockResolvedValue({ id: 'room-1', teacher: '123' });
    await expect(controller.getRooms('123', {} as any, { headers: { 'x-room-token': 'signed' } } as any)).resolves.toEqual({ rooms: [], total: 0 });
    expect(roomService.getRooms).toHaveBeenCalledWith('123', {});
  });

  it.each([null, { teacher: '456' }])('rejects listing after room deletion or teacher mismatch %j', async (room) => {
    appService.verifyRoomToken.mockReturnValue({ roomId: 'room-1', userId: '123' });
    roomService.getRoom.mockResolvedValue(room);
    await expect(controller.getRooms('123', {} as any, { headers: { 'x-room-token': 'signed' } } as any)).rejects.toMatchObject({ status: 403 });
    expect(roomService.getRooms).not.toHaveBeenCalled();
  });

  it('rejects execution capability without a verified signed token before looking up a room', async () => {
    await expect(controller.executionAccess('room-1', { headers: {} } as any)).rejects.toMatchObject({ status: 403 });
    expect(roomService.getRoom).not.toHaveBeenCalled();
  });

  it.each(['teacher-1', 'i123'])('preserves execution access for verified room member %s', async (userId) => {
    appService.verifyRoomToken.mockReturnValue({ roomId: 'room-1', userId });
    roomService.getRoom.mockResolvedValue({ teacher: 'teacher-1', students: ['i123'], completed: true });
    await expect(controller.executionAccess('room-1', { headers: { 'x-room-token': 'signed' } } as any)).resolves.toEqual({ ok: true });
    expect(appService.verifyRoomToken).toHaveBeenCalledWith('signed', 'room-1');
  });

  it('rejects removed rooms and users who have not joined the room', async () => {
    appService.verifyRoomToken.mockReturnValue({ roomId: 'room-1', userId: 'i999' });
    roomService.getRoom.mockResolvedValue({ teacher: 'teacher-1', students: ['i123'] });
    await expect(controller.executionAccess('room-1', { headers: { 'x-room-token': 'signed' } } as any)).rejects.toMatchObject({ status: 403 });
    roomService.getRoom.mockResolvedValue(null);
    await expect(controller.executionAccess('room-1', { headers: { 'x-room-token': 'signed' } } as any)).rejects.toMatchObject({ status: 403 });
  });

  it('returns a one-time launch code when creating a teacher room', async () => {
    const result = await controller.createRoom({ telegramId: 'teacher-1' } as any);

    expect(result.roomLaunchCode).toBe('one-time-launch-code-123456');
    expect(appService.createRoomLaunchCode).toHaveBeenCalledWith('room-1', 'teacher-1');
  });

  it('rolls back a room and returns 503 when the launch-code store is unavailable', async () => {
    appService.createRoomLaunchCode.mockRejectedValue(new Error('Redis unavailable'));

    await expect(
      controller.createRoom({ telegramId: 'teacher-1' } as any),
    ).rejects.toMatchObject({ status: 503 });

    expect(roomService.deleteRoom).toHaveBeenCalledWith('room-1', 'teacher-1');
  });

  it('exchanges a one-time launch code for an in-memory room token', async () => {
    const result = await controller.exchangeRoomLaunchCode('room-1', {
      launchCode: 'one-time-launch-code-123456',
      browserNonce: 'browser-nonce-123456',
    }, { headers: {} } as any, response as any);

    expect(result).toEqual({ telegramId: 'teacher-1', roomToken: 'token-room-1-teacher-1' });
    expect(appService.consumeRoomLaunchCode).toHaveBeenCalledWith(
      'one-time-launch-code-123456',
      'room-1',
      'browser-nonce-123456',
    );
    expect(response.cookie).toHaveBeenCalledWith(
      'ide_room_session_hash',
      'browser-session-token',
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/api/room/room-1',
      }),
    );
  });

  it('returns the same teacher identity when the same browser retries redemption', async () => {
    appService.consumeRoomLaunchCode.mockResolvedValue({
      roomId: 'room-1',
      userId: 'teacher-1',
    });

    const result = await controller.exchangeRoomLaunchCode(
      'room-1',
      {
        launchCode: 'already-consumed-code',
        browserNonce: 'browser-nonce-123456',
      },
      { headers: {} } as any,
      response as any,
    );

    expect(appService.consumeRoomLaunchCode).toHaveBeenCalledWith(
      'already-consumed-code',
      'room-1',
      'browser-nonce-123456',
    );
    expect(result).toEqual({
      telegramId: 'teacher-1',
      roomToken: 'token-room-1-teacher-1',
    });
  });

  it('rejects a launch code redeemed by another browser nonce', async () => {
    appService.consumeRoomLaunchCode.mockResolvedValue(undefined);

    await expect(
      controller.exchangeRoomLaunchCode(
        'room-1',
        {
          launchCode: 'missing-code',
          browserNonce: 'different-browser-nonce',
        },
        { headers: {} } as any,
        response as any,
      ),
    ).rejects.toMatchObject({ status: 404 });

    expect(appService.createRoomToken).not.toHaveBeenCalled();
  });

  it('ignores unverified stored anonymous identity when issuing a new token', async () => {
    const result = await controller.createAnonymousRoomToken('room-1', {
      telegramId: 'i123456',
    }, { headers: {} } as any, response as any);

    expect(result).toEqual({
      telegramId: 'i999999',
      roomToken: 'token-room-1-i999999',
    });
    expect(appService.createAnonymousRoomUserId).toHaveBeenCalled();
    expect(appService.createRoomToken).toHaveBeenCalledWith('room-1', 'i999999');
  });

  it('creates an anonymous room user id when the client has no saved id', async () => {
    const result = await controller.createAnonymousRoomToken(
      'room-1',
      {},
      { headers: {} } as any,
      response as any,
    );

    expect(result).toEqual({
      telegramId: 'i999999',
      roomToken: 'token-room-1-i999999',
    });
    expect(appService.createAnonymousRoomUserId).toHaveBeenCalledTimes(1);
    expect(appService.createRoomToken).toHaveBeenCalledWith('room-1', 'i999999');
  });

  it('restores the teacher identity from the protected room cookie', async () => {
    appService.verifyRoomBrowserSession.mockReturnValue({
      roomId: 'room-1',
      userId: 'teacher-1',
      exp: 9999999999,
    });

    const result = await controller.createAnonymousRoomToken(
      'room-1',
      {},
      { headers: { cookie: 'ide_room_session_hash=browser-session-token' } } as any,
      response as any,
    );

    expect(result).toEqual({
      telegramId: 'teacher-1',
      roomToken: 'token-room-1-teacher-1',
    });
    expect(appService.verifyRoomBrowserSession).toHaveBeenCalledWith(
      'browser-session-token',
      'room-1',
    );
    expect(appService.createAnonymousRoomUserId).not.toHaveBeenCalled();
  });

  it('expires accumulated root-scoped room cookies during launch exchange', async () => {
    await controller.exchangeRoomLaunchCode(
      'room-1',
      {
        launchCode: 'one-time-launch-code-123456',
        browserNonce: 'browser-nonce-123456',
      },
      {
        headers: {
          cookie: [
            'ide_room_session_0123456789abcdefabcd=old-one',
            'unrelated=value',
            'ide_room_session_fedcba9876543210abcd=old-two',
          ].join('; '),
        },
      } as any,
      response as any,
    );

    expect(response.clearCookie).toHaveBeenCalledTimes(2);
    expect(response.clearCookie).toHaveBeenCalledWith(
      'ide_room_session_0123456789abcdefabcd',
      expect.objectContaining({ path: '/', httpOnly: true, secure: true }),
    );
    expect(response.clearCookie).not.toHaveBeenCalledWith(
      'unrelated',
      expect.anything(),
    );
  });
});
