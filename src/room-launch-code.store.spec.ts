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

  it('claims creation nonces atomically with expiry and rejects replay', async () => {
    client.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    const store = new RoomLaunchCodeStore();
    expect(await store.claimCreationNonce('a'.repeat(32))).toBe(true);
    expect(await store.claimCreationNonce('a'.repeat(32))).toBe(false);
    expect(client.set).toHaveBeenCalledWith(`innoprog:ide-room:create:${'a'.repeat(32)}`, 'used', { NX: true, EX: 180 });
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
  it('bounds outstanding guest admissions when Redis stops responding', async () => {
    jest.useFakeTimers();
    const pending = new Promise(() => {});
    client.eval.mockReturnValue(pending);
    const store = new RoomLaunchCodeStore();
    const calls = Array.from({length:32},()=>store.admitGuestToken('room').catch(e=>e));
    await expect(store.admitGuestToken('room')).rejects.toThrow('busy');
    await jest.advanceTimersByTimeAsync(1000);
    const errors = await Promise.all(calls);
    expect(errors.every(e => e.message.includes('timed out'))).toBe(true);
    await expect(store.admitGuestToken('room')).rejects.toThrow('busy');
    jest.useRealTimers();
  });

});
