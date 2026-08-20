/**
 * Winnie上岸吧 - 后端服务
 * 零依赖 Node.js 服务（仅用内置 http/https/crypto/fs）
 * 功能：托管HTML、AI代理、账号注册登录、云端同步
 */

var http = require("http");
var https = require("https");
var crypto = require("crypto");
var fs = require("fs");
var path = require("path");

var PORT = process.env.PORT || 3000;
var AI_API_KEY = process.env.AI_API_KEY || "";
var AI_API_BASE = process.env.AI_API_BASE || "https://api.deepseek.com/v1";
var AI_MODEL = process.env.AI_MODEL || "deepseek-chat";
var TOKEN_TTL = 60 * 24 * 60 * 60 * 1000; // 60 days

var DATA_DIR = path.join(__dirname, "data");
var USERS_DIR = path.join(DATA_DIR, "users");
var TOKENS_FILE = path.join(DATA_DIR, "tokens.json");

// Ensure directories exist
function ensureDirs() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(e) {}
  try { fs.mkdirSync(USERS_DIR, { recursive: true }); } catch(e) {}
}
ensureDirs();

// ============ Helpers ============
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function readJSON(filePath, defaultVal) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch(e) {
    return defaultVal;
  }
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function getUserFile(username) {
  return path.join(USERS_DIR, username + ".json");
}

function getTokens() {
  return readJSON(TOKENS_FILE, {});
}

function saveTokens(tokens) {
  writeJSON(TOKENS_FILE, tokens);
}

function parseBody(req) {
  return new Promise(function(resolve, reject) {
    var body = "";
    req.on("data", function(chunk) { body += chunk; });
    req.on("end", function() {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch(e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  });
  res.end(JSON.stringify(data));
}

function authenticate(req) {
  var auth = req.headers["authorization"] || "";
  var token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  var tokens = getTokens();
  var entry = tokens[token];
  if (!entry) return null;
  if (Date.now() - entry.created > TOKEN_TTL) {
    delete tokens[token];
    saveTokens(tokens);
    return null;
  }
  return entry.username;
}

// ============ Routes ============
async function handleRequest(req, res) {
  var url = new URL(req.url, "http://localhost:" + PORT);
  var pathname = url.pathname;
  var method = req.method;

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    });
    res.end();
    return;
  }

  // Health check
  if (pathname === "/api/health" && method === "GET") {
    sendJSON(res, 200, {
      proxy: !!AI_API_KEY,
      sync: true,
      model: AI_MODEL,
      hasKey: !!AI_API_KEY
    });
    return;
  }

  // AI Simplify proxy
  if (pathname === "/api/simplify" && method === "POST") {
    if (!AI_API_KEY) {
      sendJSON(res, 503, { error: "AI proxy not configured" });
      return;
    }
    try {
      var body = await parseBody(req);
      if (!body.text) {
        sendJSON(res, 400, { error: "text is required" });
        return;
      }

      var apiBody = JSON.stringify({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: "你是一位公考备考助手。请将以下经验贴原文提炼为不超过12条重点要点，每条简洁明了一句话。直接返回JSON数组格式，如 [\"要点1\",\"要点2\"]，不要包含其他文字。"
          },
          { role: "user", content: body.text }
        ],
        temperature: 0.3,
        max_tokens: 800
      });

      var apiRes = await new Promise(function(resolve, reject) {
        var apiURL = new URL(AI_API_BASE + "/chat/completions");
        var apiReq = https.request({
          hostname: apiURL.hostname,
          port: apiURL.port || 443,
          path: apiURL.pathname + apiURL.search,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + AI_API_KEY
          }
        }, function(r) {
          var data = "";
          r.on("data", function(chunk) { data += chunk; });
          r.on("end", function() {
            try { resolve(JSON.parse(data)); }
            catch(e) { reject(new Error("AI API response parse error")); }
          });
        });
        apiReq.on("error", reject);
        apiReq.write(apiBody);
        apiReq.end();
      });

      if (apiRes.error) {
        sendJSON(res, 502, { error: apiRes.error.message || "AI API error" });
        return;
      }

      var content = apiRes.choices && apiRes.choices[0] && apiRes.choices[0].message && apiRes.choices[0].message.content;
      if (!content) {
        sendJSON(res, 502, { error: "Empty AI response" });
        return;
      }

      // Try to parse JSON array from content
      var points;
      var match = content.match(/\[[\s\S]*?\]/);
      if (match) {
        try { points = JSON.parse(match[0]); }
        catch(e) {
          points = content.split("\n").map(function(l) {
            return l.replace(/^\d+[.、)]\s*/, "").replace(/^["'""]/, "").replace(/["'""]$/, "").trim();
          }).filter(function(l) { return l.length > 3; }).slice(0, 12);
        }
      } else {
        points = content.split("\n").map(function(l) {
          return l.replace(/^\d+[.、)]\s*/, "").replace(/^["'""]/, "").replace(/["'""]$/, "").trim();
        }).filter(function(l) { return l.length > 3; }).slice(0, 12);
      }

      sendJSON(res, 200, { points: points });
    } catch(e) {
      sendJSON(res, 500, { error: e.message || "Internal error" });
    }
    return;
  }

  // Auth: Register
  if (pathname === "/api/auth/register" && method === "POST") {
    try {
      var body = await parseBody(req);
      var username = (body.username || "").trim();
      var password = body.password || "";
      if (!username || !password) {
        sendJSON(res, 400, { error: "用户名和密码必填" });
        return;
      }
      if (username.length < 2 || username.length > 30) {
        sendJSON(res, 400, { error: "用户名长度2-30" });
        return;
      }
      if (password.length < 4) {
        sendJSON(res, 400, { error: "密码至少4位" });
        return;
      }

      var userFile = getUserFile(username);
      if (fs.existsSync(userFile)) {
        sendJSON(res, 409, { error: "用户名已存在" });
        return;
      }

      var salt = crypto.randomBytes(16).toString("hex");
      var hash = hashPassword(password, salt);
      var user = { username: username, salt: salt, hash: hash, data: null, updatedAt: 0 };
      writeJSON(userFile, user);

      // Issue token
      var token = generateToken();
      var tokens = getTokens();
      tokens[token] = { username: username, created: Date.now() };
      saveTokens(tokens);

      sendJSON(res, 200, { token: token, username: username });
    } catch(e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // Auth: Login
  if (pathname === "/api/auth/login" && method === "POST") {
    try {
      var body = await parseBody(req);
      var username = (body.username || "").trim();
      var password = body.password || "";
      if (!username || !password) {
        sendJSON(res, 400, { error: "用户名和密码必填" });
        return;
      }

      var userFile = getUserFile(username);
      if (!fs.existsSync(userFile)) {
        sendJSON(res, 401, { error: "用户名或密码错误" });
        return;
      }

      var user = readJSON(userFile, null);
      var hash = hashPassword(password, user.salt);
      if (hash !== user.hash) {
        sendJSON(res, 401, { error: "用户名或密码错误" });
        return;
      }

      var token = generateToken();
      var tokens = getTokens();
      tokens[token] = { username: username, created: Date.now() };
      saveTokens(tokens);

      sendJSON(res, 200, { token: token, username: username });
    } catch(e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // Auth: Logout
  if (pathname === "/api/auth/logout" && method === "POST") {
    var authHeader = req.headers["authorization"] || "";
    var token = authHeader.replace(/^Bearer\s+/i, "");
    if (token) {
      var tokens = getTokens();
      delete tokens[token];
      saveTokens(tokens);
    }
    sendJSON(res, 200, { ok: true });
    return;
  }

  // Sync: GET
  if (pathname === "/api/sync" && method === "GET") {
    var username = authenticate(req);
    if (!username) {
      sendJSON(res, 401, { error: "未登录或令牌已过期" });
      return;
    }
    var userFile = getUserFile(username);
    var user = readJSON(userFile, { data: null, updatedAt: 0 });
    sendJSON(res, 200, { data: user.data, updatedAt: user.updatedAt || 0 });
    return;
  }

  // Sync: POST
  if (pathname === "/api/sync" && method === "POST") {
    var username = authenticate(req);
    if (!username) {
      sendJSON(res, 401, { error: "未登录或令牌已过期" });
      return;
    }
    try {
      var body = await parseBody(req);
      var userFile = getUserFile(username);
      var user = readJSON(userFile, { username: username, salt: "", hash: "", data: null, updatedAt: 0 });

      // Last-write-wins
      if (body.updatedAt && user.updatedAt && body.updatedAt < user.updatedAt) {
        sendJSON(res, 409, { error: "云端数据较新，已采用云端版本", data: user.data, updatedAt: user.updatedAt });
        return;
      }

      user.data = body.data;
      user.updatedAt = body.updatedAt || Date.now();
      writeJSON(userFile, user);
      sendJSON(res, 200, { ok: true, updatedAt: user.updatedAt });
    } catch(e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // Serve static files
  if (method === "GET") {
    var filePath = pathname === "/" ? "/index.html" : pathname;
    var fullPath = path.join(__dirname, filePath);
    // Prevent directory traversal
    if (!fullPath.startsWith(__dirname)) {
      sendJSON(res, 403, { error: "Forbidden" });
      return;
    }
    var ext = path.extname(fullPath);
    var mimeTypes = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon"
    };
    try {
      var stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        var content = fs.readFileSync(fullPath);
        res.writeHead(200, {
          "Content-Type": mimeTypes[ext] || "application/octet-stream",
          "Cache-Control": "no-cache"
        });
        res.end(content);
        return;
      }
    } catch(e) {}
  }

  // 404
  sendJSON(res, 404, { error: "Not found" });
}

// ============ Start Server ============
var server = http.createServer(handleRequest);
server.listen(PORT, function() {
  console.log("🎀 Winnie上岸吧 server running on port " + PORT);
  console.log("  AI Proxy: " + (AI_API_KEY ? "✅ enabled" : "❌ disabled (set AI_API_KEY)"));
  console.log("  Sync: ✅ enabled");
});
