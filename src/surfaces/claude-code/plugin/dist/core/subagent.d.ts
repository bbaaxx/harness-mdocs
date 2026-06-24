import { Initiative, WikiEntry, StepName, SearchResult, AuditEvent } from './types';
export interface AssemblyOptions {
    retrievedMemory?: SearchResult[];
    recentEvents?: AuditEvent[];
}
export declare class SubagentAssembler {
    assemble(initiative: Initiative, wikiEntries: WikiEntry[], currentStep: StepName, options?: AssemblyOptions): string;
}
