import { Module } from '@nestjs/common';
import { RoomModule } from './room/room.module';
import { AppService } from './app.service';
import { RoomLaunchCodeStore } from './room-launch-code.store';

@Module({
  imports: [RoomModule],
  controllers: [],
  providers: [AppService, RoomLaunchCodeStore],
  exports: [AppService]
})
export class AppModule { }
