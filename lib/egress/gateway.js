/** Refresh the gateway's cached exit outside the request path. */
export async function gatewayExit(proxy, probe, supervisor) {
  if (!supervisor || !proxy.available) return proxy
  const result = await probe(proxy.url)
  // An unsupported explicit proxy is still an explicit instruction. The
  // transport reports it as an error. Authentication and target refusal can
  // also be destination-specific, so neither result authorizes a direct exit.
  if (result.reachable || result.reason === 'invalid') return { ...proxy, reason: result.reason }
  return { ...proxy, available: false, url: undefined, reason: result.reason }
}
