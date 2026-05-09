// Tauri-side host command modules.
//
// Each submodule wraps a logical area of the Electron preload surface.
// As we port more areas, add a new module here and a registration line in
// lib.rs. The renderer reaches these through the host-api adapter
// (src/host-api.ts), so renaming or replacing a command is a one-place
// edit at this layer plus the adapter route.

pub mod app;
pub mod clipboard;
pub mod debug;
pub mod dialog;
pub mod fs;
pub mod git;
pub mod github;
pub mod image;
pub mod notification;
pub mod profile;
pub mod pty;
pub mod settings;
pub mod shell;
pub mod snippet;
pub mod update;
pub mod workspace;
