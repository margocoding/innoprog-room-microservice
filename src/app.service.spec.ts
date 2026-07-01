import { AppService } from './app.service';

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

    it('creates room tokens that live for 30 days by default', () => {
        delete process.env.ROOM_TOKEN_TTL_SECONDS;
        const service = new AppService();

        const token = service.createRoomToken('room-1', '7488194158');

        expect(token).toBeDefined();
        expect(decodeRoomToken(token as string)).toMatchObject({
            room_id: 'room-1',
            user_id: '7488194158',
            exp: Math.floor(fixedNow / 1000) + 30 * 24 * 60 * 60,
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
});
