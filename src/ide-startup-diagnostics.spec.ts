import { IdeStartupDiagnosticsController } from './ide-startup-diagnostics.controller';
import {
  IdeStartupDiagnosticsService,
  ideStartupDiagnostics,
} from './ide-startup-diagnostics';

const origin = 'https://ide.innoprog.ru';
const host = 'ide.innoprog.ru';
const validPayload = {
  version: 1,
  events: [{ event: 'script_failure', durationMs: 1230 }],
};

describe('IDE startup diagnostics', () => {
  let service: IdeStartupDiagnosticsService;

  beforeEach(() => {
    service = new IdeStartupDiagnosticsService();
    ideStartupDiagnostics.reset();
  });

  it('accepts only fixed event categories and aggregates rounded durations', () => {
    service.accept({
      version: 1,
      events: [
        ...validPayload.events,
        { event: 'resource_queue', durationMs: 30 },
        { event: 'resource_ttfb', durationMs: 40 },
        { event: 'resource_download', durationMs: 100 },
      ],
    }, origin, host, 1000);
    expect(service.render()).toContain('ide_startup_event_total{event="script_failure"} 1');
    expect(service.render()).toContain('ide_startup_duration_ms_sum{event="script_failure"} 1230');
    expect(service.render()).toContain('ide_startup_duration_ms_sum{event="resource_queue"} 30');
    expect(service.render()).toContain('ide_startup_duration_ms_sum{event="resource_ttfb"} 40');
    expect(service.render()).toContain('ide_startup_duration_ms_sum{event="resource_download"} 100');
  });

  it.each([
    ['external origin', origin, 'attacker.example'],
    ['origin with URL data', `${origin}/?room=private`, host],
    ['missing origin', undefined, host],
  ])('rejects %s without recording metrics', (_label, requestOrigin, requestHost) => {
    expect(() => service.accept(validPayload, requestOrigin, requestHost)).toThrow('invalid_origin');
    expect(service.render()).toBe('\n');
  });

  it('rejects oversized batches before recording them', () => {
    const oversized = { version: 1, events: [{ event: 'bootstrap', durationMs: 0, padding: 'x'.repeat(5000) }] };
    expect(() => service.accept(oversized, origin, host)).toThrow('payload_too_large');
    expect(service.render()).toBe('\n');
  });

  it('checks the request budget before validating payloads from the IDE origin', () => {
    for (let index = 0; index < 120; index += 1) {
      expect(() => service.accept({ version: 1, events: [] }, origin, host, 1000)).toThrow('invalid_payload');
    }
    expect(() => service.accept(validPayload, origin, host, 1000)).toThrow('rate_limited');
    expect(service.render()).toBe('\n');
  });

  it('rejects more than the fixed event batch limit', () => {
    const excessiveBatch = {
      version: 1,
      events: Array.from({ length: 25 }, () => ({ event: 'bootstrap', durationMs: 1 })),
    };
    expect(() => service.accept(excessiveBatch, origin, host)).toThrow('invalid_payload');
    expect(service.render()).toBe('\n');
  });

  it.each([
    ['NaN duration', { version: 1, events: [{ event: 'bootstrap', durationMs: Number.NaN }] }],
    ['external URL event', { version: 1, events: [{ event: 'https://evil.example/?token=x', durationMs: 1 }] }],
    ['unbounded metadata', { version: 1, events: [{ event: 'bootstrap', durationMs: 1, roomId: 'secret' }] }],
    ['unknown root metadata', { version: 1, events: [{ event: 'bootstrap', durationMs: 1 }], query: 'secret' }],
  ])('rejects %s', (_label, payload) => {
    expect(() => service.accept(payload, origin, host)).toThrow();
    expect(service.render()).toBe('\n');
  });

  it('rate limits the whole endpoint and caps accepted request batches', () => {
    for (let index = 0; index < 120; index += 1) {
      service.accept(validPayload, origin, host, 1000);
    }
    expect(() => service.accept(validPayload, origin, host, 1000)).toThrow('rate_limited');
    expect(service.render()).toContain('ide_startup_event_total{event="script_failure"} 120');
  });

  it('maps failures to sanitized HTTP errors', () => {
    const controller = new IdeStartupDiagnosticsController();
    expect(() => controller.collect({ headers: { origin: 'https://attacker.example', host } } as any, validPayload))
      .toThrow(expect.objectContaining({ status: 403 }));
    expect(() => controller.collect({ headers: { origin, host } } as any, { ...validPayload, padding: 'x'.repeat(5000) }))
      .toThrow(expect.objectContaining({ status: 413 }));
  });

  it('accepts the fixed unhandled rejection category without metadata', () => {
    service.accept({ version: 1, events: [{ event: 'unhandled_rejection', durationMs: 40 }] }, origin, host, 1000);
    expect(service.render()).toContain('ide_startup_event_total{event="unhandled_rejection"} 1');
  });
});
