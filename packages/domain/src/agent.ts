export const AGENT_IDS = {
  BRAD_KIMI: 'brad-kimi',
  HERMES: 'hermes',
  CODEX: 'codex',
  CLAUDE: 'claude',
  VERIFIER: 'verifier',
  OWNER: 'owner',
  SYSTEM: 'system'
} as const;

export type AgentId = (typeof AGENT_IDS)[keyof typeof AGENT_IDS];

export type AgentMessageType =
  | 'OWNER_REQUEST'
  | 'FIRST_PRINCIPLES'
  | 'DELEGATE'
  | 'QUESTION'
  | 'RESULT'
  | 'CRITIQUE'
  | 'REVISION'
  | 'VERIFY'
  | 'BLOCKER'
  | 'DECISION'
  | 'SYSTEM';

export type AgentThreadStatus =
  | 'SHADOW'
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING'
  | 'WAITING_APPROVAL'
  | 'WAITING_VERIFICATION'
  | 'BLOCKED'
  | 'PAUSED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED';

export type ReasoningDepth = 'LIGHT' | 'FULL';

export interface FirstPrinciplesBrief {
  objective: string;
  bindingConstraint: string;
  hiddenAssumption: string;
  candidate: string;
  strongestAttack: string;
  repair: string;
  decisiveTest: string;
  depth: ReasoningDepth;
}

export interface AuthorityEnvelope {
  level: 'READ_ONLY' | 'INTERNAL_WRITE' | 'APPROVAL_REQUIRED' | 'OWNER_APPROVAL';
  externalEffectsAllowed: boolean;
  allowedTools: string[];
  forbiddenScopes: string[];
}

export interface AgentTurnBudget {
  consecutiveAgentTurns: number;
  maxConsecutiveAgentTurns: number;
  elapsedMs: number;
  maxElapsedMs: number;
  costMicros: number;
  maxCostMicros: number;
}

const SUBSTANTIVE_PATTERNS = [
  /\b(strategy|architecture|legal|financial|deploy|delete|publish|purchase|security|credential)\b/i,
  /\b(compare|investigate|root cause|first principles|red[- ]?team|audit|design|build)\b/i,
  /\b(send|spend|file|sign|trade|transfer|approve)\b/i
];

export function classifyReasoningDepth(text: string): ReasoningDepth {
  const normalized = text.trim();
  if (normalized.length >= 240 || SUBSTANTIVE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return 'FULL';
  }
  return 'LIGHT';
}

export function buildFirstPrinciplesBrief(text: string): FirstPrinciplesBrief {
  const objective = text.trim().replace(/^\/do\b\s*/i, '').trim() || 'Resolve the owner request.';
  const depth = classifyReasoningDepth(objective);

  if (depth === 'LIGHT') {
    return {
      objective,
      bindingConstraint: 'The result must be produced and checked without creating an unauthorized effect.',
      hiddenAssumption: 'The request contains enough context to choose a reversible next action.',
      candidate: 'Take the smallest proof-bearing action that advances the objective.',
      strongestAttack: 'The action may only create activity rather than prove the requested outcome.',
      repair: 'Require a concrete artifact, source-of-truth observation, or precise blocker.',
      decisiveTest: 'Check the requested outcome against its source of truth before closing.',
      depth
    };
  }

  return {
    objective,
    bindingConstraint: 'Identify and remove the constraint that prevents a verified outcome.',
    hiddenAssumption: 'The apparent task is the highest-value interpretation within the owner\'s stated scope and authority.',
    candidate: 'Form the strongest reversible solution using current evidence and available capabilities.',
    strongestAttack: 'Assume the candidate is wrong, incomplete, unsafe, duplicated, or optimized for activity instead of outcome.',
    repair: 'Revise the candidate until the strongest remaining objection no longer changes the recommended action.',
    decisiveTest: 'Run the cheapest source-of-truth test with an explicit threshold and resulting decision.',
    depth
  };
}

export function turnBudgetFailure(budget: AgentTurnBudget): 'LOOP_BUDGET_EXHAUSTED' | 'TIME_BUDGET_EXHAUSTED' | 'COST_BUDGET_EXHAUSTED' | null {
  if (budget.consecutiveAgentTurns >= budget.maxConsecutiveAgentTurns) return 'LOOP_BUDGET_EXHAUSTED';
  if (budget.elapsedMs >= budget.maxElapsedMs) return 'TIME_BUDGET_EXHAUSTED';
  if (budget.costMicros >= budget.maxCostMicros) return 'COST_BUDGET_EXHAUSTED';
  return null;
}

export function defaultAuthorityEnvelope(): AuthorityEnvelope {
  return {
    level: 'APPROVAL_REQUIRED',
    externalEffectsAllowed: false,
    allowedTools: [],
    forbiddenScopes: ['JENNI', 'CREDENTIALS', 'LEGAL_FILING', 'PAYMENTS', 'DELETION', 'PUBLICATION']
  };
}

const SENSITIVE_TEXT_PATTERNS: RegExp[] = [
  /-----BEGIN [^-\n]+ PRIVATE KEY-----[\s\S]*?-----END [^-\n]+ PRIVATE KEY-----/g,
  /\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|bot[_-]?token|token|secret|password|passwd|pwd)\s*[:=]\s*)["']?[^\s"',;]+["']?/gi
];

export function redactSensitiveText(value: string): string {
  return SENSITIVE_TEXT_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(
      pattern,
      (_match, prefix?: unknown) => typeof prefix === 'string' ? `${prefix}[REDACTED]` : '[REDACTED]'
    ),
    value
  );
}

export function authorityViolation(text: string, authority: AuthorityEnvelope): string | null {
  if (authority.forbiddenScopes.includes('JENNI') && /\bjenni(?:pro)?\b/i.test(text)) {
    return 'FORBIDDEN_SCOPE_JENNI';
  }
  return null;
}

export function nextAgentForTurn(input: {
  currentAgentId: AgentId;
  reasoningDepth: ReasoningDepth;
  hasCritique: boolean;
}): AgentId | null {
  if (input.currentAgentId === AGENT_IDS.BRAD_KIMI) return AGENT_IDS.HERMES;
  if (input.currentAgentId === AGENT_IDS.HERMES) {
    if (input.hasCritique || input.reasoningDepth === 'LIGHT') return AGENT_IDS.VERIFIER;
    return AGENT_IDS.CODEX;
  }
  if (input.currentAgentId === AGENT_IDS.CODEX || input.currentAgentId === AGENT_IDS.CLAUDE) {
    return AGENT_IDS.HERMES;
  }
  return null;
}
