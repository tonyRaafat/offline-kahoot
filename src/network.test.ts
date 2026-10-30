import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extractIpv4Address, formatJoinUrl, isPortReachable, listenOnFreePort } from './network.js';

describe('formatJoinUrl', () => {
  it('formats ip and port as "http://<ip>:<port>"', () => {
    expect(formatJoinUrl('192.168.1.5', 3000)).toBe('http://192.168.1.5:3000');
  });

  it('formats a changed port', () => {
    expect(formatJoinUrl('10.0.0.2', 3001)).toBe('http://10.0.0.2:3001');
  });

  it('wraps IPv6 addresses in brackets', () => {
    expect(formatJoinUrl('fe80::1', 3000)).toBe('http://[fe80::1]:3000');
  });
});

describe('extractIpv4Address', () => {
  it('parses Linux "ip addr" output, skipping loopback', () => {
    const output = `
1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536
    inet 127.0.0.1/8 scope host lo
    inet6 ::1/128 scope host
2: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500
    inet 192.168.1.5/24 brd 192.168.1.255 scope global dynamic wlan0
    inet6 fe80::1/64 scope link
`;
    expect(extractIpv4Address(output)).toBe('192.168.1.5');
  });

  it('parses macOS ifconfig output, skipping link-local', () => {
    const output = `
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
	inet 169.254.23.23 netmask 0xffff0000 broadcast 169.254.255.255
	inet 192.168.0.42 netmask 0xffffff00 broadcast 192.168.0.255
`;
    expect(extractIpv4Address(output)).toBe('192.168.0.42');
  });

  it('parses Windows ipconfig output, skipping loopback', () => {
    const output = `
Ethernet adapter Ethernet:

   IPv4 Address. . . . . . . . . . . : 172.20.10.4
   Subnet Mask . . . . . . . . . . . : 255.255.255.240
   IPv6 Address. . . . : fe80::1
`;
    expect(extractIpv4Address(output)).toBe('172.20.10.4');
  });

  it('returns null when no routable IPv4 candidate exists', () => {
    expect(extractIpv4Address('inet 127.0.0.1/8 scope host lo')).toBeNull();
    expect(extractIpv4Address('')).toBeNull();
    expect(extractIpv4Address('garbage text')).toBeNull();
  });

  it('accepts the linux-ifconfig result format (drop-in same as linux-ip)', () => {
    const output = `
lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
	inet 127.0.0.1 netmask 0xff000000
en0: flags=8863<UP> mtu 1500
	inet 192.168.1.20 netmask 0xffffff00 broadcast 192.168.1.255
`;
    expect(extractIpv4Address(output)).toBe('192.168.1.20');
  });
});

describe('isPortReachable', () => {
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server) server.close(() => resolve());
      else resolve();
    });
    server = undefined;
  });

  it('reports reachable for a listening port', async () => {
    server = createServer(() => {});
    const listening = new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    await listening;
    const { port } = server.address() as AddressInfo;
    await expect(isPortReachable('127.0.0.1', port)).resolves.toBe(true);
  });

  it('reports unreachable for a closed port', async () => {
    await expect(isPortReachable('127.0.0.1', 1)).resolves.toBe(false);
  });
});

describe('listenOnFreePort', () => {
  const closables: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      closables.splice(0).map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
  });

  it('falls back to the next port when the initial one reports EADDRINUSE', async () => {
    const blocker = createServer(() => {});
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const busyPort = (blocker.address() as AddressInfo).port;
    closables.push(blocker);

    const server = createServer(() => {});
    closables.push(server);
    const listening = new Promise<number>((resolve, reject) =>
      listenOnFreePort(
        server,
        busyPort,
        3,
        (port) => resolve(port),
        (err) => reject(err),
      ),
    );

    await expect(listening).resolves.toBe(busyPort + 1);
  });

  it('gives up after maxRetries and reports the error with the last tried port', async () => {
    const blockerA = createServer(() => {});
    await new Promise<void>((resolve) => blockerA.listen(0, '127.0.0.1', resolve));
    const busyPort = (blockerA.address() as AddressInfo).port;
    const blockerB = createServer(() => {});
    await new Promise<void>((resolve) => blockerB.listen(busyPort + 1, '127.0.0.1', resolve));
    closables.push(blockerA, blockerB);

    const server = createServer(() => {});
    closables.push(server);
    let reportError: ((err: NodeJS.ErrnoException) => void) | undefined;
    const failed = new Promise<NodeJS.ErrnoException & { reportedPort?: number }>(
      (resolve) => (reportError = resolve),
    );
    listenOnFreePort(
      server,
      busyPort,
      1,
      () => {
        throw new Error('must not report listening while both ports are busy');
      },
      (err, port) => reportError?.(Object.assign(err, { reportedPort: port })),
    );

    const err = await failed;
    expect(err.code).toBe('EADDRINUSE');
    expect(err.reportedPort).toBe(busyPort + 1);
  });
});
