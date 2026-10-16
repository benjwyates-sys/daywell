# Storage reliability — session 3

Implemented on `codex/storage-reliability`, based on session 2 `08ce312` and persistence `a56412a`. This is a local single-owner service. No hosting, model calls, mailbox access, inference, sending or booking is added. All verification uses disposable synthetic databases.

## Runtime and compatibility

Node 22.16+ is required for the [SQLite online backup API](https://nodejs.org/api/sqlite.html#sqlitebackupsourceDb-path-options). Run `npm install`, then `npm test`.

Schema `PRAGMA user_version=1` replaces the unversioned baseline/session-2 schema. Opening a store upgrades it in one `BEGIN IMMEDIATE` transaction. Rows, IDs, serialized values, exact originals, typed warranty assertions and correction history are not rewritten. Added storage state, indexes, insert reference triggers and the unique correction-successor index cannot partially install. Existing orphan evidence or divergent/cyclic correction chains reject the upgrade; do not delete evidence to bypass an error. Unknown newer versions reject. Integrity is checked on open. Existing over-quota data remains readable; deliberately raise quotas before further writes if necessary. The default path was never opened or upgraded during this session's verification.

**Back up before first starting the new server or MCP against personal data.** The explicit backup CLI opens the source read-only and supports valid unversioned baseline/session-2 databases. It does not first migrate the source. Stop old-version writers before the upgrade: they do not maintain the new generation/quota/audit contract. Do not run mixed code versions on one database.

## Copyable isolated reproduction

Run from the Daywell repository root. These commands create synthetic data in a new temporary directory; no personal/default database is involved:

```sh
npm run setup
npm exec --prefix services/daywell -- playwright install chromium
npm test
export DAYWELL_DB="$(mktemp -d /tmp/daywell-storage.XXXXXX)/review.sqlite"
node services/daywell/fridge-example.js
node services/daywell/storage-cli.js usage "$DAYWELL_DB"
node services/daywell/storage-cli.js export "$DAYWELL_DB" "${DAYWELL_DB}.json"
node services/daywell/storage-cli.js import "${DAYWELL_DB}.json" "${DAYWELL_DB}.imported"
node services/daywell/storage-cli.js backup "$DAYWELL_DB" "${DAYWELL_DB}.backup"
node services/daywell/storage-cli.js restore "${DAYWELL_DB}.backup" "${DAYWELL_DB}.restored"
PORT=4188 npm start
```

Open `http://127.0.0.1:4188/#home/fixture-fridge`. Inspect original source links, typed uncertainty and History. Stop the server with Ctrl-C. To view the restored copy, run `DAYWELL_DB="${DAYWELL_DB}.restored" PORT=4188 npm start`. The restored copy is independent of the source.

All destination paths must be new and have an existing parent directory. An existing file or symlink is never overwritten, even in a publication race. Outputs are staged beside the destination, fsynced, and published with an atomic no-clobber hard link; directories/files are private (0700/0600). Failures before publication remove the stage and leave the destination absent or its prior contents unchanged. Filesystems must support hard links. A crash may leave `.daywell-stage-*` directories beside the destination; after stopping the operation, inspect/remove those abandoned private stages. A crash or directory-sync error after publication can leave a complete output despite no success response: inspect it and choose a fresh destination on retry.

## Transactions, conflicts and quotas

All mutations serialize across HTTP, MCP and CLI processes with SQLite `BEGIN IMMEDIATE`, WAL, FULL synchronization and a 10-second busy timeout. Reference validation, quota checks, record/entity changes, operation results, audit and generation advancement commit together. Unique original `(entity_id, hash)`, record key and correction-successor indexes prevent duplicates/branches; insert triggers enforce same-entity references. Every exception rolls back. A busy/locked error is recoverable: wait and retry the same input/key. A stale entity revision or already-superseded record requires fresh context and an intentional new correction, never blind rebasing.

Record and identity correction keys compare canonical normalized JSON (object key order does not matter). Identical retries return the stored operation result. `add_entity` keeps session-1 compatibility: an identical creation retry returns the **current identity**, including subsequent corrections. Read context when current state matters. Original deduplication is byte-based, scoped to one entity: repeated identical bytes return the first metadata, even if a subsequent name/source differs. It never merges provenance. Deletion removes the deleted entity's operation keys too; IDs/keys can then be reused. A repeated deletion reports Entity not found; it does not affect another entity.

Quotas are persisted once per database, shared by every process, not per-process environment flags. Defaults: 512 MiB original bytes, 64 MiB metadata bytes, 100,000 rows across entities/documents/records/history/idempotency operations. Metadata includes UTF-8 serialized values and identifiers; originals use decoded bytes. Audit has a separate fixed 1,000-entry cap. This is a logical allocation quota, not a filesystem/WAL/free-space reservation. Imports use destination quotas. Physical backups preserve source quotas; portable imports use fresh defaults. Inspect and deliberately adjust all three limits together:

```sh
node services/daywell/storage-cli.js usage "$DAYWELL_DB"
node services/daywell/storage-cli.js quotas "$DAYWELL_DB" '{"originalBytes":536870912,"metadataBytes":67108864,"rows":100000}'
```

A quota below current usage rejects without changing the previous limits. Retrying a duplicate original or operation consumes no new allocation. Disk-full and commit failures still rely on SQLite rollback/durability; backups require separate available disk space.

## Bounded reads and consistency

This is an intentional API change: `list_entities` / `GET /api/entities` now returns `{entities, nextCursor}` instead of a bare array. `get_context` keeps `entity`, `documents`, `records`, `entityHistory`, `policy`, and adds `nextCursor`. Both accept `limit` (integer 1–100, default 25) and optional `cursor`. HTTP uses query parameters; MCP uses tool arguments. Context limits each collection independently and caps the combined serialized page below 512 KiB. New record inputs are capped at 65,536 UTF-8 bytes; details retain the existing 16,000-character cap. `read_original` remains a separate bounded single-original read (20 MiB decoded maximum).

Ordering is ascending durable SQLite rowid within each collection, not timestamps or names. Cursors are opaque, signed, bound to the store, read scope and committed generation. **Any successful mutation invalidates prior cursors**, including deletion or identity updates elsewhere. A continuation then fails with `STALE_CURSOR`; discard the entire accumulated result and start again without a cursor. No mutation during a successful traversal means a stable complete collection: inserts cannot silently fall behind a keyset boundary. Changes after the final page require an ordinary refresh. This conservative contract favors explicit restart over silently stale current records. Continuous writes may prevent completion; it is not a long-lived MVCC snapshot or cross-entity global snapshot.

Follow `nextCursor` until null before deciding which records are current or which evidence exists. Current records are those whose IDs are not superseded anywhere in the **complete** history. The companion and `read-all.js` adapter implement traversal, discard partial results and retry stale reads at most twice, then show an error. Cross-entity companion refresh is still not a global snapshot; the UI collects all pages before rendering, which can consume substantial browser memory for large stores.

Legacy rows larger than 256 KiB return `{metadataCursor}` placeholders. `read_metadata` / `GET /api/metadata?cursor=…` returns `{text,nextCursor}` with at most 8,192 Unicode characters per fragment. Concatenate fragments then JSON-parse; the same stale/restart rule applies. This preserves access to previously unbounded record facts/history without unbounded responses. Both adapters resolve these fragments automatically. Oversized legacy entity headers also use a metadata placeholder; their default revision/photo fields travel alongside it. Baseline arbitrary JSON identity details remain exportable/importable even when they exceed current new-write limits. Malformed/foreign cursors and invalid limits fail. No pagination path truncates a record or omits evidence without a continuation/error.

## Portable export and import

`export DB NEW_JSON` takes a coherent SQLite read transaction, validates the result, and writes format `daywell`, archive version 1, schema version 1. It includes exact serialized entity/document/record/history/operation values and base64 original bytes. Identity revisions, personal photo selection, representative attribution, uncertainty, typed fridge claims, citations, original IDs/hashes and append-only relationships survive. The JSON has fixed allowlisted tables and columns; it is data, never SQL or an archive of filesystem paths. Names are never used as paths. Unknown archive versions/columns, malformed identifiers, invalid base64/signatures/hashes, dangling references, duplicate keys, branching/cyclic correction chains and inconsistent entity history reject before publication. Validation checks structure/relationships, not documentary truth.

`import JSON NEW_DB` uses a private staging database and a single transaction. Collision policy is **empty destination only**, with no merge, renumbering or overwrite. The internal store API likewise rejects import into a populated database. Portable import is limited to a 1 GiB JSON file and loads it into memory; it is intended for these local quotas, not multi-terabyte transfer. For stores deliberately configured above that size use physical backup/restore. Unsupported/malformed legacy metadata may prevent portable export: retain a stopped-filesystem recovery copy and resolve the validation error without rewriting originals blindly.

## Backup, restore and rollback

`backup DB NEW_SQLITE` and `restore BACKUP NEW_SQLITE` use SQLite's online backup API, so committed WAL pages are included even while the source stays open. An uncheckpointed `.sqlite` file copied by itself is **not** a supported backup. The staged database passes SQLite `integrity_check` and archive relationship/hash validation, is checkpointed into a standalone file, and is closed before publication. Restoring defaults to a new destination only; source/live databases are never replaced by these commands. Export/import is portable logical data; backup/restore also retains quotas, audit and storage state.

For an upgrade rollback: stop **all** HTTP/MCP writers, keep the failed/upgraded database and its WAL/SHM together for diagnosis, restore the **pre-upgrade** backup to a new path, select the old code checkout, and explicitly point DAYWELL_DB at that restored path in every process. There is no down-migration and no automatic overwrite. Never open an upgraded database with older code as a rollback strategy. Test the restored copy before deleting any previous copy.

## Deliberate entity deletion and privacy

Only the local CLI/store API exposes deletion; no permanent UI control or remotely callable deletion tool was added. Exact entity confirmation is required:

```sh
# Deletes only this synthetic entity from the selected DB; inspect/export first.
node services/daywell/storage-cli.js delete "$DAYWELL_DB" fixture-fridge 'DELETE fixture-fridge'
```

One transaction removes that entity, all its originals (including selected/unselected photos), agent records, entity history and entity operation/idempotency results. Evidence cannot cross entities, so unrelated entities/bytes/history remain. Narrower document/photo/record deletion is not supported: it could invalidate retained evidence or correction history. Normal correction remains append-only; this command is the explicit deletion exception.

Audit records only UTC time, monotonic sequence and operation category for the latest 1,000 committed mutations. It stores no actor, entity ID, payload, filename or reason. Caller source labels retained in records/history are **not authenticated identity**. Deletion retains only that non-identifying category/time event; no deleted content enters audit. Failed operations/identical no-op retries do not add audit events. Portable exports exclude audit, quotas and cursor signing state. Export/backup reads do not mutate the source or create an access log; physical backups include the bounded audit. There is no authenticated access audit or tamper-proof ledger.

Deletion is logical, **not forensic secure erasure**. SQLite free pages/WAL, browser memory/downloads, filesystem snapshots and previously retained exports/backups may contain copies. The user manages retention/removal of those independent copies. No encryption or hosted deletion policy is claimed.

## Verification and remaining limits

Verified: `npm test` passes 18 service/integration/browser tests and 7 historical demo tests. A separate temporary-directory CLI smoke run exercised the fixture, usage, export/import, backup/restore and confirmed deletion commands.

`npm test` covers independent synchronized worker processes and real HTTP/two-MCP races, identical/conflicting retries, one-winner corrections, atomically shared quotas, malformed/stale/cross-scope cursors, multi-page traversal, inserted rows between pages, streamed legacy metadata, typed fridge export/import and WAL backup/restore, close/reopen, collisions, malformed archives, injected pre-commit rollback, deletion isolation, schema-zero upgrades and failed migration rollback. Chromium exercises paginated HTTP correction history, source bytes, typed warranty uncertainty, personal photos and existing restart/fresh-browser behavior. No real/default database was touched.

Limits remain: local single-owner OS trust, no authenticated actor or tenant isolation, no encryption/hosted backup scheduler, bounded in-memory import/export, whole-view companion accumulation, first-encounter original metadata, and no real Gmail/reasoning client trial. File-signature and citation validation do not establish truth or fully decode media. Power-loss hardware faults, operating-system crash injection and Safari/Firefox were not tested. This does not establish hosted readiness.
