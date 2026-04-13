export interface SshPublicKey {
  id: string;
  name: string;
  publicKey: string;    // full key line, e.g. "ssh-ed25519 AAAA... comment"
  fingerprint: string;  // SHA256:... format
  addedAt: string;      // ISO datetime
}
