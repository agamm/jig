import { readFileSync } from "fs"
import { resolve } from "path"
import ts from "typescript"
import { validateJigFile } from "../validate.js"
import { getJigTsCompilerOptions } from "../domain/jig-ts-options.js"

export async function validateTsFile(filePath: string): Promise<{ ok: boolean; errors?: string }> {
  const program = ts.createProgram([filePath], getJigTsCompilerOptions({ noEmit: true }))
  const diagnostics = ts.getPreEmitDiagnostics(program)

  const fileErrors = diagnostics.filter((d) =>
    d.file && resolve(d.file.fileName) === resolve(filePath)
  )

  if (fileErrors.length === 0) return { ok: true }

  const formatted = fileErrors.map((d) => {
    const { line } = d.file!.getLineAndCharacterOfPosition(d.start!)
    const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n")
    return `Line ${line + 1}: ${msg}`
  }).join("\n")

  return { ok: false, errors: formatted }
}

/**
 * Walk the AST and check ctx.step() structure:
 *  - every jig must call ctx.step at least once
 *  - ctx.step calls must NOT be nested inside another ctx.step callback
 * Returns a list of human-readable problems (empty = ok).
 */
export function checkStepStructure(source: string, fileName = "jig.ts"): string[] {
  const problems: string[] = []
  try {
    const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

    const isCtxStepCall = (node: ts.Node): node is ts.CallExpression => {
      if (!ts.isCallExpression(node)) return false
      const expr = node.expression
      if (!ts.isPropertyAccessExpression(expr)) return false
      return ts.isIdentifier(expr.expression) && expr.expression.text === "ctx" && expr.name.text === "step"
    }

    let stepCount = 0
    let inStep = 0

    const walk = (node: ts.Node) => {
      if (isCtxStepCall(node)) {
        stepCount++
        if (inStep > 0) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
          problems.push(
            `Line ${line + 1}: ctx.step() is nested inside another ctx.step() callback. ` +
            `Steps must be flat — finish the outer step first, pass data via outer-scope variables, then start the next step.`
          )
        }
        inStep++
        ts.forEachChild(node, walk)
        inStep--
        return
      }
      ts.forEachChild(node, walk)
    }

    walk(sf)

    if (stepCount === 0) {
      problems.push(
        'Jig has no ctx.step() calls. Every jig must wrap its work in at least one ctx.step("label", [tools], async () => { ... }) block.'
      )
    }
  } catch (e: any) {
    problems.push(`Step structure check failed: ${e?.message ?? String(e)}`)
  }
  return problems
}

export async function checkJigFile(filePath: string): Promise<string> {
  const errors: string[] = []

  const tsResult = await validateTsFile(filePath)
  if (!tsResult.ok && tsResult.errors) {
    errors.push(...tsResult.errors.split("\n").map((line) => `TSC ${line}`))
  }

  try {
    const result = await validateJigFile(filePath)
    if (!result.ok) {
      for (const error of result.errors) {
        errors.push(`Validator ${error.field}: ${error.message}`)
      }
    }
    // Advisory only — never joins `errors`, because callers gate jig approval
    // on this function returning exactly "ok".
    for (const warning of result.warnings) {
      console.warn(`[validate] ${warning.field}: ${warning.message}`)
    }
  } catch (error: any) {
    errors.push(`Validator error: ${error?.message}`)
  }

  try {
    const source = readFileSync(filePath, "utf-8")
    for (const problem of checkStepStructure(source, filePath)) {
      errors.push(`Steps ${problem}`)
    }
  } catch (error: any) {
    errors.push(`Steps read error: ${error?.message}`)
  }

  return errors.length === 0 ? "ok" : errors.join("\n")
}
