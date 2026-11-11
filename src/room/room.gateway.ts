import { insertLessonTemplate, type LessonTask } from './lesson-task';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { fillDto } from 'helpers/fill-dto/fill-dto';
import { Server, Socket } from 'socket.io';
import { EditRoomDto } from './dto/edit-room-dto';
import { RoomRdo } from './rdo/room-rdo';
import { RoomService } from './room.service';
import * as Y from 'yjs';
import { BeforeApplicationShutdown, Logger, UseGuards } from '@nestjs/common';
import { AuthRoomGuard } from './auth-room.guard';
import { Language } from '@prisma/client';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { socketMetrics } from '../socket-metrics';
import { RoomResourceBudget, MAX_UPDATE_BYTES, MAX_SNAPSHOT_BYTES } from './room-resource-budget';

interface JoinPayload {
  telegramId: string;
  username?: string;
  roomId: string;
  clientInstanceId?: string;
}

interface ClientLifecyclePayload extends JoinPayload {
  state: 'hidden';
}

interface EditMember extends JoinPayload {
  changeTelegramId: string;
}

interface Member {
  clientId: string;
  clientInstanceId?: string;
  telegramId: string;
  username?: string;
  online: boolean;
  lastCursorPosition?: [number, number];
  lastSelection?: {
    line?: number;
    column?: number;
    selectionStart?: { line: number; column: number };
    selectionEnd?: { line: number; column: number };
    selectedText?: string;
  };
  userColor?: string;
  lastActivity?: Date;
  presence?: Promise<string | undefined>;
}

interface Room {
  id: string;
  members: Member[];
  teacher: string;
  studentCursorEnabled: boolean;
  studentSelectionEnabled: boolean;
  studentEditCodeEnabled: boolean;
  completed: boolean;
  lessonRevision?: number;
  presenceHeartbeatAt?: number;
  lessonKey?: string;
  lessonTask?: LessonTask | null;
  language?: Language;
}

interface EditPayload extends EditRoomDto {
  lessonRevision?: number;
  roomId: string;
  telegramId: string;
}

interface Log {
  telegramId: string;
  cursor: number[];
}

interface CursorPayload {
  roomId: string;
  position: number[];
  logs: Log[];
  telegramId: string;
}

interface TaskScrollPayload {
  roomId: string;
  telegramId: string;
  lessonRevision: number;
  taskId: string | null;
  progress: number;
}

interface SelectionPayload {
  roomId: string;
  telegramId: string;
  line?: number;
  column?: number;
  selectionStart?: {
    line: number;
    column: number;
  };
  selectionEnd?: {
    line: number;
    column: number;
  };
  selectedText?: string;
  clearSelection?: boolean;
}

interface CodeEditPayload {
  roomId: string;
  telegramId: string;
  update: Uint8Array;
  lessonRevision?: number;
}

interface CodeSyncInitPayload extends JoinPayload {
  stateVector: Uint8Array;
  lessonRevision?: number;
}

interface CodeSyncUpdatePayload extends CodeEditPayload {
  clientInstanceId: string;
  sequence: number;
}

interface SocketMembership {
  roomId: string;
  telegramId: string;
}

const DEFAULT_SOCKET_CORS_ALLOWED_ORIGINS = [
  'https://ide.innoprog.ru',
  'https://app.innoprog.ru',
  'https://api.innoprog.ru',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
];

function getSocketCorsAllowedOrigins(): Set<string> {
  const configured = process.env.ROOM_CORS_ALLOWED_ORIGINS ?? '';
  const extraOrigins = configured
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  return new Set([...DEFAULT_SOCKET_CORS_ALLOWED_ORIGINS, ...extraOrigins]);
}

const socketCorsAllowedOrigins = getSocketCorsAllowedOrigins();

const positiveIntegerSetting = (name: string, fallback: number): number => {
  const parsed = Number(process.env[name] ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
};

export const SOCKET_PING_INTERVAL_MS = positiveIntegerSetting(
  'SOCKET_IO_PING_INTERVAL_MS',
  25_000,
);
export const SOCKET_PING_TIMEOUT_MS = positiveIntegerSetting(
  'SOCKET_IO_PING_TIMEOUT_MS',
  60_000,
);
const RECONNECT_TRACKING_TTL_MS = 10 * 60_000;
const RECONNECT_TRACKING_MAX_ENTRIES = 10_000;

function isSocketCorsOriginAllowed(origin?: string): boolean {
  if (!origin) {
    return true;
  }
  return socketCorsAllowedOrigins.has(origin.replace(/\/+$/, ''));
}

function applyYjsUpdate(doc: Y.Doc, update: Uint8Array): Uint8Array | null {
  const integratedUpdates: Uint8Array[] = [];
  const handleUpdate = (integratedUpdate: Uint8Array) => {
    integratedUpdates.push(new Uint8Array(integratedUpdate));
  };
  doc.on('update', handleUpdate);
  try {
    Y.applyUpdate(doc, update);
  } finally {
    doc.off('update', handleUpdate);
  }
  if (integratedUpdates.length === 0) return null;
  return integratedUpdates.length === 1
    ? integratedUpdates[0]
    : Y.mergeUpdates(integratedUpdates);
}

@WebSocketGateway({
  cors: {
    origin: (origin, callback) => {
      if (isSocketCorsOriginAllowed(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Socket origin is not allowed'), false);
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingInterval: SOCKET_PING_INTERVAL_MS,
  pingTimeout: SOCKET_PING_TIMEOUT_MS,
})
@UseGuards(AuthRoomGuard)
export class RoomGateway
  implements OnGatewayConnection, OnGatewayDisconnect, BeforeApplicationShutdown
{
  private readonly logger = new Logger(RoomGateway.name);
  private readonly logHashKey =
    process.env.ROOM_LOG_HASH_SECRET ||
    process.env.ROOM_TOKEN_SECRET ||
    randomBytes(32).toString('hex');
  private readonly SNAPSHOT_INTERVAL_MS = Number(
    process.env.ROOM_SNAPSHOT_INTERVAL_MS ?? 5_000,
  );
  private readonly SNAPSHOT_DEBOUNCE_MS = Number(
    process.env.ROOM_SNAPSHOT_DEBOUNCE_MS ?? 1_000,
  );
  private readonly SNAPSHOT_ACK_TIMEOUT_MS = Number(
    process.env.ROOM_SNAPSHOT_ACK_TIMEOUT_MS ?? 10_000,
  );
  private readonly resourceBudget = new RoomResourceBudget();
  private readonly resolvingLessons = new Set<string>();
  private readonly switchingLessons = new Set<string>();
  private docs = new Map<string, Y.Doc>();
  private docInitTasks = new Map<string, Promise<Y.Doc>>();
  private timers = new Map<string, NodeJS.Timeout>();
  private snapshotDebounceTimers = new Map<string, NodeJS.Timeout>();
  private snapshotDirtyRooms = new Set<string>();
  private snapshotSavingRooms = new Set<string>();
  private snapshotVersions = new Map<string, number>();
  private persistedSnapshotVersions = new Map<string, number>();
  private snapshotFlushTasks = new Map<string, Promise<void>>();
  private snapshotWaiters = new Map<
    string,
    Array<{
      version: number;
      resolve: () => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }>
  >();
  private codeSyncRequests = new Map<
    string,
    Promise<{
      ok: boolean;
      persisted?: boolean;
      sequence: number;
      error?: string;
    }>
  >();
  private lastPersistedSnapshots = new Map<string, string | null>();
  private socketMemberships = new Map<string, Map<string, SocketMembership>>();
  private disconnectReasons = new Map<string, string>();
  private intentionalDisconnectReasons = new Map<string, 'hidden_tab'>();
  private recentDisconnects = new Map<
    string,
    { disconnectedAt: number; reason: string }
  >();

  constructor(private readonly roomService: RoomService) {}

  activeRooms: Room[] = [];

  @WebSocketServer() server: Server;

  private getMemberPayload(room: Room) {
    return room.members.map((member) => ({
      telegramId: member.telegramId,
      username: member.username,
      online: member.online,
      userColor: member.userColor,
      lastActivity: member.lastActivity,
    }));
  }

  private userHash(value?: string): string {
    if (!value) return 'anonymous';
    return createHmac('sha256', this.logHashKey)
      .update(value)
      .digest('hex')
      .slice(0, 16);
  }

  private reconnectKey(roomId: string, clientInstanceId?: string): string | null {
    if (!clientInstanceId) return null;
    return `${roomId}:${clientInstanceId}`;
  }

  private disconnectReasonCategory(clientId: string, reason?: string): string {
    const intentional = this.intentionalDisconnectReasons.get(clientId);
    if (intentional) return intentional;
    const normalized = String(reason ?? '').toLowerCase();
    if (normalized.includes('ping timeout')) return 'ping_timeout';
    if (normalized.includes('transport')) return 'transport_close';
    if (normalized.includes('client namespace disconnect')) {
      return 'client_disconnect';
    }
    if (normalized.includes('server namespace disconnect')) {
      return 'server_disconnect';
    }
    return 'other';
  }

  private rememberReconnectCandidate(
    roomId: string,
    clientInstanceId: string | undefined,
    reason: string,
    now = Date.now(),
  ): void {
    const key = this.reconnectKey(roomId, clientInstanceId);
    if (!key) return;
    for (const [candidateKey, candidate] of this.recentDisconnects) {
      if (now - candidate.disconnectedAt > RECONNECT_TRACKING_TTL_MS) {
        this.recentDisconnects.delete(candidateKey);
      }
    }
    while (this.recentDisconnects.size >= RECONNECT_TRACKING_MAX_ENTRIES) {
      const oldestKey = this.recentDisconnects.keys().next().value as
        | string
        | undefined;
      if (!oldestKey) break;
      this.recentDisconnects.delete(oldestKey);
    }
    this.recentDisconnects.set(key, { disconnectedAt: now, reason });
  }

  private recordReconnectSuccess(
    roomId: string,
    clientInstanceId?: string,
    now = Date.now(),
  ): void {
    const key = this.reconnectKey(roomId, clientInstanceId);
    if (!key) return;
    const previous = this.recentDisconnects.get(key);
    if (!previous) return;
    this.recentDisconnects.delete(key);
    if (now - previous.disconnectedAt > RECONNECT_TRACKING_TTL_MS) return;
    socketMetrics.increment('ide_socket_reconnect_success_total', {
      reason: previous.reason,
    });
    socketMetrics.observe(
      'ide_socket_reconnect_duration_seconds',
      (now - previous.disconnectedAt) / 1_000,
      { reason: previous.reason },
    );
  }

  private normalizeBinaryUpdate(value: unknown): Uint8Array {
    const size = (value as any)?.byteLength ?? (Array.isArray(value) ? value.length : (value as any)?.data?.length);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_UPDATE_BYTES) throw new Error('Слишком большое обновление кода');
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (Array.isArray(value)) return new Uint8Array(value);
    const bufferLike = value as { data?: number[] } | null;
    if (bufferLike?.data && Array.isArray(bufferLike.data)) {
      return new Uint8Array(bufferLike.data);
    }
    throw new Error('Invalid Yjs update payload');
  }

  private emitMembersUpdated(room: Room, trigger: string, telegramId: string) {
    this.server.to(room.id).emit('members-updated', {
      members: this.getMemberPayload(room),
      trigger,
      telegramId,
    });
  }

  private rememberSocketMembership(
    clientId: string,
    roomId: string,
    telegramId: string,
  ) {
    const memberships =
      this.socketMemberships.get(clientId) ??
      new Map<string, SocketMembership>();
    memberships.set(roomId, { roomId, telegramId });
    this.socketMemberships.set(clientId, memberships);
  }

  private forgetSocketMembership(clientId: string, roomId: string) {
    const memberships = this.socketMemberships.get(clientId);
    if (!memberships) {
      return;
    }

    memberships.delete(roomId);
    if (memberships.size === 0) {
      this.socketMemberships.delete(clientId);
    }
  }

  private getSocketById(clientId: string): Socket | undefined {
    return this.server?.sockets?.sockets?.get(clientId);
  }

  private isCurrentSocketMember(
    client: Socket,
    roomId: string,
    telegramId: string,
  ): boolean {
    const membership = this.socketMemberships.get(client.id)?.get(roomId);
    if (!membership || membership.telegramId !== telegramId) return false;

    const activeRoom = this.activeRooms.find((room) => room.id === roomId);
    const member = activeRoom?.members.find(
      (item) => item.telegramId === telegramId,
    );
    return Boolean(member?.online && member.clientId === client.id);
  }

  private async disconnectReplacedSocket(
    clientId: string,
    roomId: string,
    notifyUser: boolean,
  ) {
    this.forgetSocketMembership(clientId, roomId);

    const socket = this.getSocketById(clientId);
    if (!socket) {
      return;
    }

    if (notifyUser) {
      socket.emit('room-session-replaced', { roomId });
    }

    try {
      await socket.leave(roomId);
    } catch {
      // Socket.IO can already have removed the socket from all rooms.
    }

    socket.disconnect(true);
  }

  private async recordPresence(members: Member[], leaving = false) {
    const at = new Date();
    const pending = members.map(member => {
      const presence = member.presence;
      if (leaving) member.presence = undefined;
      return presence;
    });
    const ids = (await Promise.all(pending)).filter((id): id is string => Boolean(id));
    if (!ids.length) return;
    try {
      await this.roomService.recordPresence(ids, at, leaving);
    } catch {
      this.logger.warn('Could not update room presence history');
    }
  }

  private async markSocketLeft(
    client: Socket,
    options: { exceptRoomId?: string } = {},
  ) {
    const rememberedMemberships = this.socketMemberships.get(client.id);
    const rememberedRoomIds = new Set(rememberedMemberships?.keys() ?? []);
    const roomsToCheck = this.activeRooms.filter(
      (room) =>
        rememberedRoomIds.has(room.id) ||
        room.members.some((member) => member.clientId === client.id),
    );

    for (const room of roomsToCheck) {
      if (room.id === options.exceptRoomId) {
        continue;
      }

      const members = room.members.filter((m) => m.clientId === client.id);
      if (members.length === 0) {
        this.forgetSocketMembership(client.id, room.id);
        continue;
      }

      for (const member of members) {
        member.online = false;
        void this.recordPresence([member], true);
        member.lastSelection = undefined;
        this.forgetSocketMembership(client.id, room.id);

        try {
          await client.leave(room.id);
        } catch {
          // Socket.IO can already have removed the socket from all rooms.
        }

        this.server.to(room.id).emit('member-left', {
          telegramId: member.telegramId,
          keepCursor: true,
        });

        this.emitMembersUpdated(room, 'leave', member.telegramId);
      }

      const currentSelections = room.members
        .filter((m) => m.lastSelection && m.online)
        .map((m) => ({
          telegramId: m.telegramId,
          ...m.lastSelection,
          userColor: m.userColor,
        }));

      this.server.to(room.id).emit('selection-state', {
        selections: currentSelections,
        updatedUser: members[members.length - 1].telegramId,
      });

      const onlineMembers = room.members.filter((m) => m.online);
      if (onlineMembers.length === 0 && !this.switchingLessons.has(room.id)) {
        await this.flushRoomSnapshot(room.id, { force: true });

        const roomIndex = this.activeRooms.findIndex((r) => r.id === room.id);
        if (roomIndex > -1) {
          this.activeRooms.splice(roomIndex, 1);
        }

        this.cleanupRoomState(room.id);
      }
    }
  }

  private generateUserColor(userId: string): string {
    const colors = [
      '#FF6B6B',
      '#4ECDC4',
      '#45B7D1',
      '#96CEB4',
      '#FFEAA7',
      '#DDA0DD',
      '#98D8C8',
      '#F7DC6F',
      '#BB8FCE',
      '#85C1E9',
      '#F8C471',
      '#82E0AA',
      '#F1948A',
      '#85929E',
      '#D7BDE2',
    ];

    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      hash = userId.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  }

  private lessonState(room: Room | RoomRdo) {
    return {
      revision: room.lessonRevision ?? 0,
      key: room.lessonKey ?? 'free',
      task: room.lessonTask ?? null,
      language: room.language,
    };
  }

  private acceptsLessonRevision(roomId: string, revision?: number) {
    const current = this.activeRooms.find(room => room.id === roomId)?.lessonRevision ?? 0;
    return !this.switchingLessons.has(roomId) && (revision ?? 0) === current;
  }

  @SubscribeMessage('room-lesson:select')
  async selectLesson(
    @MessageBody() data: JoinPayload & { source: string; id?: unknown; revision: number },
    @ConnectedSocket() client: Socket,
  ) {
    const room = this.activeRooms.find(item => item.id === data.roomId);
    if (!room || room.completed || room.teacher !== data.telegramId ||
        client.data?.roomAuth?.userId !== room.teacher ||
        client.data?.roomAuth?.roomId !== room.id ||
        client.data.roomAuth.exp <= Math.floor(Date.now() / 1000) ||
        !this.isCurrentSocketMember(client, room.id, data.telegramId)) {
      return { ok: false, error: 'Выбор задач доступен владельцу комнаты' };
    }
    if (this.resolvingLessons.has(room.id) || !this.acceptsLessonRevision(room.id, data.revision)) {
      return { ok: false, error: 'Задача уже меняется. Повторите выбор' };
    }
    // Resolve platform content before blocking edits in the room.
    let selection: Awaited<ReturnType<RoomService['resolveLesson']>>;
    this.resolvingLessons.add(room.id);
    try {
      selection = await this.roomService.resolveLesson(room.teacher, data.source, data.id);
    } catch (error) {
      return { ok: false, error: error?.getStatus?.() < 500 ? error.message : 'Не удалось загрузить задачу' };
    } finally {
      this.resolvingLessons.delete(room.id);
    }
    if (room.completed || !this.acceptsLessonRevision(room.id, data.revision) ||
        !this.isCurrentSocketMember(client, room.id, data.telegramId)) {
      return { ok: false, error: 'Комната изменилась. Повторите выбор' };
    }
    this.switchingLessons.add(room.id);
    let candidate: Y.Doc | undefined;
    let old: Y.Doc | undefined;
    try {
      old = await this.getOrCreateDoc(room.id);
      await this.snapshotFlushTasks.get(room.id);
      const outgoing = Buffer.from(Y.encodeStateAsUpdate(old)).toString('base64');
      const next = await this.roomService.switchLesson(
        room.id, room.teacher, data.revision, selection.key, selection.task, outgoing,
        (snapshot, task, codeInline) => {
          const doc = new Y.Doc();
          candidate = doc;
          if (snapshot) {
            if (snapshot.length > Math.ceil(MAX_SNAPSHOT_BYTES / 3) * 4) throw new Error('Snapshot too large');
            Y.applyUpdate(doc, Buffer.from(snapshot, 'base64'));
          } else if (task?.initialCode) {
            doc.getText('codemirror').insert(0, task.initialCode);
          }
          if (!codeInline) insertLessonTemplate(doc.getText('codemirror'), task);
          return Buffer.from(this.resourceBudget.holdReplacement(room.id, doc)).toString('base64');
        },
      );
      if (next && candidate) {
        this.resourceBudget.remember(room.id, candidate);
        this.docs.set(room.id, candidate);
        candidate = undefined;
        old.destroy();
        const version = this.snapshotVersions.get(room.id) ?? 0;
        this.persistedSnapshotVersions.set(room.id, version);
        this.settleSnapshotWaiters(room.id, version);
        this.snapshotDirtyRooms.delete(room.id);
        this.lastPersistedSnapshots.delete(room.id);
        const live = this.activeRooms.find(item => item.id === room.id) ?? room;
        live.lessonKey = next.lessonKey;
        live.lessonRevision = next.lessonRevision;
        live.lessonTask = next.lessonTask;
        live.language = next.language;
        for (const member of live.members) {
          member.lastCursorPosition = undefined;
          member.lastSelection = undefined;
        }
        this.server.to(room.id).emit('room-lesson:changed', this.lessonState(live));
      }
      return { ok: true };
    } catch {
      return { ok: false, error: 'Не удалось сохранить черновик и переключить задачу' };
    } finally {
      if (candidate) {
        candidate.destroy();
        if (old) this.resourceBudget.remember(room.id, old);
      }
      this.switchingLessons.delete(room.id);
      if (this.snapshotDirtyRooms.has(room.id)) void this.flushRoomSnapshot(room.id);
      const live = this.activeRooms.find(item => item.id === room.id) ?? room;
      if (!live.members.some(member => member.online)) {
        await this.flushRoomSnapshot(room.id, { force: true });
        this.activeRooms = this.activeRooms.filter(item => item.id !== room.id);
        this.cleanupRoomState(room.id);
      }
    }
  }

  @SubscribeMessage('join-room') async handleJoinRoom(
    @MessageBody() data: JoinPayload,
    @ConnectedSocket() client: Socket,
  ) {
    const { telegramId, roomId, username, clientInstanceId } = data;
    if ((username !== undefined && (typeof username !== 'string' || username.length > 120)) ||
        (clientInstanceId !== undefined && (typeof clientInstanceId !== 'string' || clientInstanceId.length > 128))) {
      client.emit('join-room:error', {message:'Слишком длинные данные участника'}); return;
    }

    let room = await this.roomService.getRoom(roomId);

    if (!room) {
      client.emit('join-room:error', { message: 'Комната не найдена' });
      return;
    }

    let doc: Y.Doc;
    try { doc = await this.getOrCreateDoc(roomId); }
    catch { client.emit('join-room:error', { message: 'Документ превышает лимит или редактор временно занят. Сохранённый код не изменён' }); return; }

    const isParticipant =
      room.teacher === telegramId || room.students.includes(telegramId);

    if (!isParticipant) {
      room = await this.roomService.joinRoom(room.id, telegramId);
    }

    const persistedMember = await this.roomService.upsertRoomMember(
      room.id,
      telegramId,
      username,
    );
    const effectiveUsername =
      username || persistedMember?.username || undefined;

    await this.markSocketLeft(client, { exceptRoomId: room.id });
    await client.join(room.id);

    let activeRoom = this.activeRooms.find((r) => r.id === room.id);

    if (!activeRoom) {
      activeRoom = {
        id: room.id,
        language: room.language,
        lessonRevision: room.lessonRevision,
        lessonKey: room.lessonKey,
        lessonTask: room.lessonTask,
        members: [],
        studentCursorEnabled: room.studentCursorEnabled ?? true,
        studentSelectionEnabled: room.studentSelectionEnabled ?? true,
        studentEditCodeEnabled: room.studentEditCodeEnabled ?? true,
        completed: room.completed,
        teacher: room.teacher,
      };
      this.activeRooms.push(activeRoom);
      this.startSnapshotTimer(room.id);
    }

    activeRoom.members = activeRoom.members.filter((member) => {
      const isPreviousIdentityOnSameSocket =
        member.clientId === client.id && member.telegramId !== telegramId;

      if (isPreviousIdentityOnSameSocket) {
        void this.recordPresence([member], true);
        this.forgetSocketMembership(client.id, activeRoom.id);
      }

      return !isPreviousIdentityOnSameSocket;
    });

    const sameIdentityMembers = activeRoom.members.filter(
      (member) => member.telegramId === telegramId,
    );

    for (const member of sameIdentityMembers) {
      if (member.clientId !== client.id) {
        void this.recordPresence([member], true);
        const sameBrowserReconnect = Boolean(
          clientInstanceId && member.clientInstanceId === clientInstanceId,
        );
        await this.disconnectReplacedSocket(
          member.clientId,
          activeRoom.id,
          !sameBrowserReconnect,
        );
      }
    }

    let keptSameIdentity = false;
    activeRoom.members = activeRoom.members.filter((member) => {
      if (member.telegramId !== telegramId) {
        return true;
      }

      if (!keptSameIdentity) {
        keptSameIdentity = true;
        return true;
      }

      this.forgetSocketMembership(member.clientId, activeRoom.id);
      return false;
    });

    const existingMember = activeRoom.members.find(
      (member) => member.telegramId === telegramId,
    );

    if (existingMember) {
      existingMember.online = true;
      existingMember.clientId = client.id;
      existingMember.clientInstanceId = clientInstanceId;
      existingMember.lastActivity = new Date();
      if (effectiveUsername) {
        existingMember.username = effectiveUsername;
      }
    } else {
      activeRoom?.members.push({
        clientId: client.id,
        clientInstanceId,
        telegramId,
        username: effectiveUsername,
        online: true,
        userColor: this.generateUserColor(telegramId),
        lastActivity: new Date(),
      });
    }

    const currentMember = existingMember ?? activeRoom.members.at(-1);
    const claims = client.data?.roomAuth;
    if (currentMember && !currentMember.presence && !activeRoom.completed &&
        claims?.roomId === roomId && claims.userId === telegramId &&
        claims.exp > Math.floor(Date.now() / 1000)) {
      const id = randomUUID();
      currentMember.presence = this.roomService.startPresence(id, roomId, telegramId, new Date(), effectiveUsername)
        .then(started => started ? id : undefined)
        .catch(() => {
          this.logger.warn('Could not start room presence history');
          return undefined;
        });
    }
    this.rememberSocketMembership(client.id, activeRoom.id, telegramId);
    this.recordReconnectSuccess(activeRoom.id, clientInstanceId);
    this.logger.log(
      JSON.stringify({
        event: sameIdentityMembers.length > 0 ? 'room_rejoin' : 'room_join',
        roomId: activeRoom.id,
        userHash: this.userHash(telegramId),
        clientInstanceHash: this.userHash(clientInstanceId),
        transport: client.conn?.transport?.name,
      }),
    );
    this.emitMembersUpdated(activeRoom, 'join', telegramId);

    const currentCursors = activeRoom?.members
      .filter((m) => m.lastCursorPosition && m.online)
      .map((m) => ({
        telegramId: m.telegramId,
        position: m.lastCursorPosition,
        userColor: m.userColor,
        username: m.username,
      }));

    const currentSelections = activeRoom.members
      .filter((m) => m.lastSelection && m.online)
      .map((m) => ({
        telegramId: m.telegramId,
        ...m.lastSelection,
        userColor: m.userColor,
        username: m.username,
      }));

    client.emit('joined', {
      telegramId,
      username: effectiveUsername,
      currentCursors,
      currentSelections,
      userColor:
        existingMember?.userColor || this.generateUserColor(telegramId),
      isTeacher: room.teacher === telegramId,
      roomPermissions: {
        studentCursorEnabled: activeRoom?.studentCursorEnabled,
        studentSelectionEnabled: activeRoom?.studentSelectionEnabled,
        studentEditCodeEnabled: activeRoom?.studentEditCodeEnabled,
      },
      language: activeRoom.language ?? room.language,
      ...(activeRoom.lessonRevision ? { lesson: this.lessonState(activeRoom) } : {}),
      completed: room.completed,
    });


    client.emit('code-edit-action', {
      update: Y.encodeStateAsUpdate(this.docs.get(room.id) ?? doc),
      lessonRevision: activeRoom.lessonRevision ?? 0,
    });

    client.emit('selection-state', {
      selections: currentSelections,
      updatedUser: data.telegramId,
    });
  }

  @SubscribeMessage('code-sync:init') async handleCodeSyncInit(
    @MessageBody() data: CodeSyncInitPayload,
    @ConnectedSocket() client: Socket,
  ) {
    try {
      if (!this.acceptsLessonRevision(data.roomId, data.lessonRevision) ||
          !this.isCurrentSocketMember(client, data.roomId, data.telegramId)) {
        return { ok: false, error: 'Сессия комнаты устарела' };
      }
      const doc = await this.getOrCreateDoc(data.roomId);
      if (!this.acceptsLessonRevision(data.roomId, data.lessonRevision) ||
          !this.isCurrentSocketMember(client, data.roomId, data.telegramId)) {
        return { ok: false, error: 'Сессия комнаты устарела' };
      }
      const clientStateVector = this.normalizeBinaryUpdate(data.stateVector);
      const serverUpdate = Y.encodeStateAsUpdate(doc, clientStateVector);
      const serverStateVector = Y.encodeStateVector(doc);
      this.resourceBudget.consume(data.roomId, client.id, Math.max(clientStateVector.byteLength, serverUpdate.byteLength), Date.now(), true);

      this.logger.log(
        JSON.stringify({
          event: 'code_sync_init',
          roomId: data.roomId,
          userHash: this.userHash(data.telegramId),
          clientInstanceHash: this.userHash(data.clientInstanceId),
          serverUpdateBytes: serverUpdate.byteLength,
        }),
      );

      return {
        ok: true,
        serverUpdate,
        serverStateVector,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        JSON.stringify({
          event: 'code_sync_init_failed',
          roomId: data.roomId,
          userHash: this.userHash(data.telegramId),
          reason: message,
        }),
      );
      return { ok: false, error: 'Не удалось синхронизировать код' };
    }
  }

  @SubscribeMessage('code-sync:update') async handleCodeSyncUpdate(
    @MessageBody() data: CodeSyncUpdatePayload,
    @ConnectedSocket() client: Socket,
  ) {
    if (typeof data.clientInstanceId !== 'string' || data.clientInstanceId.length > 128 || !Number.isSafeInteger(data.sequence) || data.sequence < 0) {
      return {ok:false, sequence:data.sequence, error:'Некорректный идентификатор синхронизации'};
    }
    const activeRoom = this.activeRooms.find((room) => room.id === data.roomId);
    if (!activeRoom) {
      return {
        ok: false,
        sequence: data.sequence,
        error: 'Комната не найдена',
      };
    }
    if (activeRoom.completed && activeRoom.teacher !== data.telegramId) {
      return { ok: false, sequence: data.sequence, error: 'Комната завершена' };
    }
    if (
      !activeRoom.studentEditCodeEnabled &&
      data.telegramId !== activeRoom.teacher
    ) {
      return {
        ok: false,
        sequence: data.sequence,
        error: 'Редактирование кода отключено в этой комнате',
      };
    }
    if (!this.acceptsLessonRevision(data.roomId, data.lessonRevision) ||
          !this.isCurrentSocketMember(client, data.roomId, data.telegramId)) {
      return {
        ok: false,
        sequence: data.sequence,
        error: 'Сессия комнаты устарела',
      };
    }

    const requestKey = [
      data.roomId,
      data.telegramId,
      data.clientInstanceId,
      String(data.lessonRevision ?? 0),
      String(data.sequence),
    ].join(':');
    const existingRequest = this.codeSyncRequests.get(requestKey);
    if (existingRequest) return existingRequest;

    const request = (async () => {
      try {
        const update = this.normalizeBinaryUpdate(data.update);
        const doc = await this.getOrCreateDoc(data.roomId);
        if (!this.acceptsLessonRevision(data.roomId, data.lessonRevision) ||
          !this.isCurrentSocketMember(client, data.roomId, data.telegramId)) {
          return {
            ok: false,
            sequence: data.sequence,
            error: 'Сессия комнаты устарела',
          };
        }
        this.resourceBudget.consume(data.roomId, client.id, update.byteLength);
        const integratedUpdate = this.resourceBudget.apply(data.roomId, doc, update, applyYjsUpdate);
        const version = this.markRoomSnapshotDirty(data.roomId);

        const member = activeRoom.members.find(
          (item) => item.telegramId === data.telegramId,
        );
        if (member) member.lastActivity = new Date();

        if (integratedUpdate) {
          client.broadcast.to(activeRoom.id).emit('code-edit-action', {
            telegramId: data.telegramId,
            userColor: member?.userColor,
            username: member?.username,
            update: integratedUpdate,
            lessonRevision: data.lessonRevision ?? 0,
          });
        }

        await this.waitForPersistedSnapshot(data.roomId, version);

        this.logger.log(
          JSON.stringify({
            event: 'code_sync_ack',
            roomId: data.roomId,
            userHash: this.userHash(data.telegramId),
            clientInstanceHash: this.userHash(data.clientInstanceId),
            sequence: data.sequence,
            updateBytes: update.byteLength,
            snapshotVersion: version,
          }),
        );

        return { ok: true, persisted: true, sequence: data.sequence };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          JSON.stringify({
            event: 'code_sync_update_failed',
            roomId: data.roomId,
            userHash: this.userHash(data.telegramId),
            sequence: data.sequence,
            reason: message,
          }),
        );
        return {
          ok: false,
          sequence: data.sequence,
          error: 'Не удалось сохранить изменение кода',
        };
      }
    })();

    this.codeSyncRequests.set(requestKey, request);
    void request.then((response) => {
      if (!response.ok && this.codeSyncRequests.get(requestKey) === request) {
        this.codeSyncRequests.delete(requestKey);
      }
    });
    if (this.codeSyncRequests.size > 2_048) {
      const oldestKey = Array.from(this.codeSyncRequests.keys())[0];
      if (oldestKey) this.codeSyncRequests.delete(oldestKey);
    }
    return request;
  }

  @SubscribeMessage('edit-room') async handleEditRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: EditPayload,
  ) {
    const room = await this.roomService.getRoom(data.roomId);

    if (!room) {
      client.emit('error', { message: 'Комната не найдена' });
      return;
    }
    if (room.completed) return;
    if (data.language !== undefined && !this.acceptsLessonRevision(room.id, data.lessonRevision)) return;
    if (data.language !== undefined && room.lessonKey?.startsWith('platform:')) {
      client.emit('edit-room:error', { message: 'Язык задан платформенной задачей' });
      return;
    }


    if (
      data.language !== undefined &&
      !Object.values(Language).includes(data.language)
    ) {
      client.emit('edit-room:error', {
        message: 'Неподдерживаемый язык программирования',
      });
      return;
    }

    if (room.teacher !== data.telegramId) {
      if (
        !this.isCurrentSocketMember(client, room.id, data.telegramId) ||
        data.language === undefined ||
        data.taskId !== undefined ||
        data.studentCursorEnabled !== undefined ||
        data.studentEditCodeEnabled !== undefined ||
        data.studentSelectionEnabled !== undefined
      ) {
        client.emit('edit-room:error', { message: 'Недостаточно прав для изменения настроек комнаты' });
        return;
      }
      const updatedRoom = await this.roomService.changeLanguage(
        room.id, data.telegramId, data.language,
        ...(room.lessonRevision !== undefined ? [room.lessonRevision] : []),
      );
      const live = this.activeRooms.find(item => item.id === room.id);
      if (live && (live.lessonRevision ?? 0) === (updatedRoom.lessonRevision ?? 0)) live.language = updatedRoom.language;
      this.server.to(room.id).emit('room-edited', fillDto(RoomRdo, updatedRoom));
      return;
    }

    // Получаем текущую активную комнату для сохранения настроек
    const activeRoom = this.activeRooms.find((r) => r.id === room.id);

    const updatedRoom = await this.roomService.editRoom(room.id, {
      studentCursorEnabled: data.studentCursorEnabled,
      studentEditCodeEnabled: data.studentEditCodeEnabled,
      studentSelectionEnabled: data.studentSelectionEnabled,
      language: data.language,
      telegramId: data.telegramId,
      taskId: data.taskId,
    }, ...(data.language !== undefined && room.lessonRevision !== undefined ? [room.lessonRevision] : []));

    this.activeRooms = this.activeRooms.map((activeRoomItem) => {
      if (activeRoomItem.id === updatedRoom.id) {
        return {
          ...activeRoomItem,
          ...(data.language !== undefined && (activeRoomItem.lessonRevision ?? 0) === (updatedRoom.lessonRevision ?? 0)
            ? { language: updatedRoom.language } : {}),
          // Используем переданные значения или сохраняем текущие из activeRoom или room
          studentCursorEnabled:
            data.studentCursorEnabled !== undefined
              ? Boolean(data.studentCursorEnabled)
              : (activeRoom?.studentCursorEnabled ?? room.studentCursorEnabled),
          studentEditCodeEnabled:
            data.studentEditCodeEnabled !== undefined
              ? Boolean(data.studentEditCodeEnabled)
              : (activeRoom?.studentEditCodeEnabled ??
                room.studentEditCodeEnabled),
          studentSelectionEnabled:
            data.studentSelectionEnabled !== undefined
              ? Boolean(data.studentSelectionEnabled)
              : (activeRoom?.studentSelectionEnabled ??
                room.studentSelectionEnabled),
        };
      }

      return activeRoomItem;
    });

    this.server
      .to(data.roomId)
      .emit('room-edited', fillDto(RoomRdo, updatedRoom));
  }

  @SubscribeMessage('cursor') handleCursor(
    client: Socket,
    data: CursorPayload,
  ) {
    const activeRoom = this.activeRooms.find((room) => room.id === data.roomId);

    if (!activeRoom) {
      client.emit('error', { message: 'Комната не найдена' });
      return;
    }

    if (activeRoom.completed) return;

    if (!activeRoom.studentCursorEnabled) return;

    if (data.position.length !== 2) {
      client.emit('error', {
        message: 'Позиция по курсору может иметь только два значения - x, y',
      });
      return;
    }

    const member = activeRoom.members.find(
      (m) => m.telegramId === data.telegramId,
    );
    if (member) {
      member.lastCursorPosition = [data.position[0], data.position[1]];
      member.lastActivity = new Date();
    }

    const cursorData = {
      ...data,
      userColor: member?.userColor,
      username: member?.username,
    };

    client.broadcast.to(activeRoom.id).emit('cursor-action', cursorData);
  }

  @SubscribeMessage('task-scroll') handleTaskScroll(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: TaskScrollPayload,
  ) {
    if (
      typeof data?.roomId !== 'string' ||
      !Number.isSafeInteger(data.lessonRevision) ||
      (data.taskId !== null &&
        (typeof data.taskId !== 'string' || data.taskId.length > 128)) ||
      !Number.isFinite(data.progress) ||
      data.progress < 0 || data.progress > 1
    ) return;

    const { roomId, telegramId, lessonRevision, taskId, progress } = data;
    if (!this.isCurrentSocketMember(client, roomId, telegramId)) return;

    const room = this.activeRooms.find((item) => item.id === roomId);
    if (!room?.studentCursorEnabled || room.completed ||
        !this.acceptsLessonRevision(roomId, lessonRevision)) return;

    client.broadcast.to(roomId).emit('task-scroll-action', {
      roomId, lessonRevision, taskId, progress,
    });
  }

  @SubscribeMessage('selection') handleSelection(
    client: Socket,
    data: SelectionPayload,
  ) {
    const activeRoom = this.activeRooms.find((room) => room.id === data.roomId);

    if (!activeRoom) {
      return client.emit('error', {
        message: 'Комната не найдена',
      });
    }

    if (activeRoom.completed && activeRoom.teacher !== data.telegramId) return;

    if (
      !activeRoom.studentSelectionEnabled &&
      activeRoom.teacher !== data.telegramId
    )
      return;

    const member = activeRoom.members.find(
      (m) => m.telegramId === data.telegramId,
    );

    if (member) {
      member.lastActivity = new Date();

      if (
        data.line &&
        typeof data.column === 'number' &&
        (!data.selectionStart || !data.selectionEnd || !data.selectedText)
      ) {
        member.lastSelection = {
          line: data.line,
          column: data.column,
        };
      } else if (
        data.selectionStart &&
        data.selectionEnd &&
        data.selectedText
      ) {
        member.lastSelection = {
          selectionStart: data.selectionStart,
          selectionEnd: data.selectionEnd,
          selectedText: data.selectedText,
        };
      } else if (data.clearSelection) {
        member.lastSelection = {};
      }
    }

    // Отправляем все актуальные выделения комнаты
    const currentSelections = activeRoom.members
      .filter((m) => m.online)
      .map((m) => ({
        telegramId: m.telegramId,
        ...m.lastSelection,
        userColor: m.userColor,
        username: m.username,
      }));

    client.broadcast.to(activeRoom.id).emit('selection-state', {
      selections: currentSelections,
      updatedUser: data.telegramId,
    });
  }

  @SubscribeMessage('code-edit') async handleCodeEdit(
    client: Socket,
    data: CodeEditPayload,
  ) {
    const activeRoom = this.activeRooms.find((room) => room.id === data.roomId);

    if (!activeRoom) {
      return client.emit('error', {
        message: 'Комната не найдена',
      });
    }

    if (activeRoom.completed && activeRoom.teacher !== data.telegramId) return;

    if (
      !activeRoom.studentEditCodeEnabled &&
      data.telegramId !== activeRoom.teacher
    ) {
      return client.emit('error', {
        message: 'Редактирование кода отключено в этой комнате',
      });
    }

    if (!data.telegramId) {
      return client.emit('error', {
        message: 'Не указан telegramId',
      });
    }
    if (!this.acceptsLessonRevision(data.roomId, data.lessonRevision) ||
        !this.isCurrentSocketMember(client, data.roomId, data.telegramId)) {
      return client.emit('error', {
        message: 'Сессия комнаты устарела',
      });
    }

    const member = activeRoom.members.find(
      (m) => m.telegramId === data.telegramId,
    );

    if (member) {
      member.lastActivity = new Date();
    }

    const doc = await this.getOrCreateDoc(data.roomId);
    if (!this.acceptsLessonRevision(data.roomId, data.lessonRevision) ||
        !this.isCurrentSocketMember(client, data.roomId, data.telegramId)) {
      return client.emit('error', {
        message: 'Сессия комнаты устарела',
      });
    }

    let integratedUpdate: Uint8Array | null;
    try {
      const update = this.normalizeBinaryUpdate(data.update);
      this.resourceBudget.consume(data.roomId, client.id, update.byteLength);
      integratedUpdate = this.resourceBudget.apply(data.roomId, doc, update, applyYjsUpdate);
    } catch {
      client.emit('error', { message: 'Обновление кода превышает лимит или повреждено' });
      return;
    }
    if (!integratedUpdate) return;
    this.markRoomSnapshotDirty(data.roomId);

    client.broadcast.to(activeRoom.id).emit('code-edit-action', {
      telegramId: data.telegramId,
      userColor: member?.userColor,
      username: member?.username,
      update: integratedUpdate,
      lessonRevision: data.lessonRevision ?? 0,
    });
  }

  @SubscribeMessage('edit-member') async handleEditMember(
    client: Socket,
    data: EditMember,
  ) {
    const activeRoom = this.activeRooms.find((room) => room.id === data.roomId);

    if (!activeRoom) {
      return client.emit('error', { message: 'Комната не найдена' });
    }

    if (activeRoom.completed) return;

    const member = activeRoom.members.find(
      (m) => m.telegramId === data.changeTelegramId,
    );

    if (
      member &&
      (member.telegramId === data.telegramId ||
        activeRoom.teacher === data.telegramId)
    ) {
      if (data.username !== undefined && (typeof data.username !== 'string' || data.username.length > 120)) {
        client.emit('error', {message:'Слишком длинное имя участника'}); return;
      }
      try { await this.roomService.upsertRoomMember(data.roomId, data.changeTelegramId, data.username); }
      catch { client.emit('error', {message:'Не удалось сохранить имя участника'}); return; }
      member.username = data.username;

      this.emitMembersUpdated(activeRoom, 'username-update', data.telegramId);
    } else {
      return client.emit('error', { message: 'Участник не найден в комнате' });
    }
  }

  @SubscribeMessage('close-session') async handleCloseSession(
    client: Socket,
    data: JoinPayload,
  ) {
    const room = await this.roomService.getRoom(data.roomId);

    if (!room || room.teacher !== data.telegramId) {
      client.emit('error', {
        message: 'Комната не найдена',
      });
      return;
    }

    if (room.completed) return;
    if (this.switchingLessons.has(room.id)) {
      client.emit('error', { message: 'Дождитесь переключения задачи' });
      return;
    }

    const active = this.activeRooms.find(item => item.id === room.id);
    if (room.lessonRevision) {
      this.switchingLessons.add(room.id);
      try {
        const doc = await this.getOrCreateDoc(room.id);
        await this.snapshotFlushTasks.get(room.id);
        await this.roomService.completeRoom(room.id, {
          revision: room.lessonRevision,
          language: room.language,
          snapshot: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
        });
        if (active) active.completed = true;
      } finally {
        this.switchingLessons.delete(room.id);
      }
    } else {
      await this.flushRoomSnapshot(data.roomId, { force: true });
      await this.roomService.completeRoom(data.roomId);
    }
    if (active) await this.recordPresence(active.members, true);

    this.activeRooms = this.activeRooms.filter(
      (activeRoom) => activeRoom.id !== room.id,
    );

    this.cleanupRoomState(room.id);

    this.server.to(room.id).emit('complete-session', {
      message: 'Учитель завершил сессию',
    });
  }

  @SubscribeMessage('client-lifecycle') async handleClientLifecycle(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: ClientLifecyclePayload,
  ) {
    if (
      data.state !== 'hidden' ||
      this.switchingLessons.has(data.roomId) ||
      !this.isCurrentSocketMember(client, data.roomId, data.telegramId)
    ) {
      return { ok: false };
    }
    this.intentionalDisconnectReasons.set(client.id, 'hidden_tab');
    try {
      await this.flushRoomSnapshot(data.roomId, { force: true });
      this.logger.log(
        JSON.stringify({
          event: 'room_suspended',
          roomId: data.roomId,
          telegramId: data.telegramId,
          clientInstanceId: data.clientInstanceId,
          reason: 'hidden_tab',
        }),
      );
      return { ok: true, persisted: true };
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'room_suspend_failed',
          roomId: data.roomId,
          telegramId: data.telegramId,
          clientInstanceId: data.clientInstanceId,
          reason: error instanceof Error ? error.message : 'unknown_error',
        }),
      );
      return {
        ok: false,
        persisted: false,
        error: 'Не удалось сохранить состояние комнаты',
      };
    }
  }

  async handleDisconnect(client: Socket) {
    const memberships = Array.from(
      this.socketMemberships.get(client.id)?.values() ?? [],
    );
    const rawReason =
      this.disconnectReasons.get(client.id) || client.conn?.readyState;
    const reasonCategory = this.disconnectReasonCategory(client.id, rawReason);
    for (const membership of memberships) {
      const activeRoom = this.activeRooms.find(
        (room) => room.id === membership.roomId,
      );
      const member = activeRoom?.members.find(
        (item) => item.clientId === client.id,
      );
      this.rememberReconnectCandidate(
        membership.roomId,
        member?.clientInstanceId,
        reasonCategory,
      );
      socketMetrics.increment('ide_socket_disconnect_total', {
        reason: reasonCategory,
      });
      this.logger.log(
        JSON.stringify({
          event: 'socket_disconnect',
          roomId: membership.roomId,
          userHash: this.userHash(membership.telegramId),
          transport: client.conn?.transport?.name,
          reason: rawReason,
          reasonCategory,
        }),
      );
    }
    this.resourceBudget.releaseSocket(client.id);
    this.disconnectReasons.delete(client.id);
    this.intentionalDisconnectReasons.delete(client.id);
    await this.markSocketLeft(client);
  }

  async beforeApplicationShutdown(signal?: string) {
    await Promise.allSettled(this.activeRooms.map(room => this.recordPresence(room.members, true)));
    const roomIds = [...this.docs.keys()];
    if (roomIds.length === 0) {
      return;
    }

    this.logger.log(
      `Flushing ${roomIds.length} active IDE room snapshot(s) before shutdown${signal ? ` (${signal})` : ''}`,
    );

    await Promise.allSettled(
      roomIds.map((roomId) => this.flushRoomSnapshot(roomId, { force: true })),
    );
  }

  private startSnapshotTimer(roomId: string): void {
    if (this.timers.has(roomId)) {
      return;
    }

    const timer = setInterval(() => {
      void this.flushRoomSnapshot(roomId);
      const active = this.activeRooms.find(room => room.id === roomId);
      const now = Date.now();
      if (active && !active.completed && now - (active.presenceHeartbeatAt ?? 0) >= 30_000) {
        active.presenceHeartbeatAt = now;
        void this.recordPresence(active.members.filter(member => member.online));
      }
    }, this.SNAPSHOT_INTERVAL_MS);
    timer.unref?.();

    this.timers.set(roomId, timer);
  }

  private markRoomSnapshotDirty(roomId: string): number {
    const version = (this.snapshotVersions.get(roomId) ?? 0) + 1;
    this.snapshotVersions.set(roomId, version);
    this.snapshotDirtyRooms.add(roomId);

    const existingTimer = this.snapshotDebounceTimers.get(roomId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.snapshotDebounceTimers.delete(roomId);
      void this.flushRoomSnapshot(roomId);
    }, this.SNAPSHOT_DEBOUNCE_MS);
    timer.unref?.();

    this.snapshotDebounceTimers.set(roomId, timer);
    return version;
  }

  private waitForPersistedSnapshot(
    roomId: string,
    version: number,
  ): Promise<void> {
    if ((this.persistedSnapshotVersions.get(roomId) ?? 0) >= version) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiters = this.snapshotWaiters.get(roomId) ?? [];
      const waiter = {
        version,
        resolve,
        reject,
        timeout: setTimeout(() => {
          const currentWaiters = this.snapshotWaiters.get(roomId) ?? [];
          const remaining = currentWaiters.filter((item) => item !== waiter);
          if (remaining.length > 0) this.snapshotWaiters.set(roomId, remaining);
          else this.snapshotWaiters.delete(roomId);
          reject(new Error('Snapshot acknowledgement timed out'));
        }, this.SNAPSHOT_ACK_TIMEOUT_MS),
      };
      waiter.timeout.unref?.();
      waiters.push(waiter);
      this.snapshotWaiters.set(roomId, waiters);
    });
  }

  private settleSnapshotWaiters(
    roomId: string,
    persistedVersion: number,
    error?: Error,
  ): void {
    const waiters = this.snapshotWaiters.get(roomId) ?? [];
    const remaining: typeof waiters = [];

    for (const waiter of waiters) {
      if (waiter.version <= persistedVersion || error) {
        clearTimeout(waiter.timeout);
        if (error) waiter.reject(error);
        else waiter.resolve();
      } else {
        remaining.push(waiter);
      }
    }

    if (remaining.length > 0) this.snapshotWaiters.set(roomId, remaining);
    else this.snapshotWaiters.delete(roomId);
  }

  private cleanupRoomState(roomId: string): void {
    const timer = this.timers.get(roomId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(roomId);
    }

    const debounceTimer = this.snapshotDebounceTimers.get(roomId);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      this.snapshotDebounceTimers.delete(roomId);
    }

    this.snapshotDirtyRooms.delete(roomId);
    this.snapshotSavingRooms.delete(roomId);
    this.snapshotVersions.delete(roomId);
    this.persistedSnapshotVersions.delete(roomId);
    this.snapshotFlushTasks.delete(roomId);
    for (const key of this.codeSyncRequests.keys()) {
      if (key.startsWith(`${roomId}:`)) this.codeSyncRequests.delete(key);
    }
    this.settleSnapshotWaiters(
      roomId,
      Number.MAX_SAFE_INTEGER,
      new Error('Room state was disposed before persistence'),
    );
    this.docInitTasks.delete(roomId);
    this.lastPersistedSnapshots.delete(roomId);

    const doc = this.docs.get(roomId);
    if (doc) {
      doc.destroy();
      this.docs.delete(roomId);
      this.resourceBudget.releaseRoom(roomId);
    }
  }

  private async flushRoomSnapshot(
    roomId: string,
    options: { force?: boolean } = {},
  ): Promise<void> {
    let force = options.force ?? false;
    let failed = false;
    const existingTask = this.snapshotFlushTasks.get(roomId);
    if (existingTask) return existingTask;

    if (this.switchingLessons.has(roomId) || (!force && !this.snapshotDirtyRooms.has(roomId))) return;

    const task = (async () => {
      this.snapshotSavingRooms.add(roomId);
      try {
        do {
          const doc = this.docs.get(roomId);
          if (!doc) return;

          const version = this.snapshotVersions.get(roomId) ?? 0;
          const persistedVersion =
            this.persistedSnapshotVersions.get(roomId) ?? 0;
          if (!force && persistedVersion >= version) break;

          const snapshot = Buffer.from(Y.encodeStateAsUpdate(doc)).toString(
            'base64',
          );

          if (this.lastPersistedSnapshots.get(roomId) !== snapshot) {
            const revision = this.activeRooms.find(room => room.id === roomId)?.lessonRevision;
            if (revision) await this.roomService.saveRoomSnapshot(roomId, snapshot, revision);
            else await this.roomService.saveRoomSnapshot(roomId, snapshot);
            this.lastPersistedSnapshots.set(roomId, snapshot);
          }

          this.persistedSnapshotVersions.set(roomId, version);
          this.settleSnapshotWaiters(roomId, version);
          this.logger.log(
            JSON.stringify({
              event: 'room_snapshot_persisted',
              roomId,
              snapshotVersion: version,
              snapshotBytes: snapshot.length,
            }),
          );
          force = false;
        } while (
          (this.persistedSnapshotVersions.get(roomId) ?? 0) <
          (this.snapshotVersions.get(roomId) ?? 0)
        );

        if (
          (this.persistedSnapshotVersions.get(roomId) ?? 0) >=
          (this.snapshotVersions.get(roomId) ?? 0)
        ) {
          this.snapshotDirtyRooms.delete(roomId);
        }
      } catch (error) {
        failed = true;
        const normalizedError =
          error instanceof Error ? error : new Error(String(error));
        this.logger.error(
          `Cannot persist room snapshot for room ${roomId}: ${normalizedError.message}`,
        );
        this.settleSnapshotWaiters(
          roomId,
          this.snapshotVersions.get(roomId) ?? 0,
          normalizedError,
        );
      } finally {
        this.snapshotSavingRooms.delete(roomId);
      }
    })();

    this.snapshotFlushTasks.set(roomId, task);
    try {
      await task;
    } finally {
      if (this.snapshotFlushTasks.get(roomId) === task) {
        this.snapshotFlushTasks.delete(roomId);
      }
      if (this.snapshotDirtyRooms.has(roomId)) {
        const retry = () => void this.flushRoomSnapshot(roomId);
        if (failed) setTimeout(retry, 1_000).unref?.();
        else queueMicrotask(retry);
      }
    }
  }

  private async getOrCreateDoc(roomId: string): Promise<Y.Doc> {
    const existingDoc = this.docs.get(roomId);
    if (existingDoc) {
      return existingDoc;
    }

    const pendingTask = this.docInitTasks.get(roomId);
    if (pendingTask) {
      return pendingTask;
    }

    this.resourceBudget.reserveRoom(roomId);
    const initTask = (async () => {
      const doc = new Y.Doc();
      const snapshot = await this.roomService.getRoomSnapshot(roomId, (saved, task) => {
        const legacy = new Y.Doc();
        try {
          if (saved) {
            if (saved.length > Math.ceil(MAX_SNAPSHOT_BYTES / 3) * 4) throw new Error('Snapshot too large');
            Y.applyUpdate(legacy, Buffer.from(saved, 'base64'));
          } else if (task.initialCode) {
            legacy.getText('codemirror').insert(0, task.initialCode);
          }
          insertLessonTemplate(legacy.getText('codemirror'), task);
          return Buffer.from(this.resourceBudget.validate(roomId, legacy)).toString('base64');
        } finally {
          legacy.destroy();
        }
      });

      if (snapshot) {
        try {
          if (snapshot.length > Math.ceil(MAX_SNAPSHOT_BYTES / 3) * 4) throw new Error('Saved snapshot exceeds resource limit');
          Y.applyUpdate(doc, Buffer.from(snapshot, 'base64'));
          this.resourceBudget.remember(roomId, doc);
          this.lastPersistedSnapshots.set(roomId, snapshot);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `Cannot apply saved snapshot for room ${roomId}: ${message}`,
          );
          doc.destroy();
          throw new Error('Сохранённый документ превышает лимит или повреждён; исходные данные сохранены');
        }
      } else {
        this.lastPersistedSnapshots.set(roomId, null);
      }

      this.resourceBudget.remember(roomId, doc);
      this.docs.set(roomId, doc);
      this.snapshotVersions.set(roomId, 0);
      this.persistedSnapshotVersions.set(roomId, 0);
      return doc;
    })();

    this.docInitTasks.set(roomId, initTask);

    try {
      return await initTask;
    } catch (error) {
      this.resourceBudget.releaseRoom(roomId);
      throw error;
    } finally {
      this.docInitTasks.delete(roomId);
    }
  }

  handleConnection(client: Socket) {
    socketMetrics.increment('ide_socket_connection_total', {
      transport: client.conn?.transport?.name || 'unknown',
    });
    client.once('disconnect', (reason) => {
      this.disconnectReasons.set(client.id, reason);
    });
    this.logger.log(
      JSON.stringify({
        event: 'socket_connect',
        socketHash: this.userHash(client.id),
        transport: client.conn?.transport?.name,
      }),
    );
  }
}
