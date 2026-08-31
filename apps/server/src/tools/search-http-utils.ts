/**
 * Read an HTTP response without allowing a provider to allocate unbounded
 * memory. The same guard is used for hosted and self-hosted search providers.
 */
export class SearchResponseTooLargeError extends Error {
  constructor() {
    super("Web search provider response was too large");
    this.name = "SearchResponseTooLargeError";
  }
}

export async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    if (response.body) void response.body.cancel().catch(() => undefined);
    throw new SearchResponseTooLargeError();
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new SearchResponseTooLargeError();
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new SearchResponseTooLargeError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

