# Security Policy

## Supported Versions

Security fixes are handled on the current `main` branch until the first public
release process defines versioned support windows. Treat unpublished snapshots
and local plugin checkouts as unsupported outside their owning checkout.

## Reporting A Vulnerability

Report suspected sandbox escapes, authority bypasses, unsafe primary-tree writes,
secret disclosure, or child-process abuse privately through the
[GitHub Security Advisory flow](https://github.com/mcrescenzo/opencode-workflows/security/advisories/new)
for this repository. Include a minimal reproduction, affected commit or version,
and whether the issue needs a configured extension, a project workflow, or only
core plugin tools.

Please do not publish exploit details before there is a coordinated fix or a
mutual disclosure date. Do not open a public GitHub issue for an unpatched
vulnerability.

## Trust Boundary

Workflow scripts are guest code and run inside the QuickJS sandbox with injected
workflow globals only. They do not receive Node `fs`, `child_process`, `require`,
or direct domain-store access.

Configured workflow extensions are different: they are trusted host modules.
Adding an extension path to opencode config imports and runs that module in the
plugin's Node process with normal local privileges before exported capabilities
are structurally validated. The core plugin does not currently enforce extension
signatures, hash pins, or a module allowlist.

The kernel's authority, path, approval, and deterministic launch-time checks
(server-fingerprint version floor, lane rooting/permission-echo assertions)
protect core guest and tool flows. They do not automatically sandbox extension-contributed tools,
drain adapters, or mutation finalizers. Extension code can call provided guard
helpers, but that is part of the extension's trusted implementation. Only load
extensions you trust as local code.
