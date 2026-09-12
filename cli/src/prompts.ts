// Validated prompts on top of node:readline/promises.
//
// SPDX-License-Identifier: Apache-2.0
//
// Two rules hold throughout. First, nothing that fails validation is ever passed
// on: the prompt says what was wrong and asks again, because a typo in a 64-hex
// party key should cost a retry and not an assertion failure three screens
// later. Second, a closed stdin is treated as an instruction to leave, not as an
// empty answer .. otherwise Ctrl-D at a prompt would submit whatever the default
// happened to be.

import type { Interface } from 'node:readline/promises';

import { fromHex, toHex } from '@quietbooks/contract';

import { PromptAborted } from './errors.js';
import { out } from './format.js';

const HEX32_CHARS = 64;

export class Prompter {
  constructor(private readonly rli: Interface) {}

  /** The one place a question is actually asked. Everything else builds on it. */
  private async raw(question: string): Promise<string> {
    // `question` never settles on its own if the interface closes underneath it,
    // so closing is wired to an abort signal. Without this, Ctrl-D would hang
    // the process with a live wallet attached.
    const controller = new AbortController();
    const onClose = (): void => controller.abort();
    this.rli.once('close', onClose);
    try {
      return await this.rli.question(question, { signal: controller.signal });
    } catch (error) {
      throw new PromptAborted(error instanceof Error ? error.message : undefined);
    } finally {
      this.rli.removeListener('close', onClose);
    }
  }

  /** Free text. `fallback` is offered when the operator just presses enter. */
  async line(question: string, options: { fallback?: string; allowEmpty?: boolean } = {}): Promise<string> {
    const suffix = options.fallback === undefined ? '' : ` [${options.fallback}]`;
    for (;;) {
      const answer = (await this.raw(`${question}${suffix}: `)).trim();
      if (answer.length > 0) {
        return answer;
      }
      if (options.fallback !== undefined) {
        return options.fallback;
      }
      if (options.allowEmpty === true) {
        return '';
      }
      out('    (a value is required)');
    }
  }

  /** Free text that is allowed to be empty, such as a memo. */
  optional(question: string): Promise<string> {
    return this.line(question, { allowEmpty: true });
  }

  /**
   * A numbered menu.
   *
   * Separate from `choice` because a menu already lists its options on screen,
   * and repeating them as `(1/2/3/4/5/6/7/8/9/10/11/12/13/0)` after the prompt
   * adds a line of noise to every single turn of the loop.
   */
  async menu(text: string, choices: readonly string[]): Promise<string> {
    for (;;) {
      out(text);
      const answer = (await this.raw('  Choose: ')).trim();
      if (choices.includes(answer)) {
        return answer;
      }
      out(`    (${answer.length === 0 ? 'nothing entered' : `"${answer}" is not on the menu`})`);
    }
  }

  /** One of a fixed set of answers, compared case-insensitively. */
  async choice(question: string, choices: readonly string[]): Promise<string> {
    const lowered = choices.map((choice) => choice.toLowerCase());
    for (;;) {
      const answer = (await this.raw(`${question} (${choices.join('/')}): `)).trim().toLowerCase();
      const index = lowered.indexOf(answer);
      if (index >= 0) {
        return choices[index] as string;
      }
      out(`    (answer one of: ${choices.join(', ')})`);
    }
  }

  async yesNo(question: string, fallback?: boolean): Promise<boolean> {
    const suffix = fallback === undefined ? '(y/n)' : fallback ? '(Y/n)' : '(y/N)';
    for (;;) {
      const answer = (await this.raw(`${question} ${suffix}: `)).trim().toLowerCase();
      if (answer.length === 0 && fallback !== undefined) {
        return fallback;
      }
      if (answer === 'y' || answer === 'yes') return true;
      if (answer === 'n' || answer === 'no') return false;
      out('    (answer y or n)');
    }
  }

  /**
   * An explicit confirmation for an operation that cannot be undone.
   *
   * Deliberately not y/n: the word has to be typed out, so that a stray return
   * key does not fund an escrow or publish a grant.
   */
  async confirmExactly(question: string, word = 'yes'): Promise<boolean> {
    const answer = (await this.raw(`${question} (type "${word}" to continue): `)).trim();
    return answer.toLowerCase() === word.toLowerCase();
  }

  /** A non-negative integer, in the currency's smallest unit or as a count. */
  async bigint(
    question: string,
    options: { min?: bigint; max?: bigint; fallback?: bigint } = {},
  ): Promise<bigint> {
    const min = options.min ?? 0n;
    const suffix = options.fallback === undefined ? '' : ` [${options.fallback.toString()}]`;
    for (;;) {
      const answer = (await this.raw(`${question}${suffix}: `)).trim().replace(/[_,\s]/g, '');
      if (answer.length === 0 && options.fallback !== undefined) {
        return options.fallback;
      }
      if (!/^\d+$/.test(answer)) {
        out('    (whole numbers only .. amounts are in the currency\'s smallest unit)');
        continue;
      }
      const value = BigInt(answer);
      if (value < min) {
        out(`    (must be at least ${min.toString()})`);
        continue;
      }
      if (options.max !== undefined && value > options.max) {
        out(`    (must be at most ${options.max.toString()})`);
        continue;
      }
      return value;
    }
  }

  /** A count of days, used for due dates and expiries. */
  async days(question: string, fallback?: number): Promise<number> {
    const suffix = fallback === undefined ? '' : ` [${fallback}]`;
    for (;;) {
      const answer = (await this.raw(`${question}${suffix}: `)).trim();
      if (answer.length === 0 && fallback !== undefined) {
        return fallback;
      }
      const value = Number(answer);
      if (!Number.isFinite(value) || value <= 0) {
        out('    (enter a positive number of days)');
        continue;
      }
      if (value > 3650) {
        out('    (ten years is the practical limit here)');
        continue;
      }
      return value;
    }
  }

  /** A row number from a numbered list. */
  async index(question: string, count: number): Promise<number> {
    for (;;) {
      const answer = (await this.raw(`${question} (1-${count}): `)).trim();
      const value = Number(answer);
      if (!Number.isInteger(value) || value < 1 || value > count) {
        out(`    (enter a number between 1 and ${count})`);
        continue;
      }
      return value - 1;
    }
  }

  /**
   * Exactly 32 bytes of hex.
   *
   * Length and alphabet are checked here rather than left to `fromHex`, because
   * the failure an operator needs to see is "that is 62 characters, keys are
   * 64", not a decoding error from three layers down.
   */
  async hex32(
    question: string,
    options: { optional?: boolean; allowZero?: boolean } = {},
  ): Promise<Uint8Array | undefined> {
    const suffix = options.optional === true ? ' (blank for none)' : '';
    for (;;) {
      const answer = (await this.raw(`${question}${suffix}: `)).trim().replace(/^0x/i, '');
      if (answer.length === 0) {
        if (options.optional === true) {
          return undefined;
        }
        out('    (a 64-character hex value is required)');
        continue;
      }
      if (!/^[0-9a-fA-F]+$/.test(answer)) {
        out('    (hex only: characters 0-9 and a-f)');
        continue;
      }
      if (answer.length !== HEX32_CHARS) {
        out(`    (that is ${answer.length} characters; a 32-byte value is ${HEX32_CHARS})`);
        continue;
      }
      const bytes = fromHex(answer);
      if (options.allowZero !== true && bytes.every((byte) => byte === 0)) {
        out('    (an all-zero value is not a key .. it is the absence of one)');
        continue;
      }
      return bytes;
    }
  }

  /**
   * A JSON document pasted over several lines.
   *
   * Reading until the text parses is what makes pasting a pretty-printed export
   * work: there is no sentinel to remember and no need to re-flow the JSON onto
   * one line first. An empty first line leaves without importing anything.
   */
  async jsonBlock(intro: string): Promise<string | undefined> {
    out(intro);
    out('  (paste the record; it is read as soon as it parses. Blank line to cancel.)');
    let buffer = '';
    for (;;) {
      const line = await this.raw(buffer.length === 0 ? '  > ' : '  . ');
      if (buffer.length === 0 && line.trim().length === 0) {
        return undefined;
      }
      buffer += `${line}\n`;
      try {
        JSON.parse(buffer);
        return buffer;
      } catch {
        // Not a complete document yet. Keep reading.
      }
      if (buffer.length > 1_000_000) {
        out('    (that is far larger than an invoice record; cancelling)');
        return undefined;
      }
    }
  }
}

/** Hex for display, kept next to the parser so the two stay in step. */
export const hex = (bytes: Uint8Array): string => toHex(bytes);
