-- A teacher-owned room deletion must also remove its code history.
-- Bound lock acquisition so active rooms keep working if DDL cannot proceed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "logs" DROP CONSTRAINT "logs_roomId_fkey";
ALTER TABLE "logs" ADD CONSTRAINT "logs_roomId_fkey"
  FOREIGN KEY ("roomId") REFERENCES "rooms"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
COMMIT;
