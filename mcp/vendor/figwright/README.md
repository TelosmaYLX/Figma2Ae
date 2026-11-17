# Figwright source in F2A

Source: [awdr74100/figwright](https://github.com/awdr74100/figwright), version 0.7.0,
commit [`031df6a01e103c7adcc01e63d6d8aab0990001e8`](https://github.com/awdr74100/figwright/commit/031df6a01e103c7adcc01e63d6d8aab0990001e8).

This directory contains the 273 upstream TypeScript files needed by F2A's imported tool schemas,
Figma handlers and filesystem export helpers, including their type dependencies. The source is
unchanged, with LF line endings. `UPSTREAM.json` records the source paths and SHA-256 hashes.
The original MIT notice is in `LICENSE` and is included in both shipped bundles/notices.

F2A-specific integration lives in `mcp/src/figwright-*.ts` and `scripts/build-mcp.cjs`.
`figwright-catalog.ts` selects 109 tools; `figwright-commands.ts` wires their plugin handlers.
The six aliases in `mcp/README.md` preserve existing F2A tool contracts.

The separate Figwright UI, relay, leader election, msgpack transport, website-code scanners,
codebase maps and design-diff storage are not part of this integration. F2A keeps its own document
routing and sequential batch behavior. Motion is Figma-side authoring only; this port does not
add Motion-to-AE conversion.
