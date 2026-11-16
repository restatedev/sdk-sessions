//! The VM of a session object's attempt: shared-core's [`CoreExplicitRecoveryVM`],
//! which never replays a journal.
//!
//! Every attempt runs the handler from the start, and recovers from the state
//! the earlier attempts stored. An action returns a handle, and its result
//! comes back as a notification of that handle ([`Vm::take_notification`]):
//! `src/driver.ts` settles its promises with them. There is no `do_progress`,
//! so a handler awaits what it likes, with its own combinators, and nothing
//! has to fake a single await point (see the selector this replaces).
//!
//! The database's store awaits its own handles here, in Rust
//! ([`Vm::wait_in_rust`]): its reads, its acked writes and its listings never
//! reach JavaScript. Every other notification is queued for JavaScript.
//!
//! The VM is driven from two threads: JavaScript's, which ticks it, and the
//! runtime's, where a database call that waits for the store goes on (see
//! `node::answer`). It is [`Send`] but not `Sync`, so it lives behind a
//! [`Mutex`] that every call takes briefly and never holds across an await.
use bytes::Bytes;
use futures::channel::oneshot;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use restate_sdk_shared_core::explicit_recovery::{
    AttemptState, CoreExplicitRecoveryVM, ExplicitRecoveryVM, Notification, TraceId,
    request_response_unsupported,
};
use restate_sdk_shared_core::{
    AttachInvocationTarget, Error, Header, NonEmptyValue, NotificationHandle, Target,
    TerminalFailure, Value,
};
use std::collections::{HashMap, VecDeque};
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
}

/// The handles of a call: its invocation id, and its result.
#[napi(object)]
pub struct VmCallHandle {
    pub invocation_id: u32,
    pub result: u32,
}

/// A ready result, as JavaScript gets it. `kind` says which field holds it:
/// `void` none, `success` `bytes`, `failure` `failure`, `stateKeys` `keys`,
/// and `invocationId` `id`.
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

/// Where Rust waits for the notification of a handle (the database's store).
pub(crate) type RustWaiter = oneshot::Sender<std::result::Result<Value, Error>>;

/// The VM, the handles Rust waits for, and the notifications queued for JavaScript.
pub(crate) struct VmInner {
    pub(crate) vm: CoreExplicitRecoveryVM,
    rust_waiters: HashMap<NotificationHandle, RustWaiter>,
    for_js: VecDeque<Notification>,
}

impl VmInner {
    /// Take the VM's notifications, handing Rust's to their waiters and queueing the rest for
    /// JavaScript. Once the attempt is closed with an error, every waiter gets it.
    fn route(&mut self) -> std::result::Result<(), Error> {
        loop {
            match self.vm.take_next_notification() {
                Ok(Some(notification)) => match self.rust_waiters.remove(&notification.handle) {
                    Some(waiter) => {
                        let _ = waiter.send(Ok(notification.value));
                    }
                    None => self.for_js.push_back(notification),
                },
                Ok(None) => return Ok(()),
                Err(error) => {
                    for (_, waiter) in self.rust_waiters.drain() {
                        let _ = waiter.send(Err(error.clone()));
                    }
                    return Err(error);
                }
            }
        }
    }
}

/// The attempt's state machine, shared by JavaScript and the database's store.
#[napi]
pub struct Vm(pub(crate) Arc<Mutex<VmInner>>);

/// A VM error as JavaScript gets it. The attempt's shutdown carries the code
/// `ATTEMPT_SHUT_DOWN`, which the driver tells apart from a failure.
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

fn target(
    service: String,
    handler: String,
    key: Option<String>,
    idempotency_key: Option<String>,
    headers: Option<Vec<VmHeader>>,
) -> Target {
    Target {
        service,
        handler,
        key,
        idempotency_key,
        scope: None,
        limit_key: None,
        headers: headers
            .unwrap_or_default()
            .into_iter()
            .map(Into::into)
            .collect(),
    }
}

impl Vm {
    /// The lock of the VM: taken briefly, never held across an await.
    pub(crate) fn lock(&self) -> MutexGuard<'_, VmInner> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The notification of `handle`, for Rust: the database's store awaits it.
    /// A handle already notified answers at once.
    // Unused until the store moves onto the VM, which is the next change.
    #[allow(dead_code)]
    pub(crate) fn wait_in_rust(
        inner: &Arc<Mutex<VmInner>>,
        handle: NotificationHandle,
    ) -> oneshot::Receiver<std::result::Result<Value, Error>> {
        let (sender, receiver) = oneshot::channel();
        let mut vm = inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        vm.rust_waiters.insert(handle, sender);
        // The error, if any, reaches the waiter.
        let _ = vm.route();
        receiver
    }
}

#[napi]
impl Vm {
    /// Without a bidirectional stream (a request/response transport, e.g. AWS
    /// Lambda), the VM fails the invocation at once, pausing it: no response
    /// could reach the handler.
    #[napi(
        constructor,
        ts_args_type = "headers: VmHeader[], bidirectional: boolean"
    )]
    pub fn new(headers: Vec<VmHeader>, bidirectional: bool) -> Result<Self> {
        let headers: Vec<(String, String)> = headers
            .into_iter()
            .map(|header| (header.key, header.value))
            .collect();
        let mut vm = CoreExplicitRecoveryVM::new(headers).map_err(vm_error)?;
        if !bidirectional {
            vm.notify_error(request_response_unsupported());
        }
        Ok(Vm(Arc::new(Mutex::new(VmInner {
            vm,
            rust_waiters: Default::default(),
            for_js: Default::default(),
        }))))
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

    /// The runtime closed the input stream. While the handler runs, this shuts the attempt down.
    #[napi]
    pub fn notify_input_closed(&self) {
        self.lock().vm.notify_input_closed();
    }

    /// The bytes buffered so far for the response body.
    #[napi]
    pub fn take_output(&self) -> Buffer {
        self.lock().vm.take_output().to_vec().into()
    }

    #[napi]
    pub fn is_ready_to_execute(&self) -> Result<bool> {
        self.lock().vm.is_ready_to_execute().map_err(vm_error)
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
        })
    }

    /// The next notification for JavaScript, or `null`. Throws once the
    /// attempt is closed: `ATTEMPT_SHUT_DOWN` for a shutdown, else a failure.
    #[napi]
    pub fn take_notification(&self) -> Result<Option<VmNotification>> {
        let mut vm = self.lock();
        vm.route().map_err(vm_error)?;
        Ok(vm
            .for_js
            .pop_front()
            .map(|Notification { handle, value }| notification_to_js(handle.into(), value)))
    }

    // --- Request/response actions

    #[napi]
    pub fn get_state(&self, key: String, name: Option<String>) -> Result<u32> {
        self.lock()
            .vm
            .cmd_state_get(key, name)
            .map(u32::from)
            .map_err(vm_error)
    }

    #[napi]
    pub fn get_state_keys(&self, name: Option<String>) -> Result<u32> {
        self.lock()
            .vm
            .cmd_state_get_keys(name)
            .map(u32::from)
            .map_err(vm_error)
    }

    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn call(
        &self,
        service: String,
        handler: String,
        buffer: Uint8Array,
        key: Option<String>,
        idempotency_key: Option<String>,
        headers: Option<Vec<VmHeader>>,
        name: Option<String>,
    ) -> Result<VmCallHandle> {
        self.lock()
            .vm
            .cmd_call(
                target(service, handler, key, idempotency_key, headers),
                Bytes::copy_from_slice(&buffer),
                name,
            )
            .map(|handle| VmCallHandle {
                invocation_id: handle.invocation_id_notification_handle.into(),
                result: handle.call_notification_handle.into(),
            })
            .map_err(vm_error)
    }

    /// Returns the handle of the invocation id. `delay` is in milliseconds.
    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn send(
        &self,
        service: String,
        handler: String,
        buffer: Uint8Array,
        key: Option<String>,
        delay: Option<i64>,
        idempotency_key: Option<String>,
        headers: Option<Vec<VmHeader>>,
        name: Option<String>,
    ) -> Result<u32> {
        let execute_at = delay.map(|millis| {
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .expect("duration since the unix epoch cannot fail")
                + Duration::from_millis(millis.max(0) as u64)
        });
        self.lock()
            .vm
            .cmd_send(
                target(service, handler, key, idempotency_key, headers),
                Bytes::copy_from_slice(&buffer),
                execute_at,
                name,
            )
            .map(|handle| handle.invocation_id_notification_handle.into())
            .map_err(vm_error)
    }

    #[napi]
    pub fn attach_invocation(&self, invocation_id: String, name: Option<String>) -> Result<u32> {
        self.lock()
            .vm
            .cmd_attach_invocation(AttachInvocationTarget::InvocationId(invocation_id), name)
            .map(u32::from)
            .map_err(vm_error)
    }

    // --- Fire-and-forget actions
    //
    // With `ack`, Restate answers once the command is stored, and the handle
    // is notified then; without, it is notified at once.

    #[napi]
    pub fn set_state(
        &self,
        key: String,
        buffer: Uint8Array,
        name: Option<String>,
        ack: Option<bool>,
    ) -> Result<u32> {
        self.lock()
            .vm
            .cmd_state_set(
                key,
                Bytes::copy_from_slice(&buffer),
                name,
                ack.unwrap_or(false),
            )
            .map(u32::from)
            .map_err(vm_error)
    }

    #[napi]
    pub fn clear_state(&self, key: String, name: Option<String>, ack: Option<bool>) -> Result<u32> {
        self.lock()
            .vm
            .cmd_state_clear(key, name, ack.unwrap_or(false))
            .map(u32::from)
            .map_err(vm_error)
    }

    #[napi]
    pub fn clear_all_state(&self, name: Option<String>, ack: Option<bool>) -> Result<u32> {
        self.lock()
            .vm
            .cmd_state_clear_all(name, ack.unwrap_or(false))
            .map(u32::from)
            .map_err(vm_error)
    }

    #[napi]
    pub fn cancel_invocation(
        &self,
        invocation_id: String,
        name: Option<String>,
        ack: Option<bool>,
    ) -> Result<u32> {
        self.lock()
            .vm
            .cmd_cancel_invocation(invocation_id, name, ack.unwrap_or(false))
            .map(u32::from)
            .map_err(vm_error)
    }

    // --- Tracing
    //
    // A trace is shown in Restate's UI as a run, until it is ended; one the
    // attempt leaves open is ended by `end`, or by the next attempt.

    /// Inside the trace `parent` of this attempt, or else inside the attempt itself.
    #[napi]
    pub fn start_trace(&self, name: String, parent: Option<u32>) -> Result<u32> {
        self.lock()
            .vm
            .trace_start(name, parent.map(TraceId::from))
            .map(u32::from)
            .map_err(vm_error)
    }

    #[napi]
    pub fn end_trace_success(&self, trace: u32, buffer: Uint8Array) -> Result<()> {
        self.lock()
            .vm
            .trace_end(
                TraceId::from(trace),
                NonEmptyValue::Success(Bytes::copy_from_slice(&buffer)),
            )
            .map_err(vm_error)
    }

    #[napi]
    pub fn end_trace_failure(&self, trace: u32, failure: VmFailure) -> Result<()> {
        self.lock()
            .vm
            .trace_end(TraceId::from(trace), NonEmptyValue::Failure(failure.into()))
            .map_err(vm_error)
    }

    // --- Control

    /// Tells Restate the attempt makes progress, delaying its shutdown.
    #[napi]
    pub fn heartbeat(&self) -> Result<()> {
        self.lock().vm.heartbeat().map_err(vm_error)
    }

    /// Whether the invocation was cancelled, in this attempt or an earlier one.
    #[napi]
    pub fn is_cancelled(&self) -> bool {
        self.lock().vm.is_cancelled()
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
