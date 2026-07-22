import { AppService } from './app.service';
import * as crypto from 'crypto';

const decodeRoomToken = (token: string) => {
    const [, encodedPayload] = token.split('.');
    return JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
};

describe('AppService room tokens', () => {
    const originalEnv = process.env;
    const fixedNow = 1_700_000_000_000;

    beforeEach(() => {
        process.env = {
            ...originalEnv,
            ROOM_TOKEN_SECRET: 'test-room-token-secret',
        };
        jest.spyOn(Date, 'now').mockReturnValue(fixedNow);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        process.env = originalEnv;
    });

    it('creates room tokens that live for one hour by default', () => {
        delete process.env.ROOM_TOKEN_TTL_SECONDS;
        const service = new AppService();

        const token = service.createRoomToken('room-1', '7488194158');

        expect(token).toBeDefined();
        expect(decodeRoomToken(token as string)).toMatchObject({
            room_id: 'room-1',
            user_id: '7488194158',
            exp: Math.floor(fixedNow / 1000) + 60 * 60,
        });
    });

    it('allows overriding room token ttl from env', () => {
        process.env.ROOM_TOKEN_TTL_SECONDS = '604800';
        const service = new AppService();

        const token = service.createRoomToken('room-1', '7488194158');

        expect(token).toBeDefined();
        expect(decodeRoomToken(token as string).exp).toBe(
            Math.floor(fixedNow / 1000) + 604800,
        );
    });

    it('validates configuration switches and ttl fallbacks', () => {
        const service = new AppService();
        process.env.REQUIRE_ROOM_TOKEN = 'TRUE';
        expect(service.isRoomTokenRequired()).toBe(true);
        expect(service.isLegacyRoomIdAuthAllowed()).toBe(false);
        process.env.ALLOW_LEGACY_ROOM_ID_AUTH = 'yes';
        expect(service.isLegacyRoomIdAuthAllowed()).toBe(true);
        process.env.ROOM_TOKEN_TTL_SECONDS = 'invalid';
        expect(service.getRoomTokenTtlSeconds()).toBe(60 * 60);
        process.env.ROOM_TOKEN_TTL_SECONDS = '59';
        expect(service.getRoomTokenTtlSeconds()).toBe(60 * 60);
        expect(service.createAnonymousRoomUserId()).toMatch(/^i\d+$/);
    });

    it('exchanges a short-lived launch code exactly once without putting a room token in a URL', () => {
        const service = new AppService();
        const launchCode = service.createRoomLaunchCode('room-1', 'teacher-1');

        expect(launchCode).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(service.consumeRoomLaunchCode(launchCode, 'room-1')).toEqual({
            roomId: 'room-1',
            userId: 'teacher-1',
        });
        expect(service.consumeRoomLaunchCode(launchCode, 'room-1')).toBeUndefined();
    });

    it('verifies valid tokens and rejects tampering, expiration and room mismatch', () => {
        const service = new AppService();
        const token = service.createRoomToken('room-1', 'student-1', 120) as string;
        expect(service.verifyRoomToken(token, 'room-1')).toMatchObject({
            roomId: 'room-1', userId: 'student-1',
        });
        expect(service.verifyRoomToken(token, 'room-2')).toBeUndefined();
        expect(service.verifyRoomToken(`${token}x`)).toBeUndefined();
        expect(service.verifyRoomToken('bad')).toBeUndefined();
        jest.spyOn(Date, 'now').mockReturnValue(fixedNow + 121_000);
        expect(service.verifyRoomToken(token)).toBeUndefined();
        delete process.env.ROOM_TOKEN_SECRET;
        delete process.env.ENCRYPT_TELEGRAM_ID_KEY;
        expect(service.verifyRoomToken(token)).toBeUndefined();
    });

    it('returns no token without a secret unless tokens are required', () => {
        delete process.env.ROOM_TOKEN_SECRET;
        delete process.env.ENCRYPT_TELEGRAM_ID_KEY;
        const service = new AppService();
        expect(service.createRoomToken('room', 'user')).toBeUndefined();
        process.env.REQUIRE_ROOM_TOKEN = 'true';
        expect(() => service.createRoomToken('room', 'user')).toThrow(
            'ROOM_TOKEN_SECRET is required',
        );
    });

    it('decrypts a telegram id and safely rejects invalid encrypted values', () => {
        const key = crypto.randomBytes(32);
        const iv = crypto.randomBytes(16);
        process.env.ENCRYPT_TELEGRAM_ID_KEY = key.toString('base64');
        process.env.ENCRYPT_TELEGRAM_ID_IV = iv.toString('base64');
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        const encrypted = Buffer.concat([
            cipher.update('7488194158', 'utf8'),
            cipher.final(),
        ]).toString('base64url');
        const service = new AppService();
        expect(service.decryptTelegramId(encrypted)).toBe('7488194158');
        expect(service.decryptTelegramId('broken')).toBeUndefined();
        delete process.env.ENCRYPT_TELEGRAM_ID_IV;
        expect(service.decryptTelegramId(encrypted)).toBeUndefined();
    });
});
