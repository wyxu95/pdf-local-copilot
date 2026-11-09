# Third-party software

The native engine is built from [TeXpresso](https://github.com/let-def/texpresso)
and the [VS Code headless fork](https://github.com/DominikPeters/texpresso/tree/vscode),
revision `df8b0941ef19b36377014d18a9a264f3591280b1`.
TeXpresso's MIT license is copied to `native/TEXPRESSO-LICENSE` when built.
Its XeTeX engine includes the upstream notices in the source checkout.
The small patch in `scripts/texpresso-text-layer.patch` adds bounded character
geometry for text selection in this extension and is available under MIT.

Native builds link against libraries installed on the build host, including
MuPDF (AGPL-3.0-or-later or a commercial license), SDL2 (zlib), HarfBuzz (MIT),
FreeType (FTL/GPL), and ICU (Unicode license). Their licenses and sources are
available from their respective upstream projects and the host's package manager.
The development VSIX is built for local use with those host libraries.

The interaction design is inspired by [Papilot](https://github.com/PapilotAI/papilot).
This extension's TypeScript and webview are independently implemented.

Source diff and patch operations use [jsdiff](https://github.com/kpdecker/jsdiff)
under its BSD-3-Clause license. Its license is copied to `dist/JSdiff-LICENSE`
when the extension is built.

Screenshots in `docs/images/` use this repository's demo document and an isolated
VS Code test profile. Agent messages in those screenshots come from the
deterministic test CLI in `test/fake-codex.cjs`.
