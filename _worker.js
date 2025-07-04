import { connect } from 'cloudflare:sockets';

let 转码 = 'vl', 转码2 = 'ess', 符号 = '://';

let ENV_CACHE = null;

// ✅ 第⑤项优化：提前缓存 TextDecoder 实例
const decoder = new TextDecoder();

function 读取环境变量(name, fallback, env) {
  const raw = import.meta?.env?.[name] ?? env?.[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (trimmed.includes('\n')) {
      return trimmed.split('\n').map(item => item.trim()).filter(Boolean);
    }
    if (!isNaN(trimmed) && trimmed !== '') return Number(trimmed);
    return trimmed;
  }
  return raw;
}

function 初始化配置(env) {
  if (ENV_CACHE) return ENV_CACHE;
  ENV_CACHE = {
    ID: 读取环境变量('ID', '242222', env),
    UUID: 读取环境变量('UUID', 'd26432c5-a84b-47c3-aaf8-b949f326efb3', env),
    IP: 读取环境变量('IP', ['104.16.160.145'], env),
    TXT: 读取环境变量('TXT', [], env),
    PROXYIP: 读取环境变量('PROXYIP', 'sjc.o00o.ooo:443', env),
    启用反代功能: 读取环境变量('启用反代功能', true, env),
    NAT64: 读取环境变量('NAT64', false, env),
    我的节点名字: 读取环境变量('我的节点名字', '狂暴', env),
  };
  return ENV_CACHE;
}

function convertToNAT64IPv6(ipv4) {
  const parts = ipv4.split('.');
  if (parts.length !== 4) throw new Error('无效的IPv4地址');
  const hex = parts.map(p => Number(p).toString(16).padStart(2, '0'));
  return `2001:67c:2960:6464::${hex[0]}${hex[1]}:${hex[2]}${hex[3]}`;
}

async function getIPv6ProxyAddress(domain) {
  const r = await fetch(`https://1.1.1.1/dns-query?name=${domain}&type=A`, {
    headers: { 'Accept': 'application/dns-json' }
  });
  const j = await r.json();
  const a = j.Answer?.find(x => x.type === 1);
  if (!a) throw new Error('无法解析域名的IPv4地址');
  return convertToNAT64IPv6(a.data);
}

export default {
  async fetch(访问请求, env) {
    const cfg = 初始化配置(env);
    const 升级标头 = 访问请求.headers.get('Upgrade');
    const url = new URL(访问请求.url);

    if (!升级标头 || 升级标头 !== 'websocket') {
      switch (url.pathname) {
        case `/${cfg.ID}`:
          return new Response(给我订阅页面(cfg.ID, 访问请求.headers.get('Host')), {
            status: 200, headers: { "Content-Type": "text/plain;charset=utf-8" }
          });
        case `/${cfg.ID}/${转码}${转码2}`:
          return new Response(给我通用配置文件(访问请求.headers.get('Host'), cfg), {
            status: 200, headers: { "Content-Type": "text/plain;charset=utf-8" }
          });
        default:
          return new Response('Hello World!', { status: 200 });
      }
    } else {
      const enc = 访问请求.headers.get('sec-websocket-protocol');
      const data = 使用64位加解密(enc);
      if (验证VL的密钥(new Uint8Array(data.slice(1, 17))) !== cfg.UUID) {
        return new Response('无效的UUID', { status: 403 });
      }
      try {
        const { tcpSocket, initialData } = await 解析VL标头(data, cfg);
        const [client, server] = new WebSocketPair();
        server.accept();
        传输数据管道(server, tcpSocket, initialData);
        return new Response(null, { status: 101, webSocket: client });
      } catch (e) {
        return new Response(`连接目标失败: ${e.message}`, { status: 502 });
      }
    }
  }
};

function 使用64位加解密(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(str), c => c.charCodeAt(0)).buffer;
}

async function 解析VL标头(buf, cfg) {
  const b = new DataView(buf), c = new Uint8Array(buf);
  const addrTypeIndex = c[17];
  const port = b.getUint16(18 + addrTypeIndex + 1);
  let offset = 18 + addrTypeIndex + 4;
  let host;

  if (c[offset - 1] === 1) {
    host = Array.from(c.slice(offset, offset + 4)).join('.');
    offset += 4;
  } else if (c[offset - 1] === 2) {
    const len = c[offset];
    host = decoder.decode(c.slice(offset + 1, offset + 1 + len));  // ✅ 使用缓存 decoder
    offset += len + 1;
  } else {
    host = Array(8).fill().map((_, i) => b.getUint16(offset + 2 * i).toString(16)).join(':');
    offset += 16;
  }

  const initialData = buf.slice(offset);

  try {
    const sock = await connect({ hostname: host, port });
    await sock.opened;
    return { tcpSocket: sock, initialData };
  } catch {}

  if (cfg.NAT64) {
    try {
      let natTarget;
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        natTarget = convertToNAT64IPv6(host);
      } else if (host.includes(':')) {
        throw new Error('IPv6 地址无需 NAT64');
      } else {
        natTarget = await getIPv6ProxyAddress(host);
      }
      const sock = await connect({ hostname: natTarget.replace(/^\[|\]$/g, ''), port });
      await sock.opened;
      return { tcpSocket: sock, initialData };
    } catch {}
  }

  if (cfg.启用反代功能 && cfg.PROXYIP) {
    const [代理主机, 代理端口] = cfg.PROXYIP.split(':');
    const portNum = Number(代理端口) || port;
    const sock = await connect({ hostname: 代理主机, port: portNum });
    await sock.opened;
    return { tcpSocket: sock, initialData };
  }

  throw new Error('连接失败，目标不可达');
}

// ✅ 第⑦⑧项优化合并：pipeTo + Blob 高效处理
async function 传输数据管道(ws, tcp, init) {
  const writer = tcp.writable.getWriter();
  ws.send(new Uint8Array([0, 0]));
  if (init) await writer.write(init);

  tcp.readable.pipeTo(new WritableStream({
    write(chunk) {
      ws.send(chunk);
    },
    close() {
      try { ws.close(); } catch {}
    },
    abort() {
      try { ws.close(); } catch {}
    }
  })).catch(() => {
    try { ws.close(); } catch {}
  });

  ws.addEventListener('message', async evt => {
    try {
      let chunk = evt.data;
      if (chunk instanceof Blob) {
        chunk = new Uint8Array(await chunk.arrayBuffer());  // ✅ 避免多次 decode
      } else if (chunk instanceof ArrayBuffer) {
        chunk = new Uint8Array(chunk);
      } else if (typeof chunk === 'string') {
        chunk = new TextEncoder().encode(chunk);
      }
      await writer.write(chunk);
    } catch {
      try { ws.close(); } catch {}
    }
  });

  ws.addEventListener('close', () => {
    writer.releaseLock();
    tcp.close();
  });
}

function 验证VL的密钥(a) {
  const hex = Array.from(a, v => v.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function 给我订阅页面(ID, host) {
  return `订阅地址: https${符号}${host}/${ID}/${转码}${转码2}`;
}

function 给我通用配置文件(host, cfg) {
  const ips = cfg.IP.concat([`${host}:443`]);
  return ips.map(item => {
    const [main, tls] = item.split("@");
    const [addrPort, name = cfg.我的节点名字] = main.split("#");
    const parts = addrPort.split(":");
    const port = parts.length > 1 ? Number(parts.pop()) : 443;
    const addr = parts.join(":");
    const tlsOpt = tls === 'notls' ? 'security=none' : 'security=tls';
    return `${转码}${转码2}${符号}${cfg.UUID}@${addr}:${port}?encryption=none&${tlsOpt}&sni=${host}&type=ws&host=${host}&path=%2F%3Fed%3D2560#${name}`;
  }).join("\n");
}
