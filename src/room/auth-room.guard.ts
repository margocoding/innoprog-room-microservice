import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { AppService } from 'src/app.service';

const isRoomGeneratedTelegramId = (telegramId?: string): boolean =>
    Boolean(telegramId && /^i\d+$/.test(telegramId));

const isDecryptedTelegramId = (telegramId?: string): boolean =>
    Boolean(telegramId && /^\d+$/.test(telegramId));

const getRefererTelegramId = (client: any): string | undefined => {
    const referer = client?.handshake?.headers?.referer;
    if (!referer || typeof referer !== 'string') {
        return undefined;
    }

    try {
        return new URL(referer).searchParams.get('telegramId') ?? undefined;
    } catch {
        return undefined;
    }
}

@Injectable()
export class AuthRoomGuard implements CanActivate {
    constructor(private readonly appService: AppService) { }

    private normalizeTelegramId(telegramId?: string): string | undefined {
        if (!telegramId) {
            return `i${Math.floor(Math.random() * 1000000)}`;
        }

        if (isRoomGeneratedTelegramId(telegramId) || isDecryptedTelegramId(telegramId)) {
            return telegramId;
        }

        return this.appService.decryptTelegramId(telegramId);
    }

    private isValidTelegramId(telegramId?: string): telegramId is string {
        return Boolean(
            telegramId &&
            (isRoomGeneratedTelegramId(telegramId) || isDecryptedTelegramId(telegramId)),
        );
    }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const type = context.getType<'ws' | 'http'>();

        let telegramId: string | undefined;
        let client: any;

        if (type === 'ws') {
            const data = context.switchToWs().getData();
            client = context.switchToWs().getClient();

            telegramId = data.telegramId;
            const refererTelegramId = getRefererTelegramId(client);

            if (refererTelegramId && (!telegramId || isRoomGeneratedTelegramId(telegramId))) {
                telegramId = refererTelegramId;
            }

            telegramId = this.normalizeTelegramId(telegramId);

            if (!this.isValidTelegramId(telegramId)) {
                client.emit('join-room:error', { message: 'Неверная ссылка. Пожалуйста, обратитесь к администратору' });
                return false;
            }

            // перезаписываем в data
            data.telegramId = telegramId;
        } else if (type === 'http') {
            const request: Request = context.switchToHttp().getRequest();

            telegramId = request.query.telegramId || request.params.telegramId || request.body.telegramId;

            telegramId = this.normalizeTelegramId(telegramId);

            if (!this.isValidTelegramId(telegramId)) {
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
