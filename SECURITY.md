# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities through GitHub private vulnerability reporting for this repository. Do not open a public issue for an unpatched vulnerability.

Include the affected revision or package version, reproduction conditions, expected impact, and whether the report involves request ownership, cache integrity, release verification, recovery, or origin boundaries.

## Supported versions

FWA Kit is currently pre-release. Security fixes target the latest published beta once publishing begins; older beta builds are not maintained as separate support lines.

## Security boundary

FWA Local Edge owns code-release verification, package-owned browser storage, explicit request interception, and fail-open recovery to the normal web entry. It does not own application authentication, authorization, business data, cookies, account recovery, backend secrets, or server-side integrity.

The runtime must not intercept undeclared application or third-party requests. A failed candidate release must not replace the active release. Reset and recovery operations must remain scoped to Local Edge registrations, metadata, and caches.
