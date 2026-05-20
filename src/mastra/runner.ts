import { execa } from 'execa'
import { readFile } from 'fs/promises'

export type Harness = 'claude' | 'codex' | 'opencode' | 'pi'
export type AgentRole = 'researcher' | 'test-writer' | 'code-writer' | 'verifier'

export async function spawnAgent(
  harness: Harness,
  role: AgentRole,
  prompt: string,
  contextFile: string | null,
  worktreePath: string
): Promise<{ stdout: string; exitCode: number }> {
  switch (harness) {
    case 'claude': {
      let fullPrompt = prompt
      if (contextFile) {
        const context = await readFile(contextFile, 'utf8')
        fullPrompt = context + '\n' + prompt
      }
      const result = await execa('claude', ['--print', '-p', fullPrompt, '--cwd', worktreePath])
      return { stdout: result.stdout, exitCode: result.exitCode ?? 0 }
    }

    case 'codex': {
      let contextContents = ''
      if (contextFile) {
        contextContents = await readFile(contextFile, 'utf8')
      }
      const result = await execa('codex', ['exec', '--json', prompt, '-C', worktreePath], {
        input: contextContents,
      })
      return { stdout: result.stdout, exitCode: result.exitCode ?? 0 }
    }

    case 'opencode': {
      const args = ['run', '--format', 'json', '--dir', worktreePath, prompt]
      if (contextFile) {
        args.push('--file', contextFile)
      }
      const result = await execa('opencode', args)
      return { stdout: result.stdout, exitCode: result.exitCode ?? 0 }
    }

    case 'pi': {
      const subprocess = execa('pi', ['--mode', 'rpc', '--no-session'], {
        cwd: worktreePath,
        stdin: 'pipe',
      })

      if (contextFile) {
        subprocess.stdin.write(
          JSON.stringify({ type: 'bash', command: `cat ${contextFile}` }) + '\n'
        )
      }
      subprocess.stdin.write(JSON.stringify({ type: 'prompt', message: prompt }) + '\n')

      const lines: string[] = []
      for await (const line of subprocess.stdout) {
        const lineStr = typeof line === 'string' ? line : String(line)
        lines.push(lineStr)
        try {
          const parsed = JSON.parse(lineStr)
          if (parsed.type === 'agent_end') {
            subprocess.stdin.end()
            break
          }
        } catch {
          // non-JSON line, continue
        }
      }

      const awaited = await subprocess
      return { stdout: lines.join('\n'), exitCode: awaited.exitCode ?? 0 }
    }
  }
}
