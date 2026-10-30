import { exec } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { promisify } from 'node:util';
import type { Express } from 'express';
import { connect } from 'node:net';
import type { Server } from 'node:http';

const execAsync = promisify(exec);

/**
 * Formats the player join URL. IPv6 literals get bracket-wrapped so the
 * port separator stays unambiguous.
 */
export function formatJoinUrl(ip: string, port: number): string {
  const host = ip.includes(':') ? `[${ip}]` : ip;
  return `http://${host}:${port}`;
}

const IPV4_RE = /(\d{1,3}(?:\.\d{1,3}){3})/;
const CANDIDATE_LINE_RE = /\binet\b|\bIPv4/i;

/**
 * Extracts the first routable LAN IPv4 address from the raw output of
 * Linux `ip addr`, Linux/macOS `ifconfig`, or Windows `ipconfig`.
 * All three use "inet"/"IPv4" lines, so one unified line scan covers them.
 * Skips loopback (127.x) and link-local (169.254.x) candidates.
 */
export function extractIpv4Address(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    if (!CANDIDATE_LINE_RE.test(line)) continue;
    const match = line.match(IPV4_RE);
    if (!match) continue;
    const [a, b, c, d] = match[1].split('.').map(Number);
    if (a === 127) continue; // loopback
    if (a === 169 && b === 254) continue; // APIPA / link-local
    if ([a, b, c, d].every((n) => n >= 0 && n <= 255)) return match[1];
  }
  return null;
}

const PROBE_TIMEOUT_MS = 2_000;

/**
 * Port self-test: opens a TCP connection to ip:port to verify the server
 * is actually reachable from the network interface (not just bound).
 */
export function isPortReachable(ip: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: ip, port, timeout: PROBE_TIMEOUT_MS });
    const settle = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

/** Shell commands that reveal LAN IPv4 candidates, tried in order per platform. */
const DETECT_COMMANDS: Record<NodeJS.Platform, string[]> = {
  linux: ['ip -4 addr show', 'ifconfig'],
  darwin: ['ifconfig'],
  win32: ['ipconfig'],
  aix: [],
  android: [],
  freebsd: ['ifconfig'],
  haiku: [],
  openbsd: ['ifconfig'],
  sunos: ['ifconfig'],
  cygwin: ['ipconfig'],
  netbsd: ['ifconfig'],
};

/** Fallback when shell detection fails: synthesis from os.networkInterfaces(). */
function detectLanIpFromInterfaces(): string | null {
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal || info.address.startsWith('169.254.')) continue;
      return `synthetic inet ${info.address} netmask`;
    }
  }
  return null;
}

/**
 * Auto-detects the machine's LAN IPv4 on Windows/macOS/Linux.
 * Shell command first (authoritative for "reachable from Wi-Fi"),
 * then os.networkInterfaces() as fallback.
 */
export async function detectLanIp(platform: NodeJS.Platform): Promise<string | null> {
  for (const command of DETECT_COMMANDS[platform] ?? []) {
    try {
      const { stdout } = await execAsync(command, { timeout: 5_000 });
      const ip = extractIpv4Address(stdout);
      if (ip) return ip;
    } catch {
      // command unavailable — fall through to the next command / interface scan
    }
  }
  const synthetic = detectLanIpFromInterfaces();
  return synthetic === null ? null : extractIpv4Address(synthetic);
}

/**
 * Accepts an Express app on the first free port at or above `initialPort`,
 * retrying with port + 1 while the OS reports EADDRINUSE.
 */
export function listenOnFreePort(
  app: Express,
  initialPort: number,
  maxRetries: number,
  onListening: (port: number) => void,
  onError: (err: NodeJS.ErrnoException, port: number) => void,
): Server {
  const tryListen = (port: number): Server => {
    const server = app.listen(port) as Server;
    server.on('listening', () => onListening(port));
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && port < initialPort + maxRetries) {
        server.close(() => tryListen(port + 1));
      } else {
        onError(err, port);
      }
    });
    return server;
  };
  return tryListen(initialPort);
}
