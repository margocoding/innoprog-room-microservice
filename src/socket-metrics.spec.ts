import { SocketMetrics } from './socket-metrics';

describe('SocketMetrics', () => {
  it('renders bounded counter and reconnect duration labels', () => {
    const metrics = new SocketMetrics();
    metrics.increment('ide_socket_disconnect_total', {
      reason: 'ping_timeout',
    });
    metrics.observe('ide_socket_reconnect_duration_seconds', 1.25, {
      reason: 'ping_timeout',
    });

    expect(metrics.render()).toContain(
      'ide_socket_disconnect_total{reason="ping_timeout"} 1',
    );
    expect(metrics.render()).toContain(
      'ide_socket_reconnect_duration_seconds_sum{reason="ping_timeout"} 1.250000',
    );
  });

  it('escapes labels and can be reset', () => {
    const metrics = new SocketMetrics();
    metrics.increment('ide_socket_connection_total', {
      transport: 'web"socket\\test',
    });
    expect(metrics.render()).toContain(
      'transport="web\\"socket\\\\test"',
    );

    metrics.reset();
    expect(metrics.render()).toBe('\n');
  });
});
