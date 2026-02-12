#!/usr/bin/env node
// This is a shim that loads the compiled TypeScript CLI
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load the compiled CLI
const cliPath = join(__dirname, '../dist/cli/init.js');
await import(cliPath);