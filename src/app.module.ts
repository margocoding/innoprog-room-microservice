import { Module } from '@nestjs/common';
import { RoomModule } from './room/room.module';
import { AppService } from './app.service';
import { RoomLaunchCodeStore } from './room-launch-code.store';
import { PrismaModule } from './prisma/prisma.module';
import { HealthController } from './health.controller';

@Module({
  imports: [RoomModule, PrismaModule],
  controllers: [HealthController],
  providers: [AppService, RoomLaunchCodeStore],
  exports: [AppService]
})
export class AppModule { }
