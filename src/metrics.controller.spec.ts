import { MetricsController } from './metrics.controller';
import { socketMetrics } from './socket-metrics';

describe('MetricsController', () => {
  afterEach(() => socketMetrics.reset());

  it('returns Socket.IO counters in Prometheus text format', () => {
    socketMetrics.increment('ide_socket_connection_total', {
      transport: 'websocket',
    });

    expect(new MetricsController().metrics()).toContain(
      'ide_socket_connection_total{transport="websocket"} 1',
    );
  });
});
