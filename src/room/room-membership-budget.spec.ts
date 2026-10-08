import { RoomService } from './room.service';
describe('atomic membership budgets', () => {
  function setup(students: string[]) {
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      room: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'r', teacher: 't', students }),
        update: jest
          .fn()
          .mockResolvedValue({ id: 'r', teacher: 't', students }),
      },
      roomMember: {
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(256),
        upsert: jest.fn(),
      },
    };
    const prisma: any = {
      $transaction: jest.fn(async (callback: any) => callback(tx)),
    };
    return { service: new RoomService(prisma), tx };
  }
  it('takes a database row lock before rejecting excess new guests', async () => {
    const { service, tx } = setup(
      Array.from({ length: 64 }, (_, i) => `i${i}`),
    );
    await expect(service.joinRoom('r', 'i999')).rejects.toThrow();
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.room.update).not.toHaveBeenCalled();
    await expect(service.joinRoom('r', 'i1')).resolves.toBeDefined();
  });
  it('rejects membership record multiplication but preserves existing identity', async () => {
    const { service, tx } = setup([]);
    await expect(service.upsertRoomMember('r', 'new')).rejects.toThrow();
    expect(tx.roomMember.upsert).not.toHaveBeenCalled();
    tx.roomMember.findUnique.mockResolvedValue({ id: 'existing' });
    await service.upsertRoomMember('r', 'existing');
    expect(tx.roomMember.upsert).toHaveBeenCalled();
  });
});
