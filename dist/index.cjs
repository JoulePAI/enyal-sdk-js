var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// local_knowledge.js
var local_knowledge_exports = {};
__export(local_knowledge_exports, {
  LocalKnowledgeGraph: () => LocalKnowledgeGraph
});
var import_better_sqlite3, import_node_crypto, import_node_path, import_node_os, import_node_fs, SUFFIXES, LocalKnowledgeGraph;
var init_local_knowledge = __esm({
  "local_knowledge.js"() {
    import_better_sqlite3 = __toESM(require("better-sqlite3"), 1);
    import_node_crypto = __toESM(require("node:crypto"), 1);
    import_node_path = __toESM(require("node:path"), 1);
    import_node_os = __toESM(require("node:os"), 1);
    import_node_fs = __toESM(require("node:fs"), 1);
    SUFFIXES = [" ltd", " inc", " gmbh", " limited", " corp"];
    LocalKnowledgeGraph = class {
      /**
       * @param {string} [dbPath] — defaults to ~/.enyal/knowledge.db
       */
      constructor(dbPath) {
        this.dbPath = dbPath || import_node_path.default.join(import_node_os.default.homedir(), ".enyal", "knowledge.db");
        import_node_fs.default.mkdirSync(import_node_path.default.dirname(this.dbPath), { recursive: true });
        try {
          this.db = new import_better_sqlite3.default(this.dbPath);
          this.db.pragma("journal_mode = WAL");
          this._initTables();
        } catch (err) {
          if (err.code === "SQLITE_CORRUPT" || err.code === "SQLITE_NOTADB") {
            import_node_fs.default.renameSync(this.dbPath, `${this.dbPath}.corrupt.${Date.now()}`);
            this.db = new import_better_sqlite3.default(this.dbPath);
            this.db.pragma("journal_mode = WAL");
            this._initTables();
          } else {
            throw err;
          }
        }
      }
      _initTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS nodes (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                node_type TEXT NOT NULL,
                summary TEXT,
                properties TEXT DEFAULT '{}',
                name_hash TEXT,
                chunk_ids TEXT DEFAULT '[]',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS edges (
                id TEXT PRIMARY KEY,
                source_node_id TEXT NOT NULL,
                target_node_id TEXT NOT NULL,
                relationship TEXT NOT NULL,
                evidence TEXT,
                valid_from TEXT DEFAULT CURRENT_TIMESTAMP,
                valid_to TEXT,
                FOREIGN KEY (source_node_id) REFERENCES nodes(id),
                FOREIGN KEY (target_node_id) REFERENCES nodes(id),
                UNIQUE(source_node_id, target_node_id, relationship)
            );
            CREATE TABLE IF NOT EXISTS log (
                id TEXT PRIMARY KEY,
                action TEXT NOT NULL,
                details TEXT DEFAULT '{}',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_nodes_hash
                ON nodes(name_hash);
            CREATE INDEX IF NOT EXISTS idx_nodes_type
                ON nodes(node_type);
            CREATE INDEX IF NOT EXISTS idx_edges_source
                ON edges(source_node_id);
            CREATE INDEX IF NOT EXISTS idx_edges_target
                ON edges(target_node_id);
        `);
      }
      // === REMEMBER (local storage) ===
      /**
       * Store a fact locally. Free, private, instant.
       * @param {string} name
       * @param {string} [nodeType='entity']
       * @param {string|null} [summary]
       * @param {Object|null} [properties]
       * @returns {string} node ID
       */
      remember(name, nodeType = "entity", summary = null, properties = null) {
        const nameHash = this._hash(name);
        let nodeId = import_node_crypto.default.randomUUID();
        const existing = this.db.prepare(
          "SELECT id, properties FROM nodes WHERE name_hash = ?"
        ).get(nameHash);
        if (existing) {
          const oldProps = JSON.parse(existing.properties);
          const newProps = properties || {};
          const contradictions = this._detectContradictions(
            name,
            oldProps,
            newProps
          );
          const mergedProps = { ...oldProps, ...newProps };
          this.db.prepare(
            "UPDATE nodes SET summary=?, properties=?, updated_at=CURRENT_TIMESTAMP WHERE id=?"
          ).run(summary, JSON.stringify(mergedProps), existing.id);
          nodeId = existing.id;
          for (const c of contradictions) {
            this._createEdge(nodeId, nodeId, "contradicts", c);
          }
        } else {
          this.db.prepare(
            "INSERT INTO nodes (id, name, node_type, summary, properties, name_hash) VALUES (?,?,?,?,?,?)"
          ).run(
            nodeId,
            name,
            nodeType,
            summary,
            JSON.stringify(properties || {}),
            nameHash
          );
        }
        this._log("remember", { name, type: nodeType });
        return nodeId;
      }
      // === RECALL (local search) ===
      /**
       * Search local knowledge. Free, instant.
       * @param {string} query
       * @param {number} [limit=10]
       * @returns {Array<{id, name, node_type, summary, properties}>}
       */
      recall(query, limit = 10) {
        const escaped = query.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
        const rows = this.db.prepare(
          "SELECT id, name, node_type, summary, properties FROM nodes WHERE name LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?"
        ).all(`%${escaped}%`, `%${escaped}%`, limit);
        return rows.map((r) => ({
          id: r.id,
          name: r.name,
          node_type: r.node_type,
          summary: r.summary,
          properties: JSON.parse(r.properties)
        }));
      }
      // === GRAPH OPERATIONS ===
      /**
       * Traverse local graph N hops from a node.
       * @param {string} nodeId
       * @param {number} [hops=2]
       */
      connections(nodeId, hops = 2) {
        const visited = /* @__PURE__ */ new Set();
        let current = /* @__PURE__ */ new Set([nodeId]);
        const seenEdgeIds = /* @__PURE__ */ new Set();
        const allNodes = [];
        const allEdges = [];
        const edgeStmt = this.db.prepare(
          "SELECT id, source_node_id, target_node_id, relationship, evidence FROM edges WHERE source_node_id = ? OR target_node_id = ?"
        );
        for (let hop = 0; hop < hops; hop++) {
          const nextLevel = /* @__PURE__ */ new Set();
          for (const nid of current) {
            if (visited.has(nid)) continue;
            visited.add(nid);
            const edges = edgeStmt.all(nid, nid);
            for (const e of edges) {
              if (!seenEdgeIds.has(e.id)) {
                seenEdgeIds.add(e.id);
                allEdges.push({
                  id: e.id,
                  source: e.source_node_id,
                  target: e.target_node_id,
                  relationship: e.relationship,
                  evidence: e.evidence
                });
              }
              const other = e.source_node_id === nid ? e.target_node_id : e.source_node_id;
              nextLevel.add(other);
            }
          }
          current = new Set([...nextLevel].filter((x) => !visited.has(x)));
        }
        const nodeStmt = this.db.prepare(
          "SELECT id, name, node_type, summary FROM nodes WHERE id = ?"
        );
        for (const nid of visited) {
          const node = nodeStmt.get(nid);
          if (node) {
            allNodes.push({
              id: node.id,
              name: node.name,
              node_type: node.node_type,
              summary: node.summary
            });
          }
        }
        return { nodes: allNodes, edges: allEdges };
      }
      /**
       * List all contradictions in local graph.
       */
      contradictions() {
        const rows = this.db.prepare(
          "SELECT e.id, e.source_node_id, e.evidence, n.name FROM edges e JOIN nodes n ON e.source_node_id = n.id WHERE e.relationship = 'contradicts'"
        ).all();
        return rows.map((e) => ({
          id: e.id,
          node_id: e.source_node_id,
          evidence: e.evidence,
          node_name: e.name
        }));
      }
      /**
       * Knowledge base health check.
       */
      health() {
        const totalNodes = this.db.prepare("SELECT count(*) as c FROM nodes").get().c;
        const totalEdges = this.db.prepare("SELECT count(*) as c FROM edges").get().c;
        const contradictionCount = this.db.prepare(
          "SELECT count(*) as c FROM edges WHERE relationship = 'contradicts'"
        ).get().c;
        const orphans = this.db.prepare(
          "SELECT count(*) as c FROM nodes n WHERE NOT EXISTS (SELECT 1 FROM edges e WHERE e.source_node_id = n.id OR e.target_node_id = n.id)"
        ).get().c;
        let status = "healthy";
        if (contradictionCount > 5 || orphans > 10) {
          status = "unhealthy";
        } else if (contradictionCount > 0 || orphans > 3) {
          status = "needs_attention";
        }
        return {
          status,
          total_nodes: totalNodes,
          total_edges: totalEdges,
          contradictions: contradictionCount,
          orphan_nodes: orphans
        };
      }
      /**
       * Grouped overview of entire knowledge base.
       */
      index() {
        const rows = this.db.prepare(
          "SELECT n.id, n.name, n.node_type, n.summary, COUNT(e.id) as connections FROM nodes n LEFT JOIN (SELECT id, source_node_id as nid FROM edges UNION ALL SELECT id, target_node_id FROM edges) e ON e.nid = n.id GROUP BY n.id ORDER BY connections DESC"
        ).all();
        const grouped = {};
        for (const r of rows) {
          if (!grouped[r.node_type]) grouped[r.node_type] = [];
          grouped[r.node_type].push({
            id: r.id,
            name: r.name,
            summary: r.summary,
            connections: r.connections
          });
        }
        return grouped;
      }
      /**
       * Layered loading for agent context.
       * @param {number} [depth=1]
       * @param {string|null} [topic]
       */
      context(depth = 1, topic = null) {
        if (depth === 0) {
          return {
            layer: 0,
            total_nodes: this.db.prepare("SELECT count(*) as c FROM nodes").get().c,
            total_edges: this.db.prepare("SELECT count(*) as c FROM edges").get().c,
            top_entities: this.db.prepare(
              "SELECT name FROM nodes ORDER BY updated_at DESC LIMIT 5"
            ).all().map((r) => r.name)
          };
        }
        const result = this.context(0);
        result.layer = depth;
        if (depth >= 1) {
          result.top_nodes = this.db.prepare(
            "SELECT n.name, n.node_type, n.summary, COUNT(e.id) as cnt FROM nodes n LEFT JOIN (SELECT id, source_node_id as nid FROM edges UNION ALL SELECT id, target_node_id FROM edges) e ON e.nid = n.id GROUP BY n.id ORDER BY cnt DESC LIMIT 10"
          ).all();
          result.contradictions = this.contradictions();
        }
        if (depth >= 2 && topic) {
          result.topic_nodes = this.recall(topic, 50);
        }
        if (depth >= 3) {
          result.all_nodes = this.db.prepare(
            "SELECT id, name, node_type, summary FROM nodes"
          ).all();
        }
        return result;
      }
      /**
       * Compact format for agent context loading.
       * @param {number} [depth=1]
       * @param {string|null} [topic]
       * @returns {string}
       */
      compact(depth = 1, topic = null) {
        const ctx = this.context(depth, topic);
        const lines = [];
        if (ctx.top_nodes) {
          for (const n of ctx.top_nodes) {
            const prefix = n.node_type ? n.node_type[0].toUpperCase() : "?";
            lines.push(`${prefix}:${n.name}|${n.summary || ""}|${n.cnt}c`);
          }
        }
        for (const c of ctx.contradictions || []) {
          lines.push(`!${c.node_name}:${c.evidence}`);
        }
        return lines.join("\n");
      }
      /**
       * Create a relationship between two nodes.
       */
      relate(sourceId, targetId, relationship, evidence = null) {
        this._createEdge(sourceId, targetId, relationship, evidence);
      }
      /**
       * Remove a node and its edges from local graph.
       * @param {string} nodeId
       * @returns {boolean} true if node existed and was deleted
       */
      forget(nodeId) {
        this.db.prepare(
          "DELETE FROM edges WHERE source_node_id = ? OR target_node_id = ?"
        ).run(nodeId, nodeId);
        const result = this.db.prepare(
          "DELETE FROM nodes WHERE id = ?"
        ).run(nodeId);
        this._log("forget", { node_id: nodeId });
        return result.changes > 0;
      }
      /**
       * Close the database connection. Call when done.
       */
      close() {
        if (this.db) {
          this.db.close();
          this.db = null;
        }
      }
      // === INTERNAL ===
      /**
       * Hash entity name for dedup. Same algorithm as Python SDK.
       * Lowercase first, then strip corporate suffixes in order.
       */
      _hash(name) {
        let normalised = name.toLowerCase().trim();
        for (const suffix of SUFFIXES) {
          if (normalised.endsWith(suffix)) {
            normalised = normalised.slice(0, -suffix.length).trim();
          }
        }
        return import_node_crypto.default.createHash("sha256").update(normalised).digest("hex");
      }
      _detectContradictions(name, oldProps, newProps) {
        const contradictions = [];
        const oldKeys = new Set(Object.keys(oldProps));
        for (const key of Object.keys(newProps)) {
          if (oldKeys.has(key) && oldProps[key] !== newProps[key]) {
            contradictions.push(
              `${key}: was ${oldProps[key]}, now ${newProps[key]}`
            );
          }
        }
        return contradictions;
      }
      _createEdge(source, target, relationship, evidence = null) {
        try {
          this.db.prepare(
            "INSERT OR IGNORE INTO edges (id, source_node_id, target_node_id, relationship, evidence) VALUES (?,?,?,?,?)"
          ).run(import_node_crypto.default.randomUUID(), source, target, relationship, evidence);
        } catch (e) {
          if (e.code === "SQLITE_CONSTRAINT_UNIQUE" || e.code === "SQLITE_CONSTRAINT") {
          } else {
            this._log("edge_error", { error: e.message });
          }
        }
      }
      _log(action, details) {
        this.db.prepare(
          "INSERT INTO log (id, action, details) VALUES (?,?,?)"
        ).run(import_node_crypto.default.randomUUID(), action, JSON.stringify(details));
      }
      /**
       * Parse any timestamp format to comparable Date.
       */
      _normaliseTs(tsString) {
        if (!tsString) return /* @__PURE__ */ new Date(0);
        const d = new Date(tsString);
        return isNaN(d.getTime()) ? /* @__PURE__ */ new Date(0) : d;
      }
    };
  }
});

// index.js
var index_exports = {};
__export(index_exports, {
  EnyalAgent: () => EnyalAgent,
  LocalKnowledgeGraph: () => LocalKnowledgeGraph,
  aesGcmDecrypt: () => aesGcmDecrypt,
  archive: () => archive,
  bytesToHex: () => bytesToHex,
  combineSharesAndDecrypt: () => combineSharesAndDecrypt,
  complianceAttest: () => complianceAttest,
  createAgreement: () => createAgreement,
  decompressP256: () => decompressP256,
  decryptCustodialShare: () => decryptCustodialShare,
  disclose: () => disclose,
  getContradictions: () => getContradictions,
  getInbox: () => getInbox,
  getKnowledgeConnections: () => getKnowledgeConnections,
  getKnowledgeHealth: () => getKnowledgeHealth,
  getKnowledgeIndex: () => getKnowledgeIndex,
  getKnowledgeNode: () => getKnowledgeNode,
  getKnowledgeNodes: () => getKnowledgeNodes,
  getKnowledgeStats: () => getKnowledgeStats,
  getLineage: () => getLineage,
  getThread: () => getThread,
  hexToBytes: () => hexToBytes,
  markRead: () => markRead,
  memoryKDF: () => memoryKDF,
  prove: () => prove,
  requestClientDisclosure: () => requestClientDisclosure,
  requestShareProof: () => requestShareProof,
  search: () => search,
  sendMessage: () => sendMessage,
  shamirCombine: () => shamirCombine,
  synthesiseKnowledge: () => synthesiseKnowledge,
  timestamp: () => timestamp,
  verifyAgreement: () => verifyAgreement,
  verifyShareCombination: () => verifyShareCombination
});
module.exports = __toCommonJS(index_exports);

// enyal_agent.js
init_local_knowledge();
var import_node_crypto2 = __toESM(require("node:crypto"), 1);

// enyal-client.js
var enyal_client_exports = {};
__export(enyal_client_exports, {
  aesGcmDecrypt: () => aesGcmDecrypt,
  archive: () => archive,
  bytesToHex: () => bytesToHex,
  combineSharesAndDecrypt: () => combineSharesAndDecrypt,
  complianceAttest: () => complianceAttest,
  createAgreement: () => createAgreement,
  decompressP256: () => decompressP256,
  decryptCustodialShare: () => decryptCustodialShare,
  disclose: () => disclose,
  getContradictions: () => getContradictions,
  getInbox: () => getInbox,
  getKnowledgeConnections: () => getKnowledgeConnections,
  getKnowledgeHealth: () => getKnowledgeHealth,
  getKnowledgeIndex: () => getKnowledgeIndex,
  getKnowledgeNode: () => getKnowledgeNode,
  getKnowledgeNodes: () => getKnowledgeNodes,
  getKnowledgeStats: () => getKnowledgeStats,
  getLineage: () => getLineage,
  getThread: () => getThread,
  hexToBytes: () => hexToBytes,
  markRead: () => markRead,
  memoryKDF: () => memoryKDF,
  prove: () => prove,
  requestClientDisclosure: () => requestClientDisclosure,
  requestShareProof: () => requestShareProof,
  search: () => search,
  sendMessage: () => sendMessage,
  shamirCombine: () => shamirCombine,
  synthesiseKnowledge: () => synthesiseKnowledge,
  timestamp: () => timestamp,
  verifyAgreement: () => verifyAgreement,
  verifyShareCombination: () => verifyShareCombination
});
var GF256_EXP = new Uint8Array(512);
var GF256_LOG = new Uint8Array(256);
(function initGF256() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF256_EXP[i] = x;
    GF256_LOG[x] = i;
    let hi = x << 1;
    if (hi & 256) hi ^= 283;
    x = hi ^ x;
  }
  for (let i = 255; i < 512; i++) {
    GF256_EXP[i] = GF256_EXP[i - 255];
  }
})();
function gf256Mul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF256_EXP[(GF256_LOG[a] + GF256_LOG[b]) % 255];
}
function gf256Inv(a) {
  if (a === 0) throw new Error("Zero has no inverse in GF(256)");
  return GF256_EXP[255 - GF256_LOG[a]];
}
function shamirCombine(share1, share2) {
  if (share1.length !== 33 || share2.length !== 33) {
    throw new Error("Share combination failed \u2014 each share must be 33 bytes");
  }
  const x1 = share1[0], x2 = share2[0];
  if (x1 === 0 || x2 === 0 || x1 === x2) {
    throw new Error("Share combination failed \u2014 invalid share indices");
  }
  const d = x1 ^ x2;
  const dInv = gf256Inv(d);
  const secret = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    const y1 = share1[1 + i], y2 = share2[1 + i];
    const num = gf256Mul(y1, x2) ^ gf256Mul(y2, x1);
    secret[i] = gf256Mul(num, dInv);
  }
  return secret;
}
function hexToBytes(hex) {
  hex = hex.trim();
  if (hex.length % 2 !== 0) throw new Error("Hex string has odd length");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}
function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
async function memoryKDF(sharedSecret) {
  const salt = new Uint8Array(32);
  const prkKey = await crypto.subtle.importKey("raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prk = new Uint8Array(await crypto.subtle.sign("HMAC", prkKey, sharedSecret));
  const okmKey = await crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const context = new TextEncoder().encode("joulepai-memory-v1");
  const info = new Uint8Array(context.length + 1);
  info.set(context);
  info[context.length] = 1;
  return new Uint8Array(await crypto.subtle.sign("HMAC", okmKey, info));
}
async function aesGcmDecrypt(keyBytes, iv, ciphertext, tag) {
  const aesKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  const ctWithTag = new Uint8Array(ciphertext.length + tag.length);
  ctWithTag.set(ciphertext);
  ctWithTag.set(tag, ciphertext.length);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      aesKey,
      ctWithTag
    );
    return new Uint8Array(plaintext);
  } catch (_) {
    throw new Error(
      "Share combination failed \u2014 invalid recovery phrase or share. Please verify your recovery phrase and try again."
    );
  }
}
function decompressP256(compressed) {
  if (compressed.length !== 33) throw new Error("Expected 33-byte compressed key");
  const prefix = compressed[0];
  if (prefix !== 2 && prefix !== 3) throw new Error("Invalid P-256 prefix");
  const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
  const A = P - 3n;
  const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
  let x = 0n;
  for (let i = 1; i < 33; i++) x = x << 8n | BigInt(compressed[i]);
  const rhs = (modPow(x, 3n, P) + (A * x % P + P) % P + B) % P;
  const y = modPow(rhs, (P + 1n) / 4n, P);
  const yIsOdd = (y & 1n) === 1n;
  const wantOdd = prefix === 3;
  const finalY = yIsOdd === wantOdd ? y : P - y;
  const out = new Uint8Array(65);
  out[0] = 4;
  for (let i = 31; i >= 0; i--) {
    out[1 + i] = Number(x >> BigInt((31 - i) * 8) & 0xFFn);
  }
  for (let i = 31; i >= 0; i--) {
    out[33 + i] = Number(finalY >> BigInt((31 - i) * 8) & 0xFFn);
  }
  return out;
}
function modPow(base, exp, mod) {
  let result = 1n;
  base = (base % mod + mod) % mod;
  while (exp > 0n) {
    if (exp & 1n) result = result * base % mod;
    exp >>= 1n;
    base = base * base % mod;
  }
  return result;
}
async function requestClientDisclosure(apiKey, baseUrl, chunkIds, purpose) {
  return _apiCall(apiKey, "POST", "/api/v1/disclose/client-side", {
    body: { chunk_ids: chunkIds, purpose },
    baseUrl
  });
}
async function decryptCustodialShare(encryptedShare, customerPrivateKeyBytes, p256ScalarMul) {
  const ephemPub = hexToBytes(encryptedShare.ephemeral_pubkey_hex);
  const iv = hexToBytes(encryptedShare.iv_hex);
  const tag = hexToBytes(encryptedShare.tag_hex);
  const ct = base64ToBytes(encryptedShare.encrypted_share);
  const sharedSecretX = await p256ScalarMul(customerPrivateKeyBytes, ephemPub);
  const aesKey = await memoryKDF(sharedSecretX);
  return aesGcmDecrypt(aesKey, iv, ct, tag);
}
async function combineSharesAndDecrypt(customerShare, custodialShare, chunk, p256ScalarMul) {
  const privateKey = shamirCombine(customerShare, custodialShare);
  const ephemPub = hexToBytes(chunk.encryption_metadata.ecdh_public_key_hex);
  const sharedSecretX = await p256ScalarMul(privateKey, ephemPub);
  const aesKey = await memoryKDF(sharedSecretX);
  const iv = hexToBytes(chunk.encryption_metadata.iv_hex);
  const tag = hexToBytes(chunk.encryption_metadata.tag_hex);
  const ct = base64ToBytes(chunk.encrypted_payload);
  return aesGcmDecrypt(aesKey, iv, ct, tag);
}
async function verifyShareCombination(customerShare, custodialShare, poseidonKeyHash, wasmUrl) {
  const moduleUrl = wasmUrl || "/static/shamir_verify.js";
  const mod = await import(moduleUrl);
  await mod.default(moduleUrl.replace(".js", ".wasm"));
  const result = mod.verify_share_combination(
    bytesToHex(customerShare),
    bytesToHex(custodialShare),
    poseidonKeyHash
  );
  return JSON.parse(result);
}
async function requestShareProof(apiKey, baseUrl, customerShareHex, poseidonKeyHash) {
  const body = { customer_share_hex: customerShareHex };
  if (poseidonKeyHash) body.poseidon_key_hash = poseidonKeyHash;
  return _apiCall(apiKey, "POST", "/api/v1/prove/share-combination", {
    body,
    baseUrl
  });
}
var DEFAULT_BASE_URL = "https://api.enyal.ai";
async function _apiCall(apiKey, method, path2, {
  body = null,
  params = null,
  baseUrl = DEFAULT_BASE_URL
} = {}) {
  let url = `${baseUrl}${path2}`;
  if (params) {
    const qs = params instanceof URLSearchParams ? params : new URLSearchParams(params);
    url = `${url}?${qs}`;
  }
  const headers = { "X-API-Key": apiKey };
  const fetchOpts = { method, headers };
  if (body !== null) {
    headers["Content-Type"] = "application/json";
    fetchOpts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, fetchOpts);
  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    throw new Error(`API call failed (${resp.status}): ${e.detail || resp.statusText}`);
  }
  return resp.json();
}
async function archive(apiKey, { agentId, chunkType, chunkKey, data, metadata = {}, baseUrl = DEFAULT_BASE_URL }) {
  return _apiCall(apiKey, "POST", "/api/v1/archive", {
    body: { agent_id: agentId, chunk_type: chunkType, chunk_key: chunkKey, data, ...metadata },
    baseUrl
  });
}
async function search(apiKey, { query, chunkType, entity, since, until, limit = 20, baseUrl = DEFAULT_BASE_URL }) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (chunkType) params.set("chunk_type", chunkType);
  if (entity) params.set("entity", entity);
  if (since) params.set("since", since);
  if (until) params.set("until", until);
  params.set("limit", limit);
  return _apiCall(apiKey, "GET", "/api/v1/search", { params, baseUrl });
}
async function prove(apiKey, { resourceType, geographicRegion, quantumResistant = false, baseUrl = DEFAULT_BASE_URL }) {
  const body = { resource_type: resourceType, quantum_resistant: quantumResistant };
  if (geographicRegion) body.geographic_region = geographicRegion;
  return _apiCall(apiKey, "POST", "/api/v1/prove", { body, baseUrl });
}
async function disclose(apiKey, { chunkIds, recipientPubkeyHex, purpose, includeContentProof = false, proofHashType = "poseidon", baseUrl = DEFAULT_BASE_URL }) {
  return _apiCall(apiKey, "POST", "/api/v1/disclose", {
    body: { chunk_ids: chunkIds, recipient_pubkey_hex: recipientPubkeyHex, purpose, include_content_proof: includeContentProof, proof_hash_type: proofHashType },
    baseUrl
  });
}
async function timestamp(apiKey, { payload, description, baseUrl = DEFAULT_BASE_URL }) {
  const body = { payload };
  if (description) body.description = description;
  return _apiCall(apiKey, "POST", "/api/v1/timestamp", { body, baseUrl });
}
async function createAgreement(apiKey, { terms, parties, title, baseUrl = DEFAULT_BASE_URL }) {
  const body = { terms, parties };
  if (title) body.title = title;
  return _apiCall(apiKey, "POST", "/api/v1/agreement/create", { body, baseUrl });
}
async function verifyAgreement(apiKey, { agreementChunkId, terms, baseUrl = DEFAULT_BASE_URL }) {
  return _apiCall(apiKey, "POST", "/api/v1/agreement/verify", {
    body: { agreement_chunk_id: agreementChunkId, terms },
    baseUrl
  });
}
async function getLineage(apiKey, { chunkId, baseUrl = DEFAULT_BASE_URL }) {
  return _apiCall(apiKey, "GET", `/api/v1/lineage/${chunkId}`, { baseUrl });
}
async function complianceAttest(apiKey, { periodStart, periodEnd, systems, baseUrl = DEFAULT_BASE_URL }) {
  return _apiCall(apiKey, "POST", "/api/v1/compliance/attest", {
    body: { period_start: periodStart, period_end: periodEnd, systems },
    baseUrl
  });
}
async function sendMessage(apiKey, { senderAgentId, threadId, recipientAgentId, messageType, payload, expiresAt, baseUrl = DEFAULT_BASE_URL }) {
  const body = { sender_agent_id: senderAgentId, thread_id: threadId, recipient_agent_id: recipientAgentId, message_type: messageType, payload };
  if (expiresAt) body.expires_at = expiresAt;
  return _apiCall(apiKey, "POST", "/api/v1/message/send", { body, baseUrl });
}
async function getInbox(apiKey, { agentId, direction = "inbox", threadId, messageType, since, limit = 20, baseUrl = DEFAULT_BASE_URL }) {
  const params = new URLSearchParams({ agent_id: agentId, direction, limit });
  if (threadId) params.set("thread_id", threadId);
  if (messageType) params.set("message_type", messageType);
  if (since) params.set("since", since);
  return _apiCall(apiKey, "GET", "/api/v1/message/inbox", { params, baseUrl });
}
async function getThread(apiKey, { threadId, baseUrl = DEFAULT_BASE_URL }) {
  return _apiCall(apiKey, "GET", `/api/v1/message/thread/${threadId}`, { baseUrl });
}
async function markRead(apiKey, { messageIds, baseUrl = DEFAULT_BASE_URL }) {
  return _apiCall(apiKey, "POST", "/api/v1/message/read", {
    body: { message_ids: messageIds },
    baseUrl
  });
}
async function getKnowledgeNodes(apiKey, { nodeType, search: search2, limit = 50, baseUrl = DEFAULT_BASE_URL } = {}) {
  const params = new URLSearchParams();
  if (nodeType) params.set("node_type", nodeType);
  if (search2) params.set("search", search2);
  params.set("limit", limit);
  return _apiCall(apiKey, "GET", "/api/v1/knowledge/nodes", { params, baseUrl });
}
async function getKnowledgeNode(apiKey, { nodeId, baseUrl = DEFAULT_BASE_URL }) {
  return _apiCall(apiKey, "GET", `/api/v1/knowledge/node/${nodeId}`, { baseUrl });
}
async function getKnowledgeConnections(apiKey, { nodeId, hops = 2, baseUrl = DEFAULT_BASE_URL }) {
  return _apiCall(apiKey, "GET", `/api/v1/knowledge/node/${nodeId}/connections`, {
    params: new URLSearchParams({ hops }),
    baseUrl
  });
}
async function getContradictions(apiKey, { baseUrl = DEFAULT_BASE_URL } = {}) {
  return _apiCall(apiKey, "GET", "/api/v1/knowledge/contradictions", { baseUrl });
}
async function getKnowledgeStats(apiKey, { baseUrl = DEFAULT_BASE_URL } = {}) {
  return _apiCall(apiKey, "GET", "/api/v1/knowledge/stats", { baseUrl });
}
async function getKnowledgeIndex(apiKey, { baseUrl = DEFAULT_BASE_URL } = {}) {
  return _apiCall(apiKey, "GET", "/api/v1/knowledge/index", { baseUrl });
}
async function getKnowledgeHealth(apiKey, { baseUrl = DEFAULT_BASE_URL } = {}) {
  return _apiCall(apiKey, "GET", "/api/v1/knowledge/health", { baseUrl });
}
async function synthesiseKnowledge(apiKey, { query, nodeIds, baseUrl = DEFAULT_BASE_URL }) {
  return _apiCall(apiKey, "POST", "/api/v1/knowledge/synthesise", {
    body: { query, node_ids: nodeIds },
    baseUrl
  });
}

// enyal_agent.js
function requireClient() {
  return enyal_client_exports;
}
var MAX_SYNC_PAGES = 50;
var CHUNK_TYPE_MAP = {
  entity_snapshot: "entity",
  decision_record: "decision",
  verification_result: "event",
  agreement: "event",
  timestamp: "source",
  credential: "event",
  agent_message: "event"
};
var EnyalAgent = class {
  /**
   * @param {string} apiKey — ENYAL API key (eyl_...)
   * @param {string} [localDb] — path to SQLite database
   * @param {string} [baseUrl] — ENYAL API base URL
   */
  constructor(apiKey, localDb = null, baseUrl = null) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || "https://api.enyal.ai";
    this.local = new LocalKnowledgeGraph(localDb);
    this._validated = false;
  }
  // === LOCAL MEMORY (free, private, synchronous) ===
  /**
   * Store locally. Free. Private. Instant. Synchronous.
   * For natural language extraction, use rememberText() instead.
   */
  remember(name, nodeType = "entity", summary = null, properties = null) {
    return this.local.remember(name, nodeType, summary, properties);
  }
  /**
   * Natural language remember. Async — tries Ollama for entity extraction.
   * Falls back to full text as entity name if no LLM available.
   * @param {string} text
   * @param {string} [nodeType='entity']
   * @returns {Promise<string>} node ID
   */
  async rememberText(text, nodeType = "entity") {
    const { name, props } = await this._extractFromText(text);
    return this.local.remember(name, nodeType, text, props);
  }
  /**
   * Search local knowledge.
   */
  recall(query, limit = 10) {
    return this.local.recall(query, limit);
  }
  /**
   * Traverse local graph N hops from a node.
   */
  connections(nodeId, hops = 2) {
    return this.local.connections(nodeId, hops);
  }
  /**
   * List local contradictions.
   */
  contradictions() {
    return this.local.contradictions();
  }
  /**
   * Local knowledge health check.
   */
  health() {
    return this.local.health();
  }
  /**
   * Local knowledge index.
   */
  index() {
    return this.local.index();
  }
  /**
   * Layered context from local graph.
   */
  context(depth = 1, topic = null) {
    return this.local.context(depth, topic);
  }
  /**
   * Compact format for agent prompts.
   */
  compact(depth = 1, topic = null) {
    return this.local.compact(depth, topic);
  }
  /**
   * Create a relationship between two nodes.
   */
  relate(sourceId, targetId, relationship, evidence = null) {
    this.local.relate(sourceId, targetId, relationship, evidence);
  }
  /**
   * Remove from local graph. Does NOT affect ENYAL archives.
   * @returns {boolean}
   */
  forget(nodeId) {
    return this.local.forget(nodeId);
  }
  /**
   * Close the database. Call when done to release file lock.
   */
  close() {
    this.local.close();
  }
  // === PERMANENT PROOF (costs joules, async) ===
  /**
   * Archive to ENYAL. Permanent. Encrypted. Provable.
   */
  async archive(chunkType, chunkKey, data, agentId = null) {
    const client = requireClient();
    const result = await client.archive(this.apiKey, {
      agentId: agentId || "sdk-agent",
      chunkType,
      chunkKey,
      data,
      baseUrl: this.baseUrl
    });
    const name = data.name || data.decision || chunkKey;
    this.local.remember(
      name,
      CHUNK_TYPE_MAP[chunkType] || "entity",
      String(data).slice(0, 200),
      data
    );
    return result;
  }
  /**
   * Generate ZK proof.
   */
  async prove(resourceType, opts = {}) {
    const client = requireClient();
    return client.prove(this.apiKey, { resourceType, baseUrl: this.baseUrl, ...opts });
  }
  /**
   * Selective disclosure.
   */
  async disclose(chunkIds, recipientPubkey, purpose) {
    const client = requireClient();
    return client.disclose(this.apiKey, {
      chunkIds,
      recipientPubkeyHex: recipientPubkey,
      purpose,
      baseUrl: this.baseUrl
    });
  }
  // === MESSAGING ===
  async send(senderId, threadId, recipientId, messageType, payload) {
    const client = requireClient();
    return client.sendMessage(this.apiKey, {
      senderAgentId: senderId,
      threadId,
      recipientAgentId: recipientId,
      messageType,
      payload,
      baseUrl: this.baseUrl
    });
  }
  async inbox(agentId, opts = {}) {
    const client = requireClient();
    return client.getInbox(this.apiKey, { agentId, baseUrl: this.baseUrl, ...opts });
  }
  // === SYNC ===
  /**
   * Encrypt local graph client-side and archive to ENYAL.
   * ENYAL stores the encrypted blob — it cannot read it.
   * @param {string} password — ENYAL account password (required)
   */
  async syncToEnyal(password) {
    if (!password) throw new Error("Password required for encrypted sync");
    const client = requireClient();
    const nodeFields = [
      "id",
      "name",
      "node_type",
      "summary",
      "properties",
      "chunk_ids",
      "created_at",
      "updated_at"
    ];
    const nodes = this.local.db.prepare(
      "SELECT id, name, node_type, summary, properties, chunk_ids, created_at, updated_at FROM nodes"
    ).all();
    const edges = this.local.db.prepare(
      "SELECT id, source_node_id, target_node_id, relationship, evidence, valid_from, valid_to FROM edges"
    ).all();
    const cleanEdges = edges.map((e) => ({
      id: e.id,
      source: e.source_node_id,
      target: e.target_node_id,
      relationship: e.relationship,
      evidence: e.evidence,
      valid_from: e.valid_from,
      valid_to: e.valid_to
    }));
    const snapshot = {
      nodes,
      edges: cleanEdges,
      node_count: nodes.length,
      edge_count: edges.length,
      exported_at: (/* @__PURE__ */ new Date()).toISOString()
    };
    const plaintext = Buffer.from(JSON.stringify(snapshot));
    const plaintextHash = import_node_crypto2.default.createHash("sha256").update(plaintext).digest("hex");
    const key = this._deriveSnapshotKey(password);
    const iv = import_node_crypto2.default.randomBytes(12);
    const cipher = import_node_crypto2.default.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = Buffer.concat([iv, encrypted, tag]).toString("base64");
    const result = await client.archive(this.apiKey, {
      agentId: "sdk-sync",
      chunkType: "knowledge_graph_snapshot",
      chunkKey: `kg-snapshot:${(/* @__PURE__ */ new Date()).toISOString()}`,
      data: {
        encrypted_snapshot: blob,
        plaintext_hash: plaintextHash,
        node_count: nodes.length,
        edge_count: edges.length,
        encryption: "AES-256-GCM",
        key_derivation: "HKDF-SHA256",
        version: 2
      },
      baseUrl: this.baseUrl
    });
    this.local._log("sync_to_enyal", {
      nodes: nodes.length,
      edges: edges.length,
      encrypted: true
    });
    key.fill(0);
    return result;
  }
  /**
   * Download encrypted snapshot from ENYAL, decrypt locally, restore.
   * @param {string} password — ENYAL account password (required)
   */
  async restoreFromEnyal(password) {
    if (!password) throw new Error("Password required for restore");
    const client = requireClient();
    const fs2 = require("fs");
    const path2 = require("path");
    const results = await client.search(this.apiKey, {
      chunkType: "knowledge_graph_snapshot",
      limit: 1,
      baseUrl: this.baseUrl
    });
    const chunks = results.chunks || results.results || [];
    if (!chunks.length) throw new Error("No knowledge graph snapshot found on ENYAL");
    const chunk = chunks[0];
    let data = chunk.data || {};
    if (typeof data === "string") data = JSON.parse(data);
    if (!data.encrypted_snapshot) throw new Error("Snapshot is not encrypted \u2014 legacy format");
    if ((data.version || 1) < 2) throw new Error("Snapshot version not supported. Re-sync with latest SDK.");
    const backupPath = `${this.local.dbPath}.pre-restore.${Date.now()}`;
    if (fs2.existsSync(this.local.dbPath)) {
      fs2.copyFileSync(this.local.dbPath, backupPath);
    }
    const key = this._deriveSnapshotKey(password);
    try {
      const blob = Buffer.from(data.encrypted_snapshot, "base64");
      const iv = blob.subarray(0, 12);
      const tag = blob.subarray(blob.length - 16);
      const ciphertext = blob.subarray(12, blob.length - 16);
      const decipher = import_node_crypto2.default.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      let plaintext;
      try {
        plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
        key.fill(0);
        throw new Error("Decryption failed. Wrong password or corrupted snapshot.");
      }
      if (data.plaintext_hash) {
        const hash = import_node_crypto2.default.createHash("sha256").update(plaintext).digest("hex");
        if (hash !== data.plaintext_hash) {
          throw new Error("Snapshot integrity check failed \u2014 data may have been tampered with");
        }
      }
      const snapshot = JSON.parse(plaintext.toString());
      const expectedNodes = data.node_count || 0;
      const expectedEdges = data.edge_count || 0;
      const actualNodes = (snapshot.nodes || []).length;
      const actualEdges = (snapshot.edges || []).length;
      if (actualNodes !== expectedNodes || actualEdges !== expectedEdges) {
        throw new Error(`Snapshot count mismatch. Expected ${expectedNodes}/${expectedEdges}, got ${actualNodes}/${actualEdges}`);
      }
      this.local.db.exec("DELETE FROM edges");
      this.local.db.exec("DELETE FROM nodes");
      this.local.db.exec("DELETE FROM log");
      let nodesRestored = 0;
      for (const n of snapshot.nodes || []) {
        try {
          this.local.db.prepare(
            "INSERT OR REPLACE INTO nodes (id, name, node_type, summary, properties, name_hash, chunk_ids, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
          ).run(
            n.id || "",
            n.name || "",
            n.node_type || "entity",
            n.summary || "",
            n.properties || "{}",
            this.local._hash(n.name || ""),
            n.chunk_ids || "[]",
            n.created_at || "",
            n.updated_at || ""
          );
          nodesRestored++;
        } catch {
        }
      }
      let edgesRestored = 0;
      for (const e of snapshot.edges || []) {
        try {
          this.local.db.prepare(
            "INSERT OR REPLACE INTO edges (id, source_node_id, target_node_id, relationship, evidence, valid_from, valid_to) VALUES (?,?,?,?,?,?,?)"
          ).run(
            e.id || "",
            e.source || "",
            e.target || "",
            e.relationship || "",
            e.evidence || null,
            e.valid_from || null,
            e.valid_to || null
          );
          edgesRestored++;
        } catch {
        }
      }
      this.local._log("restore_from_enyal", {
        nodes_restored: nodesRestored,
        edges_restored: edgesRestored,
        snapshot_date: snapshot.exported_at
      });
      return {
        nodes_restored: nodesRestored,
        edges_restored: edgesRestored,
        nodes_expected: actualNodes,
        edges_expected: actualEdges,
        snapshot_date: snapshot.exported_at
      };
    } catch (err) {
      if (fs2.existsSync(backupPath)) {
        this.local.close();
        fs2.renameSync(backupPath, this.local.dbPath);
        const { LocalKnowledgeGraph: LocalKnowledgeGraph2 } = (init_local_knowledge(), __toCommonJS(local_knowledge_exports));
        this.local = new LocalKnowledgeGraph2(this.local.dbPath);
      }
      throw err;
    } finally {
      key.fill(0);
    }
  }
  /**
   * Pull remote knowledge into local graph.
   * @param {Object} [opts]
   * @param {string} [opts.since] — ISO timestamp, only pull nodes updated after
   * @param {number} [opts.limit=100] — nodes per page
   * @param {string} [opts.strategy='remote_wins'] — 'remote_wins' or 'local_wins'
   */
  async syncFromEnyal(opts = {}) {
    const client = requireClient();
    let { since = null, limit = 100, strategy = "remote_wins" } = opts;
    let lastSyncTime = "";
    if (since === null) {
      const row = this.local.db.prepare(
        "SELECT details FROM log WHERE action = 'sync_from_enyal' ORDER BY created_at DESC LIMIT 1"
      ).get();
      if (row) {
        const details = JSON.parse(row.details);
        since = details.last_updated || null;
        lastSyncTime = since || "";
      }
    } else {
      lastSyncTime = since;
    }
    let totalSynced = 0;
    let conflicts = 0;
    let offset = 0;
    let page = 0;
    while (true) {
      page++;
      if (page > MAX_SYNC_PAGES) {
        this.local._log("sync_truncated", {
          reason: `Hit ${MAX_SYNC_PAGES} page limit`,
          synced_so_far: totalSynced
        });
        break;
      }
      const remote = await client.getKnowledgeNodes(this.apiKey, {
        since,
        limit,
        offset,
        baseUrl: this.baseUrl
      });
      const nodes = Array.isArray(remote) ? remote : remote.nodes || [];
      if (nodes.length === 0) break;
      for (const node of nodes) {
        const nameHash = this.local._hash(node.name);
        const existing = this.local.db.prepare(
          "SELECT id, name, updated_at FROM nodes WHERE name_hash = ?"
        ).get(nameHash);
        const localNode = existing ? { id: existing.id, name: existing.name, updated_at: existing.updated_at } : null;
        const action = this._mergeNode(localNode, node, lastSyncTime, strategy);
        if (action === "conflict_local_wins") {
          conflicts++;
          continue;
        }
        if (["created", "updated", "conflict_remote_wins"].includes(action)) {
          let props = node.properties || "{}";
          if (typeof props === "string") props = JSON.parse(props);
          this.local.remember(
            node.name,
            node.node_type,
            node.summary || null,
            props
          );
          totalSynced++;
          if (action.includes("conflict")) conflicts++;
        }
      }
      offset += limit;
      if (nodes.length < limit) break;
    }
    this.local._log("sync_from_enyal", {
      nodes_synced: totalSynced,
      conflicts,
      since,
      last_updated: (/* @__PURE__ */ new Date()).toISOString()
    });
    return { synced: totalSynced, conflicts };
  }
  // === INTERNAL ===
  /**
   * Derive AES-256 key from password + account identity.
   * Salt includes API key hash so different accounts produce different keys.
   * Must match Python SDK's _derive_snapshot_key exactly.
   */
  _deriveSnapshotKey(password) {
    const accountSalt = import_node_crypto2.default.createHash("sha256").update(this.apiKey).digest("hex").slice(0, 16);
    return Buffer.from(import_node_crypto2.default.hkdfSync(
      "sha256",
      Buffer.from(password),
      Buffer.from(`enyal-knowledge-snapshot:${accountSalt}`),
      Buffer.from("client-side-encryption"),
      32
    ));
  }
  _mergeNode(localNode, remoteNode, lastSyncTime, strategy) {
    if (localNode === null) return "created";
    const localUpdated = localNode.updated_at || "";
    const localModified = this.local._normaliseTs(localUpdated) > this.local._normaliseTs(lastSyncTime);
    if (!localModified) return "updated";
    if (strategy === "local_wins") {
      this.local._log("sync_conflict", {
        node_name: remoteNode.name,
        resolution: "local_wins"
      });
      return "conflict_local_wins";
    }
    this.local._log("sync_conflict", {
      node_name: remoteNode.name,
      resolution: "remote_wins"
    });
    return "conflict_remote_wins";
  }
  /**
   * Extract entity name from natural language text.
   * Tries Ollama, falls back to full text.
   */
  async _extractFromText(text) {
    const model = process.env.ENYAL_LOCAL_MODEL || "mistral-nemo";
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1e4);
      const resp = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt: `Extract the entity name from this text. Return ONLY the name, nothing else.

Text: ${text}`,
          stream: false
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (resp.ok) {
        const body = await resp.json();
        const name = (body.response || "").trim();
        if (name) return { name, props: { raw_text: text } };
      }
    } catch {
    }
    return { name: text.trim(), props: { raw_text: text } };
  }
};

// index.js
init_local_knowledge();
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  EnyalAgent,
  LocalKnowledgeGraph,
  aesGcmDecrypt,
  archive,
  bytesToHex,
  combineSharesAndDecrypt,
  complianceAttest,
  createAgreement,
  decompressP256,
  decryptCustodialShare,
  disclose,
  getContradictions,
  getInbox,
  getKnowledgeConnections,
  getKnowledgeHealth,
  getKnowledgeIndex,
  getKnowledgeNode,
  getKnowledgeNodes,
  getKnowledgeStats,
  getLineage,
  getThread,
  hexToBytes,
  markRead,
  memoryKDF,
  prove,
  requestClientDisclosure,
  requestShareProof,
  search,
  sendMessage,
  shamirCombine,
  synthesiseKnowledge,
  timestamp,
  verifyAgreement,
  verifyShareCombination
});
