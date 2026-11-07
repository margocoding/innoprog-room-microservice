ALTER TABLE "rooms"
  ADD COLUMN "lessonRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lessonKey" TEXT NOT NULL DEFAULT 'free',
  ADD COLUMN "lessonTask" JSONB,
  ADD COLUMN "lessonSnapshot" TEXT;

CREATE TABLE "room_lesson_drafts" (
  "roomId" TEXT NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "key" TEXT NOT NULL,
  "language" "Language" NOT NULL,
  "snapshot" TEXT NOT NULL,
  PRIMARY KEY ("roomId", "key")
);
CREATE TABLE "personal_lesson_tasks" (
  "id" TEXT PRIMARY KEY,
  "owner" TEXT NOT NULL,
  "moduleId" INTEGER NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "personal_lesson_tasks_owner_moduleId_createdAt_idx"
  ON "personal_lesson_tasks" ("owner", "moduleId", "createdAt");
