// Launcher: the public preview network, with a local proof server.
//
// SPDX-License-Identifier: Apache-2.0
//
// Adapted from `bboard-cli/src/launcher/preview.ts` in
// midnightntwrk/example-bboard (Copyright (C) Midnight Foundation, Apache-2.0).

// Must stay the first import: it sets an environment variable that
// `@polkadot/util` reads when it loads, and ES module bodies run in import
// order.
import '../quiet-deps.js';

import { PreviewRemoteConfig } from '../config.js';
import { createLogger } from '../logger-utils.js';
import { run } from '../index.js';

const config = new PreviewRemoteConfig();
const logger = await createLogger(config.logDir);
await run(config, config.getEnvironment(logger), logger);
