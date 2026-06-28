import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { AppService } from 'src/app.service';

const isRoomGeneratedTelegramId = (telegramId?: string): boolean =>
    Boolean(telegramId && /^i\d+$/.test(telegramId));

const isDecryptedTelegramId = (telegramId?: string): boolean =>
    Boolean(telegramId && /^-?\d+$/.test(telegramId));

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

const getRefererParam = (client: any, name: string): string | undefined => {
    const referer = client?.handshake?.headers?.referer;
    if (!referer || typeof referer !== 'string') {
        return undefined;
    }

    try {
        return new URL(referer).searchParams.get(name) ?? undefined;
    } catch {
        return undefined;
    }
}

const firstString = (value: unknown): string | undefined => {
    if (Array.isArray(value)) {
        return firstString(value[0]);
    }
    return typeof value === 'string' && value ? value : undefined;
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

    private getRoomTokenFromWs(data: any, client: any): string | undefined {
        return (
            firstString(data?.roomToken) ||
            firstString(client?.handshake?.query?.roomToken) ||
            firstString(client?.handshake?.headers?.['x-room-token']) ||
            getRefererParam(client, 'roomToken')
        );
    }

    private getRoomTokenFromHttp(request: Request): string | undefined {
        return (
            firstString(request.headers?.['x-room-token']) ||
            firstString(request.query?.roomToken) ||
            firstString(request.body?.roomToken)
        );
    }

    private getExpectedHttpRoomId(request: Request): string | undefined {
        return (
            firstString(request.params?.id) ||
            firstString(request.body?.id) ||
            firstString(request.body?.roomId) ||
            firstString(request.query?.roomId)
        );
    }

    private rejectWs(client: any, message = 'Неверная ссылка. Пожалуйста, обратитесь к администратору') {
        client.emit('join-room:error', { message });
        return false;
    }

    private applyVerifiedWsToken(data: any, client: any, token: string, roomId?: string): boolean {
        const payload = this.appService.verifyRoomToken(token, roomId);
        if (!payload) {
            return this.rejectWs(client);
        }

        data.roomId = roomId || payload.roomId;
        data.telegramId = payload.userId;
        client.data = client.data || {};
        client.data.roomAuth = payload;
        return true;
    }

    private applySocketSession(data: any, client: any): boolean {
        const roomAuth = client?.data?.roomAuth;
        if (!roomAuth || roomAuth.exp <= Math.floor(Date.now() / 1000)) {
            return false;
        }

        const roomId = firstString(data?.roomId);
        if (!roomId || roomAuth.roomId !== roomId) {
            return false;
        }

        const normalizedTelegramId = this.normalizeTelegramId(firstString(data?.telegramId));
        if (normalizedTelegramId && normalizedTelegramId !== roomAuth.userId) {
            return false;
        }

        data.telegramId = roomAuth.userId;
        return true;
    }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const type = context.getType<'ws' | 'http'>();

        let telegramId: string | undefined;
        let client: any;

        if (type === 'ws') {
            const data = context.switchToWs().getData();
            client = context.switchToWs().getClient();

            const roomId = firstString(data?.roomId);
            const roomToken = this.getRoomTokenFromWs(data, client);
            if (roomToken) {
                return this.applyVerifiedWsToken(data, client, roomToken, roomId);
            }

            if (this.applySocketSession(data, client)) {
                return true;
            }

            if (
                roomId &&
                (this.appService.isRoomTokenRequired() ||
                    !this.appService.isLegacyRoomIdAuthAllowed())
            ) {
                return this.rejectWs(client);
            }

            telegramId = firstString(data.telegramId);
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

            const expectedRoomId = this.getExpectedHttpRoomId(request);
            const roomToken = this.getRoomTokenFromHttp(request);
            if (roomToken) {
                const payload = this.appService.verifyRoomToken(roomToken, expectedRoomId);
                if (!payload) {
                    request.res?.status(403).json({ message: 'Неверная или истекшая ссылка комнаты' });
                    return false;
                }
                telegramId = payload.userId;
            } else {
                if (
                    expectedRoomId &&
                    (this.appService.isRoomTokenRequired() ||
                        !this.appService.isLegacyRoomIdAuthAllowed())
                ) {
                    request.res?.status(403).json({ message: 'Неверная или истекшая ссылка комнаты' });
                    return false;
                }
                telegramId = firstString(request.query.telegramId) || firstString(request.params.telegramId) || firstString(request.body.telegramId);
            }

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
