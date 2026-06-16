import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { AppService } from 'src/app.service';

const isRoomGeneratedTelegramId = (telegramId?: string): boolean =>
    Boolean(telegramId && /^i\d+$/.test(telegramId));

@Injectable()
export class AuthRoomGuard implements CanActivate {
    constructor(private readonly appService: AppService) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const type = context.getType<'ws' | 'http'>();

        let telegramId: string | undefined;
        let client: any;

        if (type === 'ws') {
            const data = context.switchToWs().getData();
            client = context.switchToWs().getClient();

            telegramId = data.telegramId;

            if (!telegramId) {
                telegramId = `i${Math.floor(Math.random() * 1000000)}`;
            } else if (!isRoomGeneratedTelegramId(telegramId)) {
                telegramId = this.appService.decryptTelegramId(telegramId);
            }

            if (!telegramId || (!isRoomGeneratedTelegramId(telegramId) && isNaN(Number(telegramId)))) {
                client.emit('join-room:error', { message: 'Неверная ссылка. Пожалуйста, обратитесь к администратору' });
                return false;
            }

            // перезаписываем в data
            data.telegramId = telegramId;
        } else if (type === 'http') {
            const request: Request = context.switchToHttp().getRequest();

            telegramId = request.query.telegramId || request.params.telegramId || request.body.telegramId;

            if (!telegramId) {
                telegramId = `i${Math.floor(Math.random() * 1000000)}`;
            } else if (!isRoomGeneratedTelegramId(telegramId)) {
                telegramId = this.appService.decryptTelegramId(telegramId);
            }

            if (!telegramId || (!isRoomGeneratedTelegramId(telegramId) && isNaN(Number(telegramId)))) {
                request.res?.status(400).json({ message: 'Неверная ссылка. Пожалуйста, обратитесь к администратору' });
                return false;
            }

            if (request.params?.telegramId) {
                request.params.telegramId = telegramId;
            }
            if (request.body?.telegramId) {
                request.body.telegramId = telegramId;
            }
            if (request.query?.telegramId) {
                request.query.telegramId = telegramId;
            }


        }

        return true;
    }
}
