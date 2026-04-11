import { Hono } from 'hono'
import { agentStmts, remoteStmts, ticketStmts } from '../db'
import { agentProcessManager } from '../services/AgentProcessManager'
import { GitWorktreeManager } from '../services/GitWorktreeManager'
import type { Agent, Ticket } from '../../common/types'

export const agentsRouter = new Hono()

agentsRouter.get('/:id', (c) => {
  const agent = agentStmts.get.get(c.req.param('id')) as Agent | null
  if (!agent) return c.json({ error: 'agent not found' }, 404)
  return c.json({ ...agent, needsInput: Boolean(agent.needsInput) })
})

agentsRouter.get('/:id/diff', async (c) => {
  const agent = agentStmts.get.get(c.req.param('id')) as Agent | null
  if (!agent) return c.json({ error: 'agent not found' }, 404)

  const remoteConfig = remoteStmts.get.get() as { baseBranch: string; localPath: string } | null
  if (!remoteConfig) return c.json({ error: 'no remote configured' }, 400)

  try {
    const git = new GitWorktreeManager(remoteConfig.localPath)
    const diff = await git.getDiff(agent.worktreePath, remoteConfig.baseBranch)
    return c.json(diff)
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500)
  }
})

agentsRouter.post('/:id/merge', async (c) => {
  const agent = agentStmts.get.get(c.req.param('id')) as Agent | null
  if (!agent) return c.json({ error: 'agent not found' }, 404)

  const remoteConfig = remoteStmts.get.get() as { baseBranch: string; localPath: string } | null
  if (!remoteConfig) return c.json({ error: 'no remote configured' }, 400)

  try {
    const git = new GitWorktreeManager(remoteConfig.localPath)
    const result = await git.mergeToBase(agent.worktreePath, agent.branch, remoteConfig.baseBranch)

    if (result.success) {
      // Move ticket to done
      const ticket = ticketStmts.get.get(agent.ticketId) as Ticket | null
      if (ticket) {
        ticketStmts.updateStatus.run({
          $status: 'done',
          $updatedAt: Date.now(),
          $id: ticket.id,
        })
        // Clean up worktree
        await git.removeWorktree(agent.worktreePath).catch(() => {})
      }
    }

    return c.json(result)
  } catch (err) {
    return c.json({ success: false, conflicted: false, error: (err as Error).message }, 500)
  }
})

agentsRouter.post('/:id/kill', (c) => {
  const id = c.req.param('id')
  const agent = agentStmts.get.get(id) as Agent | null
  if (!agent) return c.json({ error: 'agent not found' }, 404)

  agentProcessManager.kill(id)
  agentStmts.updateStatus.run({ $id: id, $status: 'error', $needsInput: 0, $endedAt: Date.now() })
  return c.body(null, 204)
})

agentsRouter.post('/:id/input', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ input?: string }>()
  if (!body.input) return c.json({ error: 'input is required' }, 400)

  try {
    agentProcessManager.write(id, body.input)
    return c.json({ ok: true })
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500)
  }
})
