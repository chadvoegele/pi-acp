import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function setup(sessionId = 's1', conn = new FakeAgentSideConnection()) {
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId,
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn)
  })
  return { session, proc, conn }
}

function delta(proc: FakePiRpcProcess, text: string, type = 'text_delta') {
  proc.emit({ type: 'message_update', assistantMessageEvent: { type, delta: text } })
}

function boundary(proc: FakePiRpcProcess, type: 'message_start' | 'message_end', role = 'assistant') {
  proc.emit({ type, message: { role } })
}

function chunks(conn: FakeAgentSideConnection) {
  return conn.updates.flatMap(({ update }) =>
    update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk' ? [update] : []
  )
}

async function flush(session: PiAcpSession) {
  await session.publishContextUsage()
}

test('assistant text and thinking share an ID across tool and non-assistant events without a prompt', async () => {
  const { session, proc, conn } = setup()
  boundary(proc, 'message_start')
  delta(proc, 'reasoning', 'thinking_delta')
  delta(proc, 'before ')
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_start', toolCall: { id: 't1', name: 'read', arguments: {} } }
  })
  for (const role of ['user', 'toolResult']) {
    boundary(proc, 'message_start', role)
    boundary(proc, 'message_end', role)
  }
  delta(proc, 'after')
  boundary(proc, 'message_end')
  await flush(session)

  const updates = chunks(conn)
  assert.equal(updates.length, 3)
  const id = updates[0]!.messageId
  assert.ok(id)
  assert.ok(updates.every(update => update.messageId === id))
  assert.deepEqual(
    updates.map(update => update.sessionUpdate),
    ['agent_thought_chunk', 'agent_message_chunk', 'agent_message_chunk']
  )
  assert.deepEqual(
    updates.map(update => update.content),
    [
      { type: 'text', text: 'reasoning' },
      { type: 'text', text: 'before ' },
      { type: 'text', text: 'after' }
    ]
  )
  assert.equal(session.hasPendingTurn, false)
})

test('assistant boundaries rotate IDs, recover missing boundaries, and emit no final snapshots', async () => {
  const { session, proc, conn } = setup()
  delta(proc, 'lazy', 'thinking_delta')
  delta(proc, 'lazy text')
  boundary(proc, 'message_end')
  delta(proc, 'after end')
  boundary(proc, 'message_start')
  delta(proc, 'new start')
  boundary(proc, 'message_start')
  delta(proc, 'missing end recovered')
  boundary(proc, 'message_end')
  boundary(proc, 'message_start')
  boundary(proc, 'message_end')
  await flush(session)

  const updates = chunks(conn)
  assert.equal(updates.length, 5)
  assert.equal(updates[0]!.messageId, updates[1]!.messageId)
  const ids = updates.slice(1).map(update => update.messageId)
  assert.ok(ids.every(id => typeof id === 'string' && id.length > 0))
  assert.equal(new Set(ids).size, 4)
})

test('messages within and after a prompted turn get separate IDs', async () => {
  const { session, proc, conn } = setup()
  const pending = session.prompt('hello')
  for (let i = 0; i < 2; i++) {
    boundary(proc, 'message_start')
    delta(proc, 'identical')
    boundary(proc, 'message_end')
  }
  proc.emit({ type: 'agent_settled' })
  assert.equal(await pending, 'end_turn')
  boundary(proc, 'message_start')
  delta(proc, 'unsolicited')
  boundary(proc, 'message_end')
  await flush(session)
  assert.equal(chunks(conn).length, 3)
  assert.equal(new Set(chunks(conn).map(update => update.messageId)).size, 3)
})

test('cancellation and adapter notices do not rotate the active assistant ID', async () => {
  const { session, proc, conn } = setup()
  boundary(proc, 'message_start')
  delta(proc, 'before')
  proc.emit({ type: 'auto_retry_start' })
  await session.cancel()
  delta(proc, 'final partial')
  boundary(proc, 'message_end')
  boundary(proc, 'message_start')
  delta(proc, 'next')
  await flush(session)
  const updates = chunks(conn)
  assert.equal(updates.length, 4)
  assert.ok(updates[0]!.messageId)
  assert.equal(updates[1]!.messageId, undefined)
  assert.equal(updates[0]!.messageId, updates[2]!.messageId)
  assert.notEqual(updates[0]!.messageId, updates[3]!.messageId)
})

test('queued notifications retain their captured IDs across starts and teardown', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const conn = new FakeAgentSideConnection()
  const send = conn.sessionUpdate.bind(conn)
  conn.sessionUpdate = async msg => {
    await gate
    await send(msg)
  }
  const { session, proc } = setup('s1', conn)
  boundary(proc, 'message_start')
  delta(proc, 'first')
  boundary(proc, 'message_end')
  boundary(proc, 'message_start')
  delta(proc, 'second')
  session.dispose()
  delta(proc, 'obsolete')
  release()
  await flush(session)
  const updates = chunks(conn)
  assert.equal(updates.length, 2)
  assert.ok(updates[0]!.messageId)
  assert.ok(updates[1]!.messageId)
  assert.notEqual(updates[0]!.messageId, updates[1]!.messageId)
})

test('concurrent sessions and a restored session never reuse IDs', async () => {
  const first = setup()
  const second = setup('s2')
  delta(first.proc, 'one')
  delta(second.proc, 'two')
  first.proc.emit({ type: 'process_exit' })
  delta(first.proc, 'obsolete')
  const restored = setup()
  delta(restored.proc, 'restored')
  await Promise.all([first, second, restored].map(({ session }) => flush(session)))
  const updates = [first, second, restored].flatMap(({ conn }) => chunks(conn))
  assert.equal(updates.length, 3)
  assert.ok(updates.every(update => update.messageId))
  assert.equal(new Set(updates.map(update => update.messageId)).size, 3)
})
