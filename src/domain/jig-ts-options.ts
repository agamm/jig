import { join } from "node:path"
import ts from "typescript"
import { CONNECTIONS_DIR, PROJECT_ROOT } from "../config/paths.js"

let cachedOptions: ts.CompilerOptions | null = null

export function getJigTsCompilerOptions(overrides: ts.CompilerOptions = {}): ts.CompilerOptions {
  if (!cachedOptions) {
    const configPath = ts.findConfigFile(PROJECT_ROOT, ts.sys.fileExists, "tsconfig.json")
    let options: ts.CompilerOptions = {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ESNext,
      strict: true,
    }

    if (configPath) {
      const parsed = ts.getParsedCommandLineOfConfigFile(
        configPath,
        {},
        {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic: () => {},
        }
      )
      options = parsed?.options ?? options
    }

    cachedOptions = {
      ...options,
      baseUrl: PROJECT_ROOT,
      // Drop rootDir: in service mode CONNECTIONS_DIR is /data while the tsconfig
      // sits in /app, so any import of @jig/connections/* trips TS6059. We only
      // run with noEmit, so rootDir has no useful effect.
      rootDir: undefined,
      paths: {
        ...(options.paths ?? {}),
        "@jig/sdk": [join(PROJECT_ROOT, "src/index.ts")],
        "@jig/connections/*.js": [join(CONNECTIONS_DIR, "*.ts")],
        "@jig/connections/*.ts": [join(CONNECTIONS_DIR, "*.ts")],
        "@jig/connections/*": [join(CONNECTIONS_DIR, "*")],
      },
    }
  }

  return {
    ...cachedOptions,
    ...overrides,
    paths: {
      ...(cachedOptions.paths ?? {}),
      ...(overrides.paths ?? {}),
    },
  }
}
