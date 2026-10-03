const EVENT_NAMES = [
  'bootstrap',
  'dom_ready',
  'app_entry',
  'render_scheduled',
  'boot_timeout',
  'script_failure',
  'style_failure',
  'runtime_failure',
  'unhandled_rejection',
  'navigation',
  'resource_script',
  'resource_style',
  'resource_image',
  'resource_font',
  'resource_fetch',
  'resource_other',
  'resource_queue',
  'resource_ttfb',
  'resource_download',
] as const;

type StartupEventName = (typeof EVENT_NAMES)[number];
type StartupEvent = { event: StartupEventName; durationMs: number };
const MAX_BODY_BYTES = 4096;
const MAX_EVENTS = 24;
const MAX_DURATION_MS = 120_000;
const RATE_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 120;

export class IdeStartupDiagnosticsService {
  private windowStartedAt = 0;
  private requestCount = 0;
  private readonly counts = new Map<StartupEventName, { count: number; durationSum: number }>();

  accept(payload: unknown, origin: unknown, host: unknown, now = Date.now()): void {
    this.validateOrigin(origin, host);
    if (now - this.windowStartedAt >= RATE_WINDOW_MS || now < this.windowStartedAt) {
      this.windowStartedAt = now;
      this.requestCount = 0;
    }
    if (this.requestCount >= MAX_REQUESTS_PER_WINDOW) {
      throw new Error('rate_limited');
    }
    this.requestCount += 1;

    this.validatePayload(payload);

    const events = (payload as { events: StartupEvent[] }).events;
    for (const event of events) {
      const current = this.counts.get(event.event) ?? { count: 0, durationSum: 0 };
      current.count += 1;
      current.durationSum += event.durationMs;
      this.counts.set(event.event, current);
    }
  }

  render(): string {
    const lines: string[] = [];
    let wroteEventType = false;
    let wroteDurationType = false;
    for (const event of EVENT_NAMES) {
      const value = this.counts.get(event);
      if (!value) continue;
      if (!wroteEventType) lines.push(`# TYPE ide_startup_event_total counter`);
      wroteEventType = true;
      lines.push(`ide_startup_event_total{event="${event}"} ${value.count}`);
      if (!wroteDurationType) lines.push(`# TYPE ide_startup_duration_ms summary`);
      wroteDurationType = true;
      lines.push(`ide_startup_duration_ms_count{event="${event}"} ${value.count}`);
      lines.push(`ide_startup_duration_ms_sum{event="${event}"} ${value.durationSum}`);
    }
    return `${lines.join('\n')}\n`;
  }

  reset(): void {
    this.windowStartedAt = 0;
    this.requestCount = 0;
    this.counts.clear();
  }

  private validateOrigin(origin: unknown, host: unknown): void {
    if (typeof origin !== 'string' || origin.length > 512 || typeof host !== 'string' || host.length > 255) {
      throw new Error('invalid_origin');
    }
    try {
      const parsed = new URL(origin);
      if (
        (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
        parsed.origin !== origin ||
        parsed.host.toLowerCase() !== host.toLowerCase()
      ) {
        throw new Error('invalid_origin');
      }
    } catch {
      throw new Error('invalid_origin');
    }
  }

  private validatePayload(payload: unknown): void {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('invalid_payload');
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      throw new Error('invalid_payload');
    }
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_BODY_BYTES) {
      throw new Error('payload_too_large');
    }

    const input = payload as Record<string, unknown>;
    if (!this.hasExactKeys(input, ['events', 'version']) || input.version !== 1) {
      throw new Error('invalid_payload');
    }
    if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > MAX_EVENTS) {
      throw new Error('invalid_payload');
    }
    for (const candidate of input.events) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new Error('invalid_payload');
      }
      const event = candidate as Record<string, unknown>;
      if (
        !this.hasExactKeys(event, ['durationMs', 'event']) ||
        typeof event.event !== 'string' ||
        !EVENT_NAMES.includes(event.event as StartupEventName) ||
        typeof event.durationMs !== 'number' ||
        !Number.isFinite(event.durationMs) ||
        !Number.isInteger(event.durationMs) ||
        event.durationMs < 0 ||
        event.durationMs > MAX_DURATION_MS
      ) {
        throw new Error('invalid_payload');
      }
    }
  }

  private hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
    const actual = Object.keys(value).sort();
    return actual.length === keys.length && actual.every((key, index) => key === keys.sort()[index]);
  }
}

export const ideStartupDiagnostics = new IdeStartupDiagnosticsService();
