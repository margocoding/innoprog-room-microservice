import { Test, TestingModule } from '@nestjs/testing';
import { AppService } from 'src/app.service';
import { RoomService } from './room.service';
import { RoomController } from './room.controller';

describe('RoomController', () => {
  let controller: RoomController;
  let roomService: { getRoom: jest.Mock; createRoom: jest.Mock };
  let appService: {
    createAnonymousRoomUserId: jest.Mock;
    createRoomToken: jest.Mock;
    createRoomLaunchCode: jest.Mock;
    consumeRoomLaunchCode: jest.Mock;
    createRoomBrowserSession: jest.Mock;
    getRoomSessionCookieName: jest.Mock;
    verifyRoomBrowserSession: jest.Mock;
  };
  let response: { cookie: jest.Mock };

  beforeEach(async () => {
    roomService = {
      getRoom: jest.fn().mockResolvedValue({ id: 'room-1', teacher: 'teacher-1' }),
      createRoom: jest.fn().mockResolvedValue({ id: 'room-1', teacher: 'teacher-1' }),
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
    response = { cookie: jest.fn() };

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

  it('exchanges a one-time launch code for an in-memory room token', async () => {
    const result = await controller.exchangeRoomLaunchCode('room-1', {
      launchCode: 'one-time-launch-code-123456',
    }, response as any);

    expect(result).toEqual({ telegramId: 'teacher-1', roomToken: 'token-room-1-teacher-1' });
    expect(appService.consumeRoomLaunchCode).toHaveBeenCalledWith(
      'one-time-launch-code-123456',
      'room-1',
    );
    expect(response.cookie).toHaveBeenCalledWith(
      'ide_room_session_hash',
      'browser-session-token',
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
      }),
    );
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
});
