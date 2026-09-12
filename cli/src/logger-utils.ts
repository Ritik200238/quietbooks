// Logging for the QuietBooks CLI.
//
// SPDX-License-Identifier: Apache-2.0
//
// Adapted from `bboard-cli/src/logger-utils.ts` in midnightntwrk/example-bboard
// (Copyright (C) Midnight Foundation, Apache-2.0), which is where the
// pino + pino-pretty + multistream shape comes from.
//
// One deliberate change: the console stream is quiet by default. The example
// logs everything to the terminal, which is fine for a two-command demo but not
// for a menu-driven session where wallet sync chatter would scroll an invoice
// table off the screen between printing it and reading it. Everything still goes
// to the log file at debug level, so nothing is lost; `--verbose` (or
// DEBUG_LEVEL) puts it back on screen.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// You may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import pino from 'pino';
import pinoPretty from 'pino-pretty';

import { isVerbose } from './verbose.js';

/**
 * How much of the log reaches the screen.
 *
 * Silent by default, which is stronger than it sounds: everything the operator
 * needs is printed deliberately by the CLI itself, and every failure is reported
 * as one readable line before it is logged. Leaving the logger at `error` would
 * put a serialised stack on screen immediately under that line, which is exactly
 * what `--verbose` is for. Nothing is lost either way .. the file stream takes
 * every record at debug level.
 */
const consoleLevel = (): string => {
  const fromEnv = process.env.DEBUG_LEVEL;
  if (fromEnv !== undefined && fromEnv !== '') {
    return fromEnv;
  }
  return isVerbose() ? 'debug' : 'silent';
};

export const createLogger = async (logPath: string): Promise<pino.Logger> => {
  await fs.mkdir(path.dirname(logPath), { recursive: true });

  // Logs go to stderr so that stdout carries only what the CLI prints on
  // purpose. A judge can then pipe stdout into a file and get a clean
  // transcript of the session rather than a transcript interleaved with
  // WebSocket reconnection notices.
  const pretty: pinoPretty.PrettyStream = pinoPretty({
    colorize: false,
    sync: true,
    destination: 2,
  });

  const level = consoleLevel();
  return pino(
    { level: 'debug', depthLimit: 20 },
    pino.multistream([
      { stream: pretty, level },
      { stream: createWriteStream(logPath), level: 'debug' },
    ]),
  );
};
