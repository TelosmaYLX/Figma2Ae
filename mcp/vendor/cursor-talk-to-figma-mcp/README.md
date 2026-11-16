# Upstream source

- Project: https://github.com/grab/cursor-talk-to-figma-mcp
- Revision: `ddd90f3a6d454ea0b2fc29f1b084f50fd062b880`
- License: MIT, retained in `LICENSE`.
- `plugin.js`: upstream `src/cursor_mcp_plugin/code.js`, unchanged.
- `server.ts`: upstream `src/talk_to_figma_mcp/server.ts`, unchanged.

`scripts/build-mcp.cjs` retains the upstream tools and Figma command handlers,
replacing the separate plugin window and manual channel transport with F2A's
document discovery and local relay. The embedded plugin excludes the upstream
UI, settings initialization and analytics. Runtime dependencies are pinned in
`mcp/package-lock.json`; bundled dependency notices are in
`mcp/THIRD_PARTY_LICENSES.txt`.
