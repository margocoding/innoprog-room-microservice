import { Language } from '@prisma/client';

describe('shared IDE language contract', () => {
  it('persists every language offered by the room editor', () => {
    expect(Object.values(Language)).toEqual(
      expect.arrayContaining(['js', 'py', 'bash', 'cpp', 'sql', 'java', 'dart', 'html']),
    );
  });
});
