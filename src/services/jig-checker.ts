import { readFileSync } from "fs"
import { resolve } from "path"
import ts from "typescript"
import { PROJECT_ROOT } from "../config/paths.js"
import { validateJigFile } from "../validate.js"

export async function validateTsFile(filePath: string): Promise<{ ok: boolean; errors?: string }> {
  const tsconfigPath = `${PROJECT_ROOT}/tsconfig.json`
  const configFile = ts.readConfigFile(tsconfigPath, (p) => readFileSync(p, "utf-8"))
  const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, PROJECT_ROOT)

  const program = ts.createProgram([filePath], { ...parsedConfig.options, noEmit: true })
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
  } catch (error: any) {
    errors.push(`Validator error: ${error?.message}`)
  }

  return errors.length === 0 ? "ok" : errors.join("\n")
}
