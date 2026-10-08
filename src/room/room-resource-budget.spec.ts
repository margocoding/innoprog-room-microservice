import * as Y from 'yjs';
import { RoomResourceBudget, MAX_UPDATE_BYTES } from './room-resource-budget';
const apply = (doc: Y.Doc, update: Uint8Array) => {
  Y.applyUpdate(doc, update);
  return update;
};

describe('room resource containment', () => {
  it('rejects accumulated content before live mutation and preserves another room', () => {
    const budget = new RoomResourceBudget();
    const live = new Y.Doc();
    const author = new Y.Doc();
    budget.remember('one', live);
    for (let i = 0; i < 3; i++) {
      author
        .getText('codemirror')
        .insert(author.getText('codemirror').length, 'a'.repeat(65536));
      const update = Y.encodeStateAsUpdate(author, Y.encodeStateVector(live));
      budget.consume('one', 'socket', update.length, i * 1000);
      budget.apply('one', live, update, apply);
    }
    const before = Y.encodeStateAsUpdate(live);
    author
      .getText('codemirror')
      .insert(author.getText('codemirror').length, 'a'.repeat(65536));
    expect(() =>
      budget.apply(
        'one',
        live,
        Y.encodeStateAsUpdate(author, Y.encodeStateVector(live)),
        apply,
      ),
    ).toThrow();
    expect(Y.encodeStateAsUpdate(live)).toEqual(before);
    const other = new Y.Doc();
    const small = new Y.Doc();
    small.getText('codemirror').insert(0, 'print(7)');
    budget.remember('other', other);
    budget.apply('other', other, Y.encodeStateAsUpdate(small), apply);
    expect(other.getText('codemirror').toString()).toBe('print(7)');
    [live, author, other, small].forEach((x) => x.destroy());
  });

  it('limits deleted CRDT structs even when visible text is empty', () => {
    const budget = new RoomResourceBudget();
    const doc = new Y.Doc({ gc: false });
    const text = doc.getText('codemirror');
    text.insert(0, 'a'.repeat(1100000));
    text.delete(0, text.length);
    expect(text.length).toBe(0);
    expect(() => budget.remember('one', doc)).toThrow();
    doc.destroy();
  });

  it('rejects oversized and malformed updates without changing live state', () => {
    const budget = new RoomResourceBudget();
    const doc = new Y.Doc();
    budget.remember('one', doc);
    expect(() => budget.consume('one', 's', MAX_UPDATE_BYTES + 1, 0)).toThrow();
    const before = Y.encodeStateAsUpdate(doc);
    expect(() =>
      budget.apply('one', doc, new Uint8Array([255]), apply),
    ).toThrow();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    doc.destroy();
  });

  it('bounds frequency, restores budget over time, and isolates sockets', () => {
    const budget = new RoomResourceBudget();
    for (let i = 0; i < 60; i++) budget.consume('one', 's', 1, 0);
    expect(() => budget.consume('one', 's', 1, 0)).toThrow();
    expect(() => budget.consume('other', 't', 1, 0)).not.toThrow();
    expect(() => budget.consume('one', 's', 1, 1000)).not.toThrow();
  });

  it('rejects hidden shared roots before mutation', () => {
    const budget = new RoomResourceBudget();
    const live = new Y.Doc();
    const attacker = new Y.Doc();
    budget.remember('one', live);
    attacker.getMap('hidden').set('payload', 'x');
    expect(() =>
      budget.apply('one', live, Y.encodeStateAsUpdate(attacker), apply),
    ).toThrow();
    expect(live.share.has('hidden')).toBe(false);
    live.destroy();
    attacker.destroy();
  });

  it('caps room cardinality and frees capacity on teardown', () => {
    const budget = new RoomResourceBudget();
    for (let i = 0; i < 128; i++) budget.reserveRoom(String(i));
    expect(() => budget.reserveRoom('new')).toThrow();
    budget.releaseRoom('0');
    expect(() => budget.reserveRoom('new')).not.toThrow();
  });
});
