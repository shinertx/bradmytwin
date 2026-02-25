import type { OnboardingState } from './types.js';
export declare function getOnboardingPrompt(state: OnboardingState): string;
export declare function advanceOnboarding(state: OnboardingState, input: string): {
    nextState: OnboardingState;
    response: string;
};
