# Proposal: attenuate plugin-service Cron authority to one job

Status: design for SDK and security owner review. OpenClaw already supplies restart-safe Cron access to a long-lived plugin service; this proposal does not request another background scheduler or Gateway RPC path.

## Existing service authority

A plugin registered with `api.registerService(...)` can acquire the Gateway scheduler through its service context's `getCron?.()`. The facade offers `list`, `add`, `update`, `remove`, `removeStaleJobFamily`, and `isEnabled`. `src/plugins/service-cron.ts` binds a returned handle to `PluginRuntimeCapabilityLease`, the active service lifetime, and one scheduler instance. Its `commitGuard()` rechecks those facts at the mutation commit boundary. A replacement service obtains its own current handle; retaining an old handle does not preserve authority. A non-Gateway host may provide no Cron facade.

The correct repair for a plugin worker that continues after a caller closes is to move the operation into the registered service and use this facade. The plugin must keep its own durable target identity, intent, and recovery journal. It must not retain `api.runtime.gateway.request` or `dispatchGatewayMethod` from an authenticated request, mark itself trusted official, write Cron storage, or create a second scheduler.

## Remaining authority gap

The service facade grants access to the scheduler, not to one user-approved job. A plugin can pass a different job ID to `update` or `remove`, and `list` can reveal other jobs. Plugin metadata such as a Source Reference, job name, description, `declarationKey`, or plugin-supplied ID helps detect mistakes but is not host-owned authorization proof.

The public service facade also lacks a revision-bearing conditional update. A read followed by `update(id, patch)` can race another writer. An already-disabled job after a crash is not, by itself, proof that this plugin's operation disabled it. Plugins must fail closed when the target or metadata conflicts or the outcome cannot be attributed; they must report this limitation rather than infer success from final shape.

## Possible attenuation

Consider deriving an exact-job handle from the existing service Cron authority, backed by a host-owned binding established at an authenticated admission point. The API shape is intentionally open for review; conceptually it would permit reading only the bound job and disabling it against the revision accepted by the user. It should reuse `PluginRuntimeCapabilityLease`, scheduler-instance fencing, `commitGuard()`, and the current Cron persistence owner. It must not create a parallel lifecycle or independent authorization store when a suitable host-owned binding already exists.

The binding needs authoritative provenance. A plugin-supplied job ID, `declarationKey`, Source Reference, job name, prefix, or local metadata alone cannot grant it. SDK and security owners should decide the smallest host-owned grant, how the authenticated user action admits it, whether it survives process restart, and how disable, uninstall, job removal, or user withdrawal revoke it. Revision/CAS semantics should prevent a recovered operation from disabling a changed or repurposed job.

## Acceptance proof for a future host change

- The exact admitted job can be read and conditionally disabled after process restart through the current plugin service.
- Unrelated jobs, a different plugin, revoked grants, stale service generations, retained handles, replaced schedulers, and stale revisions are rejected at the effect boundary.
- A lost response is reconciled against the exact job and causal operation witness; matching final shape alone cannot certify success.
- Existing service Cron and authenticated Gateway request behavior stay intact; no live user data is required for tests.

This proposal concerns authority attenuation only. The existing service Cron facade is sufficient to remove a plugin worker's misuse of expired request authority, subject to its broader scope and missing public CAS. The plugin repair should proceed independently and report those limits precisely.
