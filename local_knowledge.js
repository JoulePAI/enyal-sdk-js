'use strict';

/**
 * ENYAL Local Knowledge Graph — on-device SQLite knowledge store.
 *
 * Free, private, instant. No API calls, no network, no cost.
 * Same extraction logic as the ENYAL server but running locally.
 *
 * Dependencies: better-sqlite3 (npm)
 * Node.js >= 18.7.0 (for crypto.randomUUID)
 */

const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');

const SUFFIXES = [' ltd', ' inc', ' gmbh', ' limited', ' corp'];

class LocalKnowledgeGraph {

    /**
     * @param {string} [dbPath] — defaults to ~/.enyal/knowledge.db
     */
    constructor(dbPath) {
        this.dbPath = dbPath || path.join(os.homedir(), '.enyal', 'knowledge.db');
        fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
        try {
            this.db = new Database(this.dbPath);
            this.db.pragma('journal_mode = WAL');
            this._initTables();
        } catch (err) {
            if (err.code === 'SQLITE_CORRUPT' || err.code === 'SQLITE_NOTADB') {
                // Backup corrupt file, create fresh
                fs.renameSync(this.dbPath, `${this.dbPath}.corrupt.${Date.now()}`);
                this.db = new Database(this.dbPath);
                this.db.pragma('journal_mode = WAL');
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
    remember(name, nodeType = 'entity', summary = null, properties = null) {
        const nameHash = this._hash(name);
        let nodeId = crypto.randomUUID();

        const existing = this.db.prepare(
            'SELECT id, properties FROM nodes WHERE name_hash = ?'
        ).get(nameHash);

        if (existing) {
            const oldProps = JSON.parse(existing.properties);
            const newProps = properties || {};

            const contradictions = this._detectContradictions(
                name, oldProps, newProps
            );

            const mergedProps = { ...oldProps, ...newProps };
            this.db.prepare(
                'UPDATE nodes SET summary=?, properties=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
            ).run(summary, JSON.stringify(mergedProps), existing.id);
            nodeId = existing.id;

            for (const c of contradictions) {
                this._createEdge(nodeId, nodeId, 'contradicts', c);
            }
        } else {
            this.db.prepare(
                'INSERT INTO nodes (id, name, node_type, summary, properties, name_hash) VALUES (?,?,?,?,?,?)'
            ).run(nodeId, name, nodeType, summary,
                JSON.stringify(properties || {}), nameHash);
        }

        this._log('remember', { name, type: nodeType });
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
        const escaped = query
            .replace(/\\/g, '\\\\')
            .replace(/%/g, '\\%')
            .replace(/_/g, '\\_');

        const rows = this.db.prepare(
            "SELECT id, name, node_type, summary, properties FROM nodes " +
            "WHERE name LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' " +
            "ORDER BY updated_at DESC LIMIT ?"
        ).all(`%${escaped}%`, `%${escaped}%`, limit);

        return rows.map(r => ({
            id: r.id,
            name: r.name,
            node_type: r.node_type,
            summary: r.summary,
            properties: JSON.parse(r.properties),
        }));
    }

    // === GRAPH OPERATIONS ===

    /**
     * Traverse local graph N hops from a node.
     * @param {string} nodeId
     * @param {number} [hops=2]
     */
    connections(nodeId, hops = 2) {
        const visited = new Set();
        let current = new Set([nodeId]);
        const seenEdgeIds = new Set();
        const allNodes = [];
        const allEdges = [];

        const edgeStmt = this.db.prepare(
            'SELECT id, source_node_id, target_node_id, relationship, evidence ' +
            'FROM edges WHERE source_node_id = ? OR target_node_id = ?'
        );

        for (let hop = 0; hop < hops; hop++) {
            const nextLevel = new Set();
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
                            evidence: e.evidence,
                        });
                    }
                    const other = e.source_node_id === nid
                        ? e.target_node_id
                        : e.source_node_id;
                    nextLevel.add(other);
                }
            }
            current = new Set([...nextLevel].filter(x => !visited.has(x)));
        }

        const nodeStmt = this.db.prepare(
            'SELECT id, name, node_type, summary FROM nodes WHERE id = ?'
        );
        for (const nid of visited) {
            const node = nodeStmt.get(nid);
            if (node) {
                allNodes.push({
                    id: node.id,
                    name: node.name,
                    node_type: node.node_type,
                    summary: node.summary,
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
            'SELECT e.id, e.source_node_id, e.evidence, n.name ' +
            'FROM edges e JOIN nodes n ON e.source_node_id = n.id ' +
            "WHERE e.relationship = 'contradicts'"
        ).all();

        return rows.map(e => ({
            id: e.id,
            node_id: e.source_node_id,
            evidence: e.evidence,
            node_name: e.name,
        }));
    }

    /**
     * Knowledge base health check.
     */
    health() {
        const totalNodes = this.db.prepare('SELECT count(*) as c FROM nodes').get().c;
        const totalEdges = this.db.prepare('SELECT count(*) as c FROM edges').get().c;
        const contradictionCount = this.db.prepare(
            "SELECT count(*) as c FROM edges WHERE relationship = 'contradicts'"
        ).get().c;
        const orphans = this.db.prepare(
            'SELECT count(*) as c FROM nodes n WHERE NOT EXISTS ' +
            '(SELECT 1 FROM edges e WHERE e.source_node_id = n.id OR e.target_node_id = n.id)'
        ).get().c;

        let status = 'healthy';
        if (contradictionCount > 5 || orphans > 10) {
            status = 'unhealthy';
        } else if (contradictionCount > 0 || orphans > 3) {
            status = 'needs_attention';
        }

        return {
            status,
            total_nodes: totalNodes,
            total_edges: totalEdges,
            contradictions: contradictionCount,
            orphan_nodes: orphans,
        };
    }

    /**
     * Grouped overview of entire knowledge base.
     */
    index() {
        const rows = this.db.prepare(
            'SELECT n.id, n.name, n.node_type, n.summary, COUNT(e.id) as connections ' +
            'FROM nodes n LEFT JOIN (' +
            'SELECT id, source_node_id as nid FROM edges ' +
            'UNION ALL SELECT id, target_node_id FROM edges' +
            ') e ON e.nid = n.id GROUP BY n.id ORDER BY connections DESC'
        ).all();

        const grouped = {};
        for (const r of rows) {
            if (!grouped[r.node_type]) grouped[r.node_type] = [];
            grouped[r.node_type].push({
                id: r.id,
                name: r.name,
                summary: r.summary,
                connections: r.connections,
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
                total_nodes: this.db.prepare('SELECT count(*) as c FROM nodes').get().c,
                total_edges: this.db.prepare('SELECT count(*) as c FROM edges').get().c,
                top_entities: this.db.prepare(
                    'SELECT name FROM nodes ORDER BY updated_at DESC LIMIT 5'
                ).all().map(r => r.name),
            };
        }

        const result = this.context(0);
        result.layer = depth;

        if (depth >= 1) {
            result.top_nodes = this.db.prepare(
                'SELECT n.name, n.node_type, n.summary, COUNT(e.id) as cnt ' +
                'FROM nodes n LEFT JOIN (' +
                'SELECT id, source_node_id as nid FROM edges ' +
                'UNION ALL SELECT id, target_node_id FROM edges' +
                ') e ON e.nid = n.id GROUP BY n.id ORDER BY cnt DESC LIMIT 10'
            ).all();
            result.contradictions = this.contradictions();
        }

        if (depth >= 2 && topic) {
            result.topic_nodes = this.recall(topic, 50);
        }

        if (depth >= 3) {
            result.all_nodes = this.db.prepare(
                'SELECT id, name, node_type, summary FROM nodes'
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
                const prefix = n.node_type ? n.node_type[0].toUpperCase() : '?';
                lines.push(`${prefix}:${n.name}|${n.summary || ''}|${n.cnt}c`);
            }
        }

        for (const c of (ctx.contradictions || [])) {
            lines.push(`!${c.node_name}:${c.evidence}`);
        }

        return lines.join('\n');
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
            'DELETE FROM edges WHERE source_node_id = ? OR target_node_id = ?'
        ).run(nodeId, nodeId);
        const result = this.db.prepare(
            'DELETE FROM nodes WHERE id = ?'
        ).run(nodeId);
        this._log('forget', { node_id: nodeId });
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
        return crypto.createHash('sha256').update(normalised).digest('hex');
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
                'INSERT OR IGNORE INTO edges (id, source_node_id, target_node_id, relationship, evidence) VALUES (?,?,?,?,?)'
            ).run(crypto.randomUUID(), source, target, relationship, evidence);
        } catch (e) {
            if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.code === 'SQLITE_CONSTRAINT') {
                // Duplicate edge, expected
            } else {
                this._log('edge_error', { error: e.message });
            }
        }
    }

    _log(action, details) {
        this.db.prepare(
            'INSERT INTO log (id, action, details) VALUES (?,?,?)'
        ).run(crypto.randomUUID(), action, JSON.stringify(details));
    }

    /**
     * Parse any timestamp format to comparable Date.
     */
    _normaliseTs(tsString) {
        if (!tsString) return new Date(0);
        const d = new Date(tsString);
        return isNaN(d.getTime()) ? new Date(0) : d;
    }
}

module.exports = { LocalKnowledgeGraph };
