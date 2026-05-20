import { execa } from 'execa'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface TestResult {
  exitCode: number
  output: string
  failingTests: string[]
}

export interface GateViolation {
  file: string
  line?: number
  message: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseFailingTests(output: string): string[] {
  const failing: string[] = []
  for (const line of output.split('\n')) {
    // Match vitest "✗ test name" or "× test name"
    const vitestMatch = line.match(/^[✗×]\s+(.+)$/)
    if (vitestMatch) {
      failing.push(vitestMatch[1].trim())
      continue
    }
    // Match jest "✕ test name" or "● test name"
    const jestMatch = line.match(/^[✕●]\s+(.+)$/)
    if (jestMatch) {
      failing.push(jestMatch[1].trim())
    }
  }
  return failing
}

function detectRunner(worktreePath: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(join(worktreePath, 'package.json'), 'utf-8'))
    const scripts: Record<string, string> = pkg?.scripts ?? {}
    const testScript: string = scripts.test ?? ''
    if (testScript.includes('vitest')) return ['bunx', 'vitest', 'run']
    if (testScript.includes('jest')) return ['bunx', 'jest']
    if (testScript.includes('bun test')) return ['bun', 'test']
  } catch {
    // fall through
  }
  return ['bunx', 'vitest', 'run']
}

// ─── runTests ─────────────────────────────────────────────────────────────────

export async function runTests(worktreePath: string): Promise<TestResult> {
  const [cmd, ...args] = detectRunner(worktreePath)
  try {
    const result = await execa(cmd, args, { cwd: worktreePath })
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n')
    return { exitCode: result.exitCode ?? 0, output, failingTests: [] }
  } catch (err: any) {
    const output = [err.stdout, err.stderr].filter(Boolean).join('\n')
    return {
      exitCode: err.exitCode ?? 1,
      output,
      failingTests: parseFailingTests(output),
    }
  }
}

// ─── runTypecheck ─────────────────────────────────────────────────────────────

export async function runTypecheck(
  worktreePath: string
): Promise<{ exitCode: number; output: string }> {
  if (!existsSync(join(worktreePath, 'tsconfig.json'))) {
    return { exitCode: 0, output: 'skipped' }
  }
  try {
    const result = await execa('tsc', ['--noEmit'], { cwd: worktreePath })
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n')
    return { exitCode: result.exitCode ?? 0, output }
  } catch (err: any) {
    const output = [err.stdout, err.stderr].filter(Boolean).join('\n')
    return { exitCode: err.exitCode ?? 1, output }
  }
}

// ─── artifactExists ───────────────────────────────────────────────────────────

export function artifactExists(worktreePath: string, filename: string): boolean {
  return existsSync(join(worktreePath, filename))
}

// ─── runStyleGates ────────────────────────────────────────────────────────────

const STYLE_PATTERNS: Array<{
  regex: RegExp
  message: (file: string, line: number) => string
}> = [
  {
    regex: /style=\{\{/,
    message: (file, line) => `inline style (style={{) detected in ${file}:${line}`,
  },
  {
    regex: /console\.log\s*\(/,
    message: (file, line) => `console.log detected in ${file}:${line}`,
  },
  {
    regex: /className="[^"]*\[[^\]]+\][^"]*"/,
    message: (file, line) => `arbitrary Tailwind value detected in ${file}:${line}`,
  },
]

function walkSrcFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const entries = readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...walkSrcFiles(full))
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      files.push(full)
    }
  }
  return files
}

export async function runStyleGates(
  worktreePath: string
): Promise<{ violations: GateViolation[] }> {
  const srcDir = join(worktreePath, 'src')
  const files = walkSrcFiles(srcDir)
  const violations: GateViolation[] = []

  for (const file of files) {
    let content: string
    try {
      content = readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i]
      const lineNum = i + 1
      for (const pattern of STYLE_PATTERNS) {
        if (pattern.regex.test(lineText)) {
          violations.push({
            file,
            line: lineNum,
            message: pattern.message(file, lineNum),
          })
        }
      }
    }
  }

  return { violations }
}

// ─── runJscpd ─────────────────────────────────────────────────────────────────

export async function runJscpd(
  worktreePath: string
): Promise<{ violations: GateViolation[] }> {
  try {
    const result = await execa(
      'bunx',
      ['jscpd', '--min-tokens', '50', '--reporters', 'json', '.'],
      { cwd: worktreePath }
    )
    const output = result.stdout ?? ''
    return parseJscpdOutput(output)
  } catch (err: any) {
    const output = err.stdout ?? ''
    return parseJscpdOutput(output)
  }
}

function parseJscpdOutput(output: string): { violations: GateViolation[] } {
  try {
    const data = JSON.parse(output)
    const duplicates: any[] = data?.duplicates ?? []
    const violations: GateViolation[] = duplicates.map((dup: any) => ({
      file: dup?.firstFile?.name ?? 'unknown',
      line: dup?.firstFile?.start,
      message: `Duplicate code block detected between ${dup?.firstFile?.name} and ${dup?.secondFile?.name}`,
    }))
    return { violations }
  } catch {
    return { violations: [] }
  }
}
