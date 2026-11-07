/** Shared by the API, production shell and Vite's development adapter. */
export function localOriginPolicy(port: number, addresses: string[]) {
  const normalize = (host: string) => host.replace(/^\[|\]$/g, "");
  const hosts = new Set(["localhost", ...addresses.map(normalize)]);
  return (origin: string) => {
    try {
      const url = new URL(origin);
      return url.protocol === "http:" && hosts.has(normalize(url.hostname)) &&
        Number(url.port || 80) === port;
    } catch {
      return false;
    }
  };
}
