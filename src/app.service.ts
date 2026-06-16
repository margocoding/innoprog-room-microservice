import { Injectable } from "@nestjs/common";
import * as crypto from 'crypto';

@Injectable()
export class AppService {
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
};
