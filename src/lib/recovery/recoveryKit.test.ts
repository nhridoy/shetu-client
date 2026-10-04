import { describe, expect, it } from 'vitest';
import { buildRecoveryKitContent, buildRecoveryKitFilename } from './recoveryKit';

describe('Terra recovery kit', () => {
  it('uses Terra branding in its document and exported filename', () => {
    expect(buildRecoveryKitContent('test-code', 'alice@example.com')).toContain('Terra Recovery Kit');
    expect(buildRecoveryKitFilename('alice@example.com')).toBe('terra-recovery-kit-(alice@example.com).txt');
  });
});
