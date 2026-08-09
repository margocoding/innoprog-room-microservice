import { Test, TestingModule } from '@nestjs/testing';
import { AppService } from 'src/app.service';
import { RoomService } from './room.service';
import { RoomController } from './room.controller';

describe('RoomController', () => {
  let controller: RoomController;
  let roomService: { getRoom: jest.Mock; createRoom: jest.Mock; deleteRoom: jest.Mock };
  let appService: {
    createAnonymousRoomUserId: jest.Mock;
    createRoomToken: jest.Mock;
    createRoomLaunchCode: jest.Mock;
    consumeRoomLaunchCode: jest.Mock;
    createRoomBrowserSession: jest.Mock;
    getRoomSessionCookieName: jest.Mock;
    verifyRoomBrowserSession: jest.Mock;
  };
  let response: { cookie: jest.Mock; clearCookie: jest.Mock };

  beforeEach(async () => {
    roomService = {
      getRoom: jest.fn().mockResolvedValue({ id: 'room-1', teacher: 'teacher-1' }),
      createRoom: jest.fn().mockResolvedValue({ id: 'room-1', teacher: 'teacher-1' }),
      deleteRoom: jest.fn().mockResolvedValue({ success: true }),
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

  it('reuses a saved anonymous room user id when issuing a new token', async () => {
    const result = await controller.createAnonymousRoomToken('room-1', {
      telegramId: 'i123456',
    }, { headers: {} } as any, response as any);

    expect(result).toEqual({
      telegramId: 'i123456',
      roomToken: 'token-room-1-i123456',
    });
    expect(appService.createAnonymousRoomUserId).not.toHaveBeenCalled();
    expect(appService.createRoomToken).toHaveBeenCalledWith('room-1', 'i123456');
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
