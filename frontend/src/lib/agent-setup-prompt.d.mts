export interface SetupContext {
  schemaVersion: 1;
  host: string;
  space: 'applications';
  expectedOwner?: string;
}
export function createSetupContext(hosts: string[], expectedOwner?: string | null): SetupContext;
export function buildSetupPrompt(config: { instructionsUrl: string }, context: SetupContext): string;
