import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { RoomLaunchCodeStore } from '../room-launch-code.store';
let redisAvailable = true;
try {
  execFileSync('redis-server', ['--version'], { stdio: 'ignore' });
} catch {
  redisAvailable = false;
}
(redisAvailable ? it : it.skip)(
  'shares atomic guest budgets and bounds new room keys using a real local Redis',
  async () => {
    const listener = createServer();
    const port = await new Promise<number>((resolve) =>
      listener.listen(0, '127.0.0.1', () =>
        resolve((listener.address() as any).port),
      ),
    );
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const child = spawn(
      'redis-server',
      [
        '--bind',
        '127.0.0.1',
        '--port',
        String(port),
        '--save',
        '',
        '--appendonly',
        'no',
      ],
      { stdio: 'ignore' },
    );
    const previous = process.env.IDE_ROOMS_REDIS_URL;
    process.env.IDE_ROOMS_REDIS_URL = `redis://127.0.0.1:${port}`;
    const store = new RoomLaunchCodeStore();
    const cli = (...args: string[]) =>
      execFileSync(
        'redis-cli',
        ['-h', '127.0.0.1', '-p', String(port), '--raw', ...args],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
    try {
      for (let i = 0; i < 100; i++) {
        try {
          if (cli('PING') === 'PONG') break;
        } catch {}
        await new Promise((r) => setTimeout(r, 10));
      }
      for (let i = 0; i < 12; i++)
        expect(await store.admitGuestToken('one')).toBe(true);
      expect(await store.admitGuestToken('one')).toBe(false);
      expect(await store.admitGuestToken('other')).toBe(true);
      for (let i = 0; i < 107; i++)
        expect(await store.admitGuestToken(`room-${i}`)).toBe(true);
      expect(await store.admitGuestToken('rotated')).toBe(false);
      expect(cli('EXISTS', 'innoprog:ide-room:guest:rotated')).toBe('0');
      expect(
        Number(cli('TTL', 'innoprog:ide-room:guest:global')),
      ).toBeGreaterThan(0);
    } finally {
      await store.onModuleDestroy();
      child.kill();
      if (previous === undefined) delete process.env.IDE_ROOMS_REDIS_URL;
      else process.env.IDE_ROOMS_REDIS_URL = previous;
    }
  },
  10000,
);
