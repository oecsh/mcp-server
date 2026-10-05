// API key handling. The key is a secret the customer lent us for this process
// (stdio) or this one request (HTTP): it is checked here, sent only in the
// Authorization header to the configured API, and scrubbed from anything we
// print or return.

export type KeyTier = "read_only" | "full_access";

// Same prefixes the public API accepts (see the Authentication page of the API
// docs). The body is a url-safe token, 43 characters today; the bounds are
// loose on purpose so a future longer token still passes.
const KEY_RE = /^oec_live_(ro|rw)_[A-Za-z0-9_-]{20,200}$/;

// Anything shaped like a key, so a key pasted into a tool argument or echoed
// by an upstream error is scrubbed too, not only the configured one.
const KEY_LIKE_RE = /oec_live_r[ow]_[A-Za-z0-9_-]+/g;

export class KeyError extends Error {
  override name = "KeyError";
}

/** Checks the key format and returns its tier, without ever echoing the key. */
export function checkApiKey(apiKey: string | undefined | null): KeyTier {
  if (!apiKey) {
    throw new KeyError(
      "No oec.sh API key was given. Create one in the oec.sh dashboard under Settings > API Keys " +
        "(a read-only key is enough for the read tools).",
    );
  }
  const match = KEY_RE.exec(apiKey.trim());
  if (!match) {
    throw new KeyError(
      "The oec.sh API key has the wrong format: it must start with oec_live_ro_ (read only) " +
        "or oec_live_rw_ (full access). Copy it again from Settings > API Keys.",
    );
  }
  return match[1] === "rw" ? "full_access" : "read_only";
}

/** Scrubs the given secrets (the API key, the hosted proxy secret) and anything key-shaped. */
export function redactSecrets(text: string, ...secrets: (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length > 0) out = out.split(secret).join("[redacted]");
  }
  return out.replace(KEY_LIKE_RE, "[redacted]");
}
