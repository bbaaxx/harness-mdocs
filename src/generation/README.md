# Agent Asset Generation Safety

Generator serializes repository mutations with `.mdocs-generation.lock`. Every local process that
writes managed agent assets must honor this lock by using `generateAssets`; direct edits and other
writers are outside transaction protocol.

Lock ownership is portable and never shells out: each lock records `{pid, bootToken, nonce}` where
`bootToken` is a random token persisted atomically in `.mdocs-generation.boot`. The holder refreshes
the lock mtime as a liveness signal at operation boundaries. A lock with a live PID and a matching
boot token is a live owner and is never taken over, regardless of heartbeat age. Only dead-PID,
boot-token-mismatched, or malformed locks are reclaimed, so PID reuse cannot steal a live lock.

Node does not expose portable `openat`/directory-handle-relative rename operations. Generator pins
each validated parent inode by changing cwd one segment at a time, then opens, links, renames, and
unlinks relative single basenames only. Bigint device/inode checks and no-follow opens detect swaps.
Absent destinations publish with a same-filesystem hard link and fail on `EEXIST`; existing files
move to their exact journaled backup inode before publication. On POSIX, generated files use mode
`0644`, lock and journal files use `0600`, and directory mutations are fsynced. Windows preserves
file fsync and journal ordering but skips unsupported directory handles and POSIX-only mode checks.
Only `EINVAL`, `EPERM`, and `ENOTSUP` suppress POSIX directory durability operations.

Changing cwd is process-global. Public generator APIs serialize themselves, but generator process
must not run unrelated concurrent cwd-sensitive tasks. Generator does not claim safety against code
that bypasses this API and mutates cwd concurrently.

Journal phases are `prepared`, `applying`, `committed`, and `cleaning`. Applying recovery rolls back;
committed recovery only finishes cleanup. A root bootstrap journal durably records missing directory
intent before transaction-directory creation; canonical journal takes over only after that directory
is pinned. Created identities are then journaled, and rollback removes matching empty directories
deepest-first. Every move fsyncs source and destination directories before phase advancement.

Stage/install paths are journal-owned before their `O_EXCL` create. A write or fsync failure removes
the partial artifact immediately (identity-verified), and recovery removes journal-owned partial
artifacts by the same checks, so a torn write never wedges rollback. The bootstrap journal records
its exact temporary path plus a per-transaction CSPRNG secret; recovery dedupes the duplicate
temp/journal hardlink entries by canonical path and exact dev/ino, unlinking each entry exactly
once, and deletes the temp only when path, dev/ino, byte digest, and secret proof all match.
A forged replacement — copied bytes on a new inode, or new bytes lacking the secret — is left
untouched.

`--check` never acquires lock, creates directories, compiles into repository, or repairs a pending
transaction. It reports `.mdocs-generation/journal.json` as pending and exits nonzero.
During bootstrap it reports `.mdocs-generation-bootstrap.json` instead. Pending detection happens
before canonical sources are read, including when those sources are missing.
