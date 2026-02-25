const prompts = {
    ASK_NAME: 'Welcome to Brad. What should I call you?',
    ASK_CONNECT_CALENDAR: 'Nice to meet you. Reply CONNECT CALENDAR to link Google Calendar or SKIP.',
    ASK_CONNECT_EMAIL: 'Great. Reply CONNECT EMAIL to link Gmail or SKIP.',
    CONFIRM_READY: 'All set. Reply READY to start using your twin.',
    ACTIVE: 'You are fully onboarded.'
};
export function getOnboardingPrompt(state) {
    return prompts[state];
}
export function advanceOnboarding(state, input) {
    const normalized = input.trim();
    switch (state) {
        case 'ASK_NAME':
            if (!normalized) {
                return { nextState: state, response: 'Please share your preferred name.' };
            }
            return {
                nextState: 'ASK_CONNECT_CALENDAR',
                response: `Thanks ${normalized}. Reply CONNECT CALENDAR to continue, or SKIP.`
            };
        case 'ASK_CONNECT_CALENDAR':
            if (normalized.toUpperCase() === 'CONNECT CALENDAR' || normalized.toUpperCase() === 'SKIP') {
                return {
                    nextState: 'ASK_CONNECT_EMAIL',
                    response: 'Reply CONNECT EMAIL to continue, or SKIP.'
                };
            }
            return {
                nextState: state,
                response: 'Reply CONNECT CALENDAR to link now, or SKIP to continue.'
            };
        case 'ASK_CONNECT_EMAIL':
            if (normalized.toUpperCase() === 'CONNECT EMAIL' || normalized.toUpperCase() === 'SKIP') {
                return {
                    nextState: 'CONFIRM_READY',
                    response: 'Reply READY when you are ready to start.'
                };
            }
            return {
                nextState: state,
                response: 'Reply CONNECT EMAIL to link now, or SKIP to continue.'
            };
        case 'CONFIRM_READY':
            if (normalized.toUpperCase() === 'READY') {
                return { nextState: 'ACTIVE', response: 'Great. Your twin is active.' };
            }
            return {
                nextState: state,
                response: 'Reply READY to activate your twin.'
            };
        case 'ACTIVE':
            return { nextState: state, response: 'Your twin is already active.' };
    }
}
//# sourceMappingURL=onboarding.js.map