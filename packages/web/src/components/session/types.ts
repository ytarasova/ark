/**
 * Shared types for the session detail subcomponents.
 */

export interface ErrorInfo {
  type: string;
  message?: string;
  stage?: string;
  timestamp?: string;
  detail?: string;
  agent?: string;
}
