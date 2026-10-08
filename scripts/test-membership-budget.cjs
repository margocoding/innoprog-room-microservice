// Local integration only: rejects any database except the disposable loopback test DB.
const url = new URL(process.env.DATABASE_URL || '');
if (url.hostname !== '127.0.0.1' || url.pathname !== '/innoprog_abuse_test') throw new Error('Disposable local test DB required');
const {PrismaClient} = require('@prisma/client');
const {RoomService} = require('../dist/src/room/room.service');
const db = new PrismaClient(); const service = new RoomService(db);
(async () => {
  let room;
  try {
    room = await db.room.create({data:{teacher:'teacher-test',students:Array.from({length:63},(_,i)=>`i${i}`)}});
    const joins=await Promise.allSettled(Array.from({length:8},(_,i)=>service.joinRoom(room.id,`i${100+i}`)));
    const current=await db.room.findUnique({where:{id:room.id}});
    if(joins.filter(x=>x.status==='fulfilled').length!==1 || current.students.length!==64) throw new Error('Guest race bypassed cap');
    await service.joinRoom(room.id,'i1');
    await db.roomMember.createMany({data:Array.from({length:255},(_,i)=>({roomId:room.id,telegramId:`test-${i}`}))});
    const records=await Promise.allSettled(Array.from({length:8},(_,i)=>service.upsertRoomMember(room.id,`new-${i}`)));
    const count=await db.roomMember.count({where:{roomId:room.id}});
    if(records.filter(x=>x.status==='fulfilled').length!==1 || count!==256) throw new Error('Member race bypassed cap');
    await service.upsertRoomMember(room.id,'test-1');
    console.log(JSON.stringify({parallel_guest_admitted:1,guests:64,parallel_member_record_admitted:1,member_records:256,existing_identity_reconnect:true}));
  } finally { if(room) await db.room.delete({where:{id:room.id}}); await db.$disconnect(); }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
