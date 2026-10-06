import { CanActivate, ExecutionContext, ForbiddenException, Injectable, RawBodyRequest, ServiceUnavailableException } from '@nestjs/common';
import { Request } from 'express';
import { AppService } from 'src/app.service';

@Injectable()
export class AuthRoomCreateGuard implements CanActivate {
  constructor(private readonly appService: AppService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RawBodyRequest<Request>>();
    const header = request.headers['x-room-create-authorization'];
    if (!Buffer.isBuffer(request.rawBody) || typeof header !== 'string') {
      throw new ForbiddenException('Verified room creation required');
    }
    let verified: boolean;
    try {
      verified = await this.appService.verifyRoomCreation(request.rawBody, header);
    } catch {
      throw new ServiceUnavailableException('Room creation authorization unavailable');
    }
    if (!verified) throw new ForbiddenException('Invalid or replayed room creation');
    const telegramId = this.appService.decryptTelegramId(request.body?.telegramId);
    if (!telegramId || !/^-?\d+$/.test(telegramId)) {
      throw new ForbiddenException('Invalid room creator');
    }
    request.body.telegramId = telegramId;
    return true;
  }
}
