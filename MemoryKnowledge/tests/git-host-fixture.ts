/** Deterministic public key blob; never a user's key. */
export function hostEntry(host: string, value = 1): string {
  const algorithm = Buffer.from('ssh-ed25519');
  const length = Buffer.alloc(4); length.writeUInt32BE(algorithm.length);
  const keyLength = Buffer.alloc(4); keyLength.writeUInt32BE(32);
  return `${host} ssh-ed25519 ${Buffer.concat([length, algorithm, keyLength, Buffer.alloc(32, value)]).toString('base64')}`;
}
