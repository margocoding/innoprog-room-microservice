import * as Y from 'yjs';

export const MAX_UPDATE_BYTES = 128 * 1024;
export const MAX_SNAPSHOT_BYTES = 1024 * 1024;
export const MAX_TEXT_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_DOCS = 128;
type Bucket = { tokens: number; bytes: number; at: number };

/** Bounded CRDT state, including deleted/pending structs, before live mutation. */
export class RoomResourceBudget {
  private sizes = new Map<string, number>();
  private buckets = new Map<string, Bucket>();

  reserveRoom(roomId: string) {
    if (!this.sizes.has(roomId) && this.sizes.size >= MAX_DOCS)
      throw new Error('Достигнут лимит активных комнат');
    if (!this.sizes.has(roomId)) this.sizes.set(roomId, 0);
  }

  releaseRoom(roomId: string) {
    this.sizes.delete(roomId);
    this.buckets.delete(`room:${roomId}`);
  }
  releaseSocket(socketId: string) {
    this.buckets.delete(`socket:${socketId}`);
  }

  consume(
    roomId: string,
    socketId: string,
    bytes: number,
    now = Date.now(),
    sync = false,
  ) {
    if (
      bytes > (sync ? MAX_SNAPSHOT_BYTES + MAX_UPDATE_BYTES : MAX_UPDATE_BYTES)
    )
      throw new Error('Слишком большое обновление кода');
    for (const [key, bucket] of this.buckets)
      if (now - bucket.at > 60_000) this.buckets.delete(key);
    const specs: Array<[string, number, number]> = [
      ['global', 120, 4 * 1024 * 1024],
      [`room:${roomId}`, 60, 1024 * 1024],
      [`socket:${socketId}`, 30, 512 * 1024],
    ];
    const staged = specs.map(([key, rate, byteRate]) => {
      const old = this.buckets.get(key) ?? {
        tokens: rate * 2,
        bytes: byteRate * 2,
        at: now,
      };
      const elapsed = Math.max(0, now - old.at) / 1000;
      const bucket = {
        tokens: Math.min(rate * 2, old.tokens + elapsed * rate),
        bytes: Math.min(byteRate * 2, old.bytes + elapsed * byteRate),
        at: now,
      };
      if (bucket.tokens < 1 || bucket.bytes < bytes)
        throw new Error('Слишком частые обновления кода. Повторите позже');
      return { key, bucket };
    });
    if (
      this.buckets.size +
        staged.filter((x) => !this.buckets.has(x.key)).length >
      4096
    )
      throw new Error('Редактор временно занят');
    for (const { key, bucket } of staged) {
      bucket.tokens -= 1;
      bucket.bytes -= bytes;
      this.buckets.set(key, bucket);
    }
  }

  validate(roomId: string, doc: Y.Doc): Uint8Array {
    if ([...doc.share.keys()].some((key) => key !== 'codemirror'))
      throw new Error('Неподдерживаемая структура документа');
    doc.getText('codemirror');
    const state = Y.encodeStateAsUpdate(doc);
    if (state.byteLength > MAX_SNAPSHOT_BYTES)
      throw new Error('Достигнут лимит состояния документа');
    // Includes every shared type, not just the visible editor text.
    if (
      Buffer.byteLength(JSON.stringify(doc.toJSON()), 'utf8') > MAX_TEXT_BYTES
    )
      throw new Error('Достигнут лимит размера кода');
    const total =
      [...this.sizes.values()].reduce((a, b) => a + b, 0) -
      (this.sizes.get(roomId) ?? 0) +
      state.byteLength;
    if (total > MAX_TOTAL_BYTES)
      throw new Error('Достигнут общий лимит редактора');
    return state;
  }

  remember(roomId: string, doc: Y.Doc) {
    this.reserveRoom(roomId);
    this.sizes.set(roomId, this.validate(roomId, doc).byteLength);
  }

  apply(
    roomId: string,
    doc: Y.Doc,
    update: Uint8Array,
    apply: (doc: Y.Doc, update: Uint8Array) => Uint8Array | null,
  ) {
    const staged = new Y.Doc();
    try {
      Y.applyUpdate(staged, Y.encodeStateAsUpdate(doc));
      Y.applyUpdate(staged, update);
      // Shared types decoded from updates need their constructor resolved for toJSON.
      for (const [key, type] of doc.share) {
        if (type instanceof Y.Text) staged.getText(key);
        else if (type instanceof Y.Map) staged.getMap(key);
        else if (type instanceof Y.Array) staged.getArray(key);
      }
      const state = this.validate(roomId, staged);
      const integrated = apply(doc, update);
      this.sizes.set(roomId, state.byteLength);
      return integrated;
    } finally {
      staged.destroy();
    }
  }
}
