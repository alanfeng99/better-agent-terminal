# node-sidecar/runtime

Per-platform Node binaries for the Tauri sidecar. Contents are git-ignored
(except this README and `.gitkeep`); run `pnpm run fetch:node-runtime` to
populate before `pnpm run tauri:build` if you want the release bundle to
ship a self-contained Node.

Layout (matches Node.org portable archive):

    node-sidecar/runtime/
      windows-x86_64/node.exe
      darwin-aarch64/bin/node
      darwin-x86_64/bin/node
      linux-x86_64/bin/node

The Rust resolver in `src-tauri/src/sidecar.rs::find_bundled_node` probes
`<resource_dir>/node-runtime/<platform>-<arch>/[bin/]node[.exe]` first,
then a flat fallback at `<resource_dir>/node-runtime/node[.exe]`,
falling back to PATH lookup if neither is present (so `tauri dev` works
without the bundled runtime).
