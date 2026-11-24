//! The VM of a session object's attempt, on the explicit recovery protocol
//! (version 1): shared-core's [`CoreExplicitRecoveryVM`], which has no journal.
//!
//! Every attempt runs the handler from the start, and recovers from the state
//! the earlier attempts stored. An action returns a handle, and its result
//! comes back as a notification of that handle ([`Vm::take_notification`]):
//! `src/driver.ts` settles its promises with them, in its tick, which is the
//! only place notifications are taken. Taking one is processing it: it counts
//! in the `ShutdownMessage` the VM writes when the runtime shuts the attempt
//! down, so nothing takes one to keep it for later.
//!
//! The database's store awaits some handles from Rust (its reads, its
//! commits, its flushes and its listing of the keys): it registers a waiter
//! for the handle ([`Vm::issue_and_wait`]), and the tick hands it the
//! notification as it takes it. Issuing the action and registering the
//! waiter are one critical section, so that no tick takes the notification
//! in between.
//!
//! The cancel signal comes on the reserved handle 1
//! ([`CANCEL_NOTIFICATION_HANDLE`]), which no action has: after it,
//! `is_cancelled()` is true.
//!
//! The VM is [`Send`] but not `Sync`, and it lives behind a [`Mutex`], since
//! two threads reach it: JavaScript's, which ticks it, and the runtime's,
//! where a database call that waits for the store goes on (see
//! `node::answer`). A call from the runtime's thread then asks JavaScript to
//! tick, through [`Vm::set_scheduler`], so that what it wrote is flushed and
//! what it waits for is handed to it.
use bytes::Bytes;
use futures::channel::oneshot;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use restate_sdk_shared_core::explicit_recovery::{
    ActionOptions, AttemptState, CANCEL_NOTIFICATION_HANDLE, CoreExplicitRecoveryVM,
    ExplicitRecoveryVM, Notification, Options, ProtocolVersion, RecordLevel, SpanId, StateScope,
};
use restate_sdk_shared_core::{
    AttachInvocationTarget, Error, Header, NonEmptyValue, NotificationHandle, Target,
    TerminalFailure, Value,
};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

/// A header of the request, or of a call: `{ key, value }`.
#[napi(object)]
pub struct VmHeader {
    pub key: String,
    pub value: String,
}

impl From<&Header> for VmHeader {
    fn from(header: &Header) -> Self {
        VmHeader {
            key: header.key.to_string(),
            value: header.value.to_string(),
        }
    }
}

impl From<VmHeader> for Header {
    fn from(header: VmHeader) -> Self {
        Header {
            key: header.key.into(),
            value: header.value.into(),
        }
    }
}

/// A terminal failure: what a handler throws, and what a failed action completes with.
#[napi(object)]
pub struct VmFailure {
    pub code: u32,
    pub message: String,
    pub metadata: Vec<VmHeader>,
}

impl From<TerminalFailure> for VmFailure {
    fn from(failure: TerminalFailure) -> Self {
        VmFailure {
            code: failure.code as u32,
            message: failure.message,
            metadata: failure
                .metadata
                .into_iter()
                .map(|(key, value)| VmHeader { key, value })
                .collect(),
        }
    }
}

impl From<VmFailure> for TerminalFailure {
    fn from(failure: VmFailure) -> Self {
        TerminalFailure {
            code: failure.code as u16,
            message: failure.message,
            metadata: failure
                .metadata
                .into_iter()
                .map(|header| (header.key, header.value))
                .collect(),
        }
    }
}

/// The response's head: the status and headers to write before the body.
#[napi(object)]
pub struct VmResponseHead {
    pub status_code: u32,
    pub headers: Vec<VmHeader>,
}

/// The invocation's input, once the VM is ready to execute.
#[napi(object)]
pub struct VmInput {
    pub invocation_id: String,
    pub key: String,
    pub headers: Vec<VmHeader>,
    pub input: Buffer,
    pub scope: Option<String>,
    pub limit_key: Option<String>,
    pub idempotency_key: Option<String>,
    /// The number of this attempt: 1 for the first.
    pub attempt: u32,
}

/// The handles of a call: its invocation id, and its result.
#[napi(object)]
pub struct VmCallHandle {
    pub invocation_id: u32,
    pub result: u32,
}

/// How an action appears in the runtime's record of the attempt: its display
/// name, the span it is inside of, and how much is recorded (`"default"`,
/// `"none"`, `"summary"` or `"full"`). None of it changes what it does.
#[napi(object)]
#[derive(Default)]
pub struct VmActionOptions {
    pub name: Option<String>,
    pub parent_span: Option<u32>,
    pub record: Option<String>,
}

/// The target of a call or a send.
#[napi(object)]
pub struct VmTarget {
    pub service: String,
    pub handler: String,
    pub key: Option<String>,
    pub idempotency_key: Option<String>,
    pub headers: Option<Vec<VmHeader>>,
}

impl From<VmTarget> for Target {
    fn from(target: VmTarget) -> Self {
        Target {
            service: target.service,
            handler: target.handler,
            key: target.key,
            idempotency_key: target.idempotency_key,
            scope: None,
            limit_key: None,
            headers: target
                .headers
                .unwrap_or_default()
                .into_iter()
                .map(Into::into)
                .collect(),
        }
    }
}

/// A ready result, as JavaScript gets it. `kind` says which field holds it:
/// `void` none, `success` `bytes`, `failure` `failure`, `stateKeys` `keys`,
/// and `invocationId` `id`. Handle 1 is the cancel signal (`void`).
#[napi(object)]
pub struct VmNotification {
    pub handle: u32,
    pub kind: String,
    pub bytes: Option<Buffer>,
    pub failure: Option<VmFailure>,
    pub keys: Option<Vec<String>>,
    pub id: Option<String>,
}

fn notification_to_js(handle: u32, value: Value) -> VmNotification {
    let mut js = VmNotification {
        handle,
        kind: String::new(),
        bytes: None,
        failure: None,
        keys: None,
        id: None,
    };
    match value {
        Value::Void => js.kind = "void".to_owned(),
        Value::Success(bytes) => {
            js.kind = "success".to_owned();
            js.bytes = Some(bytes.to_vec().into());
        }
        Value::Failure(failure) => {
            js.kind = "failure".to_owned();
            js.failure = Some(failure.into());
        }
        Value::StateKeys(keys) => {
            js.kind = "stateKeys".to_owned();
            js.keys = Some(keys);
        }
        Value::InvocationId(id) => {
            js.kind = "invocationId".to_owned();
            js.id = Some(id);
        }
    }
    js
}

/// What JavaScript is asked to do after Rust touches the VM: one tick.
pub(crate) type Scheduler = ThreadsafeFunction<(), (), (), Status, false, true>;

/// Where Rust waits for the notification of a handle (the database's store).
pub(crate) type RustWaiter = oneshot::Sender<std::result::Result<Value, Error>>;
/// What such a waiter receives.
pub(crate) type Waited = oneshot::Receiver<std::result::Result<Value, Error>>;

/// The VM, the handles Rust waits for, and the handles that will never be notified.
pub(crate) struct VmInner {
    pub(crate) vm: CoreExplicitRecoveryVM,
    rust_waiters: HashMap<NotificationHandle, RustWaiter>,
    /// Why the attempt ended, once the tick found out: every later waiter gets it at once.
    ended: Option<Error>,
    /// The handles of aborted atomic groups' actions, which will never be
    /// notified: JavaScript fails what waits for them ([`Vm::take_aborted`]).
    aborted: Vec<NotificationHandle>,
    scheduler: Option<Arc<Scheduler>>,
    /// Whether a tick is already asked for: one is enough until it runs, and
    /// a commit's writes would otherwise each wake JavaScript's thread.
    asked_to_tick: bool,
}

impl VmInner {
    /// The notification of `handle`, for Rust: registered now, handed over by
    /// the tick that takes it. Once the attempt is over, at once with why.
    pub(crate) fn wait_in_rust(&mut self, handle: NotificationHandle) -> Waited {
        let (sender, receiver) = oneshot::channel();
        if let Some(error) = &self.ended {
            let _ = sender.send(Err(error.clone()));
        } else {
            self.rust_waiters.insert(handle, sender);
        }
        receiver
    }

    /// Record handles that will never be notified (an aborted group's).
    pub(crate) fn forget(&mut self, handles: Vec<NotificationHandle>) {
        for handle in &handles {
            if let Some(waiter) = self.rust_waiters.remove(handle) {
                let _ = waiter.send(Err(Error::new(
                    restate_sdk_shared_core::error::codes::INTERNAL,
                    "the atomic group of this action was aborted",
                )));
            }
        }
        self.aborted.extend(handles);
    }

    /// The scheduler to call, if a tick is not already asked for.
    pub(crate) fn wanted(&mut self) -> Option<Arc<Scheduler>> {
        if self.asked_to_tick {
            return None;
        }
        self.asked_to_tick = true;
        self.scheduler.clone()
    }
}

/// Restate's signature on a request, as the SDK verifies it before dispatch.
///
/// This package serves a session object's invocations ahead of the SDK's
/// handler, and its discovery, so it verifies the signature itself: a
/// deployment with identity keys, which every `connect` has, would otherwise
/// go unchecked (`src/endpoint.ts`).
#[napi]
pub struct Identity(restate_sdk_shared_core::IdentityVerifier);

#[napi]
impl Identity {
    /// The v1 public keys a deployment accepts (`publickeyv1_…`).
    #[napi(constructor)]
    pub fn new(keys: Vec<String>) -> Result<Self> {
        let borrowed: Vec<&str> = keys.iter().map(String::as_str).collect();
        restate_sdk_shared_core::IdentityVerifier::new(&borrowed)
            .map(Self)
            .map_err(|error| Error_::new(Status::InvalidArg, error.to_string()))
    }

    /// Nothing if `headers` carry a signature of `path` by one of the keys,
    /// and why not otherwise.
    #[napi]
    pub fn verify(&self, path: String, headers: Vec<VmHeader>) -> Option<String> {
        let headers: Vec<(String, String)> = headers
            .into_iter()
            .map(|header| (header.key, header.value))
            .collect();
        self.0
            .verify_identity(&headers, &path)
            .err()
            .map(|error| error.to_string())
    }
}

/// The range of versions of the explicit recovery protocol the VM speaks, for
/// discovery (`explicitRecoveryProtocol` in manifest v6): from the core.
#[napi(object)]
pub(crate) struct VmProtocolRange {
    pub min_version: u32,
    pub max_version: u32,
}

#[napi]
pub(crate) fn explicit_recovery_protocol_range() -> VmProtocolRange {
    VmProtocolRange {
        min_version: ProtocolVersion::minimum_supported_version() as u32,
        max_version: ProtocolVersion::maximum_supported_version() as u32,
    }
}

/// The attempt's state machine, shared by JavaScript and the database's store.
#[napi]
pub struct Vm(pub(crate) Arc<Mutex<VmInner>>);

/// What the database's store's pending reads and commits fail with when the
/// attempt is over: Restate shut it down, or it failed. It crosses the addon
/// as the text of an error, so `src/database.ts` matches it to give the
/// handler the error of an attempt's end.
pub(crate) const ATTEMPT_OVER: &str = "restate-sessions: the attempt is over";

/// A VM error as JavaScript gets it. The attempt's shutdown carries the text
/// `ATTEMPT_SHUT_DOWN`, which the driver tells apart from a failure; a VM the
/// request is refused for carries `VM_REFUSED <code>:` (415 for a content
/// type of another family or version), the status to answer with.
fn vm_error(error: Error) -> Error_ {
    if error.is_suspended_error() {
        Error_::new(
            Status::GenericFailure,
            format!("ATTEMPT_SHUT_DOWN: {error}"),
        )
    } else {
        Error_::new(Status::GenericFailure, error.to_string())
    }
}

/// napi's error type, named so that shared-core's `Error` keeps its name here.
type Error_ = napi::Error;

fn scope_of(scope: &str) -> Result<StateScope> {
    match scope {
        "object" => Ok(StateScope::Object),
        "invocation" => Ok(StateScope::Invocation),
        other => Err(Error_::new(
            Status::InvalidArg,
            format!("a state scope is \"object\" or \"invocation\", not {other:?}"),
        )),
    }
}

fn record_of(record: Option<&str>) -> Result<RecordLevel> {
    match record {
        None | Some("default") => Ok(RecordLevel::Default),
        Some("none") => Ok(RecordLevel::None),
        Some("summary") => Ok(RecordLevel::Summary),
        Some("full") => Ok(RecordLevel::Full),
        Some(other) => Err(Error_::new(
            Status::InvalidArg,
            format!(
                "a record level is \"default\", \"none\", \"summary\" or \"full\", not {other:?}"
            ),
        )),
    }
}

pub(crate) fn span_of(span: u32) -> Result<SpanId> {
    SpanId::try_from(span).map_err(|_| Error_::new(Status::InvalidArg, "a span id is never 0"))
}

/// The options of an action, from JavaScript's.
pub(crate) fn options_of(options: Option<VmActionOptions>) -> Result<ActionOptions> {
    let options = options.unwrap_or_default();
    let mut made = ActionOptions::default().recorded(record_of(options.record.as_deref())?);
    made.name = options.name;
    if let Some(parent) = options.parent_span {
        made = made.inside(span_of(parent)?);
    }
    Ok(made)
}

/// `invoke_at` from a delay in milliseconds: the time since the UNIX epoch at which to invoke.
pub(crate) fn invoke_at(delay: Option<i64>) -> Option<Duration> {
    delay.map(|millis| {
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("duration since the unix epoch cannot fail")
            + Duration::from_millis(millis.max(0) as u64)
    })
}

/// The value of a span's end or a signal: nothing, bytes, or a failure.
fn non_empty(bytes: Option<Uint8Array>, failure: Option<VmFailure>) -> Option<NonEmptyValue> {
    match (bytes, failure) {
        (_, Some(failure)) => Some(NonEmptyValue::Failure(failure.into())),
        (Some(bytes), None) => Some(NonEmptyValue::Success(Bytes::copy_from_slice(&bytes))),
        (None, None) => None,
    }
}

/// The lock of a VM: taken briefly, never held across an await.
pub(crate) fn lock(inner: &Arc<Mutex<VmInner>>) -> MutexGuard<'_, VmInner> {
    inner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Vm {
    fn lock(&self) -> MutexGuard<'_, VmInner> {
        lock(&self.0)
    }

    /// The VM the database's store acts on.
    pub(crate) fn inner(&self) -> Arc<Mutex<VmInner>> {
        self.0.clone()
    }

    /// Ask JavaScript to tick, so that what Rust just sent is written and what
    /// it waits for is handed to it. Called with the lock released.
    pub(crate) fn schedule(scheduler: Option<Arc<Scheduler>>) {
        if let Some(scheduler) = scheduler {
            scheduler.call((), ThreadsafeFunctionCallMode::NonBlocking);
        }
    }

    /// `act` on the VM, in one critical section, then ask JavaScript to tick.
    pub(crate) fn act<T>(inner: &Arc<Mutex<VmInner>>, act: impl FnOnce(&mut VmInner) -> T) -> T {
        let (result, scheduler) = {
            let mut vm = lock(inner);
            let result = act(&mut vm);
            let scheduler = vm.wanted();
            (result, scheduler)
        };
        Self::schedule(scheduler);
        result
    }

    /// Issue an action with `act` and register the waiter of its handle, in
    /// one critical section, then ask JavaScript to tick: a result the VM has
    /// at once (a state value it knows) reaches the waiter in that tick.
    pub(crate) fn issue_and_wait(
        inner: &Arc<Mutex<VmInner>>,
        act: impl FnOnce(&mut CoreExplicitRecoveryVM) -> std::result::Result<NotificationHandle, Error>,
    ) -> std::result::Result<Waited, Error> {
        Self::act(inner, |vm| {
            act(&mut vm.vm).map(|handle| vm.wait_in_rust(handle))
        })
    }
}

#[napi]
impl Vm {
    /// Refused for a content type of another family or version: the error's
    /// message starts with `VM_REFUSED <code>:`, the status to answer with
    /// (415), and nothing is written.
    #[napi(constructor)]
    pub fn new(headers: Vec<VmHeader>) -> Result<Self> {
        let headers: Vec<(String, String)> = headers
            .into_iter()
            .map(|header| (header.key, header.value))
            .collect();
        let vm = CoreExplicitRecoveryVM::new(headers, Options::default()).map_err(|error| {
            Error_::new(
                Status::GenericFailure,
                format!("VM_REFUSED {}: {error}", error.code()),
            )
        })?;
        Ok(Vm(Arc::new(Mutex::new(VmInner {
            vm,
            rust_waiters: Default::default(),
            ended: None,
            aborted: Default::default(),
            scheduler: None,
            asked_to_tick: false,
        }))))
    }

    /// What the VM calls, on JavaScript's thread, after Rust acts on it: the
    /// driver's tick, which writes the output and settles what completed.
    #[napi(ts_args_type = "scheduler: () => void")]
    pub fn set_scheduler(&self, scheduler: Function<'_, (), ()>) -> Result<()> {
        let scheduler = scheduler
            .build_threadsafe_function()
            .callee_handled::<false>()
            .weak::<true>()
            .build()?;
        self.lock().scheduler = Some(Arc::new(scheduler));
        Ok(())
    }

    #[napi]
    pub fn get_response_head(&self) -> VmResponseHead {
        let head = self.lock().vm.get_response_head();
        VmResponseHead {
            status_code: head.status_code as u32,
            headers: head.headers.iter().map(Into::into).collect(),
        }
    }

    // --- Input and output

    #[napi]
    pub fn notify_input(&self, buffer: Uint8Array) {
        self.lock().vm.notify_input(Bytes::copy_from_slice(&buffer));
    }

    /// The runtime closed the input stream. While the handler runs, this
    /// shuts the attempt down: the VM writes `ShutdownMessage` at once.
    #[napi]
    pub fn notify_input_closed(&self) {
        self.lock().vm.notify_input_closed();
    }

    /// The bytes buffered so far for the response body. Every tick starts
    /// here, so the tick Rust asked for is now running: the next act asks anew.
    #[napi]
    pub fn take_output(&self) -> Buffer {
        let mut vm = self.lock();
        vm.asked_to_tick = false;
        vm.vm.take_output().to_vec().into()
    }

    /// Whether to close the response now: the VM wrote its last message, and
    /// the runtime closed its side. Write `take_output()` first.
    #[napi]
    pub fn should_close_output(&self) -> bool {
        self.lock().vm.should_close_output()
    }

    #[napi]
    pub fn is_ready_to_execute(&self) -> Result<bool> {
        self.lock().vm.is_ready_to_execute().map_err(vm_error)
    }

    #[napi]
    pub fn is_feature_supported(&self, feature: u32) -> bool {
        self.lock().vm.is_feature_supported(feature)
    }

    #[napi]
    pub fn input(&self) -> Result<VmInput> {
        let input = self.lock().vm.get_input().map_err(vm_error)?;
        Ok(VmInput {
            invocation_id: input.invocation_id,
            key: input.key,
            headers: input.headers.iter().map(Into::into).collect(),
            input: input.input.to_vec().into(),
            scope: input.scope,
            limit_key: input.limit_key,
            idempotency_key: input.idempotency_key,
            attempt: input.attempt,
        })
    }

    /// The next notification for JavaScript, or `null`: only the driver's
    /// tick calls it. A handle Rust waits for goes to its waiter, and the next
    /// one is taken. Throws once the attempt is closed: `ATTEMPT_SHUT_DOWN`
    /// for a shutdown (the VM wrote `ShutdownMessage`), else a failure (the
    /// VM wrote `ErrorMessage`).
    #[napi]
    pub fn take_notification(&self) -> Result<Option<VmNotification>> {
        let mut vm = self.lock();
        loop {
            match vm.vm.take_next_notification() {
                Ok(Some(Notification { handle, value })) => match vm.rust_waiters.remove(&handle) {
                    Some(waiter) => {
                        let _ = waiter.send(Ok(value));
                    }
                    None => return Ok(Some(notification_to_js(handle.into(), value))),
                },
                Ok(None) => return Ok(None),
                Err(error) => {
                    // What the store's waits fail with: the attempt's end if
                    // Restate shut it down, which `src/database.ts` knows by
                    // this text, and otherwise why it failed.
                    let for_waiters = if error.is_suspended_error() {
                        Error::new(
                            restate_sdk_shared_core::error::codes::INTERNAL,
                            ATTEMPT_OVER.to_owned(),
                        )
                    } else {
                        error.clone()
                    };
                    for (_, waiter) in vm.rust_waiters.drain() {
                        let _ = waiter.send(Err(for_waiters.clone()));
                    }
                    vm.ended = Some(for_waiters);
                    return Err(vm_error(error));
                }
            }
        }
    }

    /// The reserved handle of the cancel signal.
    #[napi]
    pub fn cancel_handle(&self) -> u32 {
        CANCEL_NOTIFICATION_HANDLE.into()
    }

    /// The handles of aborted atomic groups' actions since the last call:
    /// never notified.
    #[napi]
    pub fn take_aborted(&self) -> Vec<u32> {
        self.lock().aborted.drain(..).map(u32::from).collect()
    }

    // --- State

    #[napi]
    pub fn get_state(
        &self,
        scope: String,
        key: String,
        options: Option<VmActionOptions>,
    ) -> Result<u32> {
        let (scope, options) = (scope_of(&scope)?, options_of(options)?);
        self.lock()
            .vm
            .cmd_state_get(scope, key, options)
            .map(u32::from)
            .map_err(vm_error)
    }

    #[napi]
    pub fn get_state_keys(&self, scope: String, options: Option<VmActionOptions>) -> Result<u32> {
        let (scope, options) = (scope_of(&scope)?, options_of(options)?);
        self.lock()
            .vm
            .cmd_state_get_keys(scope, options)
            .map(u32::from)
            .map_err(vm_error)
    }

    /// The handle of its result, or `null` without `wantResult`.
    #[napi]
    pub fn set_state(
        &self,
        scope: String,
        key: String,
        buffer: Uint8Array,
        want_result: Option<bool>,
        options: Option<VmActionOptions>,
    ) -> Result<Option<u32>> {
        let (scope, options) = (scope_of(&scope)?, options_of(options)?);
        self.lock()
            .vm
            .cmd_state_set(
                scope,
                key,
                Bytes::copy_from_slice(&buffer),
                options,
                want_result == Some(true),
            )
            .map(|handle| handle.map(u32::from))
            .map_err(vm_error)
    }

    #[napi]
    pub fn clear_state(
        &self,
        scope: String,
        key: String,
        want_result: Option<bool>,
        options: Option<VmActionOptions>,
    ) -> Result<Option<u32>> {
        let (scope, options) = (scope_of(&scope)?, options_of(options)?);
        self.lock()
            .vm
            .cmd_state_clear(scope, key, options, want_result == Some(true))
            .map(|handle| handle.map(u32::from))
            .map_err(vm_error)
    }

    #[napi]
    pub fn clear_all_state(
        &self,
        scope: String,
        want_result: Option<bool>,
        options: Option<VmActionOptions>,
    ) -> Result<Option<u32>> {
        let (scope, options) = (scope_of(&scope)?, options_of(options)?);
        self.lock()
            .vm
            .cmd_state_clear_all(scope, options, want_result == Some(true))
            .map(|handle| handle.map(u32::from))
            .map_err(vm_error)
    }

    // --- Invocations

    /// `delay` is in milliseconds.
    #[napi]
    pub fn call(
        &self,
        target: VmTarget,
        buffer: Uint8Array,
        delay: Option<i64>,
        options: Option<VmActionOptions>,
    ) -> Result<VmCallHandle> {
        let options = options_of(options)?;
        self.lock()
            .vm
            .cmd_call(
                target.into(),
                Bytes::copy_from_slice(&buffer),
                invoke_at(delay),
                options,
            )
            .map(|handle| VmCallHandle {
                invocation_id: handle.invocation_id_notification_handle.into(),
                result: handle.call_notification_handle.into(),
            })
            .map_err(vm_error)
    }

    /// Returns the handle of the invocation id. `delay` is in milliseconds.
    #[napi]
    pub fn send(
        &self,
        target: VmTarget,
        buffer: Uint8Array,
        delay: Option<i64>,
        options: Option<VmActionOptions>,
    ) -> Result<u32> {
        let options = options_of(options)?;
        self.lock()
            .vm
            .cmd_send(
                target.into(),
                Bytes::copy_from_slice(&buffer),
                invoke_at(delay),
                options,
            )
            .map(|handle| handle.invocation_id_notification_handle.into())
            .map_err(vm_error)
    }

    #[napi]
    pub fn attach_invocation(
        &self,
        invocation_id: String,
        options: Option<VmActionOptions>,
    ) -> Result<u32> {
        let options = options_of(options)?;
        self.lock()
            .vm
            .cmd_attach_invocation(AttachInvocationTarget::InvocationId(invocation_id), options)
            .map(u32::from)
            .map_err(vm_error)
    }

    #[napi]
    pub fn cancel_invocation(
        &self,
        invocation_id: String,
        want_result: Option<bool>,
        options: Option<VmActionOptions>,
    ) -> Result<Option<u32>> {
        let options = options_of(options)?;
        self.lock()
            .vm
            .cmd_cancel_invocation(invocation_id, options, want_result == Some(true))
            .map(|handle| handle.map(u32::from))
            .map_err(vm_error)
    }

    // --- Signals

    /// The signal `index` (from 0) of the name `signalName` this invocation received: its handle.
    #[napi]
    pub fn signal_read(
        &self,
        signal_name: String,
        index: u32,
        options: Option<VmActionOptions>,
    ) -> Result<u32> {
        let options = options_of(options)?;
        self.lock()
            .vm
            .cmd_signal_read(signal_name, index, options)
            .map(u32::from)
            .map_err(vm_error)
    }

    /// A signal to another invocation: carrying `bytes`, `failure`, or nothing.
    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn signal_send(
        &self,
        target_invocation_id: String,
        signal_name: String,
        bytes: Option<Uint8Array>,
        failure: Option<VmFailure>,
        want_result: Option<bool>,
        options: Option<VmActionOptions>,
    ) -> Result<Option<u32>> {
        let options = options_of(options)?;
        self.lock()
            .vm
            .cmd_signal_send(
                target_invocation_id,
                signal_name,
                non_empty(bytes, failure),
                options,
                want_result == Some(true),
            )
            .map(|handle| handle.map(u32::from))
            .map_err(vm_error)
    }

    // --- Durability

    /// Notified (`void`) once every action made before it is applied.
    #[napi]
    pub fn flush(&self, options: Option<VmActionOptions>) -> Result<u32> {
        let options = options_of(options)?;
        self.lock()
            .vm
            .cmd_flush(options)
            .map(u32::from)
            .map_err(vm_error)
    }

    /// Opens an atomic group: the actions until `atomicGroupEnd` leave as one.
    /// Never across an await.
    #[napi]
    pub fn atomic_group_start(&self) -> Result<()> {
        self.lock().vm.atomic_group_start().map_err(vm_error)
    }

    #[napi]
    pub fn atomic_group_end(
        &self,
        want_result: Option<bool>,
        options: Option<VmActionOptions>,
    ) -> Result<Option<u32>> {
        let options = options_of(options)?;
        self.lock()
            .vm
            .atomic_group_end(options, want_result == Some(true))
            .map(|handle| handle.map(u32::from))
            .map_err(vm_error)
    }

    /// Drops the open group: the handles its actions returned, never notified.
    #[napi]
    pub fn atomic_group_abort(&self) -> Result<Vec<u32>> {
        self.lock()
            .vm
            .atomic_group_abort()
            .map(|handles| handles.into_iter().map(u32::from).collect())
            .map_err(vm_error)
    }

    // --- Spans
    //
    // Shown in Restate's UI, nested: an action whose options name a span as
    // its parent is inside it. A span the attempt leaves open ends with it.

    /// Inside the span `parent` of this attempt, or else inside the attempt itself.
    #[napi]
    pub fn span_start(&self, name: String, parent: Option<u32>) -> Result<u32> {
        let parent = parent.map(span_of).transpose()?;
        self.lock()
            .vm
            .span_start(name, parent)
            .map(u32::from)
            .map_err(vm_error)
    }

    /// End `span`: with `bytes`, with `failure`, or with nothing.
    #[napi]
    pub fn span_end(
        &self,
        span: u32,
        bytes: Option<Uint8Array>,
        failure: Option<VmFailure>,
    ) -> Result<()> {
        let span = span_of(span)?;
        self.lock()
            .vm
            .span_end(span, non_empty(bytes, failure))
            .map_err(vm_error)
    }

    // --- Control

    /// Tells Restate the attempt makes progress, delaying its shutdown.
    #[napi]
    pub fn heartbeat(&self) -> Result<()> {
        self.lock().vm.heartbeat().map_err(vm_error)
    }

    /// Whether the invocation was cancelled, as far as the handler was told:
    /// before this attempt, or by the cancel signal a tick took.
    #[napi]
    pub fn is_cancelled(&self) -> bool {
        self.lock().vm.is_cancelled()
    }

    /// The SDK ends the attempt on its own (the process is going away): an
    /// unasked `ShutdownMessage`, after which Restate starts a new attempt.
    #[napi]
    pub fn shutdown(&self) {
        self.lock().vm.shutdown();
    }

    /// Fail what the database's store waits for: the attempt is over, and
    /// nothing more will answer.
    #[napi]
    pub fn end_state_waits(&self) {
        let mut vm = self.lock();
        let over = Error::new(
            restate_sdk_shared_core::error::codes::INTERNAL,
            ATTEMPT_OVER.to_owned(),
        );
        for (_, waiter) in vm.rust_waiters.drain() {
            let _ = waiter.send(Err(over.clone()));
        }
        vm.ended.get_or_insert(over);
    }

    /// Let go of the scheduler, which holds JavaScript's tick, and so the
    /// driver and this VM: an attempt that kept it would never be freed.
    #[napi]
    pub fn clear_scheduler(&self) {
        self.lock().scheduler = None;
    }

    /// `"starting"`, `"running"` or `"closed"`.
    #[napi]
    pub fn state(&self) -> String {
        match self.lock().vm.state() {
            AttemptState::Starting => "starting",
            AttemptState::Running => "running",
            AttemptState::Closed => "closed",
        }
        .to_owned()
    }

    // --- End

    #[napi]
    pub fn end_success(&self, buffer: Uint8Array) -> Result<()> {
        self.lock()
            .vm
            .end(NonEmptyValue::Success(Bytes::copy_from_slice(&buffer)))
            .map_err(vm_error)
    }

    #[napi]
    pub fn end_failure(&self, failure: VmFailure) -> Result<()> {
        self.lock()
            .vm
            .end(NonEmptyValue::Failure(failure.into()))
            .map_err(vm_error)
    }

    /// Fails the attempt, for example with a retryable error of the handler.
    #[napi]
    pub fn notify_error(
        &self,
        message: String,
        stacktrace: Option<String>,
        delay_override_ms: Option<i64>,
    ) {
        let mut error = Error::new(restate_sdk_shared_core::error::codes::INTERNAL, message);
        if let Some(stacktrace) = stacktrace {
            error = error.with_stacktrace(stacktrace);
        }
        if let Some(delay) = delay_override_ms {
            error =
                error.with_next_retry_delay_override(Duration::from_millis(delay.max(0) as u64));
        }
        self.lock().vm.notify_error(error);
    }
}
