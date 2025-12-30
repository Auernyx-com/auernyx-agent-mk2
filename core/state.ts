export type WorkingMemory = Record<string, unknown>;

export interface AuernyxState {
    sessionId: string;
    startedAt: string;
    memory: WorkingMemory;
}

export function createState(): AuernyxState {
    return {
        sessionId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        startedAt: new Date().toISOString(),
        memory: {}
    };
}
