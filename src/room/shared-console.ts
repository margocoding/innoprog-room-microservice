import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';
import * as Y from 'yjs';

const activeStates = ['connecting', 'starting', 'compiling', 'running', 'stopping'];
const terminalStates = ['finished', 'failed', 'busy', 'error'];

type ConsoleSnapshot = {
  state: string;
  chunks: { text: string; stream: 'stdout' | 'stderr' }[];
  message: string;
  exitCode: number | null;
  deadline: number;
  batch?: {
    output: string;
    input: string;
    status: 'idle' | 'success' | 'error';
    mismatch: { actual: string; expected: string } | null;
  };
};
type ConsoleRun = {
  id: string;
  mode: 'console' | 'batch';
  owner: string;
  snapshot: ConsoleSnapshot;
  timer?: NodeJS.Timeout;
  draft?: Y.Doc;
  draftVersion: number;
  frozenLine?: string;
  eof: boolean;
  cursors: Map<string, { telegramId: string; position: Uint8Array }>;
};

function snapshotFrom(value: unknown): ConsoleSnapshot | undefined {
  if (!value || typeof value !== 'object') return;
  const { state, chunks, message, exitCode, deadline, batch } = value as ConsoleSnapshot;
  if (![...activeStates, ...terminalStates].includes(state) || typeof message !== 'string' ||
      !Array.isArray(chunks) || chunks.length > 512 || !Number.isFinite(deadline)) return;
  let length = 0;
  for (const chunk of chunks) {
    if (!chunk || typeof chunk.text !== 'string' || !['stdout', 'stderr'].includes(chunk.stream)) return;
    length += chunk.text.length;
  }
  if (length > 64_000) return;
  const result: ConsoleSnapshot = {
    state, chunks: chunks.map(({ text, stream }) => ({ text, stream })),
    message: message.slice(0, 1000), exitCode: Number.isInteger(exitCode) ? exitCode : null,
    deadline: Math.max(0, Math.min(deadline, Date.now() + 240_000)),
  };
  if (batch) {
    if (typeof batch.output !== 'string' || typeof batch.input !== 'string' ||
        !['idle', 'success', 'error'].includes(batch.status)) return;
    const mismatch = batch.mismatch;
    if (mismatch && (typeof mismatch.actual !== 'string' || typeof mismatch.expected !== 'string')) return;
    result.batch = {
      output: batch.output.slice(-64_000), input: batch.input.slice(0, 16_000), status: batch.status,
      mismatch: mismatch ? { actual: mismatch.actual.slice(-32_000), expected: mismatch.expected.slice(-32_000) } : null,
    };
  }
  return result;
}

type BatchCursor = { telegramId: string; field: 'input' | 'output'; position: Uint8Array };
type BatchFormOptions = { inputEnabled: boolean; outputEnabled: boolean };

export class SharedConsole {
  private run?: ConsoleRun;
  private batchDraft?: Y.Doc;
  private batchFormOpen = false;
  private batchCursors = new Map<string, BatchCursor>();
  private batchOptions: BatchFormOptions = { inputEnabled: true, outputEnabled: false };

  constructor(
    private readonly publish: (event: string, value: unknown) => void,
    private readonly sendTo: (socketId: string, event: string, value: unknown) => void,
  ) {}

  private describe(run: ConsoleRun) {
    const { id, mode, snapshot, draftVersion, eof, frozenLine } = run;
    return { id, mode, snapshot, draftVersion, eof, frozenLine };
  }

  private sendState(run: ConsoleRun) {
    this.publish('state', this.describe(run));
  }

  read() {
    const run = this.run;
    if (!run) return null;
    return {
      ...this.describe(run),
      draft: run.draft ? Y.encodeStateAsUpdate(run.draft) : undefined,
      cursors: [...run.cursors.values()],
    };
  }

  readBatchForm() {
    if (!this.batchDraft) return null;
    return {
      open: this.batchFormOpen, ...this.batchOptions,
      draft: Y.encodeStateAsUpdate(this.batchDraft), cursors: [...this.batchCursors.values()],
    };
  }

  openBatchForm() {
    if (this.run?.timer || this.batchFormOpen) return;
    this.batchDraft ??= new Y.Doc();
    this.batchFormOpen = true;
    this.publish('batch-form', this.readBatchForm());
  }

  closeBatchForm() {
    if (!this.batchFormOpen) return;
    this.batchFormOpen = false;
    this.batchCursors.clear();
    this.publish('batch-form', this.readBatchForm());
  }

  batchCursor(socketId: string, telegramId: string, field: unknown, position: unknown) {
    if (!this.batchFormOpen || (field !== 'input' && field !== 'output')) return;
    if (position === null) {
      if (this.batchCursors.get(socketId)?.field === field) this.removeBatchCursor(socketId);
      return;
    }
    if (!this.batchOptions[field === 'input' ? 'inputEnabled' : 'outputEnabled'] ||
        !(position instanceof Uint8Array) || position.byteLength > 80) return;
    const cursor: BatchCursor = { telegramId, field, position };
    this.batchCursors.set(socketId, cursor);
    this.publish('batch-cursor', cursor);
  }

  private removeBatchCursor(socketId: string) {
    const cursor = this.batchCursors.get(socketId);
    if (!cursor) return;
    this.batchCursors.delete(socketId);
    this.publish('batch-cursor', { ...cursor, position: null });
  }

  disableSharing() {
    const run = this.run;
    if (run?.timer) {
      const line = run.draft?.getText('line').toString() ?? '';
      if (line) run.frozenLine = line;
      this.sendTo(run.owner, 'detach', { id: run.id, line, eof: run.eof });
      run.snapshot = { ...run.snapshot, state: 'detached', deadline: 0 };
      this.finish(run);
      this.sendState(run);
    }
    if (this.batchFormOpen) this.publish('batch-detach', this.readBatchForm());
    this.closeBatchForm();
  }

  updateBatchOptions(field: unknown, value: unknown) {
    if (!this.batchFormOpen || typeof value !== 'boolean' || (field !== 'inputEnabled' && field !== 'outputEnabled')) return;
    this.batchOptions[field] = value;
    if (!value) {
      for (const [socketId, cursor] of this.batchCursors) {
        if (cursor.field === (field === 'inputEnabled' ? 'input' : 'output')) this.removeBatchCursor(socketId);
      }
    }
    this.publish('batch-option', { field, value });
  }

  editBatchForm(update: unknown) {
    if (!this.batchDraft || !this.batchFormOpen || !(update instanceof Uint8Array) || update.byteLength > 70_000) {
      return { ok: false };
    }
    const candidate = new Y.Doc();
    try {
      const fields = ['input', 'output'];
      for (const field of fields) candidate.getText(field);
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(this.batchDraft));
      Y.applyUpdate(candidate, update);
      if (candidate.store.pendingStructs || candidate.store.pendingDs || candidate.share.size !== fields.length ||
          fields.some(field => {
            const text = candidate.getText(field);
            return text.length !== text.toString().length || Buffer.byteLength(text.toString()) > 16_000;
          }) || Y.encodeStateAsUpdate(candidate).byteLength > 120_000) return { ok: false };
      this.batchDraft.destroy();
      this.batchDraft = candidate;
      this.publish('batch-edit', update);
      return { ok: true };
    } catch {
      return { ok: false };
    } finally {
      if (this.batchDraft !== candidate) candidate.destroy();
    }
  }

  start(client: Socket, mode: unknown) {
    if ((mode !== 'console' && mode !== 'batch') || this.run?.timer) return { ok: false };
    this.resetRun();
    this.closeBatchForm();
    const run: ConsoleRun = {
      id: randomUUID(), mode, owner: client.id, draftVersion: 0, eof: false,
      snapshot: { state: 'connecting', chunks: [], message: '', exitCode: null, deadline: 0 },
      cursors: new Map(),
      draft: mode === 'console' ? new Y.Doc() : undefined,
    };
    this.run = run;
    this.armTimeout(run, 30_000);
    this.sendState(run);
    return { ok: true, id: run.id };
  }

  update(client: Socket, id: unknown, value: unknown) {
    const run = this.run;
    if (!run?.timer || run.id !== id || run.owner !== client.id) return;
    const snapshot = snapshotFrom(value);
    if (!snapshot) return;
    const starting = run.snapshot.state === 'connecting';
    run.snapshot = snapshot;
    if (terminalStates.includes(snapshot.state)) this.finish(run);
    else if (starting && snapshot.state !== 'connecting') this.armTimeout(run, 210_000);
    this.sendState(run);
  }

  edit(id: unknown, version: unknown, update: unknown) {
    const run = this.run;
    if (!run?.draft || run.id !== id || run.draftVersion !== version ||
        run.snapshot.state !== 'running' || run.eof ||
        !(update instanceof Uint8Array) || update.byteLength > 20_000) return { ok: false };
    const candidate = new Y.Doc();
    try {
      candidate.getText('line');
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(run.draft));
      Y.applyUpdate(candidate, update);
      const text = candidate.getText('line');
      const value = text.toString();
      if (candidate.store.pendingStructs || candidate.store.pendingDs ||
          candidate.share.size !== 1 || text.length !== value.length ||
          /[\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value) > 4000 ||
          Y.encodeStateAsUpdate(candidate).byteLength > 48_000) return { ok: false };
      run.draft.destroy();
      run.draft = candidate;
      this.publish('edit', { id, version, update });
      return { ok: true };
    } catch {
      return { ok: false };
    } finally {
      if (run.draft !== candidate) candidate.destroy();
    }
  }

  cursor(socketId: string, telegramId: string, id: unknown, version: unknown, position: unknown) {
    const run = this.run;
    if (!run?.draft || run.id !== id || run.draftVersion !== version ||
        run.snapshot.state !== 'running' ||
        (position !== null && (!(position instanceof Uint8Array) || position.byteLength > 80))) return;
    if (position === null) {
      this.removeCursor(run, socketId, telegramId);
      return;
    }
    run.cursors.set(socketId, { telegramId, position });
    this.publish('cursor', { telegramId, id, version, position });
  }

  control(id: unknown, version: unknown, type: unknown) {
    const run = this.run;
    if (!run || run.mode !== 'console' || run.id !== id) return { ok: false };
    if (type === 'clear') {
      if (run.timer) this.sendTo(run.owner, 'control', { id, type });
      else {
        run.snapshot = { ...run.snapshot, chunks: [] };
        this.sendState(run);
      }
      return { ok: true };
    }
    if (!run.timer || !run.draft) return { ok: false };
    if (type !== 'input' && type !== 'eof' && type !== 'interrupt' && type !== 'stop') return { ok: false };
    if (type === 'input' || type === 'eof') {
      if (run.snapshot.state !== 'running' || run.eof || run.draftVersion !== version) return { ok: false };
      const data = run.draft.getText('line').toString();
      this.sendTo(run.owner, 'control', { id, type, data });
      run.draft.destroy();
      run.draft = new Y.Doc();
      run.draftVersion++;
      run.cursors.clear();
      run.eof = type === 'eof';
      this.sendState(run);
    } else {
      this.sendTo(run.owner, 'control', { id, type });
    }
    return { ok: true };
  }

  clearCursors() {
    for (const socketId of this.batchCursors.keys()) this.removeBatchCursor(socketId);
    const run = this.run;
    if (!run) return;
    for (const [socketId, cursor] of run.cursors) {
      this.removeCursor(run, socketId, cursor.telegramId);
    }
  }

  private removeCursor(run: ConsoleRun, socketId: string, telegramId: string) {
    run.cursors.delete(socketId);
    this.publish('cursor', { telegramId, id: run.id, version: run.draftVersion, position: null });
  }

  leave(socketId: string) {
    this.removeBatchCursor(socketId);
    const run = this.run;
    const cursor = run?.cursors.get(socketId);
    if (run && cursor) this.removeCursor(run, socketId, cursor.telegramId);
    if (run?.timer && run.owner === socketId) {
      this.sendTo(run.owner, 'control', { id: run.id, type: 'stop' });
      run.snapshot = { ...run.snapshot, state: 'error', message: 'Общий запуск прерван' };
      this.finish(run);
      this.sendState(run);
    }
  }

  reset() {
    this.resetRun();
    this.batchDraft?.destroy();
    this.batchDraft = undefined;
    this.batchFormOpen = false;
    this.batchCursors.clear();
  }

  private resetRun() {
    if (this.run) {
      if (this.run.timer) this.sendTo(this.run.owner, 'control', { id: this.run.id, type: 'stop' });
      this.finish(this.run);
    }
    this.run = undefined;
  }

  private armTimeout(run: ConsoleRun, milliseconds: number) {
    clearTimeout(run.timer);
    run.timer = setTimeout(() => this.leave(run.owner), milliseconds);
    run.timer.unref?.();
  }

  private finish(run: ConsoleRun) {
    clearTimeout(run.timer);
    run.timer = undefined;
    run.draft?.destroy();
    run.draft = undefined;
    run.cursors.clear();
  }
}
