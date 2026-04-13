import ts from "typescript"

export interface ConnectionImportBinding {
  localName: string
  serverName: string
}

export interface ConnectionToolReference {
  localName: string
  serverName: string
  toolName: string
}

const CONNECTION_IMPORT_RE = /^(?:@jig|jig|(?:\.\.\/)+\.jig)\/connections\/([A-Za-z0-9_-]+)(?:\.(?:js|ts))?$/

function parseSource(code: string, fileName = "jig.ts") {
  return ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

export function getConnectionImportBindings(code: string, fileName = "jig.ts"): ConnectionImportBinding[] {
  const bindings: ConnectionImportBinding[] = []
  const sf = parseSource(code, fileName)

  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue

    const match = statement.moduleSpecifier.text.match(CONNECTION_IMPORT_RE)
    if (!match) continue

    const namedBindings = statement.importClause?.namedBindings
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue

    for (const element of namedBindings.elements) {
      bindings.push({
        localName: element.name.text,
        serverName: match[1],
      })
    }
  }

  return bindings
}

export function getImportedServers(code: string, fileName = "jig.ts"): string[] {
  return [...new Set(getConnectionImportBindings(code, fileName).map((binding) => binding.serverName))]
}

export function getConnectionToolReferences(code: string, fileName = "jig.ts"): ConnectionToolReference[] {
  const bindings = new Map(
    getConnectionImportBindings(code, fileName).map((binding) => [binding.localName, binding.serverName])
  )
  const refs: ConnectionToolReference[] = []
  const sf = parseSource(code, fileName)

  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const serverName = bindings.get(node.expression.text)
      if (serverName) {
        refs.push({
          localName: node.expression.text,
          serverName,
          toolName: node.name.text,
        })
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sf)
  return refs
}

export function hasConsoleLogCall(code: string, fileName = "jig.ts"): boolean {
  const sf = parseSource(code, fileName)
  let found = false

  const visit = (node: ts.Node) => {
    if (found) return
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === "console"
      && node.expression.name.text === "log"
    ) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }

  visit(sf)
  return found
}
