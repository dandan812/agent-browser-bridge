# Third-party provenance

This project is a local adaptation of Microsoft Playwright / Playwright MCP, not an official Microsoft product.

- Playwright MCP: https://github.com/microsoft/playwright-mcp, version 0.0.85, inspected HEAD `3afdae855f62998c87644144d4f7dc705ac24dcf`.
- Playwright: https://github.com/microsoft/playwright, source commit `452a71b174f4f52fd3ba4c99b6eb6ee52d488c61`.
- Vendored Microsoft sources: `vendor/playwright/browserModel.ts`, `extension/upstream/relayConnection.ts`, `extension/upstream/connectedTabGroup.ts`. Original copyright notices retained. Apache License 2.0 included in LICENSE.
- `browserModel.ts` adds only a `readPage` method to forward allow-listed diagnostics through an already attached tab, resolved using a temporary random page identity marker rather than independent tab-list ordering. Debugger source inspection skips pauses. Other protocol logic is unchanged. Build-time adapters replace monorepo error/log helpers.
- Extension adaptation disables verbose protocol logging and replaces the connection-page bootstrap with an authenticated, loopback-only persistent control connection. Existing RelayConnection and ConnectedTabGroup implement the upstream CDP relay and per-client tab groups.
- Playwright MCP, Playwright and their dependencies remain installed as pinned npm dependencies, with their own license notices in node_modules.
- Alternatives inspected: https://github.com/ChromeDevTools/chrome-devtools-mcp at `6b056c848a981c5ecb493f6e22edd6701964a06d`. Not vendored. Playwright was selected for its existing Chrome/Edge extension, per-client tab ownership and background CDP support, not on a claim of universal superiority.
