# Third-party notices

Sidecr itself is released under the [MIT licence](LICENSE). This file lists the third-party material in the repository and in what the build steps produce.

## In the repository and in `dist/`

### Phosphor Icons

The window's icons (`ui/icons.ts`, bundled into `dist/app.js` by `bun run build:ui`) are SVG path data from [Phosphor Icons](https://phosphoricons.com), weight "regular", taken from [phosphor-icons/core](https://github.com/phosphor-icons/core/tree/main/assets/regular).

```
MIT License

Copyright (c) 2023 Phosphor Icons

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Nothing else third-party is bundled: Sidecr has no runtime dependencies, the window uses the system's own fonts (`ui-monospace`, Cascadia Mono, Consolas), and the Sidecr icon and its derived app icons in `shell/src-tauri/icons/` are Sidecr's own.

## Development dependencies

`bun install` fetches TypeScript (Apache-2.0) and Bun's type definitions (`@types/bun`, MIT) for the typecheck. They are not part of `dist/`.

## The optional native shell

`bun run build:shell` compiles `sidecr-shell` on your machine from crates.io dependencies listed in `shell/src-tauri/Cargo.lock`, chiefly [Tauri](https://tauri.app) and its plugins, which are dual-licensed under MIT or Apache-2.0, plus their own dependencies under their own licences. No binary is shipped in this repository. If you distribute a binary you built, include the notices of those crates (for example with `cargo about` or `cargo license`).
