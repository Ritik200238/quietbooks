// The QuietBooks API: deploy, join, and drive a deployment from TypeScript.
//
// SPDX-License-Identifier: Apache-2.0
//
// Everything the interface and the CLI do goes through this module. It owns one
// responsibility the callers must not have to think about: witnesses cannot see
// circuit arguments, so before any call that needs an invoice's openings, the
// relevant record has to be staged into private state and cleared again
// afterwards. `withStaged` below is the only place that happens, and every
// operation that needs it routes through that one function.
//
// The second responsibility is durability of private state. An invoice's
// openings are the only way to ever prove anything about it. They are written to
// the private-state provider BEFORE the issuing transaction is submitted, not
// after: a transaction that lands while the openings were lost in a crash would
// leave an invoice on chain that nobody can open, and there is no recovery from
// that. Writing first means the worst case is a stored record for a transaction
// that never landed, which is harmless and easy to clean up.

import {
  deployContract,
  findDeployedContract,
} from '@midnight-ntwrk/midnight-js-contracts';
import type { ContractAddress } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { combineLatest, from, map, type Observable } from 'rxjs';
import type { Logger } from 'pino';

import {
  CompiledQuietBooksContract,
  ledger,
  pureCircuits,
  emptyPrivateState,
  withInvoice,
  withActive,
  clearActive,
  prepareInvoice,
  storedInvoiceFrom,
  buildTermsFrame,
  deriveInvoiceId,
  payableTotal,
  randomBytes32,
  toHex,
  fromHex,
  nowSeconds,
  ZERO32,
  InvoiceStatus,
  type QuietBooksPrivateState,
  type StoredInvoice,
  type InvoiceDraft,
  type PreparedInvoice,
  type Reliability,
  type ScopeVector,
} from '@quietbooks/contract';

import {
  quietBooksPrivateStateKey,
  type DeployedQuietBooksContract,
  type InvoiceView,
  type QuietBooksDerivedState,
  type QuietBooksProviders,
} from './common-types.js';

export * from './common-types.js';
export * from './store-password.js';

/** Options every write shares. */
export type CallOptions = {
  /** Which PIN identity to act as. Defaults to 1. */
  readonly pin?: bigint;
};

const DEFAULT_PIN = 1n;

/**
 * Anything that can go wrong that the interface should show verbatim.
 *
 * Circuit assertion messages are written for humans .. "caller is not the
 * buyer", not "assert failed at 0x4c" .. so they are surfaced unchanged rather
 * than wrapped in a generic failure. `cause` keeps the original for logs.
 */
export class QuietBooksError extends Error {
  constructor(
    message: string,
    readonly operation: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'QuietBooksError';
  }
}

const failed = (operation: string, error: unknown): never => {
  const message = error instanceof Error ? error.message : String(error);
  // Circuit failures arrive with the assert text already in the message. Strip
  // the contract's own prefix so the interface is not repeating "quietbooks:"
  // in front of a sentence it is already labelling.
  const cleaned = message.replace(/^quietbooks:\s*/i, '').trim();
  throw new QuietBooksError(cleaned.length > 0 ? cleaned : `${operation} failed`, operation, error);
};

export class QuietBooksAPI {
  private constructor(
    public readonly deployedContract: DeployedQuietBooksContract,
    private readonly providers: QuietBooksProviders,
    private readonly logger?: Logger,
  ) {
    this.deployedContractAddress = deployedContract.deployTxData.public.contractAddress;
    providers.privateStateProvider.setContractAddress(this.deployedContractAddress);

    this.state$ = combineLatest(
      [
        providers.publicDataProvider
          .contractStateObservable(this.deployedContractAddress, { type: 'latest' })
          .pipe(map((contractState) => ledger(contractState.data))),
        // Private state is re-read on every ledger tick rather than captured
        // once: invoices are added to it continuously as the wallet issues and
        // imports them, and a stale snapshot would leave freshly issued rows
        // showing as unreadable until a page reload.
        from(this.privateState()),
      ],
      (ledgerState, privateState) =>
        deriveState(ledgerState, privateState, ledgerState.instanceSalt, DEFAULT_PIN),
    );
  }

  readonly deployedContractAddress: ContractAddress;

  /** Ledger and private state, combined into what an interface can render. */
  readonly state$: Observable<QuietBooksDerivedState>;

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  /**
   * Deploy a fresh QuietBooks instance.
   *
   * The deployer becomes the administrator, and `instanceSalt` is generated here
   * rather than taken as a parameter so that no two deployments can accidentally
   * share one. The salt is sealed on chain: a zero or reused value cannot be
   * corrected later.
   */
  static async deploy(
    providers: QuietBooksProviders,
    secret: Uint8Array,
    logger?: Logger,
  ): Promise<QuietBooksAPI> {
    const initialPrivateState = await QuietBooksAPI.loadOrCreate(providers, secret);
    const salt = randomBytes32();

    logger?.info('deploying a new QuietBooks instance');
    const deployed = await deployContract(providers, {
      compiledContract: CompiledQuietBooksContract,
      privateStateId: quietBooksPrivateStateKey,
      initialPrivateState,
      args: [salt],
    });

    logger?.info(
      { contractAddress: deployed.deployTxData.public.contractAddress },
      'deployed',
    );
    return new QuietBooksAPI(deployed, providers, logger);
  }

  /** Join an instance somebody else deployed. */
  static async join(
    providers: QuietBooksProviders,
    contractAddress: ContractAddress,
    secret: Uint8Array,
    logger?: Logger,
  ): Promise<QuietBooksAPI> {
    const initialPrivateState = await QuietBooksAPI.loadOrCreate(providers, secret, contractAddress);
    logger?.info({ contractAddress }, 'joining an existing QuietBooks instance');

    const deployed = await findDeployedContract(providers, {
      compiledContract: CompiledQuietBooksContract,
      contractAddress,
      privateStateId: quietBooksPrivateStateKey,
    });

    return new QuietBooksAPI(deployed, providers, logger);
  }

  /**
   * Load this wallet's private state, creating it on first use.
   *
   * The root secret is supplied by the caller rather than generated here so that
   * a wallet restored on a new machine keeps its identity, and therefore its
   * reliability history and its ability to open invoices it already holds.
   *
   * `knownAddress` is passed for `join`, where the deployment already exists.
   * For `deploy` there is no address yet: the level-backed private state store
   * is keyed by contract address and throws on any read or write before it has
   * one, so the initial state is returned in memory and travels to the chain as
   * `initialPrivateState` on the deploy call instead.
   */
  private static async loadOrCreate(
    providers: QuietBooksProviders,
    secret: Uint8Array,
    knownAddress?: ContractAddress,
  ): Promise<QuietBooksPrivateState> {
    if (knownAddress === undefined) {
      return emptyPrivateState(secret);
    }

    providers.privateStateProvider.setContractAddress(knownAddress);
    const existing = await providers.privateStateProvider.get(quietBooksPrivateStateKey);
    if (existing !== null && existing !== undefined) {
      return clearActive(existing);
    }
    return emptyPrivateState(secret);
  }

  // -------------------------------------------------------------------------
  // Private state
  // -------------------------------------------------------------------------

  async privateState(): Promise<QuietBooksPrivateState> {
    const state = await this.providers.privateStateProvider.get(quietBooksPrivateStateKey);
    if (state === null || state === undefined) {
      throw new QuietBooksError(
        'this wallet has no QuietBooks private state. Deploy or join first.',
        'privateState',
      );
    }
    return state;
  }

  private async savePrivateState(state: QuietBooksPrivateState): Promise<void> {
    await this.providers.privateStateProvider.set(quietBooksPrivateStateKey, state);
  }

  /**
   * Run `body` with `invoice`'s openings staged, and clear them afterwards.
   *
   * The staged state is persisted before the call because the proving flow reads
   * private state back out of the provider, not from memory. The `finally` is
   * not politeness: leaving openings armed would let the next unrelated call
   * silently prove against the wrong invoice.
   */
  private async withStaged<T>(
    invoiceId: string,
    body: () => Promise<T>,
  ): Promise<T> {
    const state = await this.privateState();
    const stored = state.invoices[invoiceId];
    if (stored === undefined) {
      throw new QuietBooksError(
        `this wallet cannot open invoice ${invoiceId}. Ask the counterparty to share its record.`,
        'stage',
      );
    }

    await this.savePrivateState(
      withActive(state, {
        terms: stored.terms,
        termsSalt: stored.termsSalt,
        fieldSalts: stored.fieldSalts,
        nonce: stored.nonce,
        settlementSalt: randomBytes32(),
      }),
    );

    try {
      return await body();
    } finally {
      const after = await this.privateState();
      await this.savePrivateState(clearActive(after));
    }
  }

  /**
   * The deployment's instance salt.
   *
   * Sealed at construction and therefore immutable, so it is fetched once and
   * cached. Every identity derivation needs it, and re-querying the chain for a
   * value that cannot change would put a network round trip in front of
   * rendering an invoice list.
   */
  private cachedSalt: Uint8Array | undefined;

  async instanceSalt(): Promise<Uint8Array> {
    if (this.cachedSalt === undefined) {
      this.cachedSalt = (await this.ledgerState()).instanceSalt;
    }
    return this.cachedSalt;
  }

  /** This wallet's party key at a given PIN. */
  async partyKey(pin: bigint = DEFAULT_PIN): Promise<Uint8Array> {
    const state = await this.privateState();
    return pureCircuits.derivePartyKeyWith(await this.instanceSalt(), state.secret, pin);
  }

  /** This wallet's administrative key, whether or not it holds the role. */
  async adminKey(): Promise<Uint8Array> {
    const state = await this.privateState();
    return pureCircuits.deriveAdminKeyWith(await this.instanceSalt(), state.secret);
  }

  async ledgerState() {
    const contractState = await this.providers.publicDataProvider.queryContractState(
      this.deployedContractAddress,
    );
    if (contractState === null) {
      throw new QuietBooksError('contract state not found on chain', 'ledgerState');
    }
    return ledger(contractState.data);
  }

  /** A snapshot of derived state, for callers that do not want the stream. */
  async snapshot(pin: bigint = DEFAULT_PIN): Promise<QuietBooksDerivedState> {
    const [ledgerState, privateState, salt] = await Promise.all([
      this.ledgerState(),
      this.privateState(),
      this.instanceSalt(),
    ]);
    return deriveState(ledgerState, privateState, salt, pin);
  }

  // -------------------------------------------------------------------------
  // Invoices
  // -------------------------------------------------------------------------

  /**
   * Issue an invoice.
   *
   * Returns the identifier and the stored record. The record is written to
   * private state before the transaction is submitted, for the reason given in
   * the module header.
   */
  async issueInvoice(
    draft: InvoiceDraft,
    buyerKey: Uint8Array,
    options: CallOptions & { arbiterKey?: Uint8Array } = {},
  ): Promise<{ invoiceId: string; stored: StoredInvoice }> {
    const pin = options.pin ?? DEFAULT_PIN;
    const prepared = await prepareInvoice(draft);
    const sellerKey = await this.partyKey(pin);
    const invoiceId = deriveInvoiceId(sellerKey, prepared.nonce);
    const invoiceHex = toHex(invoiceId);
    const issuedAt = nowSeconds();

    const stored = storedInvoiceFrom({
      invoiceId,
      prepared,
      sellerKey,
      buyerKey,
      dueDate: draft.dueDate,
      issuedAt,
      pin,
      role: 'seller',
    });

    const base = await this.privateState();
    await this.savePrivateState(withInvoice(base, stored));

    await this.withStaged(invoiceHex, async () => {
      try {
        await this.deployedContract.callTx.issueInvoice(
          pin,
          buyerKey,
          options.arbiterKey ?? ZERO32,
          draft.dueDate,
          issuedAt,
        );
      } catch (error) {
        failed('issueInvoice', error);
      }
    });

    this.logger?.info({ invoiceId: invoiceHex }, 'issued');
    return { invoiceId: invoiceHex, stored };
  }

  /**
   * Settle by binding a shielded transfer made in the same transaction.
   *
   * `note` is the Zswap note commitment of the output the payer's wallet created
   * for the seller. The contract refuses the call unless that commitment is
   * genuinely present in the containing transaction, which is what makes this a
   * binding settlement rather than an assertion.
   */
  async settleWithNote(
    invoiceId: string,
    note: Uint8Array,
    options: CallOptions = {},
  ): Promise<void> {
    const pin = options.pin ?? DEFAULT_PIN;
    await this.withStaged(invoiceId, async () => {
      try {
        await this.deployedContract.callTx.settleWithNote(
          fromHex(invoiceId),
          pin,
          note,
          nowSeconds(),
        );
      } catch (error) {
        failed('settleWithNote', error);
      }
    });
  }

  /** Settle by seller attestation, for payments made off chain. */
  async settleAttested(
    invoiceId: string,
    receiptDigest: Uint8Array,
    options: CallOptions = {},
  ): Promise<void> {
    const pin = options.pin ?? DEFAULT_PIN;
    await this.withStaged(invoiceId, async () => {
      try {
        await this.deployedContract.callTx.settleAttested(
          fromHex(invoiceId),
          pin,
          receiptDigest,
          nowSeconds(),
        );
      } catch (error) {
        failed('settleAttested', error);
      }
    });
  }

  async cancelInvoice(invoiceId: string, options: CallOptions = {}): Promise<void> {
    const pin = options.pin ?? DEFAULT_PIN;
    try {
      await this.deployedContract.callTx.cancelInvoice(fromHex(invoiceId), pin);
    } catch (error) {
      failed('cancelInvoice', error);
    }
  }

  // -------------------------------------------------------------------------
  // Escrow
  // -------------------------------------------------------------------------

  /**
   * Lock the payment with the contract.
   *
   * Escrow makes the amount public: the coin is disclosed when the contract
   * takes custody, and the vault entry keeps it readable afterwards. Callers are
   * expected to have told the user that before reaching this method.
   */
  async fundEscrow(
    invoiceId: string,
    coin: { nonce: Uint8Array; color: Uint8Array; value: bigint },
    deadline: bigint,
    options: CallOptions = {},
  ): Promise<void> {
    const pin = options.pin ?? DEFAULT_PIN;
    await this.withStaged(invoiceId, async () => {
      try {
        await this.deployedContract.callTx.fundEscrow(
          fromHex(invoiceId),
          pin,
          coin,
          deadline,
          nowSeconds(),
        );
      } catch (error) {
        failed('fundEscrow', error);
      }
    });
  }

  async releaseEscrow(
    invoiceId: string,
    sellerPayout: Uint8Array,
    options: CallOptions = {},
  ): Promise<void> {
    const pin = options.pin ?? DEFAULT_PIN;
    try {
      await this.deployedContract.callTx.releaseEscrow(
        fromHex(invoiceId),
        pin,
        { bytes: sellerPayout },
        nowSeconds(),
      );
    } catch (error) {
      failed('releaseEscrow', error);
    }
  }

  async refundEscrow(
    invoiceId: string,
    buyerPayout: Uint8Array,
    options: CallOptions = {},
  ): Promise<void> {
    const pin = options.pin ?? DEFAULT_PIN;
    try {
      await this.deployedContract.callTx.refundEscrow(fromHex(invoiceId), pin, {
        bytes: buyerPayout,
      });
    } catch (error) {
      failed('refundEscrow', error);
    }
  }

  // -------------------------------------------------------------------------
  // Disputes
  // -------------------------------------------------------------------------

  async openDispute(invoiceId: string, options: CallOptions = {}): Promise<void> {
    const pin = options.pin ?? DEFAULT_PIN;
    try {
      await this.deployedContract.callTx.openDispute(fromHex(invoiceId), pin);
    } catch (error) {
      failed('openDispute', error);
    }
  }

  async resolveDispute(
    invoiceId: string,
    forSeller: boolean,
    payout: Uint8Array,
    options: CallOptions = {},
  ): Promise<void> {
    const pin = options.pin ?? DEFAULT_PIN;
    try {
      await this.deployedContract.callTx.resolveDispute(
        fromHex(invoiceId),
        pin,
        forSeller,
        { bytes: payout },
        nowSeconds(),
      );
    } catch (error) {
      failed('resolveDispute', error);
    }
  }

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  /**
   * Authorise an auditor to see specific fields until a deadline.
   *
   * Only the hash of the audit key goes on chain. The key itself travels to the
   * auditor out of band together with the encrypted envelope, so the ledger
   * records who was authorised and for what, and never what they saw.
   */
  async grantAudit(
    invoiceId: string,
    auditKeyHash: Uint8Array,
    scopes: ScopeVector,
    expiresAt: bigint,
    options: CallOptions = {},
  ): Promise<void> {
    const pin = options.pin ?? DEFAULT_PIN;
    try {
      await this.deployedContract.callTx.grantAudit(
        fromHex(invoiceId),
        pin,
        auditKeyHash,
        scopes,
        expiresAt,
        nowSeconds(),
      );
    } catch (error) {
      failed('grantAudit', error);
    }
  }

  async revokeAudit(invoiceId: string, options: CallOptions = {}): Promise<void> {
    const pin = options.pin ?? DEFAULT_PIN;
    try {
      await this.deployedContract.callTx.revokeAudit(fromHex(invoiceId), pin);
    } catch (error) {
      failed('revokeAudit', error);
    }
  }

  // -------------------------------------------------------------------------
  // Administration
  // -------------------------------------------------------------------------

  async setPaused(value: boolean): Promise<void> {
    try {
      await this.deployedContract.callTx.setPaused(value);
    } catch (error) {
      failed('setPaused', error);
    }
  }

  // -------------------------------------------------------------------------
  // Sharing
  // -------------------------------------------------------------------------

  /**
   * Export an invoice record so the counterparty can open it.
   *
   * This is the out-of-band step the design depends on. The buyer cannot settle,
   * and no auditor can verify anything, without the openings the seller holds.
   * The payload is deliberately plain JSON: it is meant to travel over whatever
   * channel the two parties already trust with their commercial terms.
   */
  async exportInvoice(invoiceId: string): Promise<string> {
    const state = await this.privateState();
    const stored = state.invoices[invoiceId];
    if (stored === undefined) {
      throw new QuietBooksError(`invoice ${invoiceId} is not in this wallet`, 'exportInvoice');
    }
    return JSON.stringify(serialiseStored(stored), null, 2);
  }

  /** Import a record shared by a counterparty, recording our role in it. */
  async importInvoice(payload: string, role: StoredInvoice['role'] = 'buyer'): Promise<StoredInvoice> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch (error) {
      throw new QuietBooksError('shared invoice is not valid JSON', 'importInvoice', error);
    }
    const stored = { ...deserialiseStored(parsed), role };
    const state = await this.privateState();
    await this.savePrivateState(withInvoice(state, stored));
    return stored;
  }
}

// ---------------------------------------------------------------------------
// Derivation helpers
// ---------------------------------------------------------------------------

const NO_RELIABILITY: Reliability = {
  settled: 0n,
  settledOnTime: 0n,
  cancelled: 0n,
  disputesOpened: 0n,
  disputesLost: 0n,
};

/**
 * Fold ledger and private state into what an interface renders.
 *
 * Invoices this wallet cannot open are still included. That is deliberate: an
 * observer seeing rows they cannot read is an honest picture of the ledger, and
 * hiding them would make the interface look like it holds more than the chain
 * actually reveals.
 */
export const deriveState = (
  ledgerState: ReturnType<typeof ledger>,
  privateState: QuietBooksPrivateState,
  instanceSalt: Uint8Array,
  pin: bigint,
): QuietBooksDerivedState => {
  const now = nowSeconds();
  const partyKey = pureCircuits.derivePartyKeyWith(instanceSalt, privateState.secret, pin);
  const adminKey = pureCircuits.deriveAdminKeyWith(instanceSalt, privateState.secret);
  const partyKeyHex = toHex(partyKey);

  const views: InvoiceView[] = [];
  for (const [key, anchor] of ledgerState.invoices) {
    const invoiceId = toHex(key);
    const stored = privateState.invoices[invoiceId];

    // Role is read from the chain where possible and only falls back to the
    // stored record's own claim. A record arrives from a counterparty, so
    // trusting its `role` field over the anchor would let a sender mislabel our
    // position in a deal.
    const role: InvoiceView['role'] =
      toHex(anchor.sellerKey) === partyKeyHex
        ? 'seller'
        : toHex(anchor.buyerKey) === partyKeyHex
          ? 'buyer'
          : toHex(anchor.arbiterKey) === partyKeyHex
            ? 'arbiter'
            : 'observer';

    views.push({
      invoiceId,
      anchor,
      settlement: ledgerState.settlements.member(key)
        ? ledgerState.settlements.lookup(key)
        : undefined,
      auditGrant: ledgerState.auditGrants.member(key)
        ? ledgerState.auditGrants.lookup(key)
        : undefined,
      dispute: ledgerState.disputes.member(key) ? ledgerState.disputes.lookup(key) : undefined,
      stored,
      role,
      payable: stored === undefined ? undefined : payableTotal(stored.terms),
      overdue: anchor.status === InvoiceStatus.issued && anchor.dueDate < now,
    });
  }

  // Newest first. An invoice list is read top-down and the thing just issued is
  // the thing being looked for.
  views.sort((a, b) => Number(b.anchor.issuedAt - a.anchor.issuedAt));

  return {
    invoices: views,
    issuedCount: ledgerState.issuedCount,
    settledCount: ledgerState.settledCount,
    cancelledCount: ledgerState.cancelledCount,
    disputedCount: ledgerState.disputedCount,
    paused: ledgerState.paused,
    partyKey: partyKeyHex,
    isAdmin: toHex(ledgerState.admin) === toHex(adminKey),
    reliability: ledgerState.reliability.member(partyKey)
      ? ledgerState.reliability.lookup(partyKey)
      : NO_RELIABILITY,
  };
};

// ---------------------------------------------------------------------------
// Record serialisation
// ---------------------------------------------------------------------------

type SerialisedInvoice = {
  invoiceId: string;
  terms: {
    amount: string;
    taxAmount: string;
    currency: string;
    orderRef: string;
    itemsHash: string;
    memoHash: string;
  };
  termsSalt: string;
  fieldSalts: string[];
  nonce: string;
  sellerKey: string;
  buyerKey: string;
  dueDate: string;
  issuedAt: string;
  pin: string;
};

const serialiseStored = (stored: StoredInvoice): SerialisedInvoice => ({
  invoiceId: stored.invoiceId,
  terms: {
    amount: stored.terms.amount.toString(),
    taxAmount: stored.terms.taxAmount.toString(),
    currency: toHex(stored.terms.currency),
    orderRef: toHex(stored.terms.orderRef),
    itemsHash: toHex(stored.terms.itemsHash),
    memoHash: toHex(stored.terms.memoHash),
  },
  termsSalt: toHex(stored.termsSalt),
  fieldSalts: stored.fieldSalts.map(toHex),
  nonce: toHex(stored.nonce),
  sellerKey: stored.sellerKey,
  buyerKey: stored.buyerKey,
  dueDate: stored.dueDate.toString(),
  issuedAt: stored.issuedAt.toString(),
  pin: stored.pin.toString(),
});

const deserialiseStored = (value: unknown): StoredInvoice => {
  const raw = value as SerialisedInvoice;
  if (typeof raw?.invoiceId !== 'string' || !Array.isArray(raw?.fieldSalts)) {
    throw new QuietBooksError('shared invoice is missing required fields', 'importInvoice');
  }
  return {
    invoiceId: raw.invoiceId,
    terms: {
      amount: BigInt(raw.terms.amount),
      taxAmount: BigInt(raw.terms.taxAmount),
      currency: fromHex(raw.terms.currency),
      orderRef: fromHex(raw.terms.orderRef),
      itemsHash: fromHex(raw.terms.itemsHash),
      memoHash: fromHex(raw.terms.memoHash),
    },
    termsSalt: fromHex(raw.termsSalt),
    fieldSalts: raw.fieldSalts.map(fromHex),
    nonce: fromHex(raw.nonce),
    sellerKey: raw.sellerKey,
    buyerKey: raw.buyerKey,
    dueDate: BigInt(raw.dueDate),
    issuedAt: BigInt(raw.issuedAt),
    pin: BigInt(raw.pin),
    role: 'buyer',
  };
};

export type { PreparedInvoice, InvoiceDraft, StoredInvoice };
export { buildTermsFrame, prepareInvoice, payableTotal };
