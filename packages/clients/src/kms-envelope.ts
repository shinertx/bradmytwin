import { KeyManagementServiceClient } from '@google-cloud/kms';
import crypto from 'node:crypto';

export interface CipherBundle {
  wrappedDek: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export class KmsEnvelope {
  private kms = new KeyManagementServiceClient();

  constructor(private readonly kmsKeyName?: string) {}

  async encrypt(plaintext: string): Promise<CipherBundle> {
    const dek = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const wrappedDek = this.kmsKeyName
      ? await this.wrapWithKms(dek)
      : Buffer.from(dek).toString('base64');

    return {
      wrappedDek,
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      ciphertext: ciphertext.toString('base64')
    };
  }

  async decrypt(bundle: CipherBundle): Promise<string> {
    const dek = this.kmsKeyName
      ? await this.unwrapWithKms(bundle.wrappedDek)
      : Buffer.from(bundle.wrappedDek, 'base64');

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      dek,
      Buffer.from(bundle.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(bundle.authTag, 'base64'));

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(bundle.ciphertext, 'base64')),
      decipher.final()
    ]);

    return plaintext.toString('utf8');
  }

  private async wrapWithKms(dek: Buffer): Promise<string> {
    const [result] = await this.kms.encrypt({
      name: this.kmsKeyName,
      plaintext: dek
    });

    return Buffer.from(result.ciphertext as Uint8Array).toString('base64');
  }

  private async unwrapWithKms(wrappedDek: string): Promise<Buffer> {
    const [result] = await this.kms.decrypt({
      name: this.kmsKeyName,
      ciphertext: Buffer.from(wrappedDek, 'base64')
    });

    return Buffer.from(result.plaintext as Uint8Array);
  }
}
