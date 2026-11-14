export const MAX_PASSWORD_LENGTH = 4096;
export const MAX_PRIVATE_KEY_LENGTH = 65536;
export const MAX_PASSPHRASE_LENGTH = 4096;
export const MAX_NAME_LENGTH = 255;
export const MAX_DESCRIPTION_LENGTH = 1024;

export function validatePassword(value: string): string | null {
  if (value.length > MAX_PASSWORD_LENGTH) {
    return `Password must be under ${MAX_PASSWORD_LENGTH} characters`;
  }
  return null;
}

export function validatePrivateKey(value: string): string | null {
  if (value.length > MAX_PRIVATE_KEY_LENGTH) {
    return `Private key must be under ${MAX_PRIVATE_KEY_LENGTH} characters`;
  }
  return null;
}

export function validatePassphrase(value: string): string | null {
  if (value.length > MAX_PASSPHRASE_LENGTH) {
    return `Passphrase must be under ${MAX_PASSPHRASE_LENGTH} characters`;
  }
  return null;
}

export function validateName(value: string): string | null {
  if (value.length > MAX_NAME_LENGTH) {
    return `Name must be under ${MAX_NAME_LENGTH} characters`;
  }
  return null;
}

export function validateDescription(value: string): string | null {
  if (value.length > MAX_DESCRIPTION_LENGTH) {
    return `Description must be under ${MAX_DESCRIPTION_LENGTH} characters`;
  }
  return null;
}

const PEM_HEADERS = [
  "begin rsa private key",
  "begin ec private key",
  "begin ed25519 private key",
  "begin dsa private key",
  "begin openssh private key",
  "begin private key",
];

export function looksLikePrivateKey(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  if (PEM_HEADERS.some((h) => trimmed.includes(h))) return true;
  if (trimmed.startsWith("openssh-key-v1")) return true;
  if (trimmed.startsWith("putty-user-key-file-")) return true;
  return false;
}
