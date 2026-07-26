import { createClient } from 'redis';
import { RoomLaunchCodeStore } from './room-launch-code.store';

jest.mock('redis', () => ({
  createClient: jest.fn(),
}));

describe('RoomLaunchCodeStore', () => {
  const client = {
    isOpen: false,
    connect: jest.fn(),
    on: jest.fn(),
    set: jest.fn(),
    eval: jest.fn(),
    ping: jest.fn(),
    sendCommand: jest.fn(),
    quit: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    client.isOpen = false;
    client.connect.mockImplementation(async () => {
      client.isOpen = true;
    });
    client.set.mockResolvedValue('OK');
    client.quit.mockImplementation(async () => {
      client.isOpen = false;
    });
    (createClient as jest.Mock).mockReturnValue(client);
  });

  it('lets the same browser safely retry a redeemed launch code', async () => {
    client.eval
      .mockResolvedValueOnce(JSON.stringify({ roomId: 'room-1', userId: 'teacher-1' }))
      .mockResolvedValueOnce(JSON.stringify({ roomId: 'room-1', userId: 'teacher-1' }));
    const store = new RoomLaunchCodeStore();

    const code = await store.create({ roomId: 'room-1', userId: 'teacher-1' });
    await expect(store.consume(code, 'room-1', 'browser-nonce-123456')).resolves.toEqual({
      roomId: 'room-1',
      userId: 'teacher-1',
    });
    await expect(store.consume(code, 'room-1', 'browser-nonce-123456')).resolves.toEqual({
      roomId: 'room-1',
      userId: 'teacher-1',
    });

    expect(client.set).toHaveBeenCalledWith(
      `innoprog:ide-room:launch:${code}`,
      JSON.stringify({
        status: 'pending',
        roomId: 'room-1',
        userId: 'teacher-1',
      }),
      { EX: 60, NX: true },
    );
    expect(client.eval).toHaveBeenCalledTimes(2);
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      socket: {
        connectTimeout: 1000,
        reconnectStrategy: false,
      },
    }));
  });

  it('rejects a code for another room after atomically consuming it', async () => {
    client.eval.mockResolvedValue(null);
    const store = new RoomLaunchCodeStore();

    await expect(
      store.consume('code', 'room-2', 'browser-nonce-123456'),
    ).resolves.toBeUndefined();
  });

  it('rejects another browser nonce and closes the shared client', async () => {
    client.eval.mockResolvedValue(null);
    const store = new RoomLaunchCodeStore();

    await expect(
      store.consume('code', 'room-1', 'different-browser-nonce'),
    ).resolves.toBeUndefined();
    await store.onModuleDestroy();
    expect(client.quit).toHaveBeenCalledTimes(1);
  });
});
