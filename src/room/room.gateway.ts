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
import { PrismaService } from '../prisma/prisma.service';
import { UseGuards } from '@nestjs/common';
import { AuthRoomGuard } from './auth-room.guard';

interface JoinPayload {
  telegramId: string;
  username?: string;
  roomId: string;
}

interface EditMember extends JoinPayload {
  changeTelegramId: string;
}

interface Member {
  clientId: string;
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
}

interface Room {
  id: string;
  members: Member[];
  teacher: string;
  studentCursorEnabled: boolean;
  studentSelectionEnabled: boolean;
  studentEditCodeEnabled: boolean;
  completed: boolean;
}

interface EditPayload extends EditRoomDto {
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
}

@WebSocketGateway({
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 30000,
})
@UseGuards(AuthRoomGuard)
export class RoomGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private docs = new Map<string, Y.Doc>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly roomService: RoomService,
    private readonly prisma: PrismaService,
  ) { }

  activeRooms: Room[] = [];

  @WebSocketServer() server: Server;

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


  @SubscribeMessage('join-room') async handleJoinRoom(
    @MessageBody() data: JoinPayload,
    @ConnectedSocket() client: Socket,
  ) {
    const { telegramId, roomId, username } = data;

    let room = await this.roomService.getRoom(roomId);


    if (!room) {
      client.emit('join-room:error', { message: 'Комната не найдена' });
      return;
    }

    const isParticipant =
      room.teacher === telegramId || room.students.includes(telegramId);

    if (!isParticipant) {
      room = await this.roomService.joinRoom(room.id, telegramId);
    }

    await client.join(roomId);

    let activeRoom = this.activeRooms.find((r) => r.id === room.id);

    if (!activeRoom) {
      activeRoom = {
        ...room,
        members: [],
        studentCursorEnabled: room.studentCursorEnabled ?? true,
        studentSelectionEnabled: room.studentSelectionEnabled ?? true,
        studentEditCodeEnabled: room.studentEditCodeEnabled ?? true,
        completed: room.completed,
        teacher: room.teacher,
      };
      this.activeRooms.push(activeRoom);
    }

    const existingMember = activeRoom?.members.find(
      (member) => member.telegramId === telegramId,
    );

    if (existingMember) {
      existingMember.online = true;
      existingMember.clientId = client.id;
      existingMember.lastActivity = new Date();
      if (username) {
        existingMember.username = username;
      }
    } else {
      activeRoom?.members.push({
        clientId: client.id,
        telegramId,
        username,
        online: true,
        userColor: this.generateUserColor(telegramId),
        lastActivity: new Date(),
      });
    }

    // Отправляем обновленный список участников всем в комнате
    this.server.to(roomId).emit('members-updated', {
      members: activeRoom?.members.map((member) => ({
        telegramId: member.telegramId,
        username: member.username,
        isYourself: member.telegramId === telegramId,
        online: member.online,
        userColor: member.userColor,
        lastActivity: member.lastActivity,
      })),
      trigger: 'join',
      telegramId: telegramId,
    });

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
      language: room.language,
      completed: room.completed,
    });

    client.emit('code-edit-action', {
      update: Y.encodeStateAsUpdate(this.getOrCreateDoc(room.id))
    });

    client.emit('selection-state', {
      selections: currentSelections,
      updatedUser: data.telegramId,
    });
  }

  @SubscribeMessage('edit-room') async handleEditRoom(
    client: Socket,
    @MessageBody() data: EditPayload,
  ) {
    const room = await this.roomService.getRoom(data.roomId);

    if (!room || room.teacher !== data.telegramId) {
      client.emit('error', { message: 'Комната не найдена' });
      return;
    }
    if (room.completed) return;

    // Получаем текущую активную комнату для сохранения настроек
    const activeRoom = this.activeRooms.find((r) => r.id === room.id);

    const updatedRoom = await this.roomService.editRoom(room.id, {
      studentCursorEnabled: data.studentCursorEnabled,
      studentEditCodeEnabled: data.studentEditCodeEnabled,
      studentSelectionEnabled: data.studentSelectionEnabled,
      language: data.language,
      telegramId: data.telegramId,
      taskId: data.taskId,
    });

    this.activeRooms = this.activeRooms.map((activeRoomItem) => {
      if (activeRoomItem.id === updatedRoom.id) {
        return {
          ...activeRoomItem,
          // Используем переданные значения или сохраняем текущие из activeRoom или room
          studentCursorEnabled: data.studentCursorEnabled !== undefined 
            ? Boolean(data.studentCursorEnabled)
            : (activeRoom?.studentCursorEnabled ?? room.studentCursorEnabled),
          studentEditCodeEnabled: data.studentEditCodeEnabled !== undefined 
            ? Boolean(data.studentEditCodeEnabled)
            : (activeRoom?.studentEditCodeEnabled ?? room.studentEditCodeEnabled),
          studentSelectionEnabled: data.studentSelectionEnabled !== undefined 
            ? Boolean(data.studentSelectionEnabled)
            : (activeRoom?.studentSelectionEnabled ?? room.studentSelectionEnabled),
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

  @SubscribeMessage('code-edit') handleCodeEdit(
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

    const member = activeRoom.members.find(
      (m) => m.telegramId === data.telegramId,
    );

    if (member) {
      member.lastActivity = new Date();
    }

    const doc = this.getOrCreateDoc(data.roomId);

    Y.applyUpdate(doc, data.update);

    client.broadcast.to(activeRoom.id).emit('code-edit-action', {
      telegramId: data.telegramId,
      userColor: member?.userColor,
      username: member?.username,
      update: data.update,
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

    if (member && (member.telegramId === data.telegramId || activeRoom.teacher === data.telegramId)) {
      member.username = data.username;

      this.server.to(activeRoom.id).emit('members-updated', {
        members: activeRoom.members.map((member) => ({
          telegramId: member.telegramId,
          username: member.username,
          online: member.online,
          userColor: member.userColor,
          lastActivity: member.lastActivity,
        })),
        trigger: 'username-update',
        telegramId: data.telegramId,
      });
    } else {
      return client.emit('error', { message: 'Участник не найден в комнате' });
    }
  }

  @SubscribeMessage('close-session') async handleCloseSession(
    client: Socket,
    data: JoinPayload,
  ) {
    const activeRoom = await this.roomService.getRoom(data.roomId);

    if (!activeRoom || activeRoom.teacher !== data.telegramId) {
      client.emit('error', {
        message: 'Комната не найдена',
      });
      return;
    }

    if (activeRoom.completed) return;

    await this.roomService.completeRoom(data.roomId);


    this.activeRooms = this.activeRooms.filter(
      (room) => room.id !== activeRoom.id,
    );

    this.server.to(activeRoom.id).emit('complete-session', {
      message: 'Учитель завершил сессию',
    });
  }

  handleDisconnect(client: Socket) {

    for (const room of this.activeRooms) {
      const member = room.members.find((m) => m.clientId === client.id);
      if (member) {
        member.online = false;
        member.lastSelection = undefined;

        this.server.to(room.id).emit('member-left', {
          telegramId: member.telegramId,
          keepCursor: true,
        });

        // Отправляем обновленный список участников всем в комнате
        this.server.to(room.id).emit('members-updated', {
          members: room.members.map((member) => ({
            telegramId: member.telegramId,
            username: member.username,
            online: member.online,
            userColor: member.userColor,
            lastActivity: member.lastActivity,
          })),
          trigger: 'leave',
          telegramId: member.telegramId,
        });

        // Отправляем обновленное состояние выделений
        const currentSelections = room.members
          .filter((m) => m.lastSelection && m.online)
          .map((m) => ({
            telegramId: m.telegramId,
            ...m.lastSelection,
            userColor: m.userColor,
          }));

        this.server.to(room.id).emit('selection-state', {
          selections: currentSelections,
          updatedUser: member.telegramId,
        });

        // Проверяем, остались ли онлайн участники
        const onlineMembers = room.members.filter((m) => m.online);
        if (onlineMembers.length === 0) {

          // Удаляем комнату из активных
          const roomIndex = this.activeRooms.findIndex((r) => r.id === room.id);
          if (roomIndex > -1) {
            this.activeRooms.splice(roomIndex, 1);
          }
        }

        break;
      }
    }
  }

  private getOrCreateDoc(roomId: string): Y.Doc {
    if (!this.docs.has(roomId)) {
      const doc = new Y.Doc();
      this.docs.set(roomId, doc);
    }
    return this.docs.get(roomId)!;
  }

  handleConnection(client: any, ...args: any[]) { }
}
