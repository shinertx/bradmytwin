import type { WriteActionType } from './types.js';

export interface PolicyContext {
  readAllowed: boolean;
  writeRequiresApproval: boolean;
}

export function isWriteAction(actionType: WriteActionType): boolean {
  return ['SEND_EMAIL', 'CREATE_EVENT', 'UPDATE_EVENT', 'SUBMIT_FORM'].includes(actionType);
}

export function canExecuteRead(policy: PolicyContext): boolean {
  return policy.readAllowed;
}

export function requiresApproval(policy: PolicyContext, actionType: WriteActionType): boolean {
  return isWriteAction(actionType) && policy.writeRequiresApproval;
}
