export function writeSSE(res, event, data) {
  data = typeof data === "string" ? data : JSON.stringify(data);
  res.write(`event: ${event}\ndata: ${data}\n\n`);
}
