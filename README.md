# ENYAL SDK

Your agent thinks locally. ENYAL proves permanently.

## Installation

```bash
npm install @enyalai/sdk
```

## Quick Start — Local Knowledge + Permanent Proof

```python
from enyal_agent import EnyalAgent

agent = EnyalAgent(api_key="eyl_your_key")

# Remember locally (free, private, instant)
agent.remember("Tesla has 100GWh battery capacity",
               node_type="entity",
               properties={"frontier": "energy", "capacity": "100GWh"})

agent.remember("SpaceX launches 90 rockets per year",
               node_type="entity",
               properties={"frontier": "space", "launches": 90})

# Recall from local memory
results = agent.recall("battery capacity")

# Check what you know
health = agent.health()
print(health)
# {"status": "healthy", "total_nodes": 2, "contradictions": 0}

# Get compact context for your AI prompt (120 tokens)
context = agent.compact()
print(context)
# E:Tesla|100GWh battery capacity|0c
# E:SpaceX|90 launches per year|0c

# Archive permanently (costs joules, encrypted, provable)
agent.archive(
    chunk_type="decision_record",
    chunk_key="my-agent:decision:invest-energy",
    data={"decision": "Invest in energy infrastructure",
          "confidence": 0.85,
          "entities": ["Tesla"]}
)

# Sync local brain to ENYAL for backup
agent.sync_to_enyal()

# Pull remote knowledge locally
agent.sync_from_enyal()
```

## Retry Safety

All state-changing API calls automatically retry on network errors, timeouts, 5xx, and 429 (rate limit) responses. Retries use exponential backoff with jitter and a deterministic idempotency key to prevent double-charges.

```js
// Automatic retry with SDK-generated idempotency key (default)
await archive(apiKey, {
    agentId: 'my-agent', chunkType: 'decision_record',
    chunkKey: 'my-agent:decision:001', data: { decision: 'Invest in space' },
});

// Explicit idempotency key
await archive(apiKey, {
    agentId: 'my-agent', chunkType: 'decision_record',
    chunkKey: 'my-agent:decision:001', data: { decision: 'Invest in space' },
    idempotencyKey: 'my-dedup-key-12345678901234567890',
});

// Disable retry for a single call
await archive(apiKey, { ..., retry: false });
```

**Default retry policy:** 3 retries, 500ms initial delay, 2x backoff, 8s max delay, 100-300ms jitter. Respects `Retry-After` header on 429 responses. Never retries 4xx errors (except 429).

**Retry-safe endpoints:** archive, prove, disclose, client-side disclose, share-proof, timestamp, agreement/create, compliance/attest, message/send.

**Not available via SDK:** `knowledge/synthesise` requires session auth (web console only).

## Two Layers

| Feature | Local (free) | ENYAL (paid) |
|---------|-------------|--------------|
| Storage | SQLite on your machine | Permanent cryptographic ledger |
| Speed | Instant | ~200ms |
| Privacy | Never leaves your device | Encrypted, you hold the key |
| Proof | None | ZK proofs, BSV settlement |
| Cost | Free | Joules per operation |
| Persistence | Until you delete it | Permanent, immutable |

## Installation

```bash
pip install enyal-sdk
```

If using natural language `remember()` with a local LLM:

- Install Ollama: https://ollama.com
- Pull a model: `ollama pull mistral-nemo`
- Or set `ENYAL_LOCAL_MODEL=your-model-name`
- Without a pulled model, extraction falls back to using the full text as the entity name (10s timeout)

### Node.js

```bash
npm install enyal-sdk
```

```javascript
const { EnyalAgent } = require('enyal-sdk');

const agent = new EnyalAgent('eyl_your_key');

// Local (free, private, instant, synchronous)
agent.remember('SpaceX', 'entity', '90 launches/yr', { launches: 90 });
const results = agent.recall('SpaceX');

// Natural language (async, optional Ollama)
await agent.rememberText('Tesla has 100GWh battery capacity');

// Compact context for AI prompt
const ctx = agent.compact();

// Permanent proof (costs joules, async)
await agent.archive('decision_record',
    'my-agent:decision:001',
    { decision: 'Invest in space', confidence: 0.85 });

// Always close when done (releases SQLite file lock)
agent.close();
```

## Backup & Restore

```python
from enyal_agent import EnyalAgent

agent = EnyalAgent(api_key="eyl_your_key")
agent.remember("Tesla", "entity", "100GWh capacity", {"sector": "energy"})

# Backup: encrypt locally, send to ENYAL
agent.sync_to_enyal(password="your-enyal-password")
# ENYAL stores an encrypted blob it cannot read

# Restore on new device:
new_agent = EnyalAgent(api_key="eyl_your_key")
new_agent.restore_from_enyal(password="your-enyal-password")
# Downloads encrypted snapshot, decrypts locally
print(new_agent.health())
```

Your knowledge graph is portable and private:
- Encrypted before it leaves your device
- ENYAL stores the blob but can't read it
- Only your password can decrypt it
- Works across devices, platforms, and SDKs

**Important:** Snapshots are encrypted with your current password. If you change your password, old snapshots become undecryptable. Re-sync immediately after any password change.

### Limitations

- Local knowledge uses SQLite WAL mode. Do not place the database file on a network filesystem (NFS/SMB).

---

## Client-Side Disclosure & Verification

Client-side disclosure, verification, and proof generation for ENYAL's intelligence archival system.

Three trust tiers — choose based on your security requirements:

| Tier | Trust in ENYAL | What runs where | Use case |
|------|----------------|-----------------|----------|
| **Tier 1** | None | Everything client-side | Maximum security, auditor self-verification |
| **Tier 2** | During proof generation | Proof on ENYAL's server | Third-party auditor proofs |
| **Tier 3** | None | Self-hosted Rust binary | Zero-trust zero-knowledge proof generation |

## Installation

**JavaScript** — No npm packages required. Web Crypto API (browsers) or Node.js 19+.
For ECDH, provide a P-256 scalar multiply function (e.g. from `@noble/curves`).

**Python** — `pip install cryptography`

## Usage

### Tier 1 — Full client-side (zero trust)

```js
import { requestClientDisclosure, decryptCustodialShare, combineSharesAndDecrypt, verifyShareCombination } from './enyal-client.js';
import { p256 } from '@noble/curves/p256';

// P-256 scalar multiply helper for @noble/curves
async function p256ScalarMul(privKeyBytes, compressedPubKey) {
    const shared = p256.getSharedSecret(privKeyBytes, compressedPubKey, true);
    return shared.slice(1, 33); // x-coordinate only
}

// 1. Request disclosure materials (no share sent to server)
const materials = await requestClientDisclosure(apiKey, 'https://api.enyal.ai', ['chunk-id'], 'audit');

// 2. Decrypt ENYAL's share using your private key
const custodialShare = await decryptCustodialShare(materials.custodial_share, myPrivateKey, p256ScalarMul);

// 3. Combine shares and decrypt the data
const plaintext = await combineSharesAndDecrypt(myShare, custodialShare, materials.chunks[0], p256ScalarMul);

// 4. Verify share combination locally (WASM, 78KB, zero server calls)
const verification = await verifyShareCombination(myShare, custodialShare, materials.poseidon_key_hash);
console.log(verification.valid); // true — verified locally, ENYAL never saw your share
```

```python
from enyal_client import request_client_disclosure, decrypt_custodial_share, combine_shares_and_decrypt, verify_share_combination

# 1. Request disclosure materials
materials = request_client_disclosure(api_key, 'https://api.enyal.ai', ['chunk-id'], 'audit')

# 2. Decrypt custodial share
custodial_share = decrypt_custodial_share(materials['custodial_share'], my_private_key_bytes)

# 3. Combine and decrypt
plaintext = combine_shares_and_decrypt(my_share, custodial_share, materials['chunks'][0])

# 4. Verify locally (requires shamir-circuit binary for content integrity hash)
result = verify_share_combination(my_share, custodial_share, materials['poseidon_key_hash'],
                                   binary_path='/path/to/shamir-circuit')
print(result['valid'])  # True
```

### Tier 2 — Proof for auditors (share sent to server)

```js
import { requestShareProof } from './enyal-client.js';

const proof = await requestShareProof(apiKey, 'https://api.enyal.ai', myShareHex);
// proof.verified === true
// proof.share_attestation.wiped === true
// proof.share_attestation.trust_level === "operational_transparency"

// Hand proof to auditor — they verify at enyal.ai/docs/verify
```

### Tier 3 — Self-hosted (zero trust, full zero-knowledge proof)

```bash
# Clone and build
git clone https://github.com/GreenlandAI/shamir-circuit.git
cd shamir-circuit && cargo build --release

# Generate proof locally
echo '{"command":"verify_share_combination","share1_hex":"01...","share2_hex":"02...","expected_poseidon_hash":"abcd..."}' \
  | ./target/release/shamir-circuit

# Your shares never leave your machine. Full zero-knowledge proof generated locally.
```

## Test Vector

Use this to verify your GF(256) implementation produces identical results to ENYAL's.

```
Test key:    0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20
Share 1:     010712cc64a718cdf5517aa4a7540d943eee4148c6a308d3147509e70e361e3672
Share 2:     020d2286c45a3a88e9b9ea4e41bf08224cf4b4a5ab622a8400c13cf8384b1e4d84
Share 3:     030b3249a4f8244214e19ae1eae60bb9620be7fe79d434400cad2f042a601e64d6
Expected:    0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20
```

Combine any two shares → must reconstruct to `010203...1f20` (32 bytes).

**JavaScript verification:**
```js
import { shamirCombine, hexToBytes, bytesToHex } from './enyal-client.js';

const share1 = hexToBytes('010712cc64a718cdf5517aa4a7540d943eee4148c6a308d3147509e70e361e3672');
const share2 = hexToBytes('020d2286c45a3a88e9b9ea4e41bf08224cf4b4a5ab622a8400c13cf8384b1e4d84');
const secret = shamirCombine(share1, share2);
console.log(bytesToHex(secret));
// Expected: 0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20
```

**Python verification:**
```python
from enyal_client import shamir_combine

share1 = bytes.fromhex('010712cc64a718cdf5517aa4a7540d943eee4148c6a308d3147509e70e361e3672')
share2 = bytes.fromhex('020d2286c45a3a88e9b9ea4e41bf08224cf4b4a5ab622a8400c13cf8384b1e4d84')
secret = shamir_combine(share1, share2)
print(secret.hex())
# Expected: 0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20
```

## Agent Messaging

Send encrypted messages between agents. Messages are archived as immutable chunks — the chain proves existence, the relay proves order. Send costs 10 joules; inbox/thread/read are free.

**JavaScript:**
```js
import { sendMessage, getInbox, getThread, markRead } from './enyal-client.js';

// Send a trade offer
const msg = await sendMessage(apiKey, {
    senderAgentId: 'agent-alpha',
    threadId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', // use match_id for RAREEAI trades
    recipientAgentId: 'agent-beta',
    messageType: 'offer',
    payload: { resource: 'compute_4gpu', price: 500, duration_hours: 24 },
});
// msg.sequence_number === 1, msg.chunk_id archived on-chain

// Check inbox
const inbox = await getInbox(apiKey, { agentId: 'agent-beta' });
// inbox.messages[0].delivered_at set automatically

// Check outbox (what did I send?)
const sent = await getInbox(apiKey, { agentId: 'agent-alpha', direction: 'outbox' });

// Full thread view (both sides)
const thread = await getThread(apiKey, { threadId: msg.thread_id });
// thread.messages ordered by sequence_number

// Mark as read
await markRead(apiKey, { messageIds: [inbox.messages[0].message_id] });
```

**Python:**
```python
from enyal_client import send_message, get_inbox, get_thread, mark_read

# Send a trade offer
msg = send_message(api_key, 'agent-alpha',
                   'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
                   'agent-beta', 'offer',
                   {'resource': 'compute_4gpu', 'price': 500, 'duration_hours': 24})

# Check inbox
inbox = get_inbox(api_key, 'agent-beta')

# Check outbox
sent = get_inbox(api_key, 'agent-alpha', direction='outbox')

# Full thread view
thread = get_thread(api_key, msg['thread_id'])

# Mark as read
mark_read(api_key, [inbox['messages'][0]['message_id']])
```

**Message types:** `offer`, `bid`, `counter`, `accept`, `reject`, `inform`, `delivery_notice`, `general`

**Rate limits:** Free 20/hour, Pro 100/hour, Enterprise 1000/hour per agent.

## Error Handling

Wrong share or recovery phrase produces a clear error — raw crypto exceptions are never exposed:

```
Share combination failed — invalid recovery phrase or share.
Please verify your recovery phrase and try again.
```

This happens when: Shamir combine produces wrong key → ECDH derives wrong shared secret → AES-GCM auth tag verification fails.

## WASM Module

The share verification WASM module (78 KB) provides:
- `verify_share_combination(share1_hex, share2_hex, expected_hash_hex)` → JSON result
- `poseidon_hash_hex(data_hex)` → 64-char content integrity hash

Deployed at: `https://enyal.ai/static/shamir_verify.wasm`

## Trust Model

| Component | What ENYAL sees | What auditor sees |
|---|---|---|
| **Tier 1** client-side | Encrypted chunks only | Decrypted data + local verification |
| **Tier 2** share proof | Customer share (wiped after proof) | Zero-knowledge proof of valid combination |
| **Tier 3** self-hosted | Nothing | Zero-knowledge proof generated on own hardware |

Tier 2 share attestation is operational transparency — ENYAL self-reports share handling.
A malicious operator could copy the share before wiping. The attestation raises the cost
of misbehaviour but does not prevent it. Only Tier 3 prevents share exposure entirely.
