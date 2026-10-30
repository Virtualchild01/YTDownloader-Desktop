'use strict';
// Упаковка app.asar в отдельном процессе: @electron/asar держит файловые
// дескрипторы после сборки, и makensis в том же процессе не может открыть архив.
const path = require('node:path');
const VENDOR = path.join(__dirname, '..', 'vendor');
const [source, target] = process.argv.slice(2);
require(path.join(VENDOR, 'asar')).createPackage(source, target)
  .then(() => process.exit(0))
  .catch((e) => { console.error(e.message); process.exit(1); });
