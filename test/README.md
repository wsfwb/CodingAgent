# Test Workspace

This directory is the shared test workspace for repository-level verification.

## Test placement

- Package unit and component tests stay next to their package under `packages/<name>/test/` so the existing test runners discover them.
- Cross-package integration and end-to-end tests belong under `test/integration/`.
- Reusable repository-level test scripts belong under `test/scripts/`.

## Temporary data

Use the following ignored directories for generated test data:

- `test/.tmp/` for temporary workspaces and files.
- `test/.pi-config/` for isolated Pi configuration and credentials-free sessions.
- `test/artifacts/` for screenshots or other generated artifacts.
- `test/reports/` and `test/coverage/` for test reports and coverage output.

Never store real API keys, OAuth credentials, or user session data in this directory.
