#!/usr/bin/env node

// Headless RemoteServer entry. The historical Electron package loaded
// dist-electron/server-cli.js here; the Tauri package keeps the same loader
// shape and delegates to the compatibility server-cli shim.
require('./server-cli.js').runServerCli()
