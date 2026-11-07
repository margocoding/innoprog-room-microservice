ALTER TABLE "rooms" ADD COLUMN "completedAt" TIMESTAMP(3);

CREATE TABLE "room_lesson_visits" (
  "roomId" TEXT NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "revision" INTEGER NOT NULL,
  "taskKey" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "language" "Language" NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "endedAt" TIMESTAMP(3),
  "snapshot" TEXT,
  PRIMARY KEY ("roomId", "revision")
);

CREATE TABLE "room_presence" (
  "id" TEXT PRIMARY KEY,
  "roomId" TEXT NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "participant" TEXT NOT NULL,
  "displayName" TEXT,
  "kind" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "joinedAt" TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "leftAt" TIMESTAMP(3)
);

CREATE INDEX "room_presence_roomId_joinedAt_idx" ON "room_presence" ("roomId", "joinedAt");
