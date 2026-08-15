# Issue #63 operator console

The `Lanes` `navPanel` is the universal approval surface, including connected
phone web clients. Its `Awaiting operator` section reads only live BB plugin
interactions whose renderer is `operator-receipt` and whose payload is the
canonical exact receipt binding.

Approval re-fetches that host interaction, rejects binding drift, resolved or
foreign interactions, missing or incorrect `operatorPassphrase`, and worker
self-approval, then uses the existing receipt persistence seam before resolving
the same worker interaction. The passphrase is a `secret: true` setting and is
never returned to the app or stored in plugin SQLite. The receipt's existing
caller-thread provenance plus the exact host interaction id in the approval
evidence identify the connected session; no second authority store is added.

Desktop `requestInput` remains registered as the crown-jewel fallback path.
This issue does not install or reload the live plugin, add director attestation,
provisioning, or GitHub/PR operations.
