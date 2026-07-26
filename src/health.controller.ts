import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { RoomLaunchCodeStore } from './room-launch-code.store';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly launchCodes: RoomLaunchCodeStore,
  ) {}

  @Get('live')
  live() {
    return { ok: true };
  }

  @Get('ready')
  async ready() {
    try {
      const [, redisReady] = await Promise.all([
        this.prisma.$queryRawUnsafe('SELECT 1'),
        this.launchCodes.ping(),
      ]);
      if (!redisReady) {
        throw new Error('Redis ping failed');
      }
      return { ok: true };
    } catch {
      throw new ServiceUnavailableException({ ok: false });
    }
  }
}
