import { OpaqueHandle } from './handles';

/**
 * Opaque host identity. All fields are opaque references; none of them are
 * agent names, prompt role strings, environment variables, or caller-supplied
 * metadata — those are NOT identity and carry no authority.
 */
export interface HostIdentity {
  providerId: string;
  sessionRef: string;
  principalRef: string;
}

/**
 * Maps trusted host session/agent/tool-call identity to controller-issued
 * opaque handles. `bindHandle` is control-plane-only; workers can never bind
 * an identity to a handle themselves, and a caller-constructed identity object
 * has no association with any handle it did not receive through this provider.
 */
export interface HostIdentityProvider {
  currentHostIdentity(): Promise<HostIdentity | null>;
  bindHandle(identity: HostIdentity, handle: OpaqueHandle): void;
  identityForHandle(handle: OpaqueHandle): HostIdentity | null;
}
