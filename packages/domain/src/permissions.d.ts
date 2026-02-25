import type { WriteActionType } from './types.js';
export interface PolicyContext {
    readAllowed: boolean;
    writeRequiresApproval: boolean;
}
export declare function isWriteAction(actionType: WriteActionType): boolean;
export declare function canExecuteRead(policy: PolicyContext): boolean;
export declare function requiresApproval(policy: PolicyContext, actionType: WriteActionType): boolean;
