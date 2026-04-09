'use strict';

/**
 * EnyalAgent — local brain + permanent proof in one interface.
 *
 *   const { EnyalAgent } = require('enyal-sdk');
 *   const agent = new EnyalAgent('eyl_xxx');
 *
 *   // Local (free, private, instant)
 *   agent.remember('SpaceX', 'entity', '90 launches/yr', { launches: 90 });
 *   const results = agent.recall('SpaceX');
 *
 *   // Natural language (async, optional Ollama)
 *   await agent.rememberText('SpaceX launches 90 rockets per year');
 *
 *   // Permanent proof (costs joules)
 *   await agent.archive('decision_record', 'key', { decision: 'Invest' });
 *
 * Node.js >= 18.7.0 (crypto.randomUUID)
 * Dependencies: better-sqlite3
 */

const { LocalKnowledgeGraph } = require('./local_knowledge');
const crypto = require('crypto');

// Lazy-load the remote client — SDK works locally without it.
// enyal-client.js may use ESM exports; try require first, fall back to null.
let enyal;
try {
    enyal = require('./enyal-client');
} catch {
    enyal = null;
}

function requireClient() {
    if (!enyal) throw new Error('Remote methods require enyal-client.js');
    return enyal;
}

const MAX_SYNC_PAGES = 50;

const CHUNK_TYPE_MAP = {
    entity_snapshot: 'entity',
    decision_record: 'decision',
    verification_result: 'event',
    agreement: 'event',
    timestamp: 'source',
    credential: 'event',
    agent_message: 'event',
};

class EnyalAgent {

    /**
     * @param {string} apiKey — ENYAL API key (eyl_...)
     * @param {string} [localDb] — path to SQLite database
     * @param {string} [baseUrl] — ENYAL API base URL
     */
    constructor(apiKey, localDb = null, baseUrl = null) {
        this.apiKey = apiKey;
        this.baseUrl = baseUrl || 'https://api.enyal.ai';
        this.local = new LocalKnowledgeGraph(localDb);
        this._validated = false;
    }

    // === LOCAL MEMORY (free, private, synchronous) ===

    /**
     * Store locally. Free. Private. Instant. Synchronous.
     * For natural language extraction, use rememberText() instead.
     */
    remember(name, nodeType = 'entity', summary = null, properties = null) {
        return this.local.remember(name, nodeType, summary, properties);
    }

    /**
     * Natural language remember. Async — tries Ollama for entity extraction.
     * Falls back to full text as entity name if no LLM available.
     * @param {string} text
     * @param {string} [nodeType='entity']
     * @returns {Promise<string>} node ID
     */
    async rememberText(text, nodeType = 'entity') {
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
            agentId: agentId || 'sdk-agent',
            chunkType, chunkKey, data,
            baseUrl: this.baseUrl,
        });

        const name = data.name || data.decision || chunkKey;
        this.local.remember(
            name,
            CHUNK_TYPE_MAP[chunkType] || 'entity',
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
            chunkIds, recipientPubkeyHex: recipientPubkey,
            purpose, baseUrl: this.baseUrl,
        });
    }

    // === MESSAGING ===

    async send(senderId, threadId, recipientId, messageType, payload) {
        const client = requireClient();
        return client.sendMessage(this.apiKey, {
            senderAgentId: senderId, threadId,
            recipientAgentId: recipientId,
            messageType, payload,
            baseUrl: this.baseUrl,
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
        if (!password) throw new Error('Password required for encrypted sync');
        const client = requireClient();

        const nodeFields = ['id', 'name', 'node_type', 'summary', 'properties',
            'chunk_ids', 'created_at', 'updated_at'];
        const nodes = this.local.db.prepare(
            'SELECT id, name, node_type, summary, properties, chunk_ids, created_at, updated_at FROM nodes'
        ).all();
        const edges = this.local.db.prepare(
            'SELECT id, source_node_id, target_node_id, relationship, evidence, valid_from, valid_to FROM edges'
        ).all();

        const cleanEdges = edges.map(e => ({
            id: e.id, source: e.source_node_id, target: e.target_node_id,
            relationship: e.relationship, evidence: e.evidence,
            valid_from: e.valid_from, valid_to: e.valid_to,
        }));

        const snapshot = {
            nodes, edges: cleanEdges,
            node_count: nodes.length, edge_count: edges.length,
            exported_at: new Date().toISOString(),
        };

        const plaintext = Buffer.from(JSON.stringify(snapshot));
        const plaintextHash = crypto.createHash('sha256').update(plaintext).digest('hex');

        // Derive key: HKDF-SHA256, salt includes account identity
        const key = this._deriveSnapshotKey(password);

        // AES-256-GCM encrypt
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const tag = cipher.getAuthTag();
        const blob = Buffer.concat([iv, encrypted, tag]).toString('base64');

        const result = await client.archive(this.apiKey, {
            agentId: 'sdk-sync',
            chunkType: 'knowledge_graph_snapshot',
            chunkKey: `kg-snapshot:${new Date().toISOString()}`,
            data: {
                encrypted_snapshot: blob,
                plaintext_hash: plaintextHash,
                node_count: nodes.length,
                edge_count: edges.length,
                encryption: 'AES-256-GCM',
                key_derivation: 'HKDF-SHA256',
                version: 2,
            },
            baseUrl: this.baseUrl,
        });

        this.local._log('sync_to_enyal', {
            nodes: nodes.length, edges: edges.length, encrypted: true,
        });

        // Best-effort clear
        key.fill(0);
        return result;
    }

    /**
     * Download encrypted snapshot from ENYAL, decrypt locally, restore.
     * @param {string} password — ENYAL account password (required)
     */
    async restoreFromEnyal(password) {
        if (!password) throw new Error('Password required for restore');
        const client = requireClient();
        const fs = require('fs');
        const path = require('path');

        const results = await client.search(this.apiKey, {
            chunkType: 'knowledge_graph_snapshot',
            limit: 1,
            baseUrl: this.baseUrl,
        });
        const chunks = results.chunks || results.results || [];
        if (!chunks.length) throw new Error('No knowledge graph snapshot found on ENYAL');

        const chunk = chunks[0];
        let data = chunk.data || {};
        if (typeof data === 'string') data = JSON.parse(data);
        if (!data.encrypted_snapshot) throw new Error('Snapshot is not encrypted — legacy format');
        if ((data.version || 1) < 2) throw new Error('Snapshot version not supported. Re-sync with latest SDK.');

        // Backup current DB
        const backupPath = `${this.local.dbPath}.pre-restore.${Date.now()}`;
        if (fs.existsSync(this.local.dbPath)) {
            fs.copyFileSync(this.local.dbPath, backupPath);
        }

        const key = this._deriveSnapshotKey(password);

        try {
            const blob = Buffer.from(data.encrypted_snapshot, 'base64');
            const iv = blob.subarray(0, 12);
            const tag = blob.subarray(blob.length - 16);
            const ciphertext = blob.subarray(12, blob.length - 16);

            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(tag);
            let plaintext;
            try {
                plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
            } catch {
                key.fill(0);
                throw new Error('Decryption failed. Wrong password or corrupted snapshot.');
            }

            // Verify integrity hash
            if (data.plaintext_hash) {
                const hash = crypto.createHash('sha256').update(plaintext).digest('hex');
                if (hash !== data.plaintext_hash) {
                    throw new Error('Snapshot integrity check failed — data may have been tampered with');
                }
            }

            const snapshot = JSON.parse(plaintext.toString());

            // Verify counts
            const expectedNodes = data.node_count || 0;
            const expectedEdges = data.edge_count || 0;
            const actualNodes = (snapshot.nodes || []).length;
            const actualEdges = (snapshot.edges || []).length;
            if (actualNodes !== expectedNodes || actualEdges !== expectedEdges) {
                throw new Error(`Snapshot count mismatch. Expected ${expectedNodes}/${expectedEdges}, got ${actualNodes}/${actualEdges}`);
            }

            // Clear and restore
            this.local.db.exec('DELETE FROM edges');
            this.local.db.exec('DELETE FROM nodes');
            this.local.db.exec('DELETE FROM log');

            let nodesRestored = 0;
            for (const n of snapshot.nodes || []) {
                try {
                    this.local.db.prepare(
                        'INSERT OR REPLACE INTO nodes (id, name, node_type, summary, properties, name_hash, chunk_ids, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
                    ).run(
                        n.id || '', n.name || '', n.node_type || 'entity',
                        n.summary || '', n.properties || '{}',
                        this.local._hash(n.name || ''),
                        n.chunk_ids || '[]', n.created_at || '', n.updated_at || ''
                    );
                    nodesRestored++;
                } catch { /* skip corrupt */ }
            }

            let edgesRestored = 0;
            for (const e of snapshot.edges || []) {
                try {
                    this.local.db.prepare(
                        'INSERT OR REPLACE INTO edges (id, source_node_id, target_node_id, relationship, evidence, valid_from, valid_to) VALUES (?,?,?,?,?,?,?)'
                    ).run(
                        e.id || '', e.source || '', e.target || '',
                        e.relationship || '', e.evidence || null,
                        e.valid_from || null, e.valid_to || null
                    );
                    edgesRestored++;
                } catch { /* skip corrupt */ }
            }

            this.local._log('restore_from_enyal', {
                nodes_restored: nodesRestored, edges_restored: edgesRestored,
                snapshot_date: snapshot.exported_at,
            });

            return {
                nodes_restored: nodesRestored, edges_restored: edgesRestored,
                nodes_expected: actualNodes, edges_expected: actualEdges,
                snapshot_date: snapshot.exported_at,
            };
        } catch (err) {
            // Restore failed — put backup back
            if (fs.existsSync(backupPath)) {
                this.local.close();
                fs.renameSync(backupPath, this.local.dbPath);
                const { LocalKnowledgeGraph } = require('./local_knowledge');
                this.local = new LocalKnowledgeGraph(this.local.dbPath);
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
        let { since = null, limit = 100, strategy = 'remote_wins' } = opts;

        // Get last sync time once
        let lastSyncTime = '';
        if (since === null) {
            const row = this.local.db.prepare(
                "SELECT details FROM log WHERE action = 'sync_from_enyal' " +
                "ORDER BY created_at DESC LIMIT 1"
            ).get();
            if (row) {
                const details = JSON.parse(row.details);
                since = details.last_updated || null;
                lastSyncTime = since || '';
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
                this.local._log('sync_truncated', {
                    reason: `Hit ${MAX_SYNC_PAGES} page limit`,
                    synced_so_far: totalSynced,
                });
                break;
            }

            const remote = await client.getKnowledgeNodes(this.apiKey, {
                since, limit, offset,
                baseUrl: this.baseUrl,
            });
            const nodes = Array.isArray(remote) ? remote : (remote.nodes || []);
            if (nodes.length === 0) break;

            for (const node of nodes) {
                const nameHash = this.local._hash(node.name);
                const existing = this.local.db.prepare(
                    'SELECT id, name, updated_at FROM nodes WHERE name_hash = ?'
                ).get(nameHash);

                const localNode = existing
                    ? { id: existing.id, name: existing.name, updated_at: existing.updated_at }
                    : null;

                const action = this._mergeNode(localNode, node, lastSyncTime, strategy);

                if (action === 'conflict_local_wins') {
                    conflicts++;
                    continue;
                }

                if (['created', 'updated', 'conflict_remote_wins'].includes(action)) {
                    let props = node.properties || '{}';
                    if (typeof props === 'string') props = JSON.parse(props);
                    this.local.remember(
                        node.name, node.node_type,
                        node.summary || null, props
                    );
                    totalSynced++;
                    if (action.includes('conflict')) conflicts++;
                }
            }

            offset += limit;
            if (nodes.length < limit) break;
        }

        this.local._log('sync_from_enyal', {
            nodes_synced: totalSynced,
            conflicts,
            since,
            last_updated: new Date().toISOString(),
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
        const accountSalt = crypto.createHash('sha256')
            .update(this.apiKey).digest('hex').slice(0, 16);
        return Buffer.from(crypto.hkdfSync(
            'sha256',
            Buffer.from(password),
            Buffer.from(`enyal-knowledge-snapshot:${accountSalt}`),
            Buffer.from('client-side-encryption'),
            32
        ));
    }

    _mergeNode(localNode, remoteNode, lastSyncTime, strategy) {
        if (localNode === null) return 'created';

        const localUpdated = localNode.updated_at || '';
        const localModified = this.local._normaliseTs(localUpdated) >
            this.local._normaliseTs(lastSyncTime);

        if (!localModified) return 'updated';

        // Conflict: local was modified since last sync
        if (strategy === 'local_wins') {
            this.local._log('sync_conflict', {
                node_name: remoteNode.name,
                resolution: 'local_wins',
            });
            return 'conflict_local_wins';
        }

        this.local._log('sync_conflict', {
            node_name: remoteNode.name,
            resolution: 'remote_wins',
        });
        return 'conflict_remote_wins';
    }

    /**
     * Extract entity name from natural language text.
     * Tries Ollama, falls back to full text.
     */
    async _extractFromText(text) {
        const model = process.env.ENYAL_LOCAL_MODEL || 'mistral-nemo';
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);

            const resp = await fetch('http://localhost:11434/api/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model,
                    prompt: `Extract the entity name from this text. Return ONLY the name, nothing else.\n\nText: ${text}`,
                    stream: false,
                }),
                signal: controller.signal,
            });
            clearTimeout(timeout);

            if (resp.ok) {
                const body = await resp.json();
                const name = (body.response || '').trim();
                if (name) return { name, props: { raw_text: text } };
            }
        } catch {
            // Ollama not available — fallback
        }

        return { name: text.trim(), props: { raw_text: text } };
    }
}

module.exports = { EnyalAgent };
