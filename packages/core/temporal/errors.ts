import { ApplicationFailure } from "@temporalio/activity";

export class OrchestratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestratorError";
  }
}

export class ValidationError extends OrchestratorError {
  toFailure() {
    return ApplicationFailure.nonRetryable(this.message, "ValidationError");
  }
}
export class SessionNotFound extends OrchestratorError {
  toFailure() {
    return ApplicationFailure.nonRetryable(this.message, "SessionNotFound");
  }
}
export class StageNotReady extends OrchestratorError {
  toFailure() {
    return ApplicationFailure.nonRetryable(this.message, "StageNotReady");
  }
}
export class TenantQuotaError extends OrchestratorError {
  toFailure() {
    return ApplicationFailure.nonRetryable(this.message, "TenantQuotaError");
  }
}
export class ComputeNotFoundError extends OrchestratorError {
  toFailure() {
    return ApplicationFailure.nonRetryable(this.message, "ComputeNotFoundError");
  }
}
export class DispatchValidationError extends OrchestratorError {
  toFailure() {
    return ApplicationFailure.nonRetryable(this.message, "DispatchValidationError");
  }
}
export class AuthError extends OrchestratorError {
  toFailure() {
    return ApplicationFailure.nonRetryable(this.message, "AuthError");
  }
}

export class TransientOrchestratorError extends OrchestratorError {}
