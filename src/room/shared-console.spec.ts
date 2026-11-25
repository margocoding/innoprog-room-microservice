import type { Socket } from 'socket.io';
import * as Y from 'yjs';
import { SharedConsole } from './shared-console';

const owner = { id: 'owner-socket' } as Socket;
const guest = { id: 'guest-socket' } as Socket;
const running = { state: 'running', chunks: [], message: '', exitCode: null, deadline: 0 };

describe('SharedConsole', () => {
  const publish = jest.fn();
  const sendTo = jest.fn();
  let console: SharedConsole;

  beforeEach(() => {
    publish.mockClear();
    sendTo.mockClear();
    console = new SharedConsole(publish, sendTo);
  });

  afterEach(() => console.reset());

  it('grants one runner and accepts transcript updates only from that runner', () => {
    const { id } = console.start(owner, 'console');
    expect(console.start(guest, 'batch')).toEqual({ ok: false });
    console.update(guest, id, { ...running, message: 'Guest output' });
    expect(console.read()?.snapshot.state).toBe('connecting');

    console.update(owner, id, { ...running, chunks: [{ text: 'Printed', stream: 'stdout' }] });
    expect(console.read()?.snapshot.chunks).toEqual([{ text: 'Printed', stream: 'stdout' }]);
    console.leave(guest.id);
    expect(console.read()?.snapshot.state).toBe('running');
    console.leave(owner.id);
    expect(console.read()?.snapshot.state).toBe('error');
    expect(console.start(guest, 'batch').ok).toBe(true);
  });

  it('removes all console cursors from active viewers and the join snapshot', () => {
    const { id } = console.start(owner, 'console');
    console.update(owner, id, running);
    const position = Uint8Array.of(1);
    console.cursor(owner.id, 'teacher', id, 0, position);
    console.cursor(guest.id, 'student', id, 0, position);

    console.clearCursors();

    expect(publish).toHaveBeenLastCalledWith('cursor', { telegramId: 'student', id, version: 0, position: null });
    expect(console.read()?.cursors).toEqual([]);
  });

  it('freezes the shared transcript and hands the running draft to its owner when sharing stops', () => {
    const { id } = console.start(owner, 'console');
    console.update(owner, id, { ...running, chunks: [{ text: 'Prompt', stream: 'stdout' }] });
    const draft = new Y.Doc();
    try {
      draft.getText('line').insert(0, 'pending input');
      expect(console.edit(id, 0, Y.encodeStateAsUpdate(draft)).ok).toBe(true);
      console.disableSharing();
      expect(sendTo).toHaveBeenLastCalledWith(owner.id, 'detach', { id, line: 'pending input', eof: false });
      expect(console.read()?.snapshot).toMatchObject({ state: 'detached', chunks: [{ text: 'Prompt' }] });
      expect(console.control(id, 0, 'input').ok).toBe(false);
      console.update(owner, id, { ...running, message: 'Private' });
      expect(console.read()?.snapshot.message).toBe('');
    } finally {
      draft.destroy();
    }
  });

  it('removes batch markers from the teacher and student across both fields', () => {
    console.openBatchForm();
    console.updateBatchOptions('outputEnabled', true);
    const position = Uint8Array.of(1);
    console.batchCursor(owner.id, 'teacher', 'input', position);
    console.batchCursor(guest.id, 'student', 'output', position);
    console.clearCursors();
    expect(console.readBatchForm()?.cursors).toEqual([]);
    expect(publish).toHaveBeenLastCalledWith('batch-cursor', { telegramId: 'student', field: 'output', position: null });
  });

  it('merges concurrent edits to the batch form and retains the inputs when a batch starts', () => {
    console.openBatchForm();
    const first = new Y.Doc();
    const second = new Y.Doc();
    const observer = new Y.Doc();
    try {
      first.getText('input').insert(0, 'first');
      second.getText('input').insert(0, 'second');
      second.getText('output').insert(0, 'expected');
      expect(console.editBatchForm(Y.encodeStateAsUpdate(first)).ok).toBe(true);
      expect(console.editBatchForm(Y.encodeStateAsUpdate(second)).ok).toBe(true);
      console.updateBatchOptions('outputEnabled', true);
      expect(console.start(owner, 'batch').ok).toBe(true);
      const form = console.readBatchForm()!;
      expect(form).toMatchObject({ open: false, inputEnabled: true, outputEnabled: true });
      Y.applyUpdate(observer, form.draft);
      expect(['firstsecond', 'secondfirst']).toContain(observer.getText('input').toString());
      expect(observer.getText('output').toString()).toBe('expected');
    } finally {
      first.destroy();
      second.destroy();
      observer.destroy();
    }
  });

  it('merges drafts edited concurrently and delivers each submitted line once', () => {
    const { id } = console.start(owner, 'console');
    console.update(owner, id, running);
    const first = new Y.Doc();
    const second = new Y.Doc();
    try {
      first.getText('line').insert(0, 'Анна');
      second.getText('line').insert(0, 'Лена');
      const firstUpdate = Y.encodeStateAsUpdate(first);
      expect(console.edit(id, 0, firstUpdate).ok).toBe(true);
      expect(console.edit(id, 0, Y.encodeStateAsUpdate(second)).ok).toBe(true);

      expect(console.control(id, 0, 'input').ok).toBe(true);
      const [{ data }] = sendTo.mock.calls.map(call => call[2]);
      expect(['АннаЛена', 'ЛенаАнна']).toContain(data);
      expect(console.control(id, 0, 'input').ok).toBe(false);
      expect(console.edit(id, 0, firstUpdate).ok).toBe(false);
      expect(sendTo).toHaveBeenCalledTimes(1);
      expect(console.read()?.draftVersion).toBe(1);
    } finally {
      first.destroy();
      second.destroy();
    }
  });
});
