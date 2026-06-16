import { ExecutionContext } from '@nestjs/common';
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

describe('AuthRoomGuard', () => {
  it('accepts already decrypted numeric ids for websocket events', async () => {
    const appService = { decryptTelegramId: jest.fn() };
    const guard = new AuthRoomGuard(appService as any);
    const data = { telegramId: '429272623' };

    const result = await guard.canActivate(createWsContext(data));

    expect(result).toBe(true);
    expect(data.telegramId).toBe('429272623');
    expect(appService.decryptTelegramId).not.toHaveBeenCalled();
  });

  it('decrypts encrypted websocket ids from room links', async () => {
    const appService = { decryptTelegramId: jest.fn(() => '429272623') };
    const guard = new AuthRoomGuard(appService as any);
    const data = { telegramId: 'encrypted-token' };

    const result = await guard.canActivate(createWsContext(data));

    expect(result).toBe(true);
    expect(data.telegramId).toBe('429272623');
    expect(appService.decryptTelegramId).toHaveBeenCalledWith('encrypted-token');
  });

  it('uses encrypted referer id over a generated websocket id', async () => {
    const appService = { decryptTelegramId: jest.fn(() => '429272623') };
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
    const appService = { decryptTelegramId: jest.fn() };
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
});
