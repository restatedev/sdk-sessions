//! The Node.js addon of @restatedev/sessions: an object's SQLite-compatible
//! database, kept in its Restate state, over a key/value store the host
//! implements in JavaScript or over the attempt's VM, and that VM: the
//! explicit recovery protocol's (`vm`).
//!
//! The storage and the SQL on it live in `restate_sdk_shared_core` (its
//! modules `state` and `sql`, both with its feature `sql`), and so does the
//! VM (`explicit_recovery`); this crate is the napi bindings around them.
// `node` and `vm` call Node-API, which a test binary has nothing to link to:
// they are not built for the tests, and what they decide is in modules that are.
mod call;
// The core's fake runtime, for this package's tests (feature `fake_runtime`).
#[cfg(all(not(test), feature = "fake_runtime"))]
mod fake_runtime;
#[cfg(not(test))]
mod node;
#[cfg(not(test))]
mod vm;
