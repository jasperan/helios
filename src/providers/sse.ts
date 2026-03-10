/**
 * Shared SSE (Server-Sent Events) stream parser.
 * Both Claude and OpenAI providers use SSE framing with identical structure.
 */
export async function* parseSSELines(resp: Response): AsyncGenerator<unknown> {
  const reader = resp.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;

      try {
        yield JSON.parse(data);
      } catch (e) {
        // Skip malformed/partial JSON, re-throw anything else
        if (!(e instanceof SyntaxError)) throw e;
      }
    }
  }
}
