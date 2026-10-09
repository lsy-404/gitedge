import { ApiError, errorMessage, type Translate } from "./api";

/** Localizes a failed security action; an expired confirmation window gets its own message. */
export function securityErrorMessage(
  cause: unknown,
  t: Translate,
  overrides: Partial<Record<number, string>> = {}
): string {
  if (cause instanceof ApiError && cause.code === "reauth_required") return t("reauthRequired");
  if (cause instanceof ApiError && cause.code === "invalid_code") return t("securityCodeInvalid");
  return errorMessage(cause, t, overrides);
}
