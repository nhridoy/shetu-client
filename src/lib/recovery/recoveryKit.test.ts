import { describe, expect, it } from 'vitest';
import { buildRecoveryKitContent, buildRecoveryKitFilename } from './recoveryKit';

describe('Shetu recovery kit', () => {
  it('uses Shetu branding in its document and exported filename', () => {
    expect(buildRecoveryKitContent('test-code', 'alice@example.com')).toContain('Shetu Recovery Kit');
    expect(buildRecoveryKitFilename('alice@example.com')).toBe('shetu-recovery-kit-(alice@example.com).txt');
  });
});
