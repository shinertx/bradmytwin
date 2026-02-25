export function isWriteAction(actionType) {
    return ['SEND_EMAIL', 'CREATE_EVENT', 'UPDATE_EVENT', 'SUBMIT_FORM'].includes(actionType);
}
export function canExecuteRead(policy) {
    return policy.readAllowed;
}
export function requiresApproval(policy, actionType) {
    return isWriteAction(actionType) && policy.writeRequiresApproval;
}
//# sourceMappingURL=permissions.js.map