-- One statement per migration: PostgreSQL must run CONCURRENTLY outside a transaction.
CREATE INDEX CONCURRENTLY "logs_roomId_createdAt_idx" ON "logs" ("roomId", "createdAt" DESC);
