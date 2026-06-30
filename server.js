const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
let Pool = null;

try {
  ({ Pool } = require("pg"));
} catch (error) {
  Pool = null;
}

const PORT = Number(process.env.PORT || 5177);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 5443);
const IS_PRODUCTION = process.env.NODE_ENV === "production" || process.env.RENDER;
const ROOT = path.join(__dirname, "public");
const CERT_PATH = path.join(__dirname, "certs", "screenboard-dev.pfx");
const PRESENTER_PASSWORD = process.env.PRESENTER_PASSWORD || "1234";
const MAX_PRESENTERS = Number(process.env.MAX_PRESENTERS || 2);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const DATABASE_URL = process.env.DATABASE_URL || "";
const rooms = new Map();
const pool = DATABASE_URL && Pool
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }
    })
  : null;
let dbReady = false;
let dbError = pool ? "" : "DATABASE_URL tanimli degil";

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signSession(user) {
  const payload = base64url(JSON.stringify({
    id: user.id,
    email: user.email,
    role: user.role,
    name: user.display_name,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000
  }));
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifySession(token) {
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  if (Buffer.byteLength(sig) !== Buffer.byteLength(expected)) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch (error) {
    return null;
  }
}

function hashUserPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyUserPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const current = hashUserPassword(password, salt).split(":")[1];
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(current));
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase().slice(0, 160);
}

function normalizeReferralCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 32);
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.display_name,
    role: user.role,
    subscriptionStatus: user.subscription_status,
    subscriptionExpiresAt: user.subscription_expires_at
  };
}

function authToken(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

async function query(sql, params = []) {
  if (!pool || !dbReady) throw new Error(dbError || "Veritabani hazir degil");
  return pool.query(sql, params);
}

async function authUser(req) {
  const session = verifySession(authToken(req));
  if (!session) return null;
  const result = await query("select * from users where id = $1", [session.id]);
  return result.rows[0] || null;
}

function hasTeacherAccess(user) {
  if (!user) return false;
  if (user.role === "admin") return true;
  if (user.role !== "teacher") return false;
  if (user.subscription_status !== "active") return false;
  if (!user.subscription_expires_at) return true;
  return new Date(user.subscription_expires_at).getTime() > Date.now();
}

function requireDb(res) {
  if (dbReady) return true;
  json(res, 503, { ok: false, error: dbError || "Veritabani bagli degil" });
  return false;
}

async function initDatabase() {
  if (!pool) return;
  try {
    await pool.query(`
      create table if not exists users (
        id text primary key,
        email text unique not null,
        display_name text not null,
        password_hash text not null,
        role text not null default 'teacher',
        subscription_status text not null default 'active',
        subscription_expires_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create table if not exists referral_codes (
        id text primary key,
        code text unique not null,
        max_uses integer not null default 1,
        used_count integer not null default 0,
        expires_at timestamptz,
        active boolean not null default true,
        created_by text,
        created_at timestamptz not null default now()
      );
    `);
    dbReady = true;
    dbError = "";
    const adminUsername = normalizeEmail(process.env.ADMIN_USERNAME || "admin");
    const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL || `${adminUsername}@dersflow.local`);
    const adminPassword = String(process.env.ADMIN_PASSWORD || "");
    const adminName = normalizeDisplayName(process.env.ADMIN_NAME || "Admin");
    if (adminEmail && adminPassword.length >= 8) {
      await pool.query(`
        insert into users (id, email, display_name, password_hash, role, subscription_status)
        values ($1, $2, $3, $4, 'admin', 'active')
        on conflict (email) do update set
          role = 'admin',
          display_name = excluded.display_name,
          password_hash = excluded.password_hash,
          subscription_status = 'active',
          updated_at = now()
      `, [crypto.randomUUID(), adminEmail, adminName, hashUserPassword(adminPassword)]);
    }
  } catch (error) {
    dbReady = false;
    dbError = error.message;
    console.error("Database init failed:", error.message);
  }
}

async function ensureConfiguredAdmin() {
  const adminUsername = normalizeEmail(process.env.ADMIN_USERNAME || "admin");
  const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL || `${adminUsername}@dersflow.local`);
  const adminPassword = String(process.env.ADMIN_PASSWORD || "");
  const adminName = normalizeDisplayName(process.env.ADMIN_NAME || "Admin");
  if (!adminEmail || adminPassword.length < 8) return null;
  const result = await query(`
    insert into users (id, email, display_name, password_hash, role, subscription_status)
    values ($1, $2, $3, $4, 'admin', 'active')
    on conflict (email) do update set
      role = 'admin',
      display_name = excluded.display_name,
      password_hash = excluded.password_hash,
      subscription_status = 'active',
      updated_at = now()
    returning *
  `, [crypto.randomUUID(), adminEmail, adminName, hashUserPassword(adminPassword)]);
  return result.rows[0] || null;
}

function normalizeDisplayName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 32) || "Misafir";
}

function normalizeTitle(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 64) || "Canli Ders";
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function passwordHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function participantsFor(room) {
  return [...room.clients.entries()].map(([clientId, client]) => ({
    clientId,
    name: client.name || "Misafir",
    role: room.presenters.has(clientId) ? "presenter" : "viewer",
    handRaised: Boolean(client.handRaised),
    joinedAt: client.joinedAt
  })).sort((a, b) => a.joinedAt - b.joinedAt);
}

function cleanupRooms() {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    const isEmpty = room.clients.size === 0;
    const isOld = now - room.updatedAt > 60 * 60 * 1000;
    if (isEmpty && isOld) rooms.delete(roomId);
  }
}

setInterval(cleanupRooms, 10 * 60 * 1000).unref();

function roomFor(id) {
  const key = String(id || "").replace(/[^A-Z0-9-]/gi, "").toUpperCase().slice(0, 16);
  if (!key) return null;
  if (!rooms.has(key)) {
    rooms.set(key, {
      clients: new Map(),
      presenters: new Set(),
      events: [],
      nextSeq: 1,
      board: [],
      questions: [],
      material: null,
      kicked: new Map(),
      drawingLocked: false,
      passwordHash: "",
      title: "Canli Ders",
      presenterId: null,
      updatedAt: Date.now()
    });
  }
  return rooms.get(key);
}

function sendEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function remember(room, payload) {
  const event = { ...payload, seq: room.nextSeq++ };
  room.events.push(event);
  if (room.events.length > 1000) room.events.splice(0, room.events.length - 1000);
  return event;
}

function broadcast(roomId, payload, exceptId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.updatedAt = Date.now();
  const event = remember(room, payload);
  for (const [clientId, client] of room.clients) {
    if (clientId !== exceptId && client.res) sendEvent(client.res, event);
  }
}

function broadcastTransient(roomId, payload, exceptId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.updatedAt = Date.now();
  for (const [clientId, client] of room.clients) {
    if (clientId !== exceptId && client.res) sendEvent(client.res, payload);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 8_000_000) {
        req.destroy();
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function isPresenter(room, clientId) {
  return room.presenters.has(clientId);
}

function serveStatic(req, res) {
  const url = new URL(req.url, `${req.socket.encrypted ? "https" : "http"}://${req.headers.host}`);
  const cleanPath = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
  const filePath = path.normalize(path.join(ROOT, cleanPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".svg": "image/svg+xml"
    };
    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

function handleRequest(req, res) {
  const url = new URL(req.url, `${req.socket.encrypted ? "https" : "http"}://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    json(res, 200, {
      ok: true,
      rooms: rooms.size,
      uptime: Math.round(process.uptime()),
      database: dbReady ? "ready" : "not-ready"
    });
    return undefined;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/register") {
    (async () => {
      try {
        if (!requireDb(res)) return;
        const payload = await readBody(req);
        const adminUsername = normalizeEmail(process.env.ADMIN_USERNAME || "admin");
        const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL || `${adminUsername}@dersflow.local`);
        const loginName = normalizeEmail(payload.email || payload.username);
        const email = loginName === adminUsername ? adminEmail : loginName;
        const name = normalizeDisplayName(payload.name || payload.displayName);
        const password = String(payload.password || "");
        const code = normalizeReferralCode(payload.referralCode);
        if (!email || !email.includes("@")) {
          json(res, 400, { ok: false, error: "Gecerli e-posta gerekli" });
          return;
        }
        if (password.length < 8) {
          json(res, 400, { ok: false, error: "Sifre en az 8 karakter olmali" });
          return;
        }
        if (!code) {
          json(res, 400, { ok: false, error: "Referans kodu gerekli" });
          return;
        }
        const client = await pool.connect();
        try {
          await client.query("begin");
          const codeResult = await client.query("select * from referral_codes where code = $1 for update", [code]);
          const referral = codeResult.rows[0];
          const now = Date.now();
          if (!referral || !referral.active) throw new Error("Referans kodu gecersiz");
          if (referral.used_count >= referral.max_uses) throw new Error("Referans kodu kullanildi");
          if (referral.expires_at && new Date(referral.expires_at).getTime() < now) throw new Error("Referans kodunun suresi dolmus");
          const existing = await client.query("select id from users where email = $1", [email]);
          if (existing.rows[0]) throw new Error("Bu e-posta zaten kayitli");
          const id = crypto.randomUUID();
          const expiresAt = new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();
          const userResult = await client.query(`
            insert into users (id, email, display_name, password_hash, role, subscription_status, subscription_expires_at)
            values ($1, $2, $3, $4, 'teacher', 'active', $5)
            returning *
          `, [id, email, name, hashUserPassword(password), expiresAt]);
          await client.query("update referral_codes set used_count = used_count + 1 where id = $1", [referral.id]);
          await client.query("commit");
          const user = userResult.rows[0];
          json(res, 200, { ok: true, user: publicUser(user), token: signSession(user) });
        } catch (error) {
          await client.query("rollback");
          json(res, 400, { ok: false, error: error.message });
        } finally {
          client.release();
        }
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
      }
    })();
    return undefined;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    (async () => {
      try {
        if (!requireDb(res)) return;
        const payload = await readBody(req);
        const adminUsername = normalizeEmail(process.env.ADMIN_USERNAME || "admin");
        const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL || `${adminUsername}@dersflow.local`);
        const loginName = normalizeEmail(payload.email || payload.username);
        const email = loginName === adminUsername ? adminEmail : loginName;
        const password = String(payload.password || "");
        let result = await query("select * from users where email = $1", [email]);
        let user = result.rows[0];
        if (!user && loginName === adminUsername && password === String(process.env.ADMIN_PASSWORD || "")) {
          user = await ensureConfiguredAdmin();
        }
        if (!user || !verifyUserPassword(password, user.password_hash)) {
          json(res, 403, { ok: false, error: "E-posta veya sifre hatali" });
          return;
        }
        json(res, 200, { ok: true, user: publicUser(user), token: signSession(user) });
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
      }
    })();
    return undefined;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/me") {
    (async () => {
      try {
        if (!requireDb(res)) return;
        const user = await authUser(req);
        if (!user) {
          json(res, 401, { ok: false, error: "Oturum bulunamadi" });
          return;
        }
        json(res, 200, { ok: true, user: publicUser(user) });
      } catch (error) {
        json(res, 401, { ok: false, error: "Oturum gecersiz" });
      }
    })();
    return undefined;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/metrics") {
    (async () => {
      try {
        if (!requireDb(res)) return;
        const user = await authUser(req);
        if (!user || user.role !== "admin") {
          json(res, 403, { ok: false, error: "Admin yetkisi gerekli" });
          return;
        }
        const memory = process.memoryUsage();
        const activeRooms = [...rooms.entries()].map(([roomId, room]) => ({
          roomId,
          title: room.title,
          participants: room.clients.size,
          presenters: room.presenters.size,
          boardItems: room.board.length,
          questions: room.questions.length,
          updatedAt: room.updatedAt
        }));
        const users = await query("select count(*)::int as total from users");
        const teachers = await query("select count(*)::int as total from users where role = 'teacher'");
        json(res, 200, {
          ok: true,
          database: dbReady ? "ready" : "not-ready",
          uptime: Math.round(process.uptime()),
          memory: {
            rss: memory.rss,
            heapUsed: memory.heapUsed,
            heapTotal: memory.heapTotal
          },
          activeRoomCount: rooms.size,
          activeRooms,
          userCount: users.rows[0].total,
          teacherCount: teachers.rows[0].total,
          render: {
            note: "Render CPU/RAM/bandwidth icin kesin limit takibi Render Dashboard uzerinden gorulur; burasi uygulama ici canli yuk ozetidir."
          }
        });
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
      }
    })();
    return undefined;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/referral-codes") {
    (async () => {
      try {
        if (!requireDb(res)) return;
        const user = await authUser(req);
        if (!user || user.role !== "admin") {
          json(res, 403, { ok: false, error: "Admin yetkisi gerekli" });
          return;
        }
        const result = await query(`
          select id, code, max_uses, used_count, expires_at, active, created_at
          from referral_codes
          order by created_at desc
          limit 100
        `);
        json(res, 200, { ok: true, codes: result.rows });
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
      }
    })();
    return undefined;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/referral-codes") {
    (async () => {
      try {
        if (!requireDb(res)) return;
        const user = await authUser(req);
        if (!user || user.role !== "admin") {
          json(res, 403, { ok: false, error: "Admin yetkisi gerekli" });
          return;
        }
        const payload = await readBody(req);
        const code = normalizeReferralCode(payload.code) || crypto.randomBytes(4).toString("hex").toUpperCase();
        const maxUses = Math.max(1, Math.min(500, Number(payload.maxUses || 1)));
        const days = Math.max(1, Math.min(365, Number(payload.days || 30)));
        const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
        const result = await query(`
          insert into referral_codes (id, code, max_uses, expires_at, active, created_by)
          values ($1, $2, $3, $4, true, $5)
          returning id, code, max_uses, used_count, expires_at, active, created_at
        `, [crypto.randomUUID(), code, maxUses, expiresAt, user.id]);
        json(res, 200, { ok: true, code: result.rows[0] });
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
      }
    })();
    return undefined;
  }

  const referralPatchMatch = url.pathname.match(/^\/api\/admin\/referral-codes\/([^/]+)$/i);
  if (req.method === "PATCH" && referralPatchMatch) {
    (async () => {
      try {
        if (!requireDb(res)) return;
        const user = await authUser(req);
        if (!user || user.role !== "admin") {
          json(res, 403, { ok: false, error: "Admin yetkisi gerekli" });
          return;
        }
        const payload = await readBody(req);
        const active = Boolean(payload.active);
        const result = await query(`
          update referral_codes set active = $1 where id = $2
          returning id, code, max_uses, used_count, expires_at, active, created_at
        `, [active, referralPatchMatch[1]]);
        json(res, 200, { ok: true, code: result.rows[0] || null });
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
      }
    })();
    return undefined;
  }

  if (req.method === "POST" && url.pathname === "/api/rooms") {
    (async () => {
      try {
        if (!requireDb(res)) return;
        const user = await authUser(req);
        if (!hasTeacherAccess(user)) {
          json(res, 403, { ok: false, error: "Oda olusturmak icin aktif egitmen hesabi gerekli" });
          return;
        }
        const payload = await readBody(req);
        const clientId = String(payload.clientId || "");
        const password = String(payload.password || "");
        const name = normalizeDisplayName(payload.displayName || payload.name);
        const title = normalizeTitle(payload.title);
        if (!clientId) {
          json(res, 400, { ok: false, error: "Eksik cihaz kimligi" });
          return;
        }
        if (password.length < 4) {
          json(res, 400, { ok: false, error: "Oda sifresi en az 4 karakter olmali" });
          return;
        }
        const id = crypto.randomBytes(3).toString("hex").toUpperCase();
        const room = roomFor(id);
        room.passwordHash = passwordHash(password);
        room.title = title;
        room.clients.set(clientId, { role: "presenter", name, joinedAt: Date.now() });
        room.presenters.add(clientId);
        room.presenterId = clientId;
        json(res, 200, {
          ok: true,
          roomId: id,
          title: room.title,
          role: "presenter",
          drawingLocked: room.drawingLocked,
          presenterId: room.presenterId,
          presenterCount: room.presenters.size,
          maxPresenters: MAX_PRESENTERS,
          participants: participantsFor(room),
          questions: room.questions,
          material: room.material,
          board: room.board,
          cursor: room.nextSeq - 1
        });
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
      }
    })();
    return undefined;
  }

  const joinMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9-]+)\/join$/i);
  if (req.method === "POST" && joinMatch) {
    (async () => {
      try {
        const roomId = joinMatch[1].toUpperCase();
        const room = rooms.get(roomId);
        if (!room) {
          json(res, 404, { ok: false, error: "Oda bulunamadi" });
          return;
        }
        const payload = await readBody(req);
        const clientId = String(payload.clientId || "");
        const requestedRole = payload.role === "presenter" ? "presenter" : "viewer";
        const role = room.presenterId ? requestedRole : "presenter";
        const password = String(payload.password || "");
        const name = normalizeDisplayName(payload.displayName || payload.name);

        if (!clientId) {
          json(res, 400, { ok: false, error: "Eksik cihaz kimligi" });
          return;
        }
        if (room.passwordHash && passwordHash(password) !== room.passwordHash) {
          json(res, 403, { ok: false, error: "Oda sifresi hatali" });
          return;
        }
        if (!room.passwordHash && role === "presenter" && password !== PRESENTER_PASSWORD) {
          json(res, 403, { ok: false, error: "Sunucu sifresi hatali" });
          return;
        }
        if (role === "presenter" && !room.presenters.has(clientId) && room.presenters.size >= MAX_PRESENTERS) {
          json(res, 409, { ok: false, error: "Sunucu limiti dolu" });
          return;
        }
        room.clients.set(clientId, {
          ...(room.clients.get(clientId) || {}),
          role,
          name,
          joinedAt: room.clients.get(clientId)?.joinedAt || Date.now()
        });
        if (role === "presenter") {
          room.presenters.add(clientId);
          if (!room.presenterId) room.presenterId = clientId;
        }
        const participantList = participantsFor(room);
        broadcast(roomId, {
          type: "presence",
          action: "join",
          clientId,
          name,
          role,
          title: room.title,
          presenterId: room.presenterId,
          presenterCount: room.presenters.size,
          maxPresenters: MAX_PRESENTERS,
          participants: participantList,
          drawingLocked: room.drawingLocked
        }, clientId);

        json(res, 200, {
          ok: true,
          role,
          title: room.title,
          drawingLocked: room.drawingLocked,
          presenterId: room.presenterId,
          presenterCount: room.presenters.size,
          maxPresenters: MAX_PRESENTERS,
          participants: participantList,
          questions: room.questions,
          material: room.material,
          board: room.board,
          cursor: room.nextSeq - 1
        });
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
      }
    })();
    return undefined;
  }

  const eventMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9-]+)\/events$/i);
  if (req.method === "GET" && eventMatch) {
    const roomId = eventMatch[1].toUpperCase();
    const clientId = url.searchParams.get("clientId") || crypto.randomUUID();
    const role = url.searchParams.get("role") === "presenter" ? "presenter" : "viewer";
    const password = url.searchParams.get("password") || "";
    const room = rooms.get(roomId);

    if (!room) {
      json(res, 404, { ok: false, error: "Oda bulunamadi" });
      return undefined;
    }

    if (role === "presenter" && password !== PRESENTER_PASSWORD) {
      json(res, 403, { ok: false, error: "Sunucu sifresi hatali" });
      return undefined;
    }
    if (role === "presenter" && !room.presenters.has(clientId) && room.presenters.size >= MAX_PRESENTERS) {
      json(res, 409, { ok: false, error: "Sunucu limiti dolu" });
      return undefined;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write(": connected\n\n");

    room.clients.set(clientId, { res, role, joinedAt: Date.now() });
    if (role === "presenter") {
      room.presenters.add(clientId);
      if (!room.presenterId) room.presenterId = clientId;
    }

    sendEvent(res, {
      type: "snapshot",
      clientId,
      roomId,
      title: room.title,
      presenterId: room.presenterId,
      presenterCount: room.presenters.size,
      maxPresenters: MAX_PRESENTERS,
      participants: participantsFor(room),
      questions: room.questions,
      material: room.material,
      drawingLocked: room.drawingLocked,
      board: room.board
    });
    broadcast(roomId, {
      type: "presence",
      action: "join",
      clientId,
      role,
      title: room.title,
      presenterId: room.presenterId,
      presenterCount: room.presenters.size,
      maxPresenters: MAX_PRESENTERS,
      participants: participantsFor(room),
      drawingLocked: room.drawingLocked
    }, clientId);

    const heartbeat = setInterval(() => res.write(": ping\n\n"), 20000);
    req.on("close", () => {
      clearInterval(heartbeat);
      const activeRoom = rooms.get(roomId);
      if (!activeRoom) return;
      const activeClient = activeRoom.clients.get(clientId);
      if (activeClient && activeClient.res && activeClient.res !== res) return;
      activeRoom.clients.delete(clientId);
      if (role === "presenter") activeRoom.presenters.delete(clientId);
      if (activeRoom.presenterId === clientId) activeRoom.presenterId = null;
      if (!activeRoom.presenterId) {
        activeRoom.presenterId = [...activeRoom.presenters][0] || null;
      }
      broadcast(roomId, {
        type: "presence",
        action: "leave",
        clientId,
        role,
        title: activeRoom.title,
        presenterId: activeRoom.presenterId,
        presenterCount: activeRoom.presenters.size,
        maxPresenters: MAX_PRESENTERS,
        participants: participantsFor(activeRoom),
        drawingLocked: activeRoom.drawingLocked
      });
    });
    return undefined;
  }

  const pollMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9-]+)\/poll$/i);
  if (req.method === "GET" && pollMatch) {
    const roomId = pollMatch[1].toUpperCase();
    const room = rooms.get(roomId);
    const clientId = url.searchParams.get("clientId") || "";
    const after = Number(url.searchParams.get("after") || 0);
    if (!room) {
      json(res, 404, { ok: false, error: "Oda bulunamadi" });
      return undefined;
    }
    const client = room.clients.get(clientId);

    if (!client) {
      if (room.kicked.has(clientId)) {
        json(res, 403, { ok: false, error: "Odadan cikarildin" });
        return undefined;
      }
      json(res, 403, { ok: false, error: "Once odaya katil" });
      return undefined;
    }

    const events = room.events.filter(event => event.seq > after && event.from !== clientId);
    json(res, 200, {
      ok: true,
      cursor: room.nextSeq - 1,
      title: room.title,
      drawingLocked: room.drawingLocked,
      presenterId: room.presenterId,
      presenterCount: room.presenters.size,
      maxPresenters: MAX_PRESENTERS,
      participants: participantsFor(room),
      questions: room.questions,
      material: room.material,
      events
    });
    return undefined;
  }

  const closeMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9-]+)$/i);
  if (req.method === "DELETE" && closeMatch) {
    (async () => {
      try {
        const roomId = closeMatch[1].toUpperCase();
        const room = rooms.get(roomId);
        if (!room) {
          json(res, 404, { ok: false, error: "Oda bulunamadi" });
          return;
        }
        const payload = await readBody(req);
        const clientId = String(payload.clientId || "");
        if (!isPresenter(room, clientId)) {
          json(res, 403, { ok: false, error: "Bu islem sadece sunucu icin" });
          return;
        }
        broadcast(roomId, {
          type: "room-closed",
          from: clientId,
          roomId,
          title: room.title,
          sentAt: Date.now()
        });
        rooms.delete(roomId);
        json(res, 200, { ok: true });
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
      }
    })();
    return undefined;
  }

  const messageMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9-]+)\/messages$/i);
  if (req.method === "POST" && messageMatch) {
    (async () => {
      try {
      const roomId = messageMatch[1].toUpperCase();
      const room = rooms.get(roomId);
      if (!room) {
        json(res, 404, { ok: false, error: "Oda bulunamadi" });
        return;
      }
      const payload = await readBody(req);
      const sender = room.clients.get(payload.from);
      const senderIsPresenter = Boolean(sender && isPresenter(room, payload.from));
      const message = {
        ...payload,
        roomId,
        sentAt: Date.now()
      };

      if (message.type === "board-lock") {
        if (!senderIsPresenter) {
          json(res, 403, { ok: false, error: "Bu islem sadece sunucu icin" });
          return;
        }
        room.drawingLocked = Boolean(message.locked);
        broadcast(roomId, {
          type: "board-lock",
          from: payload.from,
          role: "presenter",
          roomId,
          locked: room.drawingLocked,
          sentAt: Date.now()
        });
        json(res, 200, { ok: true, drawingLocked: room.drawingLocked });
        return;
      }

      if (message.type === "hand-raise") {
        if (!sender) {
          json(res, 403, { ok: false, error: "Once odaya katil" });
          return;
        }
        sender.handRaised = Boolean(message.raised);
        broadcast(roomId, {
          type: "presence",
          action: "update",
          clientId: payload.from,
          role: sender.role,
          title: room.title,
          presenterId: room.presenterId,
          presenterCount: room.presenters.size,
          maxPresenters: MAX_PRESENTERS,
          participants: participantsFor(room),
          drawingLocked: room.drawingLocked,
          sentAt: Date.now()
        });
        json(res, 200, { ok: true, participants: participantsFor(room) });
        return;
      }

      if (message.type === "question") {
        if (!sender) {
          json(res, 403, { ok: false, error: "Once odaya katil" });
          return;
        }
        const text = String(message.text || "").trim().replace(/\s+/g, " ").slice(0, 240);
        if (!text) {
          json(res, 400, { ok: false, error: "Soru bos olamaz" });
          return;
        }
        const question = {
          id: crypto.randomUUID(),
          from: payload.from,
          name: sender.name || "Misafir",
          text,
          answered: false,
          createdAt: Date.now()
        };
        room.questions.push(question);
        if (room.questions.length > 50) room.questions.splice(0, room.questions.length - 50);
        broadcast(roomId, {
          type: "questions",
          from: payload.from,
          roomId,
          questions: room.questions,
          sentAt: Date.now()
        });
        json(res, 200, { ok: true, questions: room.questions });
        return;
      }

      if (message.type === "question-clear") {
        if (!senderIsPresenter) {
          json(res, 403, { ok: false, error: "Bu islem sadece sunucu icin" });
          return;
        }
        room.questions = [];
        broadcast(roomId, {
          type: "questions",
          from: payload.from,
          roomId,
          questions: room.questions,
          sentAt: Date.now()
        });
        json(res, 200, { ok: true, questions: room.questions });
        return;
      }

      if (message.type === "participant-kick") {
        if (!senderIsPresenter) {
          json(res, 403, { ok: false, error: "Bu islem sadece sunucu icin" });
          return;
        }
        const targetId = String(message.clientId || "");
        if (!targetId || targetId === payload.from || !room.clients.has(targetId)) {
          json(res, 400, { ok: false, error: "Katilimci bulunamadi" });
          return;
        }
        room.clients.delete(targetId);
        room.presenters.delete(targetId);
        room.kicked.set(targetId, Date.now());
        broadcast(roomId, {
          type: "participant-kicked",
          from: payload.from,
          to: targetId,
          roomId,
          sentAt: Date.now()
        });
        broadcast(roomId, {
          type: "presence",
          action: "leave",
          clientId: targetId,
          title: room.title,
          presenterId: room.presenterId,
          presenterCount: room.presenters.size,
          maxPresenters: MAX_PRESENTERS,
          participants: participantsFor(room),
          drawingLocked: room.drawingLocked,
          sentAt: Date.now()
        });
        json(res, 200, { ok: true, participants: participantsFor(room) });
        return;
      }

      if (message.type === "material-set") {
        if (!senderIsPresenter) {
          json(res, 403, { ok: false, error: "Bu islem sadece sunucu icin" });
          return;
        }
        const material = message.material || {};
        const type = material.type === "pdf" ? "pdf" : material.type === "image" ? "image" : "";
        const dataUrl = String(material.dataUrl || "");
        if (!type || !dataUrl.startsWith("data:")) {
          json(res, 400, { ok: false, error: "Materyal okunamadi" });
          return;
        }
        room.material = {
          type,
          name: String(material.name || "Materyal").slice(0, 80),
          dataUrl,
          scale: clampNumber(material.scale, 40, 160, 100),
          page: Math.round(clampNumber(material.page, 1, 9999, 1)),
          updatedAt: Date.now()
        };
        broadcast(roomId, {
          type: "material",
          from: payload.from,
          roomId,
          material: room.material,
          sentAt: Date.now()
        });
        json(res, 200, { ok: true, material: room.material });
        return;
      }

      if (message.type === "material-update") {
        if (!senderIsPresenter) {
          json(res, 403, { ok: false, error: "Bu islem sadece sunucu icin" });
          return;
        }
        if (!room.material) {
          json(res, 404, { ok: false, error: "Materyal yok" });
          return;
        }
        const options = message.options || {};
        if (room.material.type === "image" && options.scale !== undefined) {
          room.material.scale = clampNumber(options.scale, 40, 160, room.material.scale || 100);
        }
        if (room.material.type === "pdf" && options.page !== undefined) {
          room.material.page = Math.round(clampNumber(options.page, 1, 9999, room.material.page || 1));
        }
        room.material.updatedAt = Date.now();
        broadcast(roomId, {
          type: "material",
          from: payload.from,
          roomId,
          material: room.material,
          sentAt: Date.now()
        });
        json(res, 200, { ok: true, material: room.material });
        return;
      }

      if (message.type === "material-clear") {
        if (!senderIsPresenter) {
          json(res, 403, { ok: false, error: "Bu islem sadece sunucu icin" });
          return;
        }
        room.material = null;
        broadcast(roomId, {
          type: "material",
          from: payload.from,
          roomId,
          material: null,
          sentAt: Date.now()
        });
        json(res, 200, { ok: true, material: null });
        return;
      }

      if (message.type === "laser") {
        broadcastTransient(roomId, message, payload.from);
        json(res, 200, { ok: true });
        return;
      }

      if (message.type === "board-stroke" && message.stroke) {
        if (room.drawingLocked && !senderIsPresenter) {
          json(res, 403, { ok: false, error: "Izleyici cizimi kapali" });
          return;
        }
        room.board.push(message.stroke);
        if (room.board.length > 5000) room.board.splice(0, room.board.length - 5000);
      }
      if (message.type === "board-clear") {
        if (!senderIsPresenter) {
          json(res, 403, { ok: false, error: "Bu islem sadece sunucu icin" });
          return;
        }
        room.board = [];
      }
      if (message.type === "board-undo" && message.strokeId) {
        if (room.drawingLocked && !senderIsPresenter) {
          json(res, 403, { ok: false, error: "Izleyici cizimi kapali" });
          return;
        }
        room.board = room.board.filter(stroke => stroke.id !== message.strokeId);
      }

      broadcast(roomId, message);
      json(res, 200, { ok: true });
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
    })();
    return undefined;
  }

  serveStatic(req, res);
  return undefined;
}

const server = http.createServer(handleRequest);

initDatabase();

server.listen(PORT, "0.0.0.0", () => {
  const addresses = [];
  const nets = require("os").networkInterfaces();
  for (const values of Object.values(nets)) {
    for (const net of values || []) {
      if (net.family === "IPv4" && !net.internal) addresses.push(`http://${net.address}:${PORT}`);
    }
  }
  console.log(`Live classroom server is running at http://localhost:${PORT}`);
  for (const address of addresses) console.log(`LAN: ${address}`);
});

if (!IS_PRODUCTION && fs.existsSync(CERT_PATH)) {
  const secureServer = https.createServer({
    pfx: fs.readFileSync(CERT_PATH),
    passphrase: process.env.CERT_PASSPHRASE || ""
  }, handleRequest);

  secureServer.listen(HTTPS_PORT, "0.0.0.0", () => {
    const addresses = [];
    const nets = require("os").networkInterfaces();
    for (const values of Object.values(nets)) {
      for (const net of values || []) {
        if (net.family === "IPv4" && !net.internal) addresses.push(`https://${net.address}:${HTTPS_PORT}`);
      }
    }
    console.log(`Secure live classroom server is running at https://localhost:${HTTPS_PORT}`);
    for (const address of addresses) console.log(`Secure LAN: ${address}`);
  });
} else {
  console.log(IS_PRODUCTION
    ? "Local HTTPS disabled in production; Render provides public HTTPS."
    : "HTTPS disabled: run scripts\\create-dev-cert.ps1 to create certs\\screenboard-dev.pfx");
}
