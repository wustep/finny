export const statusLabels = {
  active: "Active",
  error: "Needs attention",
  pending_expiration: "Expiring soon",
} as const;

// Plaid's error codes in the words of someone who just wants their bank to
// work again. Anything not listed falls back to naming the code.
export const errorExplanations: Record<string, string> = {
  ITEM_LOGIN_REQUIRED: "Your bank needs you to sign in again.",
  INVALID_CREDENTIALS: "The sign-in details your bank has on file no longer work.",
  INVALID_MFA: "The security code your bank asked for didn't go through.",
  INVALID_UPDATED_USERNAME: "Your username at the bank changed.",
  ITEM_LOCKED: "Your bank has locked the account. Sign in at your bank to unlock it, then reconnect here.",
  USER_PERMISSION_REVOKED: "Access to this bank was revoked, so it stopped sharing data.",
  ACCESS_NOT_GRANTED: "You didn't grant Finny access to this bank.",
  USER_INPUT_TIMEOUT: "The last reconnect timed out before it finished.",
  ITEM_NOT_SUPPORTED: "Your bank no longer supports this kind of connection.",
  INSUFFICIENT_CREDENTIALS: "Your bank is asking for more than the saved credentials.",
  INSTITUTION_DOWN: "Your bank is down. This usually clears on its own.",
  INSTITUTION_NOT_RESPONDING: "Your bank isn't responding. This usually clears on its own.",
  INSTITUTION_NO_LONGER_SUPPORTED: "This bank is no longer supported.",
};

export function connectionAlert(input: {
  status: keyof typeof statusLabels;
  errorCode?: string;
}): {
  title: string;
  detail: string;
  nextStep: string;
  button: string;
} {
  if (input.status === "pending_expiration") {
    return {
      title: "Bank login needed soon",
      detail:
        "Your bank shares data for a fixed stretch and this one is nearly up.",
      nextStep: "Reconnect now — sign in at the bank if it asks.",
      button: "Reconnect",
    };
  }
  return {
    title: "This connection stopped working",
    detail: input.errorCode
      ? (errorExplanations[input.errorCode] ??
        `Your bank reported ${input.errorCode}.`)
      : "Your bank stopped sharing data with Finny.",
    nextStep: "Reconnect to start syncing again.",
    button: "Reconnect",
  };
}
