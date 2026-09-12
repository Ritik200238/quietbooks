// Launcher: the public preprod network, with a local proof server.
//
// SPDX-License-Identifier: Apache-2.0
//
// Adapted from `bboard-cli/src/launcher/preprod.ts` in
// midnightntwrk/example-bboard (Copyright (C) Midnight Foundation, Apache-2.0).

import { PreprodRemoteConfig } from '../config.js';
import { createLogger } from '../logger-utils.js';
import { run } from '../index.js';

const config = new PreprodRemoteConfig();
const logger = await createLogger(config.logDir);
await run(config, config.getEnvironment(logger), logger);
