import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { RoomController } from './room.controller';
import { RoomGateway } from './room.gateway';
import { RoomService } from './room.service';
import { AppModule } from 'src/app.module';
import { AuthRoomGuard } from './auth-room.guard';
import { AuthRoomCreateGuard } from './auth-room-create.guard';

@Module({
  imports: [PrismaModule, forwardRef(() => AppModule)],
  providers: [RoomService, RoomGateway, AuthRoomGuard, AuthRoomCreateGuard],
  controllers: [RoomController],
})
export class RoomModule { }
