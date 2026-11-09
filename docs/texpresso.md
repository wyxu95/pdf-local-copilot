# TeXpresso source integration

The extension uses a pinned source checkout and two small patches, managed by
[`scripts/build-native.mjs`](../scripts/build-native.mjs).

## Source identity

- Original project: <https://github.com/let-def/texpresso>
- Headless/VS Code base: <https://github.com/DominikPeters/texpresso/tree/vscode>
- Pinned revision: `df8b0941ef19b36377014d18a9a264f3591280b1`
- Local source directory: `vendor/texpresso/`
- Local changes: [`scripts/texpresso-text-layer.patch`](../scripts/texpresso-text-layer.patch) and [`scripts/texpresso-pdf-links.patch`](../scripts/texpresso-pdf-links.patch)

The text-layer patch adds 39 lines in three files. The PDF-links patch extends the PDF backend:

| Upstream file | Addition |
| --- | --- |
| `src/frontend/renderer.h` | Declares `txp_renderer_characters` |
| `src/frontend/renderer.c` | Exports character code points and page-space rectangles, bounded to 12,000 entries per page |
| `src/frontend/preview.c` | Adds the character array to full-page preview responses |
| `src/frontend/engine_pdf.c` | Exports bounded link rectangles, resolved internal targets, and named destination coordinates through MuPDF |

The driver, headless protocol, incremental engine, and XeTeX modifications come
from the pinned upstream source. This extension adds selection geometry and the
VS Code integration. The XeTeX engine source itself is unchanged by our patches.

The DVI backend already provides internal links and named destinations at this
pinned revision. The PDF-links patch supplies equivalent metadata for the PDF
backend used with pdfLaTeX or LuaLaTeX builds. The viewer resolves citation and
float targets locally and crops their rendered pages for hover previews.

## Build and verify

```sh
npm run native:build
git -C vendor/texpresso rev-parse HEAD
git -C vendor/texpresso diff --stat
git -C vendor/texpresso apply --reverse --check ../../scripts/texpresso-text-layer.patch
git -C vendor/texpresso apply --reverse --check ../../scripts/texpresso-pdf-links.patch
native/texpresso -capabilities
```

The build script clones the fork when needed, checks out the pinned revision,
applies each patch or verifies that it is already applied, and invokes `make all`.
It preserves a dirty checkout at a different revision by stopping before a
checkout. A partial or incompatible patch also stops the build.

Outputs are `native/texpresso`, `native/texpresso-xetex`,
`native/TEXPRESSO-LICENSE`, and `native/build.json`. Both executables must stay in
the same directory. The build manifest records the source revision, platform,
architecture, patch status, and reported capabilities.

`vendor/` and `native/` are ignored local build directories. This keeps the Git
repository focused on the extension source, the exact upstream identity, and
the complete patches. Rebuilding reproduces the source modifications. Output binaries reflect the
target host's installed libraries and toolchain.

## Updating the engine

For an engine update, review the new upstream revision, update the pinned SHA in
`scripts/build-native.mjs`, rebase the patches, and rebuild. Run `npm test` and the
isolated VS Code UI tests before installing the new VSIX. Update this document,
the README, and the third-party notice with the revision being distributed.

Native binaries link against system-installed libraries. Dependency and license
information is in the pinned upstream [INSTALL.md](https://github.com/DominikPeters/texpresso/blob/df8b0941ef19b36377014d18a9a264f3591280b1/INSTALL.md)
and [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
