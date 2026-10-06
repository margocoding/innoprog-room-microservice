import { AuthRoomCreateGuard } from './auth-room-create.guard';
import { AppService } from 'src/app.service';

describe('AuthRoomCreateGuard', () => {
  const context = (request: any) => ({ switchToHttp: () => ({ getRequest: () => request }) }) as any;

  it.each(['123456789', 'i123', 'legacy-encrypted-id'])('rejects unsigned creator %s even with room credentials', async (telegramId) => {
    const app = { verifyRoomCreation: jest.fn(), decryptTelegramId: jest.fn() };
    const guard = new AuthRoomCreateGuard(app as any);
    await expect(guard.canActivate(context({ headers: { 'x-room-token': 'signed-guest' }, body: { telegramId } }))).rejects.toMatchObject({ status: 403 });
    expect(app.verifyRoomCreation).not.toHaveBeenCalled();
  });

  it('allows verified bot/API creation and binds creator to encrypted transport body', async () => {
    const app = { verifyRoomCreation: jest.fn().mockResolvedValue(true), decryptTelegramId: jest.fn().mockReturnValue('123456789') };
    const request = { headers: { 'x-room-create-authorization': 'signed-create' }, rawBody: Buffer.from('{}'), body: { telegramId: 'encrypted-id' } };
    await expect(new AuthRoomCreateGuard(app as any).canActivate(context(request))).resolves.toBe(true);
    expect(request.body.telegramId).toBe('123456789');
    expect(app.verifyRoomCreation).toHaveBeenCalledWith(request.rawBody, 'signed-create');
  });

  it('fails closed on Redis outages and rejected signatures', async () => {
    const app = { verifyRoomCreation: jest.fn().mockResolvedValue(false), decryptTelegramId: jest.fn() };
    const request = { headers: { 'x-room-create-authorization': 'signed-create' }, rawBody: Buffer.from('{}'), body: {} };
    const guard = new AuthRoomCreateGuard(app as any);
    await expect(guard.canActivate(context(request))).rejects.toMatchObject({ status: 403 });
    app.verifyRoomCreation.mockRejectedValue(new Error('Redis unavailable'));
    await expect(guard.canActivate(context(request))).rejects.toMatchObject({ status: 503 });
    expect(app.decryptTelegramId).not.toHaveBeenCalled();
  });
});
