/**
 * SSE event assembler for text/event-stream responses (Gemini CLI +
 * Antigravity `streamGenerateContent`). Implements enough of
 * https://html.spec.whatwg.org/multipage/server-sent-events.html to handle
 * multi-line `data:` fields within a single event (spec: concatenate
 * with `\n`), without hauling in a dependency.
 *
 * Usage:
 *   for await (const chunk of iterSseEvents(response.body)) {
 *     const obj = JSON.parse(chunk) as Foo
 *     ...
 *   }
 *
 * The iterator yields the concatenated `data:` payload of each event,
 * stripped of `data:` prefixes. Events containing only `[DONE]` are
 * filtered out. Comment lines (`:...`) and other field names (`event:`,
 * `id:`, `retry:`) are ignored — we only care about the JSON payload.
 */

export async function* iterSseEvents(body: ReadableStream<Uint8Array> | null | undefined): AsyncGenerator<string> {
	if (!body) return
	const reader = body.getReader()
	const decoder = new TextDecoder()
	let buffer = ""
	const dataBuf: string[] = []

	function* flushEvent(): Generator<string> {
		if (dataBuf.length === 0) return
		const payload = dataBuf.join("\n")
		dataBuf.length = 0
		if (payload === "[DONE]") return
		yield payload
	}

	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			buffer += decoder.decode(value, { stream: true })

			// Split off complete lines; keep the trailing partial in buffer.
			let newlineIdx: number
			// biome-ignore lint/suspicious/noAssignInExpressions: idiomatic line-by-line loop
			while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
				let line = buffer.slice(0, newlineIdx)
				buffer = buffer.slice(newlineIdx + 1)
				// Strip trailing \r for CRLF-terminated streams.
				if (line.endsWith("\r")) line = line.slice(0, -1)

				if (line === "") {
					// Blank line ends the current event.
					yield* flushEvent()
					continue
				}
				if (line.startsWith(":")) {
					// SSE comment — ignore.
					continue
				}
				// Field format: "<name>" or "<name>:<value>" or "<name>: <value>".
				// We only care about the `data` field.
				let field: string
				let value: string
				const colonIdx = line.indexOf(":")
				if (colonIdx < 0) {
					field = line
					value = ""
				} else {
					field = line.slice(0, colonIdx)
					value = line.slice(colonIdx + 1)
					// Spec: strip a single leading space after the colon.
					if (value.startsWith(" ")) value = value.slice(1)
				}
				if (field === "data") {
					dataBuf.push(value)
				}
				// Other fields (`event`, `id`, `retry`) are ignored.
			}
		}
		// Flush any final buffered line.
		if (buffer.length > 0) {
			let line = buffer
			if (line.endsWith("\r")) line = line.slice(0, -1)
			if (line !== "" && !line.startsWith(":")) {
				const colonIdx = line.indexOf(":")
				const field = colonIdx < 0 ? line : line.slice(0, colonIdx)
				let value = colonIdx < 0 ? "" : line.slice(colonIdx + 1)
				if (value.startsWith(" ")) value = value.slice(1)
				if (field === "data") dataBuf.push(value)
			}
			buffer = ""
		}
		// Flush final event if the stream ended without a trailing blank line.
		yield* flushEvent()
	} finally {
		reader.releaseLock()
	}
}
