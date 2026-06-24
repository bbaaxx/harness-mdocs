/**
 * Try to run `fn` while holding a lock at `<baseDir>/.<name>.lock`.
 * Returns true if the lock was acquired and `fn` ran, false on timeout.
 */
export declare function withLock<T>(baseDir: string, name: string, fn: () => T, opts?: {
    timeoutMs?: number;
    retryMs?: number;
}): {
    ran: boolean;
    value?: T;
};
