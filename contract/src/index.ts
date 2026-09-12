// QuietBooks contract package .. public surface.
//
// SPDX-License-Identifier: Apache-2.0
//
// Re-exports the compiled contract alongside the private-state model, the
// witness implementations and the shared encodings. Consumers should import
// from here rather than reaching into `build/`, so that a recompile cannot
// silently change anyone's import paths.

import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';

import * as Compiled from '../build/contract/index.js';
import * as Wit from './witnesses.js';

export * from './witnesses.js';
export * from './util.js';
export * from './invoice.js';
export * from './audit.js';

/**
 * The contract as midnight-js wants it.
 *
 * `deployContract` and `findDeployedContract` take a `compiledContract`, not a
 * bare `Contract` instance: the wrapper carries the witness implementations and
 * the location of the proving and verifying keys alongside the circuits, so a
 * caller cannot deploy with one set of witnesses and prove with another.
 *
 * The asset path is relative to this module. Callers that place the compiled
 * artifacts elsewhere .. a bundled interface, a CLI shipping its own copy ..
 * should pass an explicit path to their ZK config provider instead of relying
 * on this default.
 */
export const CompiledQuietBooksContract = CompiledContract.make<
  Compiled.Contract<Wit.QuietBooksPrivateState>
>('QuietBooks', Compiled.Contract<Wit.QuietBooksPrivateState>).pipe(
  CompiledContract.withWitnesses(Wit.witnesses),
  CompiledContract.withCompiledFileAssets('../build'),
);

export {
  Contract,
  ledger,
  pureCircuits,
  contractReferenceLocations,
  InvoiceStatus,
  SettlementMode,
  DisputeOutcome,
} from '../build/contract/index.js';

export type {
  Ledger,
  Witnesses,
  ImpureCircuits,
  PureCircuits,
  InvoiceAnchor,
  Settlement,
  AuditGrant,
  Reliability,
  InvoiceTerms,
  TermsFrame,
} from '../build/contract/index.js';
