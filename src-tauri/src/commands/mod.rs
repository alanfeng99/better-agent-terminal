// Tauri-side host command modules.
//
// Each submodule wraps a logical area of the Electron preload surface.
// As we port more areas, add a new module here and a registration line in
// lib.rs. The renderer reaches these through the host-api adapter
// (src/host-api.ts), so renaming or replacing a command is a one-place
// edit at this layer plus the adapter route.

pub mod dialog;
pub mod fs;
pub mod settings;
pub mod shell;
