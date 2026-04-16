/**
 * ENYAL Client SDK — Three-tier client-side disclosure, verification, and proof.
 *
 * TIER 1 — Browser/local verification (zero trust in ENYAL)
 *   requestClientDisclosure, decryptCustodialShare, combineSharesAndDecrypt, verifyShareCombination
 *
 * TIER 2 — Proof server (trust ENYAL during proof generation, proof for auditors)
 *   requestShareProof
 *
 * TIER 3 — Self-hosted (documented in README, not in SDK)
 *   Clone shamir-circuit repo, cargo build --release, run locally.
 *
 * Dependencies: Web Crypto API (browsers) or Node.js 19+ crypto.
 * P-256 ECDH requires a scalar multiply function — provide your own or use @noble/curves.
 *
 * No external npm packages required for Shamir combine + WASM verification.
 */

// ────────────────────────────────────────────────────────────────
// GF(256) Arithmetic — identical to enyal/shamir.py
// Generator = 3, irreducible polynomial = 0x11B (same as AES)
// ────────────────────────────────────────────────────────────────

const GF256_EXP = new Uint8Array(512);
const GF256_LOG = new Uint8Array(256);

(function initGF256() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
        GF256_EXP[i] = x;
        GF256_LOG[x] = i;
        let hi = x << 1;
        if (hi & 0x100) hi ^= 0x11B;
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

/**
 * Shamir Lagrange interpolation at x=0 for two shares.
 * Each share: Uint8Array [index_byte, data_0, ..., data_31] = 33 bytes.
 * Returns: Uint8Array of 32-byte reconstructed secret.
 */
function shamirCombine(share1, share2) {
    if (share1.length !== 33 || share2.length !== 33) {
        throw new Error("Share combination failed — each share must be 33 bytes");
    }
    const x1 = share1[0], x2 = share2[0];
    if (x1 === 0 || x2 === 0 || x1 === x2) {
        throw new Error("Share combination failed — invalid share indices");
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

// ────────────────────────────────────────────────────────────────
// Encoding Helpers
// ────────────────────────────────────────────────────────────────

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
    return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

// ────────────────────────────────────────────────────────────────
// Crypto Helpers (Web Crypto API)
// ────────────────────────────────────────────────────────────────

/**
 * HKDF-SHA256 matching enyal's bsv_memory._memory_kdf:
 *   PRK = HMAC-SHA256(salt=zeros(32), IKM=shared_secret)
 *   OKM = HMAC-SHA256(PRK, "joulepai-memory-v1" || 0x01)
 */
async function memoryKDF(sharedSecret) {
    const salt = new Uint8Array(32);
    const prkKey = await crypto.subtle.importKey("raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const prk = new Uint8Array(await crypto.subtle.sign("HMAC", prkKey, sharedSecret));
    const okmKey = await crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const context = new TextEncoder().encode("joulepai-memory-v1");
    const info = new Uint8Array(context.length + 1);
    info.set(context);
    info[context.length] = 0x01;
    return new Uint8Array(await crypto.subtle.sign("HMAC", okmKey, info));
}

/**
 * AES-256-GCM decrypt. On auth tag mismatch (wrong key/share), throws
 * a user-friendly error instead of raw crypto exception.
 */
async function aesGcmDecrypt(keyBytes, iv, ciphertext, tag) {
    const aesKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
    const ctWithTag = new Uint8Array(ciphertext.length + tag.length);
    ctWithTag.set(ciphertext);
    ctWithTag.set(tag, ciphertext.length);
    try {
        const plaintext = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv, tagLength: 128 },
            aesKey, ctWithTag
        );
        return new Uint8Array(plaintext);
    } catch (_) {
        throw new Error(
            "Share combination failed — invalid recovery phrase or share. " +
            "Please verify your recovery phrase and try again."
        );
    }
}

/**
 * P-256 point decompression (pure JS, no dependencies).
 * Converts 33-byte compressed public key to 65-byte uncompressed.
 */
function decompressP256(compressed) {
    if (compressed.length !== 33) throw new Error("Expected 33-byte compressed key");
    const prefix = compressed[0];
    if (prefix !== 0x02 && prefix !== 0x03) throw new Error("Invalid P-256 prefix");

    const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
    const A = P - 3n;
    const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

    let x = 0n;
    for (let i = 1; i < 33; i++) x = (x << 8n) | BigInt(compressed[i]);

    const rhs = (modPow(x, 3n, P) + ((A * x) % P + P) % P + B) % P;
    const y = modPow(rhs, (P + 1n) / 4n, P);

    const yIsOdd = (y & 1n) === 1n;
    const wantOdd = prefix === 0x03;
    const finalY = yIsOdd === wantOdd ? y : P - y;

    const out = new Uint8Array(65);
    out[0] = 0x04;
    for (let i = 31; i >= 0; i--) { out[1 + i] = Number((x >> BigInt((31 - i) * 8)) & 0xFFn); }
    for (let i = 31; i >= 0; i--) { out[33 + i] = Number((finalY >> BigInt((31 - i) * 8)) & 0xFFn); }
    return out;
}

function modPow(base, exp, mod) {
    let result = 1n;
    base = ((base % mod) + mod) % mod;
    while (exp > 0n) {
        if (exp & 1n) result = (result * base) % mod;
        exp >>= 1n;
        base = (base * base) % mod;
    }
    return result;
}

// ────────────────────────────────────────────────────────────────
// TIER 1 — Client-side (zero trust in ENYAL)
// ────────────────────────────────────────────────────────────────

/**
 * 1. Request client-side disclosure materials from ENYAL.
 *    Returns encrypted chunks + ECDH-encrypted custodial share + poseidon_key_hash.
 *    No decryption on server. Customer share is NOT sent.
 *
 * @param {string} apiKey - ENYAL API key (eyl_...)
 * @param {string} baseUrl - API base URL (e.g. "https://api.enyal.ai")
 * @param {string[]} chunkIds - chunk IDs to disclose
 * @param {string} purpose - disclosure purpose description
 */
export async function requestClientDisclosure(apiKey, baseUrl, chunkIds, purpose) {
    return _apiCall(apiKey, "POST", "/api/v1/disclose/client-side", {
        body: { chunk_ids: chunkIds, purpose }, baseUrl,
    });
}

/**
 * 2. Decrypt the custodial share using your P-256 private key.
 *    The custodial share was ECDH-encrypted with your registered public key.
 *
 * @param {Object} encryptedShare - custodial_share from disclosure response
 * @param {Uint8Array} customerPrivateKeyBytes - 32-byte P-256 private key
 * @param {Function} p256ScalarMul - async (privKeyBytes, compressedPubKey) => Uint8Array(32) shared secret x-coord
 *                                    Provide via @noble/curves or your own P-256 implementation.
 * @returns {Promise<Uint8Array>} 33-byte custodial share (index + data)
 */
export async function decryptCustodialShare(encryptedShare, customerPrivateKeyBytes, p256ScalarMul) {
    const ephemPub = hexToBytes(encryptedShare.ephemeral_pubkey_hex);
    const iv = hexToBytes(encryptedShare.iv_hex);
    const tag = hexToBytes(encryptedShare.tag_hex);
    const ct = base64ToBytes(encryptedShare.encrypted_share);

    const sharedSecretX = await p256ScalarMul(customerPrivateKeyBytes, ephemPub);
    const aesKey = await memoryKDF(sharedSecretX);
    return aesGcmDecrypt(aesKey, iv, ct, tag);
}

/**
 * 3. Combine shares and decrypt a chunk.
 *    GF(256) Lagrange interpolation → reconstruct private key → ECDH → AES-GCM decrypt.
 *    On wrong share: AES-GCM auth tag mismatch → clear error message.
 *
 * @param {Uint8Array} customerShare - 33-byte customer share (index + data)
 * @param {Uint8Array} custodialShare - 33-byte custodial share (from decryptCustodialShare)
 * @param {Object} chunk - chunk object from disclosure response (with encrypted_payload + encryption_metadata)
 * @param {Function} p256ScalarMul - async (privKeyBytes, compressedPubKey) => Uint8Array(32)
 * @returns {Promise<Uint8Array>} decrypted plaintext bytes
 */
export async function combineSharesAndDecrypt(customerShare, custodialShare, chunk, p256ScalarMul) {
    const privateKey = shamirCombine(customerShare, custodialShare);
    const ephemPub = hexToBytes(chunk.encryption_metadata.ecdh_public_key_hex);
    const sharedSecretX = await p256ScalarMul(privateKey, ephemPub);
    const aesKey = await memoryKDF(sharedSecretX);
    const iv = hexToBytes(chunk.encryption_metadata.iv_hex);
    const tag = hexToBytes(chunk.encryption_metadata.tag_hex);
    const ct = base64ToBytes(chunk.encrypted_payload);
    return aesGcmDecrypt(aesKey, iv, ct, tag);
}

/**
 * 4. Verify share combination locally via WASM (78KB).
 *    Runs content integrity hash of reconstructed key in browser — zero server calls.
 *
 * @param {Uint8Array} customerShare - 33-byte customer share
 * @param {Uint8Array} custodialShare - 33-byte custodial share
 * @param {string} poseidonKeyHash - 64-char hex of expected key hash
 * @param {string} [wasmUrl] - URL to shamir_verify.js (default: /static/shamir_verify.js)
 * @returns {Promise<{valid: boolean, reconstructed_hash: string, expected_hash: string}>}
 */
export async function verifyShareCombination(customerShare, custodialShare, poseidonKeyHash, wasmUrl) {
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

// ────────────────────────────────────────────────────────────────
// TIER 2 — Proof server (trust ENYAL during proof generation)
// ────────────────────────────────────────────────────────────────

/**
 * 5. Request a cryptographic share combination proof from ENYAL (Tier 2).
 *    Customer sends their share to the server. ENYAL retrieves its custodial share,
 *    generates a zero-knowledge proof via the proof server, then wipes both shares.
 *
 *    NOTE: This is NOT zero-knowledge to ENYAL. ENYAL sees the share during
 *    proof generation. The proof is for third-party auditors.
 *    For zero-trust verification, use Tier 1 (verifyShareCombination).
 *    For zero-trust proof generation, use Tier 3 (self-hosted Rust binary).
 *
 * @param {string} apiKey - ENYAL API key
 * @param {string} baseUrl - API base URL
 * @param {string} customerShareHex - 66-char hex of customer share
 * @param {string} [poseidonKeyHash] - optional, looked up from account if omitted
 * @returns {Promise<Object>} proof + share_attestation
 */
export async function requestShareProof(apiKey, baseUrl, customerShareHex, poseidonKeyHash) {
    const body = { customer_share_hex: customerShareHex };
    if (poseidonKeyHash) body.poseidon_key_hash = poseidonKeyHash;
    return _apiCall(apiKey, "POST", "/api/v1/prove/share-combination", {
        body, baseUrl,
    });
}

// ────────────────────────────────────────────────────────────────
// Shared HTTP helper + Idempotency Map
// ────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://api.enyal.ai";

/**
 * Shared HTTP helper. All ENYAL API calls route through here.
 *
 * @param {string} apiKey - eyl_ API key
 * @param {string} method - HTTP method (GET, POST, etc.)
 * @param {string} path - API path (e.g., "/api/v1/archive")
 * @param {Object} [opts]
 * @param {Object} [opts.body] - Request body (POST/PUT)
 * @param {URLSearchParams|Object} [opts.params] - Query parameters (GET)
 * @param {string} [opts.baseUrl] - Base URL override
 * @returns {Promise<Object>} Parsed JSON response
 */
async function _apiCall(apiKey, method, path, {
    body = null, params = null, baseUrl = DEFAULT_BASE_URL,
} = {}) {
    let url = `${baseUrl}${path}`;
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

// ────────────────────────────────────────────────────────────────
// API Wrappers — Core Operations
// ────────────────────────────────────────────────────────────────

/**
 * Archive to ENYAL's immutable ledger.
 * @param {string} apiKey - eyl_ API key
 * @param {Object} opts - { agentId, chunkType, chunkKey, data, metadata?, baseUrl? }
 */
export async function archive(apiKey, { agentId, chunkType, chunkKey, data, metadata = {}, baseUrl = DEFAULT_BASE_URL }) {
    return _apiCall(apiKey, "POST", "/api/v1/archive", {
        body: { agent_id: agentId, chunk_type: chunkType, chunk_key: chunkKey, data, ...metadata },
        baseUrl,
    });
}

/**
 * Search archived intelligence.
 * @param {string} apiKey
 * @param {Object} opts - { query, chunkType?, entity?, since?, until?, limit?, baseUrl? }
 */
export async function search(apiKey, { query, chunkType, entity, since, until, limit = 20, baseUrl = DEFAULT_BASE_URL }) {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (chunkType) params.set("chunk_type", chunkType);
    if (entity) params.set("entity", entity);
    if (since) params.set("since", since);
    if (until) params.set("until", until);
    params.set("limit", limit);
    return _apiCall(apiKey, "GET", "/api/v1/search", { params, baseUrl });
}

/**
 * Generate a ZK proof of archived intelligence.
 * @param {string} apiKey
 * @param {Object} opts - { resourceType, geographicRegion?, quantumResistant?, baseUrl? }
 */
export async function prove(apiKey, { resourceType, geographicRegion, quantumResistant = false, baseUrl = DEFAULT_BASE_URL }) {
    const body = { resource_type: resourceType, quantum_resistant: quantumResistant };
    if (geographicRegion) body.geographic_region = geographicRegion;
    return _apiCall(apiKey, "POST", "/api/v1/prove", { body, baseUrl });
}

/**
 * Server-side disclosure — re-encrypts chunks for a recipient.
 * @param {string} apiKey
 * @param {Object} opts - { chunkIds, recipientPubkeyHex, purpose, includeContentProof?, proofHashType?, baseUrl? }
 */
export async function disclose(apiKey, { chunkIds, recipientPubkeyHex, purpose, includeContentProof = false, proofHashType = "poseidon", baseUrl = DEFAULT_BASE_URL }) {
    return _apiCall(apiKey, "POST", "/api/v1/disclose", {
        body: { chunk_ids: chunkIds, recipient_pubkey_hex: recipientPubkeyHex, purpose, include_content_proof: includeContentProof, proof_hash_type: proofHashType },
        baseUrl,
    });
}

// ────────────────────────────────────────────────────────────────
// API Wrappers — Trust Endpoints
// ────────────────────────────────────────────────────────────────

/**
 * Timestamp anchored to ENYAL's immutable ledger.
 * @param {string} apiKey
 * @param {Object} opts - { payload, description?, baseUrl? }
 */
export async function timestamp(apiKey, { payload, description, baseUrl = DEFAULT_BASE_URL }) {
    const body = { payload };
    if (description) body.description = description;
    return _apiCall(apiKey, "POST", "/api/v1/timestamp", { body, baseUrl });
}

/**
 * Create a multi-party agreement anchored to ENYAL's immutable ledger.
 * @param {string} apiKey
 * @param {Object} opts - { terms, parties, title?, baseUrl? }
 */
export async function createAgreement(apiKey, { terms, parties, title, baseUrl = DEFAULT_BASE_URL }) {
    const body = { terms, parties };
    if (title) body.title = title;
    return _apiCall(apiKey, "POST", "/api/v1/agreement/create", { body, baseUrl });
}

/**
 * Verify an agreement against its terms anchored to ENYAL's immutable ledger.
 * @param {string} apiKey
 * @param {Object} opts - { agreementChunkId, terms, baseUrl? }
 */
export async function verifyAgreement(apiKey, { agreementChunkId, terms, baseUrl = DEFAULT_BASE_URL }) {
    return _apiCall(apiKey, "POST", "/api/v1/agreement/verify", {
        body: { agreement_chunk_id: agreementChunkId, terms }, baseUrl,
    });
}

/**
 * Get the provenance lineage chain for a chunk.
 * @param {string} apiKey
 * @param {Object} opts - { chunkId, baseUrl? }
 */
export async function getLineage(apiKey, { chunkId, baseUrl = DEFAULT_BASE_URL }) {
    return _apiCall(apiKey, "GET", `/api/v1/lineage/${chunkId}`, { baseUrl });
}

/**
 * Generate a compliance attestation report.
 * @param {string} apiKey
 * @param {Object} opts - { periodStart, periodEnd, systems, baseUrl? }
 */
export async function complianceAttest(apiKey, { periodStart, periodEnd, systems, baseUrl = DEFAULT_BASE_URL }) {
    return _apiCall(apiKey, "POST", "/api/v1/compliance/attest", {
        body: { period_start: periodStart, period_end: periodEnd, systems },
        baseUrl,
    });
}

// ────────────────────────────────────────────────────────────────
// API Wrappers — Agent Messaging
// ────────────────────────────────────────────────────────────────

/**
 * Send an agent-to-agent message. Cost: 10 joules.
 * @param {string} apiKey - eyl_ API key
 * @param {Object} opts - { senderAgentId, threadId, recipientAgentId, messageType, payload, expiresAt?, baseUrl? }
 */
export async function sendMessage(apiKey, { senderAgentId, threadId, recipientAgentId, messageType, payload, expiresAt, baseUrl = DEFAULT_BASE_URL }) {
    const body = { sender_agent_id: senderAgentId, thread_id: threadId, recipient_agent_id: recipientAgentId, message_type: messageType, payload };
    if (expiresAt) body.expires_at = expiresAt;
    return _apiCall(apiKey, "POST", "/api/v1/message/send", { body, baseUrl });
}

/**
 * Retrieve messages for an agent (inbox, outbox, or all).
 * @param {string} apiKey
 * @param {Object} opts - { agentId, direction?, threadId?, messageType?, since?, limit?, baseUrl? }
 */
export async function getInbox(apiKey, { agentId, direction = 'inbox', threadId, messageType, since, limit = 20, baseUrl = DEFAULT_BASE_URL }) {
    const params = new URLSearchParams({ agent_id: agentId, direction, limit });
    if (threadId) params.set("thread_id", threadId);
    if (messageType) params.set("message_type", messageType);
    if (since) params.set("since", since);
    return _apiCall(apiKey, "GET", "/api/v1/message/inbox", { params, baseUrl });
}

/**
 * Retrieve all messages in a thread, ordered by sequence number.
 * @param {string} apiKey
 * @param {Object} opts - { threadId, baseUrl? }
 */
export async function getThread(apiKey, { threadId, baseUrl = DEFAULT_BASE_URL }) {
    return _apiCall(apiKey, "GET", `/api/v1/message/thread/${threadId}`, { baseUrl });
}

/**
 * Mark messages as read.
 * @param {string} apiKey
 * @param {Object} opts - { messageIds, baseUrl? }
 */
export async function markRead(apiKey, { messageIds, baseUrl = DEFAULT_BASE_URL }) {
    return _apiCall(apiKey, "POST", "/api/v1/message/read", {
        body: { message_ids: messageIds }, baseUrl,
    });
}

// ────────────────────────────────────────────────────────────────
// Knowledge Base — browsable wiki auto-built from archived chunks
// ────────────────────────────────────────────────────────────────

export async function getKnowledgeNodes(apiKey, { nodeType, search, limit = 50, baseUrl = DEFAULT_BASE_URL } = {}) {
    const params = new URLSearchParams();
    if (nodeType) params.set("node_type", nodeType);
    if (search) params.set("search", search);
    params.set("limit", limit);
    return _apiCall(apiKey, "GET", "/api/v1/knowledge/nodes", { params, baseUrl });
}

export async function getKnowledgeNode(apiKey, { nodeId, baseUrl = DEFAULT_BASE_URL }) {
    return _apiCall(apiKey, "GET", `/api/v1/knowledge/node/${nodeId}`, { baseUrl });
}

export async function getKnowledgeConnections(apiKey, { nodeId, hops = 2, baseUrl = DEFAULT_BASE_URL }) {
    return _apiCall(apiKey, "GET", `/api/v1/knowledge/node/${nodeId}/connections`, {
        params: new URLSearchParams({ hops }), baseUrl,
    });
}

export async function getContradictions(apiKey, { baseUrl = DEFAULT_BASE_URL } = {}) {
    return _apiCall(apiKey, "GET", "/api/v1/knowledge/contradictions", { baseUrl });
}

export async function getKnowledgeStats(apiKey, { baseUrl = DEFAULT_BASE_URL } = {}) {
    return _apiCall(apiKey, "GET", "/api/v1/knowledge/stats", { baseUrl });
}

export async function getKnowledgeIndex(apiKey, { baseUrl = DEFAULT_BASE_URL } = {}) {
    return _apiCall(apiKey, "GET", "/api/v1/knowledge/index", { baseUrl });
}

export async function getKnowledgeHealth(apiKey, { baseUrl = DEFAULT_BASE_URL } = {}) {
    return _apiCall(apiKey, "GET", "/api/v1/knowledge/health", { baseUrl });
}

/**
 * Combine multiple knowledge nodes into a synthesis. Cost: 5 joules.
 * Creates a new 'synthesis' node with 'informed_by' edges to each source.
 * @param {string} apiKey
 * @param {Object} options
 * @param {string} options.query - Synthesis question (max 500 chars)
 * @param {string[]} options.nodeIds - 1-20 node UUIDs to synthesise
 * @returns {Promise<{id, name, node_type, summary, source_nodes, edges_created, cost}>}
 */
export async function synthesiseKnowledge(apiKey, { query, nodeIds, baseUrl = DEFAULT_BASE_URL }) {
    return _apiCall(apiKey, "POST", "/api/v1/knowledge/synthesise", {
        body: { query, node_ids: nodeIds }, baseUrl,
    });
}

// ────────────────────────────────────────────────────────────────
// Exports
// ────────────────────────────────────────────────────────────────

export { shamirCombine, hexToBytes, bytesToHex, memoryKDF, aesGcmDecrypt, decompressP256 };
