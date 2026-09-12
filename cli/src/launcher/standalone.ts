// Launcher: a local network in Docker containers, started by the testkit.
//
// SPDX-License-Identifier: Apache-2.0
//
// Adapted from `bboard-cli/src/launcher/standalone.ts` in
// midnightntwrk/example-bboard (Copyright (C) Midnight Foundation, Apache-2.0).

import { StandaloneConfig } from '../config.js';
import { createLogger } from '../logger-utils.js';
import { run } from '../index.js';

const config = new StandaloneConfig();
const logger = await createLogger(config.logDir);
await run(config, config.getEnvironment(logger), logger);
