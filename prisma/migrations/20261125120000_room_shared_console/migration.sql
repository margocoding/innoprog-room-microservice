ALTER TABLE "rooms" ADD COLUMN "sharedConsoleEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "rooms" ALTER COLUMN "studentSelectionEnabled" SET DEFAULT true,
                    ALTER COLUMN "studentEditCodeEnabled" SET DEFAULT true;

CREATE TABLE "ide_shared_console_intro" (
    "accountId" TEXT PRIMARY KEY,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
