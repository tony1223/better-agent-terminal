#!/usr/bin/env node

// Headless RemoteServer entry. Delegate to the Rust server binary launcher.
require('./server-cli.js').runServerCli()
