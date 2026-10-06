// Requires a disposable local PostgreSQL database, never production credentials.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const database = process.env.ROOM_DELETE_TEST_DATABASE_URL;
assert(database, 'ROOM_DELETE_TEST_DATABASE_URL is required');
const url = new URL(database);
assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Only local test PostgreSQL is allowed');
const schema = `room_delete_test_${randomBytes(8).toString('hex')}`;
const admin = new PrismaClient({ datasources: { db: { url: database } } });
url.searchParams.set('schema', schema);
const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function seed() {
  return prisma.room.create({ data: {
    teacher: 'test-owner', students: ['test-guest'],
    logs: { create: { code: 'synthetic code' } },
    roomMembers: { create: { telegramId: 'test-guest', username: 'Test guest' } },
  } });
}
async function counts(id, expected) {
  assert.equal(await prisma.room.count({ where: { id } }), expected);
  assert.equal(await prisma.log.count({ where: { roomId: id } }), expected);
  assert.equal(await prisma.roomMember.count({ where: { roomId: id } }), expected);
}
(async () => {
  try {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const migrated = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, DATABASE_URL: url.toString() }, encoding: 'utf8',
    });
    assert.equal(migrated.status, 0, 'All tracked migrations must apply to a fresh test schema');
    const room = await seed();
    await assert.rejects(prisma.room.delete({ where: { id: room.id, teacher: 'wrong-owner' } }), { code: 'P2025' });
    await counts(room.id, 1);
    await assert.rejects(prisma.$transaction(async tx => {
      await tx.room.delete({ where: { id: room.id, teacher: 'test-owner' } });
      throw new Error('expected rollback');
    }), /expected rollback/);
    await counts(room.id, 1);
    await prisma.room.delete({ where: { id: room.id, teacher: 'test-owner' } });
    await counts(room.id, 0);
    console.log('owner deletion, wrong-owner denial and transaction rollback passed');

    const concurrent = await prisma.room.create({ data: { teacher: 'test-owner', students: [] } });
    let releaseWriter, writerReady;
    const gate = new Promise(resolve => { releaseWriter = resolve; });
    const ready = new Promise(resolve => { writerReady = resolve; });
    const writer = prisma.$transaction(async tx => {
      await tx.log.create({ data: { roomId: concurrent.id, code: 'concurrent synthetic code' } });
      writerReady();
      await gate;
    }, { timeout: 10000 });
    await ready;
    let deletionSettled = false;
    const deletion = prisma.room.delete({ where: { id: concurrent.id, teacher: 'test-owner' } })
      .finally(() => { deletionSettled = true; });
    let blocked = false;
    try {
      for (let attempt = 0; attempt < 50; attempt++) {
        const locks = await admin.$queryRawUnsafe(`SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%DELETE%'`);
        if (locks[0].n > 0) { blocked = true; break; }
        if (deletionSettled) break;
        await pause(20);
      }
    } finally {
      releaseWriter();
      await writer;
      await deletion;
    }
    assert(blocked, 'Parent deletion must wait for an uncommitted referencing log insert');
    assert.equal(await prisma.room.count({ where: { id: concurrent.id } }), 0);
    assert.equal(await prisma.log.count({ where: { roomId: concurrent.id } }), 0);
    console.log('concurrent log writer commits before atomic cascading room deletion');
  } finally {
    await prisma.$disconnect();
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$disconnect();
  }
})().catch(() => { console.error('Room deletion PostgreSQL acceptance failed'); process.exitCode = 1; });
