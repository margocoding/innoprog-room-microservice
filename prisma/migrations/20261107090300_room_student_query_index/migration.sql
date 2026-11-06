-- One statement per migration: PostgreSQL must run CONCURRENTLY outside a transaction.
CREATE INDEX CONCURRENTLY "rooms_students_idx" ON "rooms" USING GIN ("students");
