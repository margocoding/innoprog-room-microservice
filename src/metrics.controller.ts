import { Controller, Get, Header } from '@nestjs/common';
import { socketMetrics } from './socket-metrics';

@Controller()
export class MetricsController {
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  metrics(): string {
    return socketMetrics.render();
  }
}
