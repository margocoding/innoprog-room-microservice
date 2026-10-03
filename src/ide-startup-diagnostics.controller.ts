import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  PayloadTooLargeException,
  Post,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { ideStartupDiagnostics } from './ide-startup-diagnostics';

@Controller('diagnostics')
export class IdeStartupDiagnosticsController {
  @Post('ide-startup')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  collect(@Req() request: Request, @Body() payload: unknown): void {
    try {
      ideStartupDiagnostics.accept(payload, request.headers.origin, request.headers.host);
    } catch (error) {
      const reason = error instanceof Error ? error.message : '';
      if (reason === 'invalid_origin') throw new ForbiddenException();
      if (reason === 'payload_too_large') throw new PayloadTooLargeException();
      if (reason === 'rate_limited') {
        throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
      }
      throw new BadRequestException();
    }
  }
}
