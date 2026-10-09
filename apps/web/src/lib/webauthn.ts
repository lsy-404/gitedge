import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnError,
} from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

export { browserSupportsWebAuthn };

/** True when the failure is the person dismissing or timing out the browser prompt. */
export function passkeyPromptCancelled(cause: unknown): boolean {
  return (
    (cause instanceof WebAuthnError && cause.code === "ERROR_CEREMONY_ABORTED") ||
    (cause instanceof DOMException &&
      (cause.name === "NotAllowedError" || cause.name === "AbortError"))
  );
}

export function promptPasskeyRegistration(optionsJSON: PublicKeyCredentialCreationOptionsJSON) {
  return startRegistration({ optionsJSON });
}

export function promptPasskeyAuthentication(optionsJSON: PublicKeyCredentialRequestOptionsJSON) {
  return startAuthentication({ optionsJSON });
}
