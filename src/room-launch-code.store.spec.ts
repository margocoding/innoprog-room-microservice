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

  it('stores launch codes with a 60 second TTL and consumes them through GETDEL', async () => {
    client.sendCommand
      .mockResolvedValueOnce(JSON.stringify({ roomId: 'room-1', userId: 'teacher-1' }))
      .mockResolvedValueOnce(null);
    const store = new RoomLaunchCodeStore();

    const code = await store.create({ roomId: 'room-1', userId: 'teacher-1' });
    await expect(store.consume(code, 'room-1')).resolves.toEqual({
      roomId: 'room-1',
      userId: 'teacher-1',
    });
    await expect(store.consume(code, 'room-1')).resolves.toBeUndefined();

    expect(client.set).toHaveBeenCalledWith(
      `innoprog:ide-room:launch:${code}`,
      JSON.stringify({ roomId: 'room-1', userId: 'teacher-1' }),
      { EX: 60, NX: true },
    );
    expect(client.sendCommand).toHaveBeenCalledWith([
      'GETDEL',
      `innoprog:ide-room:launch:${code}`,
    ]);
  });

  it('rejects a code for another room after atomically consuming it', async () => {
    client.sendCommand.mockResolvedValue(
      JSON.stringify({ roomId: 'room-1', userId: 'teacher-1' }),
    );
    const store = new RoomLaunchCodeStore();

    await expect(store.consume('code', 'room-2')).resolves.toBeUndefined();
  });

  it('rejects malformed Redis values and closes the shared client', async () => {
    client.sendCommand.mockResolvedValue('{broken');
    const store = new RoomLaunchCodeStore();

    await expect(store.consume('code', 'room-1')).resolves.toBeUndefined();
    await store.onModuleDestroy();
    expect(client.quit).toHaveBeenCalledTimes(1);
  });
});
