import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface IdentityBinding {
  instanceId: string;
  providerId: string;
  externalSubject: string;
  coreUserId: string;
  encryptedUserKey: string;
  displayName?: string;
  updatedAt: string;
}

interface IdentityFile {
  version: 1;
  bindings: IdentityBinding[];
}

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function encryptSecret(value: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((part) => part.toString('base64url')).join('.');
}

export function decryptSecret(value: string, secret: string): string {
  const [ivText, tagText, ciphertextText] = value.split('.');
  if (!ivText || !tagText || !ciphertextText) throw new Error('invalid encrypted identity binding');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export class FileIdentityStore {
  private readonly bindings = new Map<string, IdentityBinding>();

  constructor(private readonly filePath: string) {
    this.load();
  }

  find(instanceId: string, providerId: string, externalSubject: string): IdentityBinding | null {
    return this.bindings.get(this.key(instanceId, providerId, externalSubject)) ?? null;
  }

  save(binding: IdentityBinding): void {
    this.bindings.set(this.key(binding.instanceId, binding.providerId, binding.externalSubject), binding);
    this.flush();
  }

  private key(instanceId: string, providerId: string, externalSubject: string): string {
    return `${instanceId}\u0000${providerId}\u0000${externalSubject}`;
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<IdentityFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.bindings)) return;
      for (const binding of parsed.bindings) {
        if (
          binding && typeof binding.instanceId === 'string' && typeof binding.providerId === 'string' &&
          typeof binding.externalSubject === 'string' && typeof binding.coreUserId === 'string' &&
          typeof binding.encryptedUserKey === 'string'
        ) {
          this.bindings.set(this.key(binding.instanceId, binding.providerId, binding.externalSubject), binding);
        }
      }
    } catch {
      throw new Error(`invalid Panel auth identity store: ${this.filePath}`);
    }
  }

  private flush(): void {
    const parent = dirname(this.filePath);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tempPath, JSON.stringify({ version: 1, bindings: [...this.bindings.values()] }, null, 2), {
      encoding: 'utf8', mode: 0o600,
    });
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, this.filePath);
  }
}
