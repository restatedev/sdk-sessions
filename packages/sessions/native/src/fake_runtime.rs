//! For tests only (feature `fake_runtime`): shared-core's fake Restate runtime
//! of the explicit recovery protocol, `explicit_recovery::fake_runtime`, as
//! the class `FakeRuntime`.
//!
//! One invocation, over as many attempts as it takes: bytes in (`receive`,
//! what the SDK wrote), bytes out (`takeOutput`, what the SDK reads). It
//! applies what it receives, answers, decides between restart and suspend
//! after a shutdown, and checks everything the SDK sends against the
//! protocol: a violation throws (its message starts with `FAKE_VIOLATION`)
//! and is kept in `violations()`.
use crate::vm::{VmFailure, VmHeader};
use bytes::Bytes;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use restate_sdk_shared_core::Value;
use restate_sdk_shared_core::explicit_recovery::fake_runtime::{
    AttemptOutcome, CalleeBehavior, FakeRuntime as Core, FakeRuntimeError, FakeRuntimeOptions,
    InvocationSpec, InvocationStatus, Preload, ShutdownReason, request_headers,
};

fn fake_error(error: FakeRuntimeError) -> Error {
    match error {
        FakeRuntimeError::Violation(what) => {
            Error::new(Status::GenericFailure, format!("FAKE_VIOLATION: {what}"))
        }
        FakeRuntimeError::Misuse(what) => {
            Error::new(Status::InvalidArg, format!("fake runtime misuse: {what}"))
        }
    }
}

/// A preload policy: `"all"`, `"lazy"`, or the keys to preload.
fn preload_of(policy: Option<Either<String, Vec<String>>>) -> Result<Preload> {
    match policy {
        None => Ok(Preload::All),
        Some(Either::B(keys)) => Ok(Preload::Eager(keys)),
        Some(Either::A(policy)) => match policy.as_str() {
            "all" => Ok(Preload::All),
            "lazy" => Ok(Preload::Lazy),
            other => Err(Error::new(
                Status::InvalidArg,
                format!("a preload policy is \"all\", \"lazy\" or a list of keys, not {other:?}"),
            )),
        },
    }
}

/// A value: `bytes` (a success), `failure`, or neither (void).
#[napi(object)]
pub struct FakeValue {
    pub bytes: Option<Uint8Array>,
    pub failure: Option<VmFailure>,
}

fn value_of(value: Option<FakeValue>) -> Value {
    match value {
        Some(FakeValue {
            failure: Some(failure),
            ..
        }) => Value::Failure(failure.into()),
        Some(FakeValue {
            bytes: Some(bytes), ..
        }) => Value::Success(Bytes::copy_from_slice(&bytes)),
        _ => Value::Void,
    }
}

/// A value as a test reads it: `kind` (`void`, `success`, `failure`), and the field that holds it.
#[napi(object)]
pub struct FakeValueOut {
    pub kind: String,
    pub bytes: Option<Buffer>,
    pub failure: Option<VmFailure>,
}

fn value_out(value: &Value) -> FakeValueOut {
    match value {
        Value::Success(bytes) => FakeValueOut {
            kind: "success".to_owned(),
            bytes: Some(bytes.to_vec().into()),
            failure: None,
        },
        Value::Failure(failure) => FakeValueOut {
            kind: "failure".to_owned(),
            bytes: None,
            failure: Some(failure.clone().into()),
        },
        _ => FakeValueOut {
            kind: "void".to_owned(),
            bytes: None,
            failure: None,
        },
    }
}

/// The invocation the fake runs, and how it behaves; every field has a default.
#[napi(object)]
#[derive(Default)]
pub struct FakeInvocation {
    pub invocation_id: Option<String>,
    pub service: Option<String>,
    pub handler: Option<String>,
    /// The object's key (`"key"` by default); see `keyless`.
    pub key: Option<String>,
    /// A target without a key, which has no object state.
    pub keyless: Option<bool>,
    pub shared: Option<bool>,
    pub input: Option<Uint8Array>,
    pub headers: Option<Vec<VmHeader>>,
    pub idempotency_key: Option<String>,
    /// `"all"`, `"lazy"`, or the keys to preload.
    pub object_preload: Option<Either<String, Vec<String>>>,
    pub invocation_preload: Option<Either<String, Vec<String>>>,
    pub first_next_result_id: Option<u32>,
    pub max_consecutive_failures: Option<u32>,
    pub max_idle_restarts: Option<u32>,
    pub features: Option<Vec<u32>>,
}

/// A state entry.
#[napi(object)]
pub struct FakeEntry {
    pub key: String,
    pub value: Buffer,
}

/// How an attempt ended: `kind` is `completed`, `failed_invocation` (`code`),
/// `paused` (`code`), `failed` (`reason`), `restarted` (`rule`), `lost` or
/// `suspended`.
#[napi(object)]
pub struct FakeOutcome {
    pub kind: String,
    pub code: Option<u32>,
    pub reason: Option<String>,
    pub rule: Option<u32>,
}

/// An invocation a `Call` made (sends included).
#[napi(object)]
pub struct FakeCall {
    pub invocation_id: String,
    pub service: String,
    pub handler: String,
    pub key: String,
    pub idempotency_key: Option<String>,
    pub parameter: Buffer,
    /// Milliseconds since the UNIX epoch; 0 for as soon as possible.
    pub invoke_time: f64,
    pub attempt: u32,
    /// What it returned, once it did.
    pub output: Option<FakeValueOut>,
}

/// A signal an action sent to another invocation.
#[napi(object)]
pub struct FakeSignal {
    pub target_invocation_id: String,
    pub name: String,
    pub value: FakeValueOut,
}

/// Where the invocation stands: `ready`, `running`, `suspended`, `paused`, or
/// `completed` with its output.
#[napi(object)]
pub struct FakeStatus {
    pub status: String,
    pub output: Option<FakeValueOut>,
}

#[napi]
pub struct FakeRuntime(Core);

#[napi]
impl FakeRuntime {
    #[napi(constructor)]
    pub fn new(invocation: Option<FakeInvocation>) -> Result<Self> {
        let invocation = invocation.unwrap_or_default();
        let defaults = InvocationSpec::default();
        let first_next_result_id = invocation.first_next_result_id.unwrap_or(1);
        if first_next_result_id == 0 {
            return Err(Error::new(
                Status::InvalidArg,
                "firstNextResultId is at least 1",
            ));
        }
        let spec = InvocationSpec {
            invocation_id: invocation.invocation_id.unwrap_or(defaults.invocation_id),
            service: invocation.service.unwrap_or(defaults.service),
            handler: invocation.handler.unwrap_or(defaults.handler),
            key: match invocation.keyless {
                Some(true) => None,
                _ => Some(invocation.key.unwrap_or_else(|| "key".to_owned())),
            },
            shared: invocation.shared.unwrap_or(false),
            input: invocation
                .input
                .map(|input| Bytes::copy_from_slice(&input))
                .unwrap_or_default(),
            headers: (invocation.headers.unwrap_or_default().into_iter())
                .map(|header| (header.key, header.value))
                .collect(),
            idempotency_key: invocation.idempotency_key,
            scope: None,
            limit_key: None,
            object_preload: preload_of(invocation.object_preload)?,
            invocation_preload: preload_of(invocation.invocation_preload)?,
        };
        let options = FakeRuntimeOptions {
            first_next_result_id,
            max_consecutive_failures: invocation.max_consecutive_failures,
            max_idle_restarts: invocation.max_idle_restarts.unwrap_or(3),
            features: invocation.features.unwrap_or_default(),
            ..Default::default()
        };
        Ok(Self(Core::with_options(spec, options)))
    }

    /// The headers of the request that opens an attempt.
    #[napi]
    pub fn request_headers() -> Vec<VmHeader> {
        request_headers()
            .into_iter()
            .map(|(key, value)| VmHeader { key, value })
            .collect()
    }

    #[napi]
    pub fn content_type(&self) -> String {
        self.0.content_type().to_owned()
    }

    // --- Setting the scene

    #[napi]
    pub fn set_object_state(&mut self, key: String, value: Uint8Array) {
        self.0
            .object_state_mut()
            .insert(key, Bytes::copy_from_slice(&value));
    }

    #[napi]
    pub fn clear_object_state(&mut self, key: String) {
        self.0.object_state_mut().remove(&key);
    }

    #[napi]
    pub fn set_invocation_state(&mut self, key: String, value: Uint8Array) {
        self.0
            .invocation_state_mut()
            .insert(key, Bytes::copy_from_slice(&value));
    }

    /// What a call to `service`/`handler` does: `"pending"` (until
    /// `completeCall`), `"not_found"`, or `"returns"` with `value`.
    #[napi]
    pub fn script_callee(
        &mut self,
        service: String,
        handler: String,
        behavior: String,
        value: Option<FakeValue>,
    ) -> Result<()> {
        let behavior = match behavior.as_str() {
            "pending" => CalleeBehavior::Pending,
            "not_found" => CalleeBehavior::NotFound,
            "returns" => CalleeBehavior::Returns(value_of(value)),
            other => {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "a callee's behavior is \"pending\", \"returns\" or \"not_found\", not {other:?}"
                    ),
                ));
            }
        };
        self.0.script_callee(service, handler, behavior);
        Ok(())
    }

    // --- Observing

    #[napi]
    pub fn status(&self) -> FakeStatus {
        let (status, output) = match self.0.status() {
            InvocationStatus::Ready => ("ready", None),
            InvocationStatus::Running => ("running", None),
            InvocationStatus::Suspended => ("suspended", None),
            InvocationStatus::Paused => ("paused", None),
            InvocationStatus::Completed(value) => ("completed", Some(value_out(value))),
        };
        FakeStatus {
            status: status.to_owned(),
            output,
        }
    }

    #[napi]
    pub fn object_state(&self) -> Vec<FakeEntry> {
        (self.0.object_state().iter())
            .map(|(key, value)| FakeEntry {
                key: key.clone(),
                value: value.to_vec().into(),
            })
            .collect()
    }

    #[napi]
    pub fn invocation_state(&self) -> Vec<FakeEntry> {
        (self.0.invocation_state().iter())
            .map(|(key, value)| FakeEntry {
                key: key.clone(),
                value: value.to_vec().into(),
            })
            .collect()
    }

    /// The outcome of each attempt that ended.
    #[napi]
    pub fn outcomes(&self) -> Vec<FakeOutcome> {
        (self.0.outcomes().iter())
            .map(|outcome| {
                let (kind, code, reason, rule) = match outcome {
                    AttemptOutcome::Completed => ("completed", None, None, None),
                    AttemptOutcome::FailedInvocation { code } => {
                        ("failed_invocation", Some(*code), None, None)
                    }
                    AttemptOutcome::Paused { code } => ("paused", Some(*code), None, None),
                    AttemptOutcome::Failed { reason } => {
                        ("failed", None, Some(reason.clone()), None)
                    }
                    AttemptOutcome::Restarted { rule } => {
                        ("restarted", None, None, Some(u32::from(*rule)))
                    }
                    AttemptOutcome::Lost => ("lost", None, None, None),
                    AttemptOutcome::Suspended => ("suspended", None, None, None),
                };
                FakeOutcome {
                    kind: kind.to_owned(),
                    code,
                    reason,
                    rule,
                }
            })
            .collect()
    }

    #[napi]
    pub fn attempt_number(&self) -> u32 {
        self.0.attempt_number()
    }

    #[napi]
    pub fn next_result_id(&self) -> u32 {
        self.0.next_result_id()
    }

    /// Every invocation a `Call` made, sends included, in order.
    #[napi]
    pub fn calls(&self) -> Vec<FakeCall> {
        (self.0.calls().iter())
            .map(|call| FakeCall {
                invocation_id: call.invocation_id.clone(),
                service: call.service.clone(),
                handler: call.handler.clone(),
                key: call.key.clone(),
                idempotency_key: call.idempotency_key.clone(),
                parameter: call.parameter.to_vec().into(),
                invoke_time: call.invoke_time as f64,
                attempt: call.attempt,
                output: call.output.as_ref().map(value_out),
            })
            .collect()
    }

    #[napi]
    pub fn signals_sent(&self) -> Vec<FakeSignal> {
        (self.0.signals_sent().iter())
            .map(|signal| FakeSignal {
                target_invocation_id: signal.target_invocation_id.clone(),
                name: signal.name.clone(),
                value: value_out(&signal.value),
            })
            .collect()
    }

    #[napi]
    pub fn cancels_sent(&self) -> Vec<String> {
        self.0.cancels_sent().to_vec()
    }

    #[napi]
    pub fn violations(&self) -> Vec<String> {
        self.0.violations().to_vec()
    }

    #[napi]
    pub fn last_retry_delay(&self) -> Option<f64> {
        self.0.last_retry_delay().map(|delay| delay as f64)
    }

    #[napi]
    pub fn is_closed(&self) -> bool {
        self.0.is_closed()
    }

    #[napi]
    pub fn is_attempt_running(&self) -> bool {
        self.0.is_attempt_running()
    }

    // --- The attempt

    #[napi]
    pub fn start_attempt(&mut self) -> Result<Buffer> {
        let start = self.0.start_attempt().map_err(fake_error)?;
        Ok(start.to_vec().into())
    }

    #[napi]
    pub fn receive(&mut self, bytes: Uint8Array) -> Result<()> {
        self.0
            .receive(Bytes::copy_from_slice(&bytes))
            .map_err(fake_error)
    }

    #[napi]
    pub fn take_output(&mut self) -> Buffer {
        self.0.take_output().to_vec().into()
    }

    #[napi]
    pub fn set_auto_apply(&mut self, auto_apply: bool) {
        self.0.set_auto_apply(auto_apply);
    }

    #[napi]
    pub fn apply_pending(&mut self, max: u32) -> Result<u32> {
        self.0
            .apply_pending(max as usize)
            .map(|applied| applied as u32)
            .map_err(fake_error)
    }

    /// `reason`: `"inactivity"` (the attempt must be silent) or `"own"`.
    #[napi]
    pub fn shut_down(&mut self, reason: String) -> Result<()> {
        let reason = match reason.as_str() {
            "inactivity" => ShutdownReason::Inactivity,
            "own" => ShutdownReason::Own,
            other => {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("a shutdown's reason is \"inactivity\" or \"own\", not {other:?}"),
                ));
            }
        };
        self.0.shut_down(reason).map_err(fake_error)
    }

    #[napi]
    pub fn shutdown_answer_timed_out(&mut self) -> Result<()> {
        self.0.shutdown_answer_timed_out().map_err(fake_error)
    }

    #[napi]
    pub fn sdk_closed(&mut self) -> Result<()> {
        self.0.sdk_closed().map_err(fake_error)
    }

    #[napi]
    pub fn break_stream(&mut self) -> Result<()> {
        self.0.break_stream().map_err(fake_error)
    }

    #[napi]
    pub fn lose_attempt(&mut self) -> Result<()> {
        self.0.lose_attempt().map_err(fake_error)
    }

    // --- The world

    #[napi]
    pub fn complete_call(
        &mut self,
        invocation_id: String,
        output: Option<FakeValue>,
    ) -> Result<()> {
        self.0
            .complete_call(&invocation_id, value_of(output))
            .map_err(fake_error)
    }

    #[napi]
    pub fn send_signal(&mut self, name: String, value: Option<FakeValue>) {
        self.0.send_signal(&name, value_of(value));
    }

    #[napi]
    pub fn cancel(&mut self) {
        self.0.cancel();
    }

    #[napi]
    pub fn resume(&mut self) -> Result<()> {
        self.0.resume().map_err(fake_error)
    }
}
