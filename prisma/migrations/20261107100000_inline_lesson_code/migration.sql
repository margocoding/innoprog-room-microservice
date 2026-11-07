ALTER TABLE "rooms" ADD COLUMN "lessonCodeInline" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "room_lesson_drafts" ADD COLUMN "codeInline" BOOLEAN NOT NULL DEFAULT false;
