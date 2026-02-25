export interface CipherBundle {
    wrappedDek: string;
    iv: string;
    authTag: string;
    ciphertext: string;
}
export declare class KmsEnvelope {
    private readonly kmsKeyName?;
    private kms;
    constructor(kmsKeyName?: string | undefined);
    encrypt(plaintext: string): Promise<CipherBundle>;
    decrypt(bundle: CipherBundle): Promise<string>;
    private wrapWithKms;
    private unwrapWithKms;
}
