import { BlockList, isIP } from "node:net";

type InterfaceAddress = { name: string; address: string; cidr: string | null };
type Ip = { address: string; family: "ipv4" | "ipv6" };

function parseIp(raw: string): Ip | null {
  // Scoped IPv6 requires an interface scope that URL and socket adapters do not
  // consistently retain. Deny it instead of guessing.
  if (raw.includes("%")) return null;
  const value = raw.replace(/^\[|\]$/g, "");
  if (isIP(value) === 4) return { address: value, family: "ipv4" };
  if (isIP(value) !== 6) return null;
  const address = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/.exec(address);
  if (mapped) {
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
    return {
      address: `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`,
      family: "ipv4",
    };
  }
  return { address, family: "ipv6" };
}

const invalid = new BlockList();
invalid.addSubnet("0.0.0.0", 8, "ipv4");
invalid.addSubnet("127.0.0.0", 8, "ipv4");
invalid.addSubnet("224.0.0.0", 4, "ipv4");
invalid.addAddress("255.255.255.255", "ipv4");
invalid.addAddress("::", "ipv6");
invalid.addAddress("::1", "ipv6");
// Socket adapters can omit the scope on link-local peers, so the interface
// cannot be distinguished reliably from another interface's fe80::/10.
invalid.addSubnet("fe80::", 10, "ipv6");
invalid.addSubnet("ff00::", 8, "ipv6");

/** Evaluate the actual socket peer against current, explicitly selected interfaces. */
export function createLanPolicy(
  names: string[],
  interfaces: () => InterfaceAddress[],
) {
  const selected = new Set(names);
  return (peerAddress: string, targetHost: string): boolean => {
    const peer = parseIp(peerAddress), target = parseIp(targetHost);
    if (
      !peer || !target || peer.family !== target.family ||
      invalid.check(peer.address, peer.family) ||
      invalid.check(target.address, target.family)
    ) return false;
    try {
      return interfaces().some((item) => {
        if (!selected.has(item.name) || !item.cidr) return false;
        const local = parseIp(item.address);
        const [networkText, prefixText, extra] = item.cidr.split("/");
        const network = parseIp(networkText), prefix = Number(prefixText);
        if (
          !local || !network || local.family !== target.family ||
          local.address !== target.address ||
          network.address !== local.address ||
          network.family !== local.family || extra !== undefined ||
          !/^\d+$/.test(prefixText ?? "") || !Number.isInteger(prefix) ||
          prefix < 1 || prefix > (local.family === "ipv4" ? 32 : 128)
        ) return false;
        const subnet = new BlockList();
        subnet.addSubnet(network.address, prefix, network.family);
        return subnet.check(peer.address, peer.family);
      });
    } catch {
      return false;
    }
  };
}
