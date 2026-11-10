import { describe, expect, it } from 'vitest';
import { fingerprint } from '../../src/http/idempotency';

describe('fingerprint', () => {
  it('ignores key order and undefined fields', () => {
    expect(fingerprint('swap', { a: 1, b: 'x', c: undefined })).toBe(
      fingerprint('swap', { b: 'x', a: 1 }),
    );
  });

  it('differs when the operation or any value differs', () => {
    const base = fingerprint('deposit', { walletId: 'w', amount: '1.000000' });
    expect(fingerprint('swap', { walletId: 'w', amount: '1.000000' })).not.toBe(base);
    expect(fingerprint('deposit', { walletId: 'w', amount: '1.000001' })).not.toBe(base);
  });
});
