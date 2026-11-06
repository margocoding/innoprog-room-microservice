-- One statement per migration: PostgreSQL must run CONCURRENTLY outside a transaction.
CREATE INDEX CONCURRENTLY "room_members_roomId_idx" ON "room_members" ("roomId");
