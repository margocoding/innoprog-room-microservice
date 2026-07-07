import { Test, TestingModule } from '@nestjs/testing';
import { AppService } from 'src/app.service';
import { RoomService } from './room.service';
import { RoomController } from './room.controller';

describe('RoomController', () => {
  let controller: RoomController;
  let roomService: { getRoom: jest.Mock };
  let appService: {
    createAnonymousRoomUserId: jest.Mock;
    createRoomToken: jest.Mock;
  };

  beforeEach(async () => {
    roomService = {
      getRoom: jest.fn().mockResolvedValue({ id: 'room-1', teacher: 'teacher-1' }),
    };
    appService = {
      createAnonymousRoomUserId: jest.fn(() => 'i999999'),
      createRoomToken: jest.fn((roomId: string, telegramId: string) => {
        return `token-${roomId}-${telegramId}`;
      }),
    };

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

  it('reuses a saved anonymous room user id when issuing a new token', async () => {
    const result = await controller.createAnonymousRoomToken('room-1', {
      telegramId: 'i123456',
    });

    expect(result).toEqual({
      telegramId: 'i123456',
      roomToken: 'token-room-1-i123456',
    });
    expect(appService.createAnonymousRoomUserId).not.toHaveBeenCalled();
    expect(appService.createRoomToken).toHaveBeenCalledWith('room-1', 'i123456');
  });

  it('creates an anonymous room user id when the client has no saved id', async () => {
    const result = await controller.createAnonymousRoomToken('room-1', {});

    expect(result).toEqual({
      telegramId: 'i999999',
      roomToken: 'token-room-1-i999999',
    });
    expect(appService.createAnonymousRoomUserId).toHaveBeenCalledTimes(1);
    expect(appService.createRoomToken).toHaveBeenCalledWith('room-1', 'i999999');
  });
});
