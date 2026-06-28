import { ExecutionContext } from '@nestjs/common';
import { AppService } from 'src/app.service';
import { AuthRoomGuard } from './auth-room.guard';

const createWsContext = (
  data: Record<string, unknown>,
  headers: Record<string, string> = {},
  clientOverrides: Record<string, unknown> = {},
) =>
  ({
    getType: () => 'ws',
    switchToWs: () => ({
      getData: () => data,
      getClient: () => ({
        handshake: { headers },
        emit: jest.fn(),
        ...clientOverrides,
      }),
    }),
  }) as unknown as ExecutionContext;

const createHttpContext = (request: Record<string, any>) =>
  ({
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  }) as unknown as ExecutionContext;

const createAppServiceMock = (overrides: Record<string, unknown> = {}) => ({
  decryptTelegramId: jest.fn(),
  isRoomTokenRequired: jest.fn(() => false),
  isLegacyRoomIdAuthAllowed: jest.fn(() => true),
  verifyRoomToken: jest.fn(),
  ...overrides,
});

describe('AuthRoomGuard', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('accepts already decrypted numeric ids for websocket events', async () => {
    const appService = createAppServiceMock();
    const guard = new AuthRoomGuard(appService as any);
    const data = { telegramId: '429272623' };

    const result = await guard.canActivate(createWsContext(data));

    expect(result).toBe(true);
    expect(data.telegramId).toBe('429272623');
    expect(appService.decryptTelegramId).not.toHaveBeenCalled();
  });

  it('decrypts encrypted websocket ids from room links', async () => {
    const appService = createAppServiceMock({
      decryptTelegramId: jest.fn(() => '429272623'),
    });
    const guard = new AuthRoomGuard(appService as any);
    const data = { telegramId: 'encrypted-token' };

    const result = await guard.canActivate(createWsContext(data));

    expect(result).toBe(true);
    expect(data.telegramId).toBe('429272623');
    expect(appService.decryptTelegramId).toHaveBeenCalledWith('encrypted-token');
  });

  it('uses encrypted referer id over a generated websocket id', async () => {
    const appService = createAppServiceMock({
      decryptTelegramId: jest.fn(() => '429272623'),
    });
    const guard = new AuthRoomGuard(appService as any);
    const data = { telegramId: 'i123456' };

    const result = await guard.canActivate(
      createWsContext(data, {
        referer:
          'https://ide.innoprog.ru/?roomId=room-1&telegramId=encrypted-token',
      }),
    );

    expect(result).toBe(true);
    expect(data.telegramId).toBe('429272623');
    expect(appService.decryptTelegramId).toHaveBeenCalledWith('encrypted-token');
  });

  it('accepts already decrypted numeric ids for http requests', async () => {
    const appService = createAppServiceMock();
    const guard = new AuthRoomGuard(appService as any);
    const request = {
      query: { telegramId: '429272623' },
      params: {},
      body: {},
    };

    const result = await guard.canActivate(createHttpContext(request));

    expect(result).toBe(true);
    expect(request.query.telegramId).toBe('429272623');
    expect(appService.decryptTelegramId).not.toHaveBeenCalled();
  });

  it('rejects room websocket access without token when strict mode is enabled', async () => {
    const appService = createAppServiceMock({
      isRoomTokenRequired: jest.fn(() => true),
    });
    const guard = new AuthRoomGuard(appService as any);
    const clientEmit = jest.fn();

    const result = await guard.canActivate(
      createWsContext(
        { telegramId: '429272623', roomId: 'room-1' },
        {},
        { emit: clientEmit },
      ),
    );

    expect(result).toBe(false);
    expect(clientEmit).toHaveBeenCalledWith('join-room:error', {
      message: 'Неверная ссылка. Пожалуйста, обратитесь к администратору',
    });
  });

  it('accepts signed room token and rewrites websocket telegram id from payload', async () => {
    process.env.ROOM_TOKEN_SECRET = 'room-token-secret';
    const appService = new AppService();
    const guard = new AuthRoomGuard(appService);
    const roomToken = appService.createRoomToken('room-1', '-1001234567890');
    const data = {
      telegramId: '429272623',
      roomId: 'room-1',
      roomToken,
    };
    const client: any = { data: {}, emit: jest.fn() };

    const result = await guard.canActivate(createWsContext(data, {}, client));

    expect(result).toBe(true);
    expect(data.telegramId).toBe('-1001234567890');
    expect(client.data.roomAuth).toMatchObject({
      roomId: 'room-1',
      userId: '-1001234567890',
    });
  });

  it('allows subsequent websocket events only for the verified socket identity', async () => {
    const appService = createAppServiceMock({
      isRoomTokenRequired: jest.fn(() => true),
    });
    const guard = new AuthRoomGuard(appService as any);
    const client: any = {
      data: {
        roomAuth: {
          roomId: 'room-1',
          userId: '429272623',
          exp: Math.floor(Date.now() / 1000) + 60,
        },
      },
      emit: jest.fn(),
    };
    const data = { telegramId: '111', roomId: 'room-1' };

    const result = await guard.canActivate(createWsContext(data, {}, client));

    expect(result).toBe(false);
  });
});
