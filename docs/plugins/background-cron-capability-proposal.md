# Proposal: bounded background Cron capability for external plugins

Status: design for SDK and security owner review. This page does not grant a capability or change runtime behavior.

## Problem

An external plugin can update a Cron job during an authenticated Gateway request, but a durable background worker cannot resume the same operation after process restart. `api.runtime.gateway.request` admits only bundled or trusted official plugins. `dispatchGatewayMethod` retains the authority of a current authenticated plugin request and cannot be borrowed by a later timer. Treating an external plugin as trusted official, retaining the request context, or writing Cron storage directly would bypass those boundaries.

The desired flow is narrower than arbitrary Gateway access: after a user has accepted a plugin-owned Reminder decision, the plugin must read the exact bound Cron job and conditionally disable it, then finish its own dependent work. The plugin records a durable logical operation before the effect and reconciles an uncertain outcome after restart. Cron remains authoritative for job state and configuration revision.

## Proposed authority

The host should provide a separate closure-bound Scheduler capability, rather than relaxing either existing Gateway API. An activated external plugin may use it only if a host-side admission policy explicitly grants that plugin background Cron authority. The capability is bound to the current plugin instance/generation and aborts or fails when that generation stops, reloads, or loses the grant. It exposes only exact-job `get` and conditional `update`; it cannot select operator scopes or dispatch other Gateway methods. `update` must require the expected configuration revision and a patch limited to disabling the bound Reminder. The host rechecks grant and generation immediately before the native effect, including after any await.

The job binding needs a host-verifiable origin. A plugin-supplied job ID, declaration key, Source Reference, or name prefix alone is not proof of ownership: another plugin could claim it. The preferred design is an authenticated admission step that records the plugin and exact Cron job identity in a host-owned grant when the user accepts the Reminder operation. Recovery must revalidate that binding from host-owned state; the plugin's metadata is a lookup hint, not authorization. The grant's persistence, retention, and revocation semantics require owner review before implementation. If a suitable existing host-owned binding exists, reuse it instead of adding another store.

## Required review decisions

1. Identify the existing owner, if any, for a durable plugin-to-Cron-job binding; otherwise approve the smallest host-owned grant record and its lifecycle.
2. Decide how the authenticated user action admits the exact job and how an external plugin requests that grant without inheriting broad operator authority.
3. Define revocation on plugin disable, uninstall, reload, job deletion, and user withdrawal; a retained capability must fail after revocation.
4. Confirm the public SDK surface and manifest/config declaration. No plugin-controlled manifest field alone may authorize itself.

## Acceptance proof

- An external plugin with an admitted exact job can read it and conditionally disable it after a real host process termination and restart. Its dependent action runs only after the Cron outcome is witnessed.
- A different external plugin, a detached callback, a stale plugin generation, an unrelated job ID, a changed configuration revision, a revoked grant, and an unlisted Gateway method are denied without a native mutation.
- Timeout after a Cron write reconciles against the same job and operation identity; it cannot redirect to another job or report success from a matching final shape alone.
- Existing authenticated plugin requests and bundled/trusted-official Gateway requests keep their current behavior. No live job or personal data is needed for qualification.

This proposal is separate from conditional `cron.add` ID validation. SDK and security owner acceptance is required before implementation because it widens the host's plugin authority boundary.
