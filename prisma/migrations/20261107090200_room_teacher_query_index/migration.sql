-- One statement per migration: PostgreSQL must run CONCURRENTLY outside a transaction.
CREATE INDEX CONCURRENTLY "rooms_teacher_createdAt_idx" ON "rooms" ("teacher", "createdAt" DESC);
