import { Injectable } from "@nestjs/common";
import * as crypto from 'crypto';

export interface RoomTokenPayload {
    roomId: string;
    userId: string;
    exp: number;
}

const DEFAULT_ROOM_TOKEN_TTL_SECONDS = 60 * 60;
const ROOM_LAUNCH_CODE_TTL_SECONDS = 2 * 60;
const MAX_LAUNCH_CODES = 10_000;

@Injectable()
export class AppService {
    private readonly roomLaunchCodes = new Map<string, { roomId: string; userId: string; exp: number }>();
    private b64urlEncode(data: Buffer | string) {
        return Buffer.from(data).toString('base64url');
    }

    b64urlDecodeToBuf(s: string) {
        let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        return Buffer.from(b64, 'base64');
    }

    decryptTelegramId(token: string): string | undefined {
        try {
            const { ENCRYPT_TELEGRAM_ID_KEY, ENCRYPT_TELEGRAM_ID_IV } = process.env;
            if (!ENCRYPT_TELEGRAM_ID_IV || !ENCRYPT_TELEGRAM_ID_KEY) return undefined;
            const key: Buffer = Buffer.from(ENCRYPT_TELEGRAM_ID_KEY, 'base64');
            const iv: Buffer = Buffer.from(ENCRYPT_TELEGRAM_ID_IV, 'base64');
            const encrypted = this.b64urlDecodeToBuf(token);
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
            const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
            return decrypted.toString('utf8')
        } catch {
            return undefined;
        }
    }

    private getRoomTokenSecret(): string | undefined {
        return process.env.ROOM_TOKEN_SECRET || process.env.ENCRYPT_TELEGRAM_ID_KEY;
    }

    isRoomTokenRequired(): boolean {
        return String(process.env.REQUIRE_ROOM_TOKEN || '').toLowerCase() === 'true';
    }

    isLegacyRoomIdAuthAllowed(): boolean {
        const configured = process.env.ALLOW_LEGACY_ROOM_ID_AUTH;
        if (configured !== undefined) {
            return ['1', 'true', 'yes', 'on'].includes(configured.toLowerCase());
        }
        return !this.isRoomTokenRequired();
    }

    createAnonymousRoomUserId(): string {
        return `i${crypto.randomInt(100000, 999999999)}`;
    }

    createRoomLaunchCode(roomId: string, userId: string): string {
        const now = Math.floor(Date.now() / 1000);
        for (const [code, payload] of this.roomLaunchCodes) {
            if (payload.exp < now) this.roomLaunchCodes.delete(code);
        }
        while (this.roomLaunchCodes.size >= MAX_LAUNCH_CODES) {
            const oldest = this.roomLaunchCodes.keys().next().value;
            if (!oldest) break;
            this.roomLaunchCodes.delete(oldest);
        }
        const code = crypto.randomBytes(24).toString('base64url');
        this.roomLaunchCodes.set(code, {
            roomId,
            userId,
            exp: now + ROOM_LAUNCH_CODE_TTL_SECONDS,
        });
        return code;
    }

    consumeRoomLaunchCode(code: string, expectedRoomId: string): { roomId: string; userId: string } | undefined {
        const payload = this.roomLaunchCodes.get(code);
        this.roomLaunchCodes.delete(code);
        if (!payload || payload.roomId !== expectedRoomId || payload.exp < Math.floor(Date.now() / 1000)) {
            return undefined;
        }
        return { roomId: payload.roomId, userId: payload.userId };
    }

    getRoomTokenTtlSeconds(): number {
        const configured = process.env.ROOM_TOKEN_TTL_SECONDS;
        if (!configured) {
            return DEFAULT_ROOM_TOKEN_TTL_SECONDS;
        }

        const parsed = Number(configured);
        if (!Number.isFinite(parsed) || parsed < 60) {
            return DEFAULT_ROOM_TOKEN_TTL_SECONDS;
        }

        return Math.floor(parsed);
    }

    createRoomToken(roomId: string, userId: string, ttlSeconds?: number): string | undefined {
        const secret = this.getRoomTokenSecret();
        if (!secret) {
            if (this.isRoomTokenRequired()) {
                throw new Error('ROOM_TOKEN_SECRET is required when REQUIRE_ROOM_TOKEN=true');
            }
            return undefined;
        }
        const tokenTtlSeconds = ttlSeconds ?? this.getRoomTokenTtlSeconds();

        const payload = {
            v: 1,
            room_id: roomId,
            user_id: userId,
            exp: Math.floor(Date.now() / 1000) + tokenTtlSeconds,
        };
        const encodedPayload = this.b64urlEncode(
            JSON.stringify(payload, Object.keys(payload).sort()),
        );
        const signature = crypto
            .createHmac('sha256', secret)
            .update(encodedPayload)
            .digest('base64url');
        return `v1.${encodedPayload}.${signature}`;
    }

    verifyRoomToken(token: string, expectedRoomId?: string): RoomTokenPayload | undefined {
        const secret = this.getRoomTokenSecret();
        if (!secret || !token) {
            return undefined;
        }

        try {
            const [version, encodedPayload, signature] = token.split('.');
            if (version !== 'v1' || !encodedPayload || !signature) {
                return undefined;
            }

            const expectedSignature = crypto
                .createHmac('sha256', secret)
                .update(encodedPayload)
                .digest();
            const actualSignature = this.b64urlDecodeToBuf(signature);
            if (
                actualSignature.length !== expectedSignature.length ||
                !crypto.timingSafeEqual(actualSignature, expectedSignature)
            ) {
                return undefined;
            }

            const payload = JSON.parse(this.b64urlDecodeToBuf(encodedPayload).toString('utf8'));
            if (
                payload?.v !== 1 ||
                typeof payload.room_id !== 'string' ||
                typeof payload.user_id !== 'string' ||
                typeof payload.exp !== 'number'
            ) {
                return undefined;
            }

            if (expectedRoomId && payload.room_id !== expectedRoomId) {
                return undefined;
            }

            if (payload.exp <= Math.floor(Date.now() / 1000)) {
                return undefined;
            }

            return {
                roomId: payload.room_id,
                userId: payload.user_id,
                exp: payload.exp,
            };
        } catch {
            return undefined;
        }
    }
};
