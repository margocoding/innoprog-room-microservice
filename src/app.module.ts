import { Module } from '@nestjs/common';
import { RoomModule } from './room/room.module';
import { AppService } from './app.service';
import { RoomLaunchCodeStore } from './room-launch-code.store';
import { PrismaModule } from './prisma/prisma.module';
import { HealthController } from './health.controller';
import { MetricsController } from './metrics.controller';

@Module({
  imports: [RoomModule, PrismaModule],
  controllers: [HealthController, MetricsController],
  providers: [AppService, RoomLaunchCodeStore],
  exports: [AppService]
})
export class AppModule { }
