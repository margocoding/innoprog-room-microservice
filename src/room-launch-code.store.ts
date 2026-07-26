import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createClient, RedisClientType } from 'redis';
import * as crypto from 'crypto';

const ROOM_LAUNCH_CODE_TTL_SECONDS = 60;
const ROOM_LAUNCH_KEY_PREFIX = 'innoprog:ide-room:launch:';
const CREATE_ATTEMPTS = 5;

export interface RoomLaunchPayload {
  roomId: string;
  userId: string;
}

@Injectable()
export class RoomLaunchCodeStore implements OnModuleDestroy {
  private client?: RedisClientType;
  private connecting?: Promise<RedisClientType>;

  private async getClient(): Promise<RedisClientType> {
    if (this.client?.isOpen) {
      return this.client;
    }
    if (this.connecting) {
      return this.connecting;
    }

    const client = createClient({
      url:
        process.env.IDE_ROOMS_REDIS_URL ||
        process.env.REDIS_URL ||
        'redis://redis:6379',
      socket: {
        connectTimeout: 1000,
        reconnectStrategy: false,
      },
    });
    client.on('error', (error) => {
      console.error('IDE room launch Redis error', {
        name: error?.name || 'RedisError',
      });
    });
    this.connecting = client.connect().then(() => {
      this.client = client as RedisClientType;
      return this.client;
    }).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async create(payload: RoomLaunchPayload): Promise<string> {
    const client = await this.getClient();
    for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
      const code = crypto.randomBytes(24).toString('base64url');
      const result = await client.set(
        `${ROOM_LAUNCH_KEY_PREFIX}${code}`,
        JSON.stringify(payload),
        { EX: ROOM_LAUNCH_CODE_TTL_SECONDS, NX: true },
      );
      if (result === 'OK') {
        return code;
      }
    }
    throw new Error('Unable to allocate a unique IDE room launch code');
  }

  async consume(
    code: string,
    expectedRoomId: string,
  ): Promise<RoomLaunchPayload | undefined> {
    if (!code || !expectedRoomId) {
      return undefined;
    }
    const client = await this.getClient();
    const raw = await client.sendCommand([
      'GETDEL',
      `${ROOM_LAUNCH_KEY_PREFIX}${code}`,
    ]);
    if (typeof raw !== 'string') {
      return undefined;
    }

    try {
      const payload = JSON.parse(raw);
      if (
        typeof payload?.roomId !== 'string' ||
        typeof payload?.userId !== 'string' ||
        payload.roomId !== expectedRoomId
      ) {
        return undefined;
      }
      return { roomId: payload.roomId, userId: payload.userId };
    } catch {
      return undefined;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client?.isOpen) {
      await this.client.quit();
    }
  }
}
