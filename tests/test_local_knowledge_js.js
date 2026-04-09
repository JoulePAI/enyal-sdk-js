'use strict';

/**
 * Tests for ENYAL JS SDK — local knowledge graph + EnyalAgent.
 *
 * T1.  Create 3 entities
 * T2.  Recall by keyword
 * T3.  Contradiction detected
 * T4.  health() shows contradiction
 * T5.  compact() returns format
 * T6.  context depth 0
 * T7.  context depth 1
 * T8.  context depth 2 with topic
 * T9.  context depth 2 without topic — no garbage
 * T10. connections traversal
 * T11. relate creates edge
 * T12. forget returns true, removes node
 * T13. forget non-existent returns false
 * T14. SQL LIKE injection safe
 * T15. name_hash consistent across normalisations
 * T16-20. Sync (tested structurally — no mock framework)
 * T21. Natural language remember (fallback, no Ollama)
 * T22. _hash matches Python output for same input
 *
 * Run: node test_local_knowledge_js.js
 */

const { LocalKnowledgeGraph } = require('./local_knowledge');
const { EnyalAgent } = require('./enyal_agent');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (!condition) {
        console.error(`  FAIL: ${msg}`);
        failed++;
        return false;
    }
    passed++;
    return true;
}

function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        console.error(`  FAIL: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        failed++;
        return false;
    }
    passed++;
    return true;
}

function makeDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enyal-test-'));
    const dbPath = path.join(dir, 'test.db');
    return { dir, dbPath };
}

function cleanup(kg, dir, dbPath) {
    kg.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
    try { fs.rmdirSync(dir); } catch {}
}

// ── T1. Create 3 entities ──

function testT1() {
    console.log('T1: Create 3 entities');
    const { dir, dbPath } = makeDb();
    const kg = new LocalKnowledgeGraph(dbPath);

    const id1 = kg.remember('Tesla', 'entity', 'EV manufacturer', { sector: 'auto' });
    const id2 = kg.remember('SpaceX', 'entity', 'Space launch', { sector: 'aerospace' });
    const id3 = kg.remember('NVIDIA', 'entity', 'GPU maker', { sector: 'semi' });

    assert(id1 && id2 && id3, 'All IDs returned');
    assert(new Set([id1, id2, id3]).size === 3, '3 unique IDs');

    const count = kg.db.prepare('SELECT count(*) as c FROM nodes').get().c;
    assertEqual(count, 3, '3 nodes in DB');

    cleanup(kg, dir, dbPath);
}

// ── T2. Recall by keyword ──

function testT2() {
    console.log('T2: Recall by keyword');
    const { dir, dbPath } = makeDb();
    const kg = new LocalKnowledgeGraph(dbPath);

    kg.remember('Tesla', 'entity', 'EV manufacturer with 100GWh capacity');
    kg.remember('SpaceX', 'entity', 'Launches 90 rockets per year');

    const r1 = kg.recall('Tesla');
    assertEqual(r1.length, 1, 'Found Tesla');
    assertEqual(r1[0].name, 'Tesla', 'Correct name');

    const r2 = kg.recall('rockets');
    assertEqual(r2.length, 1, 'Found by summary keyword');

    const r3 = kg.recall('nonexistent');
    assertEqual(r3.length, 0, 'No false matches');

    cleanup(kg, dir, dbPath);
}

// ── T3. Contradiction detected ──

function testT3() {
    console.log('T3: Contradiction detected');
    const { dir, dbPath } = makeDb();
    const kg = new LocalKnowledgeGraph(dbPath);

    kg.remember('Tesla', 'entity', 'EV maker', { capacity: '100GWh' });
    kg.remember('Tesla', 'entity', 'EV maker', { capacity: '150GWh' });

    const c = kg.contradictions();
    assertEqual(c.length, 1, 'One contradiction');
    assert(c[0].evidence.includes('capacity'), 'Evidence mentions capacity');
    assert(c[0].evidence.includes('100GWh'), 'Evidence has old value');
    assert(c[0].evidence.includes('150GWh'), 'Evidence has new value');

    cleanup(kg, dir, dbPath);
}

// ── T4. health() shows contradiction ──

function testT4() {
    console.log('T4: health() shows contradiction');
    const { dir, dbPath } = makeDb();
    const kg = new LocalKnowledgeGraph(dbPath);

    kg.remember('Tesla', 'entity', 'EV', { cap: '100' });
    kg.remember('Tesla', 'entity', 'EV', { cap: '150' });

    const h = kg.health();
    assertEqual(h.contradictions, 1, 'health reports 1 contradiction');
    assertEqual(h.status, 'needs_attention', 'Status is needs_attention');

    cleanup(kg, dir, dbPath);
}

// ── T5. compact() returns format ──

function testT5() {
    console.log('T5: compact() returns format');
    const { dir, dbPath } = makeDb();
    const kg = new LocalKnowledgeGraph(dbPath);

    kg.remember('Tesla', 'entity', '100GWh battery');
    kg.remember('SpaceX', 'entity', '90 launches/yr');

    const c = kg.compact();
    assert(typeof c === 'string', 'Returns string');
    assert(c.includes('E:'), 'Has entity prefix');
    assert(c.includes('Tesla'), 'Has Tesla');

    cleanup(kg, dir, dbPath);
}

// ── T6. context depth 0 ──

function testT6() {
    console.log('T6: context depth 0');
    const { dir, dbPath } = makeDb();
    const kg = new LocalKnowledgeGraph(dbPath);

    kg.remember('Tesla', 'entity', 'EV maker');

    const ctx = kg.context(0);
    assertEqual(ctx.layer, 0, 'Layer 0');
    assertEqual(ctx.total_nodes, 1, '1 node');
    assert(ctx.top_entities.includes('Tesla'), 'Tesla in top entities');

    cleanup(kg, dir, dbPath);
}

// ── T7. context depth 1 ──

function testT7() {
    console.log('T7: context depth 1');
    const { dir, dbPath } = makeDb();
    const kg = new LocalKnowledgeGraph(dbPath);

    kg.remember('Tesla', 'entity', 'EV maker');
    kg.remember('SpaceX', 'entity', 'Rockets');

    const ctx = kg.context(1);
    assertEqual(ctx.layer, 1, 'Layer 1');
    assert(ctx.top_nodes.length > 0, 'Has top_nodes');
    assert('contradictions' in ctx, 'Has contradictions key');

    cleanup(kg, dir, dbPath);
}

// ── T8. context depth 2 with topic ──

function testT8() {
    console.log('T8: context depth 2 with topic');
    const { dir, dbPath } = makeDb();
    const kg = new LocalKnowledgeGraph(dbPath);

    kg.remember('Tesla', 'entity', 'Battery company');
    kg.remember('SpaceX', 'entity', 'Rockets');

    const ctx = kg.context(2, 'Battery');
    assert('topic_nodes' in ctx, 'Has topic_nodes with topic');
    assertEqual(ctx.topic_nodes.length, 1, 'Found 1 topic node');

    cleanup(kg, dir, dbPath);
}

// ── T9. context depth 2 without topic — no garbage ──

function testT9() {
    console.log('T9: context depth 2 without topic');
    const { dir, dbPath } = makeDb();
    const kg = new LocalKnowledgeGraph(dbPath);

    kg.remember('Tesla', 'entity', 'Car company');

    const ctx = kg.context(2, null);
    assert(!('topic_nodes' in ctx), 'No topic_nodes when topic is null');

    cleanup(kg, dir, dbPath);
}

// ── T10. connections traversal ──

function testT10() {
    console.log('T10: connections traversal');
    const { dir, dbPath } = makeDb();
    const kg = new LocalKnowledgeGraph(dbPath);

    const id1 = kg.remember('Tesla', 'entity', 'EV maker');
    const id2 = kg.remember('Elon Musk', 'person', 'CEO');
    kg._createEdge(id1, id2, 'led_by', 'CEO since 2008');

    const graph = kg.connections(id1, 2);
    assertEqual(graph.nodes.length, 2, '2 nodes traversed');
    assertEqual(graph.edges.length, 1, '1 edge (no duplicates)');
    assertEqual(graph.edges[0].relationship, 'led_by', 'Correct relationship');

    cleanup(kg, dir, dbPath);
}

// ── T11. relate creates edge ──

function testT11() {
    console.log('T11: relate creates edge');
    const { dir, dbPath } = makeDb();
    const kg = new LocalKnowledgeGraph(dbPath);

    const id1 = kg.remember('Tesla', 'entity', 'EV');
    const id2 = kg.remember('SpaceX', 'entity', 'Rockets');
    kg.relate(id1, id2, 'informed_by', 'Tech transfer');

    const edges = kg.db.prepare(
        'SELECT relationship, evidence FROM edges WHERE source_node_id = ? AND target_node_id = ?'
    ).all(id1, id2);
    assertEqual(edges.length, 1, '1 edge created');
    assertEqual(edges[0].relationship, 'informed_by', 'Correct relationship');
    assertEqual(edges[0].evidence, 'Tech transfer', 'Evidence stored');

    cleanup(kg, dir, dbPath);
}

// ── T12. forget returns true, removes node ──

function testT12() {
    console.log('T12: forget returns true');
    const { dir, dbPath } = makeDb();
    const kg = new LocalKnowledgeGraph(dbPath);

    const id1 = kg.remember('Tesla', 'entity', 'EV');
    const id2 = kg.remember('SpaceX', 'entity', 'Rockets');
    kg.relate(id1, id2, 'partner');

    const result = kg.forget(id1);
    assertEqual(result, true, 'Returns true for existing node');

    const node = kg.db.prepare('SELECT id FROM nodes WHERE id = ?').get(id1);
    assertEqual(node, undefined, 'Node deleted');

    const edges = kg.db.prepare(
        'SELECT id FROM edges WHERE source_node_id = ? OR target_node_id = ?'
    ).all(id1, id1);
    assertEqual(edges.length, 0, 'Edges cleaned up');

    const sp = kg.recall('SpaceX');
    assertEqual(sp.length, 1, 'Other node still exists');

    cleanup(kg, dir, dbPath);
}

// ── T13. forget non-existent returns false ──

function testT13() {
    console.log('T13: forget non-existent');
    const { dir, dbPath } = makeDb();
    const kg = new LocalKnowledgeGraph(dbPath);

    const result = kg.forget('non-existent-id');
    assertEqual(result, false, 'Returns false for non-existent node');

    cleanup(kg, dir, dbPath);
}

// ── T14. SQL LIKE injection safe ──

function testT14() {
    console.log('T14: SQL LIKE injection safe');
    const { dir, dbPath } = makeDb();
    const kg = new LocalKnowledgeGraph(dbPath);

    kg.remember('Tesla Motors', 'entity', 'EV maker');
    kg.remember('SpaceX', 'entity', 'Rockets');

    const r1 = kg.recall('%');
    assertEqual(r1.length, 0, '% does not match everything');

    const r2 = kg.recall('Tesl_');
    assertEqual(r2.length, 0, '_ does not act as wildcard');

    cleanup(kg, dir, dbPath);
}

// ── T15. name_hash consistent across normalisations ──

function testT15() {
    console.log('T15: name_hash normalisation');
    const { dir, dbPath } = makeDb();
    const kg = new LocalKnowledgeGraph(dbPath);

    const h1 = kg._hash('Tesla Inc');
    const h2 = kg._hash('tesla inc');
    const h3 = kg._hash('TESLA INC');
    const h4 = kg._hash('Tesla');

    assertEqual(h1, h2, 'Case insensitive');
    assertEqual(h2, h3, 'All caps matches');
    assertEqual(h1, h4, 'Inc suffix stripped');

    cleanup(kg, dir, dbPath);
}

// ── T16-T20. Sync structural tests ──

function testT16to20() {
    console.log('T16-20: Sync structural tests');
    const { dir, dbPath } = makeDb();
    const kg = new LocalKnowledgeGraph(dbPath);

    // T16: last sync time is stored and retrievable
    kg._log('sync_from_enyal', {
        nodes_synced: 5,
        since: null,
        last_updated: '2026-04-01T00:00:00.000Z',
    });
    const row = kg.db.prepare(
        "SELECT details FROM log WHERE action = 'sync_from_enyal' ORDER BY created_at DESC LIMIT 1"
    ).get();
    const details = JSON.parse(row.details);
    assertEqual(details.nodes_synced, 5, 'T16: sync log records count');
    assertEqual(details.last_updated, '2026-04-01T00:00:00.000Z', 'T16: timestamp stored');

    // T17: _normaliseTs works
    const d1 = kg._normaliseTs('2026-04-01T00:00:00');
    const d2 = kg._normaliseTs('2026-04-02T00:00:00');
    const d3 = kg._normaliseTs(null);
    assert(d2 > d1, 'T17: later date is greater');
    assert(d1 > d3, 'T17: null normalises to epoch');

    // T18: merge — no local modification → updated
    kg.remember('TestNode', 'entity', 'Before sync', { v: 1 });
    kg._log('sync_from_enyal', {
        nodes_synced: 1,
        last_updated: new Date().toISOString(),
    });
    // Local was not modified after sync → should accept remote
    const agent = new EnyalAgent('test', dbPath);
    const action1 = agent._mergeNode(
        { id: '1', name: 'TestNode', updated_at: '2026-04-01T00:00:00' },
        { name: 'TestNode', node_type: 'entity', summary: 'Remote' },
        '2026-04-05T00:00:00',
        'remote_wins'
    );
    assertEqual(action1, 'updated', 'T18: unmodified local → updated');

    // T19: merge — local modified → conflict
    const action2 = agent._mergeNode(
        { id: '1', name: 'TestNode', updated_at: '2026-04-10T00:00:00' },
        { name: 'TestNode', node_type: 'entity', summary: 'Remote' },
        '2026-04-05T00:00:00',
        'local_wins'
    );
    assertEqual(action2, 'conflict_local_wins', 'T19: local_wins strategy');

    const action3 = agent._mergeNode(
        { id: '1', name: 'TestNode', updated_at: '2026-04-10T00:00:00' },
        { name: 'TestNode', node_type: 'entity', summary: 'Remote' },
        '2026-04-05T00:00:00',
        'remote_wins'
    );
    assertEqual(action3, 'conflict_remote_wins', 'T19: remote_wins strategy');

    // T20: merge — no local node → created
    const action4 = agent._mergeNode(null, { name: 'New' }, '', 'remote_wins');
    assertEqual(action4, 'created', 'T20: null local → created');

    agent.close();
    cleanup(kg, dir, dbPath);
}

// ── T21. Natural language remember (fallback) ──

async function testT21() {
    console.log('T21: Natural language remember (fallback)');
    const { dir, dbPath } = makeDb();
    const agent = new EnyalAgent('test', dbPath);

    const nodeId = await agent.rememberText('Tesla has 100GWh battery capacity');
    assert(nodeId, 'Returns node ID');

    const node = agent.local.db.prepare(
        'SELECT name, properties FROM nodes WHERE id = ?'
    ).get(nodeId);
    assert(node, 'Node stored');
    const props = JSON.parse(node.properties);
    assert('raw_text' in props, 'raw_text in properties');

    agent.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
    try { fs.rmdirSync(dir); } catch {}
}

// ── T22. _hash matches Python output ──

function testT22() {
    console.log('T22: _hash matches Python output');
    const { dir, dbPath } = makeDb();
    const kg = new LocalKnowledgeGraph(dbPath);

    // Python reference: all four normalise to 'greenland ai' → f8f8b4275263e617...
    const expected = 'f8f8b4275263e617';

    const tests = [
        'Greenland AI Limited',
        'greenland ai',
        'GREENLAND AI LTD',
        'Greenland AI Limited Ltd',
    ];

    for (const name of tests) {
        const hash = kg._hash(name);
        assert(hash.startsWith(expected),
            `${name} → ${hash.slice(0, 16)} should start with ${expected}`);
    }

    cleanup(kg, dir, dbPath);
}

// ── T23. Corrupted DB recovery ──

function testT23() {
    console.log('T23: Corrupted DB recovery');
    const { dir, dbPath } = makeDb();

    // Write garbage to simulate corruption
    fs.writeFileSync(dbPath, 'THIS IS NOT A VALID SQLITE DATABASE FILE');

    const kg = new LocalKnowledgeGraph(dbPath);

    // Should have created a fresh DB
    const id = kg.remember('TestNode', 'entity', 'After recovery');
    assert(id, 'Can remember after recovery');

    const results = kg.recall('TestNode');
    assertEqual(results.length, 1, 'Node stored in fresh DB');

    // Corrupt file should be preserved
    const corruptFiles = fs.readdirSync(dir).filter(f => f.includes('.corrupt.'));
    assert(corruptFiles.length > 0, 'Corrupt file preserved as .corrupt.{timestamp}');

    kg.close();
    // Cleanup
    for (const f of fs.readdirSync(dir)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
    try { fs.rmdirSync(dir); } catch {}
}

// ── Run all ──

async function main() {
    testT1();
    testT2();
    testT3();
    testT4();
    testT5();
    testT6();
    testT7();
    testT8();
    testT9();
    testT10();
    testT11();
    testT12();
    testT13();
    testT14();
    testT15();
    testT16to20();
    await testT21();
    testT22();
    testT23();

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main();
