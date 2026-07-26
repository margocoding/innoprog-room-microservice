import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports liveness without touching dependencies', () => {
    const prisma = { $queryRawUnsafe: jest.fn() };
    const launchCodes = { ping: jest.fn() };
    const controller = new HealthController(prisma as any, launchCodes as any);

    expect(controller.live()).toEqual({ ok: true });
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(launchCodes.ping).not.toHaveBeenCalled();
  });

  it('reports readiness only when PostgreSQL and Redis respond', async () => {
    const prisma = { $queryRawUnsafe: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const launchCodes = { ping: jest.fn().mockResolvedValue(true) };
    const controller = new HealthController(prisma as any, launchCodes as any);

    await expect(controller.ready()).resolves.toEqual({ ok: true });
  });

  it.each(['postgres', 'redis'])('returns 503 when %s is unavailable', async (dependency) => {
    const prisma = {
      $queryRawUnsafe: jest.fn().mockImplementation(() =>
        dependency === 'postgres' ? Promise.reject(new Error('offline')) : Promise.resolve([]),
      ),
    };
    const launchCodes = {
      ping: jest.fn().mockImplementation(() =>
        dependency === 'redis' ? Promise.reject(new Error('offline')) : Promise.resolve(true),
      ),
    };
    const controller = new HealthController(prisma as any, launchCodes as any);

    await expect(controller.ready()).rejects.toMatchObject({ status: 503 });
  });
});
