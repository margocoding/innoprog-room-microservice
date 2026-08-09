import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { CreateRoomDto } from './dto/create-room-dto';
import { EditRoomDto } from './dto/edit-room-dto';
import { GetRoomsDto } from './dto/get-rooms-dto';
import { RoomRdo } from './rdo/room-rdo';
import { RoomService } from './room.service';
import { AuthRoomGuard } from './auth-room.guard';
import { DeleteRoomDto } from './dto/delete-room-dto';
import { AppService } from 'src/app.service';
import { CreateAnonymousRoomTokenDto } from './dto/create-anonymous-room-token-dto';
import { ExchangeRoomLaunchCodeDto } from './dto/exchange-room-launch-code-dto';

@ApiTags('Room')
@Controller('room')
@UsePipes(new ValidationPipe({ whitelist: true }))
export class RoomController {
  private readonly logger = new Logger(RoomController.name);

  constructor(
    private readonly roomService: RoomService,
    private readonly appService: AppService,
  ) { }

  @ApiOperation({ summary: 'Create room' })
  @ApiResponse({ status: 200, type: RoomRdo })
  @UseGuards(AuthRoomGuard)
  @Post('/')
  async createRoom(@Body() dto: CreateRoomDto): Promise<RoomRdo> {
    const room = await this.roomService.createRoom(dto);
    let roomLaunchCode: string;
    try {
      roomLaunchCode = await this.appService.createRoomLaunchCode(room.id, room.teacher);
    } catch (error) {
      try {
        await this.roomService.deleteRoom(room.id, room.teacher);
      } catch (rollbackError) {
        this.logger.error(
          `Failed to roll back room ${room.id}: ${rollbackError?.constructor?.name || 'Error'}`,
        );
      }
      this.logger.error(
        `Launch store unavailable for room ${room.id}: ${error?.constructor?.name || 'Error'}`,
      );
      throw new ServiceUnavailableException(
        'Не удалось подготовить безопасный вход в комнату',
      );
    }
    return {
      ...room,
      roomToken: this.appService.createRoomToken(room.id, room.teacher),
      roomLaunchCode,
    };
  }

  @ApiOperation({ summary: 'Exchange one-time room launch code' })
  @Post('/:id/launch')
  async exchangeRoomLaunchCode(
    @Param('id') id: string,
    @Body() dto: ExchangeRoomLaunchCodeDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ telegramId: string; roomToken: string }> {
    const launch = await this.appService.consumeRoomLaunchCode(
      dto.launchCode,
      id,
      dto.browserNonce,
    );
    if (!launch) {
      throw new NotFoundException('Launch code not found or expired');
    }
    const roomToken = this.appService.createRoomToken(id, launch.userId);
    if (!roomToken) {
      throw new NotFoundException('Room token unavailable');
    }
    this.clearLegacyRoomSessionCookies(response, request.headers.cookie);
    this.setRoomSessionCookie(response, id, launch.userId);
    return { telegramId: launch.userId, roomToken };
  }

  @ApiOperation({ summary: 'Create anonymous signed room token' })
  @ApiResponse({ status: 200, example: { telegramId: 'i123456', roomToken: 'v1...' } })
  @ApiNotFoundResponse({
    example: new NotFoundException('Room not found').getResponse(),
  })
  @Post('/:id/token')
  async createAnonymousRoomToken(
    @Param('id') id: string,
    @Body() dto: CreateAnonymousRoomTokenDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ telegramId: string; roomToken?: string }> {
    const room = await this.roomService.getRoom(id);
    if (!room) {
      throw new NotFoundException('Room not found');
    }

    const cookieName = this.appService.getRoomSessionCookieName(id);
    const cookieToken = this.readCookie(request.headers.cookie, cookieName);
    const existing = cookieToken
      ? this.appService.verifyRoomBrowserSession(cookieToken, id)
      : undefined;
    const telegramId = existing?.userId
      || dto?.telegramId
      || this.appService.createAnonymousRoomUserId();
    this.clearLegacyRoomSessionCookies(response, request.headers.cookie);
    this.setRoomSessionCookie(response, id, telegramId);
    return {
      telegramId,
      roomToken: this.appService.createRoomToken(id, telegramId),
    };
  }

  private readCookie(header: string | undefined, name: string): string {
    for (const part of String(header || '').split(';')) {
      const [rawName, ...rawValue] = part.trim().split('=');
      if (rawName === name) {
        return decodeURIComponent(rawValue.join('='));
      }
    }
    return '';
  }

  private setRoomSessionCookie(
    response: Response,
    roomId: string,
    userId: string,
  ): void {
    const session = this.appService.createRoomBrowserSession(roomId, userId);
    if (!session) {
      return;
    }
    response.cookie(
      this.appService.getRoomSessionCookieName(roomId),
      session,
      {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: `/api/room/${encodeURIComponent(roomId)}`,
        maxAge: 365 * 24 * 60 * 60 * 1000,
      },
    );
  }

  private clearLegacyRoomSessionCookies(
    response: Response,
    cookieHeader: string | undefined,
  ): void {
    const legacyCookieNames = new Set(
      String(cookieHeader || '')
        .split(';')
        .map((part) => part.trim().split('=', 1)[0])
        .filter((name) => /^ide_room_session_[a-f0-9]{20}$/.test(name)),
    );
    for (const name of legacyCookieNames) {
      response.clearCookie(name, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
      });
    }
  }

  @ApiOperation({ summary: 'Get all rooms by telegram id ' })
  @ApiResponse({ status: 200, type: [RoomRdo] })
  @UseGuards(AuthRoomGuard)
  @Get('/:telegramId')
  async getRooms(
    @Param('telegramId') telegramId: string,
    @Query() dto: GetRoomsDto,
  ): Promise<{ rooms: RoomRdo[]; total: number }> {
    return await this.roomService.getRooms(telegramId, dto);
  }

  @ApiOperation({ summary: 'Edit an existing room' })
  @ApiResponse({ status: 200, type: RoomRdo })
  @ApiNotFoundResponse({
    example: new NotFoundException('Room not found').getResponse(),
  })
  @UseGuards(AuthRoomGuard)
  @Put('/:id')
  async editRoom(
    @Param('id') id: string,
    @Body() dto: EditRoomDto,
  ): Promise<RoomRdo> {
    return await this.roomService.editRoom(id, dto);
  }

  @ApiOperation({ summary: 'Delete a room' })
  @ApiResponse({ status: 200, example: { success: true } })
  @ApiNotFoundResponse({
    example: new NotFoundException('Room not found').getResponse(),
  })
  @UseGuards(AuthRoomGuard)
  @Delete('/')
  async deleteRoom(@Body() dto: DeleteRoomDto): Promise<{ success: boolean }> {
    console.log(dto);
    return await this.roomService.deleteRoom(dto.id, dto.telegramId);
  }
}
