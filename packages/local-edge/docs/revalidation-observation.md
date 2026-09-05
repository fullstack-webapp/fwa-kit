# Revalidation observation protocol

Local Edge exposes one kernel state through two asynchronous channels: Service Worker messages provide low-latency progress and terminal signals, while `GET /__fwa/state` remains the authoritative recovery read. These channels do not share browser delivery order. The kernel therefore supplies its own observation identity instead of asking the document runtime to infer order from arrival time or `releaseId`.

## Ordering domain

Revalidation progress is in-memory and intentionally disappears when a Service Worker global restarts. Its ordering domain follows that lifetime:

```text
exact controller generation
→ kernel instance
→ observation revision
→ install attempt
```

- `kernelInstanceId` is generated once when one `ServiceWorkerGlobalScope` evaluates.
- `observationRevision` increases for every externally observable change in that instance: attempt start, every progress count, terminal transition, and mode/release publication.
- An attempt uses the revision allocated at start as its `attemptId`.
- A retry or repair is a new attempt even when `releaseId` is unchanged.
- Worker restart creates a new instance and revision domain. A current-controller snapshot from that instance clears progress from the previous instance.

`releaseId` continues to identify immutable release content. It is never used as install-attempt identity.

## Protocol level and wire identity

A level-2 kernel adds these internal fields to snapshots, messages, and revalidation results:

```ts
interface KernelObservationIdentity {
  kernelInstanceId: string
  observationRevision: number
}

interface KernelProgress extends KernelObservationIdentity {
  attemptId: number
  releaseId: string
  completedAssets: number
  totalAssets: number
}
```

Progress and terminal messages carry the same identity. Successful `installed`, `repaired`, and `updated` responses carry the terminal revision and attempt identity because the kernel settles the attempt before producing the response.

A state snapshot contains its instance and revision plus optional running progress. Absence of progress means that instance is idle at that revision. The public facade continues to expose only `{ releaseId, completedAssets, totalAssets }`; kernel identity remains an internal wire concern.

Protocol level is a capability, not a destructive minimum:

- the worker advertises level 2;
- the loader's minimum accepted level remains 1;
- a level-2 loader under a valid level-1 worker keeps the existing offline release and update behavior but does not project percentage progress or run ordering heuristics;
- a level-1 loader ignores the additive level-2 fields from a newer worker;
- gaining progress capability never unregisters a valid offline controller.

## Kernel publication

### Linearizable snapshots

The worker maintains an internal lifecycle mutation boundary and a lifecycle-only version used to retry durable reads. Progress revisions do not invalidate a snapshot read: durable metadata is unaffected by a count tick, and memory plus identity are cloned together after the durable transaction. The worker does not hold the lifecycle boundary while downloading, verifying, or matching release assets.

A snapshot:

1. waits for any short lifecycle mutation;
2. captures the observation version;
3. reads enabled and release metadata in one readonly IndexedDB transaction;
4. clones the instance identity, revision, and in-memory progress;
5. retries when the lifecycle version changed or another lifecycle mutation began.

Retries are bounded. Exhaustion returns a kernel-identified unavailable response; it never enters destructive compatibility takeover.

Attempt start publishes its in-memory running state in the same lifecycle mutation that establishes candidate ownership. Commit/failure clears running progress and advances the revision in a short mutation. Progress updates advance revision synchronously even when the 250 ms transport throttle suppresses a message, so a later snapshot still describes the newest count.

Equal revision means the same kernel state version, not the same payload shape. A partial terminal event and a full idle snapshot can legitimately share a revision. A compatible snapshot at the current revision may enrich release projection; incompatible running/settled or attempt identity at the same revision is a protocol violation.

### Durable authority fence

Progress ordering is instance-local, but release commitment still crosses durable storage. IndexedDB holds an internal metadata epoch and candidate owner:

```text
metadata epoch + kernel instance + attempt + release
```

- only an authorized activate path may bootstrap an absent metadata epoch;
- every worker pins its epoch before serving control requests;
- a restarted worker may load an existing epoch but may not recreate one that disappeared;
- before each descriptor fetch, IndexedDB allocates a monotonic release-observation sequence under the cache lock; the network request then runs without that lock, and its enable / disable write or candidate claim is accepted only if its sequence is still the latest issued observation in the same transaction;
- client pin mutation/pruning, abandoned/failed candidate cache cleanup, retained/orphan cache pruning, reset, and final reopen-by-name verification run inside one app-scoped Web Lock; descriptor and asset network I/O stay outside the lock;
- descriptor fetches are bounded to 10 seconds and individual asset fetches to 30 seconds, so a half-open request cannot retain progress or `revalidationInFlight` indefinitely;
- client pin writes merge atomically in IndexedDB and request selection re-reads durable pins, so overlapping worker globals cannot drop another client's release binding;
- every durable read/write is checked against the worker's pinned metadata epoch, and commit additionally verifies full candidate ownership plus latest-issued release-observation authority in the same IndexedDB transaction that writes active/retained/enabled metadata;
- a disable observation takes the same lock and supersedes/cleans any candidate owner before returning, so an older download cannot re-enable Local Edge;
- superseded workers cannot commit or clear a newer candidate journal, and the lock prevents an owned failure cleanup from deleting a replacement attempt's cache;
- final verification reopens the candidate cache by name while holding the same lock, so a detached cache object cannot authorize an unreachable release after a concurrent delete;
- a pre-reset worker with an old pinned epoch treats missing or replaced metadata as permanent loss of authority.

Reset preserves the old instance identity in memory for its final network-only responses, aborts owned work, deletes metadata, and unregisters. A later activated replacement bootstraps a new metadata epoch.

## Document provenance

The document runtime maintains an exact controller object and a monotonically increasing local controller generation.

- A state fetch captures both before starting and discards its response if either changed.
- A message is accepted only when `event.source === navigator.serviceWorker.controller`; matching script URLs is insufficient.
- `controllerchange` synchronously clears progress, invalidates old responses, resets accepted instance identity, and pulls the new controller.
- A message cannot switch an established kernel instance. A mismatched message is ignored and coalesces one recovery pull.
- A strict current-controller snapshot may establish a new instance.
- A response cannot switch instances; it triggers a current-controller pull instead.
- Explicit network-open documents never publish kernel progress from either channel.

State-read outcomes are discriminated as snapshot, incompatible controller, temporarily unavailable kernel, or stale-controller response. Invalid level-2 data and transient storage errors do not masquerade as an incompatible worker. Kernel-owned error responses retain kernel identity headers.

## Observation reduction

One pure reducer owns progress ordering for both startup and later snapshots. Release projection remains separate: startup may adopt the active release, while later reads preserve the document's loaded `releaseId` and announce a differing active release.

For one established instance:

- lower revision: discard the entire observation, including release projection;
- higher progress revision: bind the attempt and publish its count;
- higher terminal revision: settle and clear progress;
- higher snapshot revision: publish snapshot progress or clear when idle;
- equal revision:
  - compatible progress is idempotent;
  - terminal followed by a compatible idle snapshot is accepted and the snapshot may enrich release projection;
  - running snapshot followed by matching progress is compatible;
  - a running/settled conflict or changed attempt/release/total is invalid.

One `(kernelInstanceId, attemptId)` permanently binds one `releaseId` and `totalAssets`; counts remain within bounds and never decrease for that attempt. Malformed or conflicting observations do not advance the reducer and trigger one coalesced recovery pull.

A lost terminal event heals on the next successful state read. When scheduled checks are disabled, healing is not time-bounded unless another terminal/response, controller change, explicit revalidation, visibility/online trigger, or consumer action causes a pull; the public UI therefore keeps spinner fallback and never treats percentage as durable truth.

Successful `installed`, `repaired`, and `updated` responses act as terminal observations before their authoritative pull. `updated` resolves only after a compatible snapshot publishes the announcement. Pull failure returns `failed` rather than exposing an applicable update that the document cannot observe.

## Verification invariants

Pure reducer tests cover:

- delayed lower-revision snapshot/event after terminal or retry;
- same-release retry resetting count at a higher revision;
- idle higher revision clearing progress after a missed terminal;
- different-instance messages unable to switch state;
- authoritative snapshot establishing a new instance;
- same-revision terminal plus idle snapshot enrichment;
- same-revision running/settled and immutable identity conflicts;
- stale observations unable to change release projection;
- explicit network mode never publishing progress.

Kernel tests cover:

- revision movement on start, every progress update, terminal, and mode/release transition;
- progress ticks pairing with the final memory/identity clone without retry, plus bounded retry across lifecycle mutations;
- coherent release/progress snapshots;
- response and terminal sharing terminal identity;
- process restart creating a new instance with idle progress;
- candidate commit and cleanup rejecting superseded owners;
- pre-reset instances unable to recreate metadata.

Compatibility and browser tests cover level-1 offline degradation, old-controller response/message rejection, missed-terminal recovery, awaited announcement semantics, and the existing release, pinning, reset, network-open, and update behavior.

The design must be reopened instead of patched if correctness again depends on fetch/message wall-clock timing, inferring attempts from `releaseId`, optional level-2 ordering fields, destructive capability upgrade, or unfenced authority-changing metadata writes.
