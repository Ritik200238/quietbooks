// Silence a dependency warning that is about npm's layout, not about us.
//
// SPDX-License-Identifier: Apache-2.0
//
// Starting the CLI printed about thirty lines of this before the banner:
//
//   @polkadot/wasm-util has multiple versions, ensure that there is only one
//   installed. Either remove and explicitly install matching versions or dedupe
//   using your package manager. The following conflicting packages were found:
//       esm 7.5.4  node_modules/@polkadot/keyring/node_modules/@polkadot/wasm-util/
//       esm 7.5.4  node_modules/@polkadot/rpc-core/node_modules/@polkadot/wasm-util/
//       ...
//
// Read the versions: they are identical. What `detectPackage` found is one
// version of one package reached through four paths, which is what npm
// workspaces do when several dependencies pin the same library and hoisting
// leaves some copies nested. There is no conflict to resolve.
//
// This is the flag `@polkadot/util` provides for it, and it is deliberately
// narrow: `detectPackage` only honours it when every entry carries the same
// version (`entriesSameVersion && esmCjsWarningDisabled`). A genuine version
// mismatch still warns, which is the property that makes silencing this one
// safe rather than a blindfold.
//
// Not fixed by deduping, because the versions of `@polkadot/*` reached here come
// from the pinned Midnight stack, and forcing them together with an npm override
// would be drifting that stack to tidy a message.
//
// Imported for its side effect, and imported FIRST, because it has to run before
// anything pulls in `@polkadot/util`. ES module bodies execute in import order,
// so the position of the import in the entry module is the whole mechanism --
// move it down and the warning comes back.

process.env.POLKADOTJS_DISABLE_ESM_CJS_WARNING = '1';
